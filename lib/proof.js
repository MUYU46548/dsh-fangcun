/**
 * 自证 sidecar：把 agent **真的调了方寸工具**这件事记成本地日志。
 *
 * 为什么需要它：契约 ②⑦–⑩（开工触发 / 收工回写 / 新问题建卡 / 不过度触发）
 * 的判据都是"记录里出现过某个 tool/call"，而这不是靠模型自述、也不是靠人看界面 ——
 * 只能从 `session/event` 的 `tool/call` 里抠。插件自己记一份，AI 事后能对账。
 *
 * 记录什么、不记录什么：
 *  · 只记 `mcp__fangcun__*`（本机方寸 MCP 工具的名字前缀，工具列表里就是这么显示的）；
 *  · 只记「什么时候、哪个会话、第几轮、哪个工具」，**不记参数**（参数里可能有用户私事）；
 *  · 追加写，超过上限丢最旧的（与 outbox 同思路：别让一个日志慢慢吃满磁盘）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, sessionIdOf } from './usage.js'

/** 方寸 MCP 工具在会话里的名字前缀（工具列表实测：`mcp__fangcun__list_tasks`） */
export const FANGCUN_TOOL_PREFIX = 'mcp__fangcun__'

/** 上限：真按每天几百次调用算，500 行够回溯好几天了 */
export const MAX_PROOF_ROWS = 500

export function proofPaths(home) {
  const dir = path.join(home, 'dsh-fangcun')
  return { dir, tools: path.join(dir, 'tools.jsonl') }
}

export function isFangcunTool(name) {
  return String(name || '').startsWith(FANGCUN_TOOL_PREFIX)
}

function countLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    return raw.split('\n').filter((l) => l.trim()).length
  } catch { return 0 }
}

export class ToolProof {
  constructor(options = {}) {
    this.file = proofPaths(options.home || dshHome()).tools
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.rows = countLines(this.file)
    this.lastAt = ''
  }

  /**
   * 喂一个 `session/event`。不是 `tool/call`、不是方寸工具、取不出会话 id —— 一律忽略（返回 null）。
   * 返回写入的那一行，方便测试与将来的现场排查。
   */
  record(session, event) {
    try {
      if (!event || typeof event !== 'object' || event.type !== 'tool/call') return null
      const data = event.data || {}
      const tool = String(data.name || '')
      if (!isFangcunTool(tool)) return null
      const sessionId = sessionIdOf(session)
      if (!sessionId) return null // 宁可少记一条，也不写一个假 id
      const row = {
        at: new Date(this.now()).toISOString(),
        session: sessionId,
        turn: Number(data.turn) || 0,
        tool,
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf-8')
      this.rows += 1
      this.lastAt = row.at
      if (this.rows > MAX_PROOF_ROWS) this.trim()
      return row
    } catch (e) {
      this.onError('写自证日志失败：' + String((e && e.message) || e))
      return null
    }
  }

  /** 超上限就整份重写，只留最后 MAX_PROOF_ROWS 行（与 sent.jsonl 的压缩同一做法） */
  trim() {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8')
      const lines = raw.split('\n').filter((l) => l.trim())
      const kept = lines.slice(-MAX_PROOF_ROWS)
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8')
      fs.renameSync(tmp, this.file)
      this.rows = kept.length
    } catch (e) {
      this.onError('压缩自证日志失败：' + String((e && e.message) || e))
    }
  }

  /** health 用：条数与最后一次时间。文件路径不暴露（没意义，还会把本机路径带进日志） */
  state() {
    return { rows: this.rows, lastAt: this.lastAt }
  }
}
