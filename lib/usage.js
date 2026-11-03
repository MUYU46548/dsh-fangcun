/**
 * 用量账本：会话事件 → 每轮聚合 → 报回方寸。
 *
 * 判据（都在测试里钉着）：
 *  ① **不丢**：方寸没开、管道断了、DSH 崩了 → 记录留在本地 outbox，下次再发；
 *  ② **不重**：幂等键 = `sessionId#turn`，同一轮结算两次只记一次；
 *  ③ **不猜**：报的是 token（供应商返回的硬数据），不报金额 —— 金额要自己维护价目表，
 *     那是估算，塞进标着 "Provider-reported cost" 的字段里就是让账本说假话；
 *  ④ **不吵**：任何失败只回调 onError，绝不抛进 DSH 的主流程。
 *
 * 口径：`prompt_tokens = inputTokens + cacheReadTokens`（缓存读也是输入侧的 token，
 * 拆分写进 note，不让人误以为全价）；`completion_tokens = outputTokens`
 * （DSH 保证 reasoning ⊆ output，不重复计）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpPipeClient, toolResultToJson } from './mcp-pipe.js'

/** DSH 主目录：环境变量优先，默认 `~/.dsh`（与 DSH 自己的口径一致） */
export function dshHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME || '').trim()
  if (fromEnv) return fromEnv
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dsh')
}

export function usagePaths(home) {
  const dir = path.join(home, 'dsh-fangcun')
  return { dir, outbox: path.join(dir, 'outbox.jsonl'), sent: path.join(dir, 'sent.jsonl') }
}

function readJsonl(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf-8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过，不因一行坏数据整份作废 */ }
  }
  return out
}

function writeJsonlAtomic(file, rows) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8')
  fs.renameSync(tmp, file)
}

/** 方寸 outbox 里还有几条没发出去（health 用） */
export function pendingCount(env = process.env) {
  return readJsonl(usagePaths(dshHome(env)).outbox).length
}

const SENT_KEEP = 2000

export class UsageLedger {
  constructor(options = {}) {
    const home = options.home || dshHome()
    const paths = usagePaths(home)
    this.outboxPath = paths.outbox
    this.sentPath = paths.sent
    this.pipePath = String(options.pipePath || '')
    this.clientVersion = String(options.clientVersion || '0.0.0')
    this.clientName = String(options.clientName || 'dsh')
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.maxBatch = Number(options.maxBatch) > 0 ? Number(options.maxBatch) : 20

    /** sessionId -> { turn, input, cache, output, model, at } */
    this.turns = new Map()
    this.queue = []
    this.sent = new Set()
    this.flushing = false
    this.lastError = ''
    this.load()
  }

  load() {
    this.sent = new Set(readJsonl(this.sentPath).map((r) => r && r.key).filter(Boolean))
    // 进程在"发出去了但没来得及落盘 sent"之间崩掉时，outbox 里会有已发过的键 → 过滤
    this.queue = readJsonl(this.outboxPath)
      .filter((r) => r && typeof r.key === 'string' && r.payload && !this.sent.has(r.key))
  }

  pendingCount() {
    return this.queue.length
  }

  /** 聚合一轮：assistant/message 累加，turn/end 结算 */
  onSessionEvent(sessionId, event) {
    try {
      const id = String(sessionId || '')
      if (!id || !event || typeof event !== 'object') return
      const data = event.data
      if (event.type === 'turn/end') { this.finalize(id); return }
      if (event.type !== 'assistant/message') return
      if (!data || typeof data !== 'object' || !data.usage) return
      const turn = Number(data.turn)
      if (!Number.isFinite(turn)) return

      let agg = this.turns.get(id)
      if (agg && agg.turn !== turn) this.finalize(id)
      agg = this.turns.get(id)
      if (!agg) {
        agg = { turn, input: 0, cache: 0, output: 0, model: '', at: this.now() }
        this.turns.set(id, agg)
      }
      agg.input += Number(data.usage.inputTokens) || 0
      agg.cache += Number(data.usage.cacheReadTokens) || 0
      agg.output += Number(data.usage.outputTokens) || 0
      const model = data.message && data.message.source && data.message.source.model
      if (model) agg.model = String(model)
      agg.at = this.now()
    } catch (e) {
      this.onError('聚合会话事件失败：' + String((e && e.message) || e))
    }
  }

  /** 会话被销毁时也要结算，避免"中途关掉就丢了半轮" */
  onSessionDisposed(sessionId) {
    this.finalize(String(sessionId || ''))
  }

  finalize(sessionId) {
    const id = String(sessionId || '')
    const agg = this.turns.get(id)
    if (!agg) return
    this.turns.delete(id)

    const prompt = agg.input + agg.cache
    const completion = agg.output
    if (prompt + completion <= 0) return

    const key = `${id}#${agg.turn}`
    if (this.sent.has(key)) return
    const payload = {
      client: this.clientName,
      model: agg.model || 'unknown',
      prompt_tokens: prompt,
      completion_tokens: completion,
      at: new Date(agg.at).toISOString(),
      // 120 字上限：把口径写进来，别让人以为 prompt 全是全价 token
      note: `session=${id.slice(0, 8)} turn=${agg.turn} cache_read=${agg.cache}`,
    }
    this.queue.push({ key, payload })
    this.persist()
    void this.flush()
  }

  persist() {
    try { writeJsonlAtomic(this.outboxPath, this.queue) } catch (e) { this.onError('落盘 outbox 失败：' + String((e && e.message) || e)) }
  }

  markSent(key) {
    this.sent.add(key)
    try {
      fs.mkdirSync(path.dirname(this.sentPath), { recursive: true })
      fs.appendFileSync(this.sentPath, JSON.stringify({ key, at: new Date().toISOString() }) + '\n', 'utf-8')
      this.compactSent()
    } catch (e) {
      this.onError('记录已发键失败：' + String((e && e.message) || e))
    }
  }

  compactSent() {
    try {
      const rows = readJsonl(this.sentPath)
      if (rows.length <= SENT_KEEP * 2) return
      writeJsonlAtomic(this.sentPath, rows.slice(-SENT_KEEP))
    } catch { /* 压缩失败不影响主流程 */ }
  }

  /**
   * 发队列。传输失败保留队列（下次再试）；工具层拒绝则丢弃（重试也不会好）。
   * 返回的 Promise 在**这一轮发送结束**时 resolve —— 已在发送中就复用它，
   * 否则调用方 `await flush()` 会在中途返回，测试与关闭流程都会读到半截状态。
   */
  flush() {
    if (this.flushing) return this.flushPromise || Promise.resolve()
    if (!this.queue.length || !this.pipePath) return Promise.resolve()
    this.flushing = true
    this.flushPromise = this.drain()
      .finally(() => {
        this.flushing = false
        this.flushPromise = null
        this.persist()
      })
    return this.flushPromise
  }

  async drain() {
    let client = null
    try {
      client = new McpPipeClient({ pipePath: this.pipePath, version: this.clientVersion })
      let sent = 0
      while (this.queue.length > 0 && sent < this.maxBatch) {
        const entry = this.queue[0]
        if (this.sent.has(entry.key)) { this.queue.shift(); continue }
        const result = await client.callTool('usage_report', entry.payload)
        const json = toolResultToJson(result)
        if (!json || json.ok !== true) {
          this.onError('方寸拒绝了这条用量：' + JSON.stringify(json).slice(0, 200))
          this.queue.shift() // 毒记录：不留在队列里挡住后面的
          continue
        }
        this.markSent(entry.key)
        this.queue.shift()
        sent++
      }
    } catch (e) {
      // 传输层失败（方寸没开 / 管道断 / 超时）：原样保留，等下一次
      this.lastError = String((e && e.message) || e)
    } finally {
      try { if (client) client.close() } catch { /* ignore */ }
    }
  }

  dispose() {
    this.persist()
  }
}
