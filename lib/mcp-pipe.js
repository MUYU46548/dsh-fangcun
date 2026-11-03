/**
 * 方寸 MCP 的最小客户端：换行分隔的 JSON-RPC 2.0，走命名管道。
 *
 * 为什么不引 MCP SDK：插件是零依赖的（只用 node 内置模块），而这里只需要两个方法
 * （`initialize` 和 `tools/call`）—— 方寸侧的协议实现就在
 * `desktop/src/main/mcp/socket-server.ts` + `handler.ts` 里，逐行对得上。
 *
 * 三条纪律：
 *  ① **连不上不算异常**：方寸没开是常态，调用方拿到 `{ok:false}` 后把事件留在本地队列；
 *  ② **超时必须真的结束**：named pipe 在 Windows 上"连上了但对端不回"是会发生的，
 *     没有超时就会把插件挂成僵尸；
 *  ③ 任何失败都不许冒泡到 DSH 的主流程（调用方 catch，日志走 ctx.logger）。
 */
import net from 'node:net'

/** 方寸实现了这三个版本，回显客户端请求的那个；用最早对齐的基线最稳 */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

export class McpPipeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'McpPipeError'
  }
}

export class McpPipeClient {
  constructor(options = {}) {
    this.pipePath = String(options.pipePath || '')
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 3000
    this.clientInfo = {
      name: String(options.name || 'dsh-fangcun'),
      version: String(options.version || '0.0.0'),
    }
    this.socket = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.initialized = false
  }

  connect() {
    if (this.socket) return Promise.resolve()
    if (!this.pipePath) return Promise.reject(new McpPipeError('pipe path is empty'))
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.pipePath)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch { /* ignore */ }
        reject(new McpPipeError('连接超时：' + this.pipePath))
      }, this.timeoutMs)
      const onError = (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { socket.destroy() } catch { /* ignore */ }
        reject(new McpPipeError('连接失败：' + (e && e.message ? e.message : String(e))))
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener('error', onError)
        this.socket = socket
        this.attach(socket)
        resolve()
      })
    })
  }

  attach(socket) {
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      this.buffer += chunk
      let idx
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue /* 坏行当噪音，不炸连接 */ }
        if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          entry.resolve(msg)
        }
      }
    })
    // 对端断开是常态（用户关掉方寸），不是错误
    socket.on('error', () => { /* 交给 close 处理 */ })
    socket.on('close', () => {
      const err = new McpPipeError('管道已断开')
      for (const [, entry] of this.pending) entry.reject(err)
      this.pending.clear()
      this.socket = null
      this.initialized = false
    })
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.socket) { reject(new McpPipeError('尚未连接')); return }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpPipeError('请求超时：' + method))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new McpPipeError('写入失败：' + (e && e.message ? e.message : String(e))))
      }
    })
  }

  notify(method, params) {
    try {
      if (!this.socket) return
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch { /* 通知失败无所谓 */ }
  }

  async initialize() {
    if (this.initialized) return
    const res = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    })
    if (res.error) throw new McpPipeError('initialize 失败：' + (res.error.message || '未知错误'))
    // 方寸对 notifications/* 一律静默；这里只是守规范，不要等回包
    this.notify('notifications/initialized', {})
    this.initialized = true
  }

  /**
   * 调一个方寸工具。返回 `result`（MCP 的 `{ content: [...] }` 形状）。
   * 传输层失败会抛；工具层失败（isError）**不抛**，由调用方按 `content` 判。
   */
  async callTool(name, args = {}) {
    await this.connect()
    await this.initialize()
    const res = await this.request('tools/call', { name, arguments: args })
    if (res.error) throw new McpPipeError('tools/call 失败：' + (res.error.message || '未知错误'))
    return res.result
  }

  close() {
    try {
      if (this.socket) this.socket.destroy()
    } catch { /* ignore */ }
    this.socket = null
    this.initialized = false
  }
}

/** 把 MCP 的 `{content:[{type:'text',text}]}` 解成 JSON；解析不了就原样给文本 */
export function toolResultToJson(result) {
  const text = result && Array.isArray(result.content)
    ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
    : ''
  if (!text) return { ok: false, error: 'empty tool result' }
  try { return JSON.parse(text) } catch { return { ok: false, error: text.slice(0, 200) } }
}
