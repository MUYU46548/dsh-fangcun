/**
 * dsh-fangcun —— 方寸（tegula）× DSH 插件（宿主侧）
 *
 * ⚠ 现状（v0.1.0）：**只做了"能装、能自报状态"**。
 *   `/fangcun/health.json` 报的是**能自证的事实**（数据根从哪读到、三个目录在不在、
 *   方寸 MCP 管道路径、与方寸的契约版本），外加一栏 `todo` 明写还没做什么 ——
 *   不给用户"功能都齐了"的错觉。
 *
 * 三条边界（越界即错）：
 *  ① **不许 import 方寸的代码**，也不许 import electron。插件与方寸之间只走对外接口：
 *     命名管道 MCP（Windows `\\.\pipe\tegula-mcp`）、`tegula` CLI、数据目录里的文件。
 *     这条是"两个仓互不锁死"的前提，测试里钉着，加一行 import 就红。
 *  ② **只读方寸数据**。要写方寸必须走 MCP 工具（方寸侧会把关），不直接改 task-data。
 *  ③ **不改 DSH 自己的配置**。只声明自己的路由，不 patch 别人的 bundle。
 *
 * 已核实的宿主形态（2026-11-03 从真插件源码读出，别再猜）：
 *  · 导出 `export default { name, apply(root) }`；
 *  · `root.inject(['webServer'], (ctx) => …)` 局部等待某个服务；
 *  · 注册路由是 `ctx.webServer.register({ kind: 'exact', path, handler })`
 *    —— **没有 `method` 字段**，方法在 handler 里自己判；
 *  · `root.on('webserver/index-inject', (table) => …)` 往页面表里推行，
 *    但那张表是**宿主启动时收集一次**的，晚注册就永远进不去 ⇒ 将来做挂件时，
 *    推行必须放在 apply() 最前面，不能藏在 inject 回调里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UsageLedger, pendingCount } from './usage.js'
import { McpPipeClient, toolResultToJson } from './mcp-pipe.js'
import { BOOTSTRAP_JS, WIDGET_JS, WIDGET_ROUTE } from './widget.js'

/** 与 package.json 的 version 必须一致（测试会比，防两处漂移） */
export const PLUGIN_NAME = 'dsh-fangcun'
export const PLUGIN_VERSION = '0.2.0'

/**
 * 与方寸之间的契约版本。方寸侧改了 `usage_report` / `list_tasks` 的字段就 +1，
 * 插件按这个版本决定"能不能报"和"怎么报"——而不是靠猜。
 */
export const CONTRACT_VERSION = 1

/** 方寸 MCP 的命名管道名（与方寸 `main/mcp/pipe.ts` 同一口径） */
const MCP_PIPE_BASENAME = 'tegula-mcp'

/**
 * 找方寸数据根。三处来源，按可靠度排：
 *  ① 环境变量 `FANGCUN_DATA_DIR`（多机/便携部署时唯一可靠的方式）
 *  ② `%APPDATA%/方寸/data-dir.json`（方寸桌面版自己记的，产品名是中文）
 *  ③ `%APPDATA%/Fangcun/data-dir.json`（旧名字，留着兼容）
 * ⚠ 认不出来就返回 null —— **不猜一个路径**。猜错会让插件对着空目录报"一切正常"。
 */
export function resolveDataDir(env = process.env) {
  const fromEnv = String(env.FANGCUN_DATA_DIR || '').trim()
  if (fromEnv) return { dir: fromEnv, source: 'env' }

  const appData = String(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  for (const appName of ['方寸', 'Fangcun', 'fangcun-desktop']) {
    const p = path.join(appData, appName, 'data-dir.json')
    try {
      if (!fs.existsSync(p)) continue
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const dir = String(raw?.dir || '').trim()
      if (dir) return { dir, source: 'appdata:' + appName }
    } catch { /* 坏文件当没有，继续找下一处 */ }
  }
  return { dir: null, source: 'none' }
}

/** MCP 管道路径：Windows 是命名管道，其它平台是临时目录下的 socket */
export function mcpPipePath(platform = process.platform, tmpdir = os.tmpdir()) {
  return platform === 'win32'
    ? `\\\\.\\pipe\\${MCP_PIPE_BASENAME}`
    : path.join(tmpdir, MCP_PIPE_BASENAME + '.sock')
}

/** 只看"文件在不在"，不解析内容 —— 判数字要留给方寸自己（插件不重复实现解析） */
export function collectHealth(env = process.env) {
  const { dir, source } = resolveDataDir(env)
  const has = (rel) => {
    if (!dir) return false
    try { return fs.existsSync(path.join(dir, rel)) } catch { return false }
  }

  return {
    ok: true,
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    // 契约版本单独摆出来：方寸升级后如果对不上，一眼能看见，而不是"静默少报"
    contract: { version: CONTRACT_VERSION, usageTool: 'usage_report', tasksTool: 'list_tasks' },
    fangcun: {
      dataDir: dir || '',
      // 这个来源字段很重要：远程/多机排查时，"从哪读到的"比"读到了什么"更关键
      source,
      found: {
        registry: has('registry.yaml'),
        taskData: has('task-data'),
        policies: has('policies'),
      },
      mcpPipe: mcpPipePath(),
    },
    // 用量上报的现状：outbox 里还有几条没发出去（方寸没开时会攒着，不丢）
    usage: { outboxPending: pendingCount(env) },
    // 诚实清单：还没在真机上验过的部分（不假装"全绿"）
    todo: [
      '桌面端真机验证：session/event 是否真收到、index-inject 行是否真进页面',
    ],
  }
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2)
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function healthHandler(req, res) {
  try {
    if (String(req?.method || 'GET').toUpperCase() !== 'GET') {
      res.setHeader?.('Allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    sendJson(res, 200, collectHealth())
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

/** 管道路径：允许环境变量覆盖（多实例 / 测试 / 非默认部署） */
export function resolvePipePath(env = process.env) {
  const fromEnv = String(env.FANGCUN_MCP_PIPE || '').trim()
  return fromEnv || mcpPipePath()
}

/** 方寸的终态：完成 / 驳回。空状态**算未完成**（没填 ≠ 做完） */
const CLOSED_STATUSES = new Set(['完成', '驳回'])
const TASK_CACHE_MS = 10_000
let taskCache = { at: 0, body: null }

function isLoopback(address) {
  const a = String(address || '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function widgetHandler(req, res) {
  try {
    if (String(req?.method || 'GET').toUpperCase() !== 'GET') {
      res.setHeader?.('Allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(WIDGET_JS)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

/**
 * 只读待办：经方寸 MCP `list_tasks` 拿数据 —— **不读 task-data 文件**。
 * 这样方寸改数据格式不会变成插件的发版理由。
 */
async function tasksHandler(req, res) {
  try {
    if (String(req?.method || 'GET').toUpperCase() !== 'GET') {
      res.setHeader?.('Allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    // 只给本机：看板是私人数据，别让局域网里任何页面都能读
    if (!isLoopback(req?.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: '只能从本机访问' })
      return
    }
    const now = Date.now()
    if (taskCache.body && now - taskCache.at < TASK_CACHE_MS) {
      sendJson(res, 200, taskCache.body)
      return
    }

    let client = null
    try {
      client = new McpPipeClient({ pipePath: resolvePipePath(), version: PLUGIN_VERSION })
      const result = await client.callTool('list_tasks', { view: 'active' })
      const tasks = toolResultToJson(result)
      if (!Array.isArray(tasks)) throw new Error('list_tasks 返回的不是数组')
      const open = tasks.filter((t) => !CLOSED_STATUSES.has(String((t && t.status) || '')))
      const body = {
        ok: true,
        total: open.length,
        items: open.slice(0, 20).map((t) => ({
          id: String((t && t.id) || ''),
          title: String((t && t.title) || ''),
          status: String((t && t.status) || ''),
          project: Array.isArray(t && t.project) ? t.project.join(' / ') : String((t && t.project) || ''),
        })),
        at: new Date().toISOString(),
      }
      taskCache = { at: now, body }
      sendJson(res, 200, body)
    } catch (e) {
      taskCache = { at: 0, body: null }
      sendJson(res, 503, { ok: false, error: '方寸未连接：' + String((e && e.message) || e) })
    } finally {
      try { if (client) client.close() } catch { /* ignore */ }
    }
  } catch (e) {
    try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch { /* 已结束 */ }
  }
}

/**
 * 路由清单单独提出来，既方便宿主注册，也方便测试直接调 handler 验返回。
 *
 * ⚠ 字段是 `{ kind: 'exact', path, handler }` —— 2026-11-03 从 dsh-keep-awake 与
 *   dsh-whale-widget 的实文件里核出来的形状。早先写的 `{ method, path, handler }`
 *   是错的：宿主认 `kind` + `path`，方法由 handler 自己判。
 */
export const ROUTES = [
  { kind: 'exact', path: '/fangcun/health.json', handler: healthHandler },
  { kind: 'exact', path: WIDGET_ROUTE, handler: widgetHandler },
  { kind: 'exact', path: '/fangcun/api/tasks', handler: tasksHandler },
]

export default {
  name: PLUGIN_NAME,
  apply(root) {
    // ① 注入行必须**最先**注册：宿主在启动时把这张表收集一次（见 HANDOFF 事实 7），
    //    晚一步就永远进不去，桌面端挂件会"装了但看不见"。
    const injectRow = (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_ROUTE) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: BOOTSTRAP_JS })
      } catch { /* 宿主表结构变了：静默，不影响插件其它部分 */ }
    }
    if (typeof root.on === 'function') {
      const subscribe = () => {
        let off = null
        try { off = root.on('webserver/index-inject', injectRow) } catch { /* 老宿主没有这个事件 */ }
        return () => { try { if (typeof off === 'function') off() } catch { /* ignore */ } }
      }
      if (typeof root.effect === 'function') {
        root.effect(subscribe, PLUGIN_NAME + ': index-inject')
      } else {
        subscribe()
      }
    }

    // ② 用量上报：订阅会话事件。**不依赖任何服务**，所以放在 inject 之前。
    if (typeof root.effect === 'function' && typeof root.on === 'function') {
      root.effect(() => {
        const ledger = new UsageLedger({
          pipePath: resolvePipePath(),
          clientVersion: PLUGIN_VERSION,
          onError: (msg) => {
            try { root.logger?.warn?.('[dsh-fangcun] ' + msg) } catch { /* logger 可选 */ }
          },
        })
        const offs = []
        const subscribe = (name, fn) => {
          try {
            const off = root.on(name, fn)
            if (typeof off === 'function') offs.push(off)
          } catch { /* 老宿主没有这个事件：降级，不炸插件 */ }
        }
        subscribe('session/event', (sessionId, event) => ledger.onSessionEvent(sessionId, event))
        subscribe('session/disposed', (session) => {
          const id = typeof session === 'string' ? session : (session && (session.id || session.sessionId))
          if (id) ledger.onSessionDisposed(String(id))
        })
        // 方寸没开时队列会攒着；定时重试，别等下一轮对话才想起
        const timer = setInterval(() => { void ledger.flush() }, 60_000)
        if (typeof timer.unref === 'function') timer.unref()
        void ledger.flush()
        return () => {
          clearInterval(timer)
          for (const off of offs) { try { off() } catch { /* ignore */ } }
          ledger.dispose()
        }
      }, PLUGIN_NAME + ': usage')
    }

    // ② 只读路由
    root.inject(['webServer'], (ctx) => {
      const registerAll = () => {
        const disposers = []
        for (const r of ROUTES) {
          const d = ctx.webServer.register(r)
          if (typeof d === 'function') disposers.push(d)
        }
        return () => {
          for (const d of disposers) {
            try { d() } catch { /* 已注销 */ }
          }
        }
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(registerAll, PLUGIN_NAME + ': routes')
      } else {
        registerAll()
      }
    })
  },
}
