/**
 * 一行现状：给 `systemPrompt.context()` 用的**同步缓存**。
 *
 * 为什么要有这个文件：宿主拼提示词时调的是同步 provider（`text: () => string`），
 * 而方寸的数据要走命名管道 MCP（异步）。**绝不能在 provider 里 await** ——
 * 那会把每一轮模型调用卡在管道上，方寸没开就是每轮都卡。所以：
 *   后台定时把 `list_tasks` 的结果抄进内存 → provider 只读这份快照。
 * 快照永远是"上一份成功的"，读它不需要任何 IO，也不会抛。
 *
 * 口径（③#8 的底线）：数字直接用 `list_tasks` 的结果，**不自己判优先级、不分组、不做摘要**。
 * 未完成 = 状态不是「完成」「驳回」（空状态算未完成 —— 没填 ≠ 做完）。
 */
import { McpPipeClient, toolResultToJson } from './mcp-pipe.js'

/** 方寸的终态。与 index.js 的 `CLOSED_STATUSES` 同一口径 */
export const CLOSED_STATUSES = new Set(['完成', '驳回'])

/** 快照多久刷新一次。比挂件的 60 秒轮询同一节奏：都是"给人看个大概"的量级 */
export const STATUS_REFRESH_MS = 60_000

export function countOpen(tasks) {
  if (!Array.isArray(tasks)) return 0
  return tasks.filter((t) => {
    if (!t || typeof t !== 'object') return false // 坏数据不算一张卡
    return !CLOSED_STATUSES.has(String(t.status || ''))
  }).length
}

function hhmm(at) {
  const d = new Date(Number(at) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 一行文本。契约 ⑥#4 的形状：`<项目> · 未完成 <N> 张 · 截至 <时间>`。
 * 不列标题、不分组、不做摘要 —— 那是 ③#4 明确不要的东西。
 * 方寸没连上就明说「未连接」，不拿旧数字假装新鲜。
 */
export function formatStatusLine(snapshot) {
  const s = snapshot || {}
  // 没装本体 ≠ 没连上：前者要请用户去下载，后者要请用户打开方寸。别混成一句话。
  if (s.installed === false) return '方寸 · 未安装'
  if (s.error) return '方寸 · 未连接'
  if (!Number.isFinite(s.total)) return '方寸 · 未连接'
  const scope = s.project ? String(s.project) : '全部项目'
  return scope + ' · 未完成 ' + s.total + ' 张 · 截至 ' + hhmm(s.at)
}

export class BoardStatus {
  /**
   * @param {object} options
   * @param {string} options.pipePath   方寸 MCP 管道
   * @param {string} [options.project]  只统计某个项目（`FANGCUN_PROJECT`）
   * @param {string} [options.clientVersion]
   * @param {() => number} [options.now]
   * @param {(msg: string) => void} [options.onError]
   */
  constructor(options = {}) {
    this.pipePath = String(options.pipePath || '')
    this.project = String(options.project || '').trim()
    this.clientVersion = String(options.clientVersion || '0.0.0')
    /** 机器上装没装方寸本体（`lib/detect.js` 的结论）。false 时那行写「未安装」 */
    this.installed = options.installed !== false
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    /** `{ total: number|null, at: number, error: string, project: string, installed: boolean }` */
    this.snapshot = { total: null, at: 0, error: '', project: this.project, installed: this.installed }
    this.refreshing = false
    this.pending = null
  }

  /** 后台刷新。并发调用复用同一个 Promise —— 别让定时器和启动各开一条管道 */
  refresh() {
    if (this.refreshing) return this.pending || Promise.resolve(this.snapshot)
    this.refreshing = true
    this.pending = this.query().finally(() => {
      this.refreshing = false
      this.pending = null
    })
    return this.pending
  }

  async query() {
    if (!this.pipePath) {
      this.snapshot = { total: null, at: this.now(), error: '没有管道路径', project: this.project, installed: this.installed }
      return this.snapshot
    }
    let client = null
    try {
      client = new McpPipeClient({ pipePath: this.pipePath, version: this.clientVersion })
      const args = { view: 'active' }
      if (this.project) args.project = this.project
      const tasks = toolResultToJson(await client.callTool('list_tasks', args))
      if (!Array.isArray(tasks)) throw new Error('list_tasks 返回的不是数组')
      this.snapshot = { total: countOpen(tasks), at: this.now(), error: '', project: this.project, installed: this.installed }
    } catch (e) {
      // 方寸没开是常态，不是事故：只记在快照里，provider 读到就是"未连接"
      this.snapshot = {
        total: null,
        at: this.now(),
        error: String((e && e.message) || e),
        project: this.project,
        installed: this.installed,
      }
      this.onError('一行现状刷新失败：' + this.snapshot.error)
    } finally {
      try { if (client) client.close() } catch { /* ignore */ }
    }
    return this.snapshot
  }

  /** provider 只调这个：纯内存、不抛、永不阻塞 */
  line() {
    try { return formatStatusLine(this.snapshot) } catch { return '方寸 · 未连接' }
  }

  /** health 用：把"最后一次成功是什么时候、失败原因"摊开 */
  state() {
    const s = this.snapshot
    return {
      project: s.project || '',
      total: Number.isFinite(s.total) ? s.total : null,
      at: s.at ? new Date(s.at).toISOString() : '',
      error: s.error || '',
      installed: s.installed !== false,
      line: this.line(),
    }
  }
}
