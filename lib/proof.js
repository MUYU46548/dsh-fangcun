/**
 * 自证 sidecar：把 agent **真的调了方寸工具**、以及**这一轮怎么用的**记成本地日志。
 *
 * 为什么需要它：契约 ②⑦–⑩（开工触发 / 收工回写 / 新问题建卡 / 不过度触发）
 * 的判据都是"记录里出现过某个 tool/call"，而这不是靠模型自述、也不是靠人看界面 ——
 * 只能从 `session/event` 的 `tool/call` 里抠。插件自己记一份，AI 事后能对账。
 *
 * 两本账：
 *  · `tools.jsonl`：每次方寸工具调用一行（什么时候、哪个会话、第几轮、哪个工具）；
 *  · `turns.jsonl`：每轮收尾一行，记**顺序**（第一次工具是不是方寸读、改文件与回写的先后），
 *    这样 ②7「开工先查」、②8「收工回写」不再靠人翻日志，`health.proof.turns` 直接出数。
 *
 * 记录什么、不记录什么：
 *  · 只记「什么时候、哪个会话、第几轮、哪个工具（名字）」与**序号**；
 *  · **不记参数**（参数里可能有用户私事）。卡号另走 `cards.js` 的白名单，只取 `id`；
 *  · 追加写，超过上限丢最旧的（与 outbox 同思路：别让一个日志慢慢吃满磁盘）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, sessionIdOf } from './usage.js'

/** 方寸 MCP 工具在会话里的名字前缀（工具列表实测：`mcp__fangcun__list_tasks`） */
export const FANGCUN_TOOL_PREFIX = 'mcp__fangcun__'

/** 上限：真按每天几百次调用算，500 行够回溯好几天了 */
export const MAX_PROOF_ROWS = 500

/** 每轮记录的条数不会比调用数少太多，同一上限即可 */
export const MAX_TURN_ROWS = 500

/** 内存里最多同时跟踪多少轮（超过就丢最旧的，免得长会话把内存拖住） */
const MAX_OPEN_TURNS = 200

/**
 * 「明确改文件」的工具名。这是一个**启发式**：拿不准的一律不认（宁可算成"没改"，
 * 也不要虚报"开工先查"）。`pwsh` 归到"可能改文件"（`SHELL_TOOLS`）单独计数 ——
 * 它能写文件，但光看名字分不出"跑了个 ls"还是"写了个文件"。
 */
export const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'multiedit', 'notebook_edit'])

/** 「可能改文件」的 shell 类工具：只计数，不拿来判"该回写" */
export const SHELL_TOOLS = new Set(['pwsh', 'bash', 'sh', 'shell', 'exec', 'run_command'])

export function proofPaths(home) {
  const dir = path.join(home, 'dsh-fangcun')
  return { dir, tools: path.join(dir, 'tools.jsonl'), turns: path.join(dir, 'turns.jsonl') }
}

export function isFangcunTool(name) {
  return String(name || '').startsWith(FANGCUN_TOOL_PREFIX)
}

/** `mcp__fangcun__update_task` → `update_task`（只去前缀，不改大小写） */
export function fangcunShortName(name) {
  const s = String(name || '')
  return isFangcunTool(s) ? s.slice(FANGCUN_TOOL_PREFIX.length) : ''
}

/** 回写方寸的工具（短名）。②8 要的是 `move_status` / `update_task`，建卡与收卡也算 */
export const CARD_WRITE_TOOLS = new Set(['create_task', 'update_task', 'move_status', 'intake_task'])

function readJsonl(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf-8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
  }
  return out
}

function countLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    return raw.split('\n').filter((l) => l.trim()).length
  } catch { return 0 }
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf-8')
}

function trimJsonl(file, keep) {
  const rows = readJsonl(file)
  if (rows.length <= keep) return rows.length
  const tmp = file + '.tmp'
  const kept = rows.slice(-keep)
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf-8')
  fs.renameSync(tmp, file)
  return kept.length
}

/**
 * 一行轮次记录 → 判定。抽成函数是为了"读回来的历史"与"刚收尾的这一轮"走同一套口径，
 * 不会出现"重启前后数字各算各的"。
 */
export function verdictOf(row) {
  const editAt = Number(row && row.editAt) || 0
  const shellAt = Number(row && row.shellAt) || 0
  const readAt = Number(row && row.readAt) || 0
  const writeAt = Number(row && row.writeAt) || 0
  const tools = Number(row && row.tools) || 0
  return {
    withEdit: editAt > 0, // 这一轮改过文件 = 干了活
    readBeforeEdit: editAt > 0 && readAt > 0 && readAt < editAt, // ②7：先查方寸再动手
    wroteBack: writeAt > 0, // ②8：动过方寸的写工具
    readOnly: tools > 0 && !editAt && !shellAt && !writeAt && readAt > 0, // 只查了方寸，别的什么也没干
    withShell: shellAt > 0, // 可能改过文件（分不出，只能当提示）
  }
}

/** 把若干轮的判定汇总。逐轮求和，不做比率 —— 比率让调用方自己算，免得分子分母对不上 */
export function summarize(rows) {
  const out = { turns: 0, withEdit: 0, readBeforeEdit: 0, wroteBack: 0, readOnly: 0, withShell: 0 }
  for (const row of Array.isArray(rows) ? rows : []) {
    const v = verdictOf(row)
    out.turns += 1
    if (v.withEdit) out.withEdit += 1
    if (v.readBeforeEdit) out.readBeforeEdit += 1
    if (v.wroteBack) out.wroteBack += 1
    if (v.readOnly) out.readOnly += 1
    if (v.withShell) out.withShell += 1
  }
  return out
}

export class ToolProof {
  constructor(options = {}) {
    const paths = proofPaths(options.home || dshHome())
    this.file = paths.tools
    this.turnsFile = paths.turns
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.rows = countLines(this.file)
    this.lastAt = ''
    /** key（`session#turn`）-> 这一轮的调用现场 */
    this.open = new Map()
    /** 历史汇总（从 turns.jsonl 读回来，启动即有数） */
    this.history = summarize(readJsonl(this.turnsFile))
  }

  /**
   * 喂一个 `session/event`。
   *  · `tool/call`：记顺序；方寸工具额外写 `tools.jsonl`（返回那一行，方便测试与排查）；
   *  · `turn/end`：收尾这一轮，写 `turns.jsonl` 一行（返回那一行）。
   */
  record(session, event) {
    try {
      if (!event || typeof event !== 'object') return null
      if (event.type === 'turn/end') return this.finalizeTurn(session, Number((event.data || {}).turn))
      if (event.type !== 'tool/call') return null

      const sessionId = sessionIdOf(session)
      if (!sessionId) return null // 宁可少记一条，也不写一个假 id
      const data = event.data || {}
      const tool = String(data.name || '')
      if (!tool) return null
      const turn = Number(data.turn) || 0
      const key = sessionId + '#' + turn
      let bucket = this.open.get(key)
      if (!bucket) {
        bucket = { session: sessionId, turn, tools: 0, first: tool, at: this.now(), readAt: 0, editAt: 0, shellAt: 0, writeAt: 0 }
        this.open.set(key, bucket)
        while (this.open.size > MAX_OPEN_TURNS) {
          const oldest = this.open.keys().next()
          if (oldest.done) break
          this.open.delete(oldest.value)
        }
      }
      bucket.tools += 1
      const pos = bucket.tools
      if (isFangcunTool(tool)) {
        const short = fangcunShortName(tool)
        if (CARD_WRITE_TOOLS.has(short)) {
          if (!bucket.writeAt) bucket.writeAt = pos
        } else if (!bucket.readAt) {
          bucket.readAt = pos
        }
      } else if (EDIT_TOOLS.has(tool.toLowerCase())) {
        if (!bucket.editAt) bucket.editAt = pos
      } else if (SHELL_TOOLS.has(tool.toLowerCase())) {
        if (!bucket.shellAt) bucket.shellAt = pos
      }

      // 方寸工具调用单独留一行（原有行为：契约 ②⑦–⑩ 的原始判据）
      if (!isFangcunTool(tool)) return null
      const row = { at: new Date(this.now()).toISOString(), session: sessionId, turn, tool }
      appendJsonl(this.file, row)
      this.rows += 1
      this.lastAt = row.at
      if (this.rows > MAX_PROOF_ROWS) this.rows = trimJsonl(this.file, MAX_PROOF_ROWS)
      return row
    } catch (e) {
      this.onError('写自证日志失败：' + String((e && e.message) || e))
      return null
    }
  }

  /**
   * 收尾一轮：算判定、落 `turns.jsonl`、并进汇总。
   * 为什么按轮落盘而不是只留内存：真机验收要能回答"过去这几天是不是一直在联动"，
   * 重启就清空的数字证明不了任何事。
   *
   * ⚠ `turn/end` **不一定带 `data.turn`**（账本那边也是靠 `agg.turn` 反查的）。
   * 带就按轮次精确收；不带就收这个会话**最新**那一轮 —— 两害相权，收错一轮也好过
   * 让 open 越攒越多、数字永远不动（`health.proof.open` 会一直涨，那更难看懂）。
   */
  finalizeTurn(session, turn) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return null
    const t = Number(turn)
    if (Number.isFinite(t) && t > 0) {
      const key = sessionId + '#' + t
      const bucket = this.open.get(key)
      if (bucket) {
        this.open.delete(key)
        return this.writeTurn(bucket)
      }
    }
    let newestKey = ''
    let newestAt = -Infinity
    for (const [key, bucket] of this.open.entries()) {
      if (bucket.session !== sessionId) continue
      if (Number(bucket.at) >= newestAt) {
        newestAt = Number(bucket.at)
        newestKey = key
      }
    }
    if (!newestKey) return null
    const newest = this.open.get(newestKey)
    this.open.delete(newestKey)
    return this.writeTurn(newest)
  }

  /** 会话销毁时把它名下未收尾的轮次一起收掉（不然这些轮次永远算不进数字） */
  finalizeSession(session) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return 0
    let n = 0
    for (const [key, bucket] of Array.from(this.open.entries())) {
      if (bucket.session !== sessionId) continue
      this.open.delete(key)
      try { this.writeTurn(bucket); n += 1 } catch { /* 单轮失败不影响其它 */ }
    }
    return n
  }

  writeTurn(bucket) {
    const row = {
      at: new Date(this.now()).toISOString(),
      session: bucket.session,
      turn: bucket.turn,
      tools: bucket.tools,
      first: String(bucket.first || '').slice(0, 64),
      readAt: bucket.readAt,
      editAt: bucket.editAt,
      shellAt: bucket.shellAt,
      writeAt: bucket.writeAt,
    }
    appendJsonl(this.turnsFile, row)
    // 汇总按行重算（而不是自增）：读回来的历史与新增的这一行必须同一口径，
    // 否则重启一次数字就漂了。行数有上限，重算很便宜。
    this.history = summarize(readJsonl(this.turnsFile))
    if (countLines(this.turnsFile) > MAX_TURN_ROWS) trimJsonl(this.turnsFile, MAX_TURN_ROWS)
    this.lastAt = row.at
    return row
  }

  /** health 用：条数、最后一次时间，加上②⑦⑧⑩的机器判据 */
  state() {
    return {
      rows: this.rows,
      lastAt: this.lastAt,
      // 未收尾的轮次：正常应该接近 0（turn/end 会收），大就说明事件链有问题
      open: this.open.size,
      turns: { ...this.history },
    }
  }
}
