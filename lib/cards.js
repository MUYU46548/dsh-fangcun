/**
 * 卡号追踪：从 `session/event` 的 `tool/call` 里**只取 `arguments.id`**。
 *
 * 为什么需要它（2026-11-05 用户："让 DSH 真正和方寸联动起来，而不是摆设"）：
 *  ① 用量账本现在只到 `session#turn`，不知道"这一轮在动哪张卡" —— 带上卡号，
 *     方寸那边才能**按卡归因 token**（"这张卡烧了多少"）；
 *  ② 挂件只能显示"总共 130 张"，而用户此刻真正关心的是"我手上这张" ——
 *     最近动过的卡号就够，标题由 `list_tasks` 的结果自己匹配，不多打一次管道。
 *
 * 隐私边界（与 `proof.js` 同一条）：**只白名单取 `id` 一个字段**，
 * `arguments` 里其余内容（标题、正文、检索词、正文片段……）一个字符都不读、不存、不落盘。
 * 白名单按"参数里确实有卡 id"的工具列，**不按名字前缀一起收** ——
 * `get_log/update_log` 的 `id` 是执行日志号，混进来就是一个假卡号。
 */

import { sessionIdOf } from './usage.js'
import { CARD_WRITE_TOOLS, fangcunShortName } from './proof.js'

/** 参数里带**卡号**的方寸工具（短名，去掉 `mcp__fangcun__` 前缀） */
export const CARD_ID_TOOLS = new Set([
  'get_task',
  'update_task',
  'move_status',
  'delete_task',
  'plan_get',
])

export { CARD_WRITE_TOOLS }

/** 从一次 `tool/call` 里取卡号。取不到、或工具不在白名单 → 空串（绝不猜） */
export function cardIdFromCall(toolName, args) {
  const short = fangcunShortName(toolName)
  if (!short || !CARD_ID_TOOLS.has(short)) return ''
  let a = args
  if (typeof a === 'string') {
    try { a = JSON.parse(a) } catch { return '' }
  }
  if (!a || typeof a !== 'object') return ''
  const raw = a.id
  if (typeof raw !== 'string') return ''
  const id = raw.trim()
  // 卡号是文件名级别的短标识；超长/带换行的东西不像是 id，宁可不要
  if (!id || id.length > 120 || /[\r\n]/.test(id)) return ''
  return id
}

function sessionKey(sessionId, turn) {
  return String(sessionId || '') + '#' + String(Number(turn) || 0)
}

/**
 * 内存里的"这一轮动过哪些卡"。
 *
 * 只活在进程里：卡号是**给当前这一轮用的**，重启后旧轮次不会再来结算；
 * 挂件关心的也只是"刚才在办哪张"。所以不落盘 —— 少一个需要清理的文件。
 */
export class CardTracker {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs] 挂件只认这么久以内动过的卡（默认 30 分钟）
   * @param {number} [options.maxTurns] 最多保留多少轮的卡号（默认 200）
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 30 * 60 * 1000
    this.maxTurns = Number(options.maxTurns) > 0 ? Number(options.maxTurns) : 200
    /** key -> { session, turn, ids: string[], at: number }（Map 的插入顺序就是轮次先后） */
    this.turns = new Map()
    /** 最近一次"动过卡"的现场，挂件读它 */
    this.last = null
  }

  /**
   * 喂一个 `session/event`。只认 `tool/call`，只取卡号。
   * @returns {{id: string, tool: string, turn: number, session: string} | null}
   */
  observe(session, event) {
    try {
      if (!event || typeof event !== 'object' || event.type !== 'tool/call') return null
      const data = event.data || {}
      const tool = String(data.name || '')
      const id = cardIdFromCall(tool, data.arguments)
      if (!id) return null
      const sessionId = sessionIdOf(session)
      if (!sessionId) return null
      const turn = Number(data.turn) || 0
      const key = sessionKey(sessionId, turn)
      let bucket = this.turns.get(key)
      if (!bucket) {
        bucket = { session: sessionId, turn, ids: [], at: this.now() }
        this.turns.set(key, bucket)
      }
      if (bucket.ids.indexOf(id) < 0) bucket.ids.push(id)
      bucket.at = this.now()
      this.last = { id, tool, turn, session: sessionId, at: bucket.at }
      this.prune()
      return this.last
    } catch {
      return null // 追踪坏了不能连累记账
    }
  }

  /** 这一轮动过哪些卡（按出现顺序，去重）。用量 note 用第一条 */
  idsFor(sessionId, turn) {
    const bucket = this.turns.get(sessionKey(sessionId, turn))
    return bucket ? bucket.ids.slice() : []
  }

  /** 挂件用：最近一次动过的卡。超过 TTL 就当没有（别让上午的卡冒充"本次在办"） */
  focus() {
    const last = this.last
    if (!last) return null
    if (this.now() - last.at > this.ttlMs) return null
    return { id: last.id, at: last.at, tool: last.tool, turn: last.turn }
  }

  /** 会话销毁：把它的轮次一起丢掉，别让已结束会话的卡冒充"本次在办" */
  forgetSession(session) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return 0
    let n = 0
    for (const [key, bucket] of Array.from(this.turns.entries())) {
      if (bucket.session !== sessionId) continue
      this.turns.delete(key)
      n += 1
    }
    if (this.last && this.last.session === sessionId) this.last = null
    return n
  }

  /** 只保留最近 maxTurns 轮：Map 按插入顺序，超了从最旧的删 */
  prune() {
    while (this.turns.size > this.maxTurns) {
      const oldest = this.turns.keys().next()
      if (oldest.done) break
      this.turns.delete(oldest.value)
    }
  }

  /** health 用：只报条数与最后一张的 id，不摊全部历史 */
  state() {
    const focus = this.focus()
    return {
      turns: this.turns.size,
      lastCardId: focus ? focus.id : '',
      lastAt: focus ? new Date(focus.at).toISOString() : '',
    }
  }
}
