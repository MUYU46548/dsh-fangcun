/**
 * v3 作用域自动绑定（2026-11-25 · P16.3 接线第二步）
 *
 * 抄 `harm-m422/dsh-memory` 的「工具参数自动绑 `file:`」：模型读/写/改某个文件时，
 * 这次检索就该优先带出**那个文件**上次做到哪 —— 不让模型自己记得传作用域。
 *
 * 数据只从 `session/event` 的 `tool/call` 里取**路径**（`file_path` / `path`），
 * 不取正文、不落盘、不跨会话：`SessionScopes` 按会话 id 分桶，`session/disposed` 时清掉。
 *
 * 边界（故意不做）：
 *  · 不认 `pwsh` 命令里的路径（解析 shell 引号只会制造假路径）；
 *  · 不认 `glob/grep` 的目录（那是范围，不是某个文件上次做到哪）；
 *  · 路径不解析相对/绝对（模型传什么记什么）—— 解析错比不解析更坏。
 */

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multi_edit', 'notebook_edit'])
const FILE_KEYS = ['file_path', 'filePath']
/** 每个会话最多记多少条文件作用域（防长会话无限涨） */
const MAX_PER_SESSION = 24

export function sessionIdOf(session) {
  if (typeof session === 'string') return session.trim()
  if (session && typeof session.id === 'string') return session.id.trim()
  return ''
}

function normalizePath(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\\/g, '/')
  if (!s || s.length > 500) return ''
  if (/[\r\n\u0000]/.test(s)) return ''
  return s
}

/**
 * 每会话的 `file:` 作用域桶。`observe()` 返回本次新增的 scope（便于测试/日志），
 * 重复观察同一文件只保留一条，超过上限丢最旧的。
 */
export class SessionScopes {
  constructor(opts = {}) {
    this.max = Number(opts.max) > 0 ? Number(opts.max) : MAX_PER_SESSION
    /** @type {Map<string, string[]>} sessionId -> scope（旧→新） */
    this.buckets = new Map()
  }

  observe(session, event) {
    try {
      if (!event || typeof event !== 'object' || event.type !== 'tool/call') return []
      const data = event.data || {}
      const tool = String(data.name || '')
      if (!FILE_TOOLS.has(tool)) return []
      const sessionId = sessionIdOf(session)
      if (!sessionId) return []
      let args = data.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { return [] }
      }
      if (!args || typeof args !== 'object') return []
      const added = []
      for (const key of FILE_KEYS) {
        const p = normalizePath(args[key])
        if (!p) continue
        const scope = 'file:' + p
        if (this.add(sessionId, scope)) added.push(scope)
      }
      return added
    } catch {
      return [] // 追踪坏了不能连累记账/挂件
    }
  }

  add(sessionId, scope) {
    const id = String(sessionId || '').trim()
    const s = String(scope || '').trim()
    if (!id || !s) return false
    const list = this.buckets.get(id) || []
    if (list.includes(s)) return false
    list.push(s)
    while (list.length > this.max) list.shift()
    this.buckets.set(id, list)
    return true
  }

  /** 该会话当前的活跃作用域（旧→新；调用方决定要不要全用） */
  list(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return []
    return (this.buckets.get(id) || []).slice()
  }

  forget(sessionId) {
    const id = String(sessionId || '').trim()
    if (id) this.buckets.delete(id)
  }

  size() {
    return this.buckets.size
  }
}
