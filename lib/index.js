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
import { BOOTSTRAP_JS, REPORT_ROUTE, WIDGET_JS, WIDGET_ROUTE } from './widget.js'
import { BoardStatus } from './status.js'
import { ToolProof } from './proof.js'
import { CardTracker } from './cards.js'
import { registerPrompt } from './prompt.js'
import { DOWNLOAD_URL, detectInstall } from './detect.js'

/** 与 package.json 的 version 必须一致（测试会比，防两处漂移） */
export const PLUGIN_NAME = 'dsh-fangcun'
export const PLUGIN_VERSION = '0.3.0'

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

/**
 * 方寸本体装没装 + 数据根在哪，合成一份判断。
 *
 * 有数据根就一定"装过"（哪怕是 `FANGCUN_DATA_DIR` 指到仓库根）；
 * 没数据根才去查装机痕迹（快捷方式 / userData / 更新器 / 常见安装目录）。
 * 这份判断**不碰管道、不碰网络**，每个请求都能现算（十几次 `existsSync`）。
 */
export function collectInstall(env = process.env) {
  const data = resolveDataDir(env)
  const info = detectInstall(env)
  if (data.dir && !info.installed) {
    return { ...info, installed: true, evidence: 'data-dir:' + data.source }
  }
  return info
}

/** MCP 管道路径：Windows 是命名管道，其它平台是临时目录下的 socket */
export function mcpPipePath(platform = process.platform, tmpdir = os.tmpdir()) {
  return platform === 'win32'
    ? `\\\\.\\pipe\\${MCP_PIPE_BASENAME}`
    : path.join(tmpdir, MCP_PIPE_BASENAME + '.sock')
}

/**
 * 活着的账本（health 读它）。为什么放模块级：账本活在 `root.effect` 的闭包里，
 * health handler 拿不到闭包变量 —— 而"最近一次失败是什么"恰恰只能从账本里读。
 * 只读引用，不跨进程共享；插件没 apply 时是 null（health 退回读 outbox 文件）。
 */
let liveLedger = null

/**
 * 挂件是否真的进了页面的**证据链**（不靠人眼）：
 *  · `injected` / `pushed`：宿主有没有来收集那张表、我们推的行有没有进表；
 *  · `servedByPage`：页面**真的来取脚本**的次数。主判据是我们自己加在 src 上的
 *    `?from=page`（只有注入行会带）；`sec-fetch-*` / `referer` 只当辅助 ——
 *    桌面端 Electron 实测两者都不带，光看头会把"页面在跑"读成"没人来取"。
 * 行进了表但页面没执行时，`pushed>0 && servedByPage==0`，一眼能分开
 * "没进表"和"进了表但没跑"这两种故障（分诊表里最难分的那一格）。
 */
const widgetProbe = { injected: 0, pushed: 0, servedByPage: 0, lastServedAt: '' }

/**
 * 页面侧自证（`REPORT_ROUTE`）。`servedByPage` 只能证明"脚本被取走了"，
 * 证明不了"它跑起来、挂上 DOM、没被谁摘掉"。桌面端页面是 `dsh-app://app/`，
 * 由页面侧解释执行注入行 —— 中间任何一环静默失败，用户只看得到"挂件不见了"。
 * 这里留**最近 12 条**（boot / mount / probe / removed / error…），够定位，不涨成日志。
 */
const widgetPage = { count: 0, lastAt: '', events: [] }
const WIDGET_PAGE_EVENTS = 12

/**
 * 提示词与自证的活引用（health 读）。
 * 这两块都属于"装上了但没生效完全看不出来"的那一类：规则段根本没注册、
 * 一行现状永远是"未连接"、自证日志一行都没长 —— 只有机器能说清，所以摊进 health.json。
 */
let liveBoard = null
let liveProof = null
let liveCards = null

/** 规则段 / 一行现状到底注册上没。拿不到 `systemPrompt` 服务时是 false（老宿主），不假装成功 */
const promptState = { rules: false, status: false, error: '' }

/**
 * 逐轮判定的空汇总（插件没 apply 时 health 用它）。
 * 形状必须与 `lib/proof.js` 的 `summarize([])` 一致，否则"没数据"会被读成"全是 0 分"。
 */
const EMPTY_TURNS = { turns: 0, withEdit: 0, readBeforeEdit: 0, wroteBack: 0, readOnly: 0, withShell: 0 }

/** 只看"文件在不在"，不解析内容 —— 判数字要留给方寸自己（插件不重复实现解析） */
export function collectHealth(env = process.env) {
  const { dir, source } = resolveDataDir(env)
  const install = collectInstall(env)
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
      // 装机判定：没装 / 装了没跑 / 装了没连，提示的话术完全不同（见 lib/detect.js）
      installed: install.installed,
      installedEvidence: install.evidence,
      downloadUrl: install.installed ? '' : DOWNLOAD_URL,
      found: {
        registry: has('registry.yaml'),
        taskData: has('task-data'),
        policies: has('policies'),
      },
      mcpPipe: mcpPipePath(),
    },
    // 用量上报的现状：发没发出去、上次失败是什么 —— 失败要看得见，不能只写日志
    usage: liveLedger
      ? liveLedger.state()
      : { outboxPending: pendingCount(env), lastSentAt: '', lastError: '' },
    // 挂件注入的证据链（真机验收 ② 全靠这三格，不靠眼睛）
    widget: {
      ...widgetProbe,
      // 页面自己报上来的：脚本跑没跑、挂没挂上、量出来的位置、有没有被摘掉
      page: { count: widgetPage.count, lastAt: widgetPage.lastAt, events: widgetPage.events.slice() },
    },
    // 提示词：规则段 / 一行现状有没有真注册上，以及那行现在长什么样
    prompt: {
      rules: promptState.rules,
      status: promptState.status,
      error: promptState.error,
      line: liveBoard ? liveBoard.line() : '',
    },
    // 自证 sidecar：方寸工具被调用过几次（契约 ②⑦–⑩ 的判据从这儿读）
    // `turns` 是按轮统计的**顺序证据**：②7「先查后改」、②8「收工回写」不靠人翻日志
    proof: liveProof ? liveProof.state() : { rows: 0, lastAt: '', open: 0, turns: { ...EMPTY_TURNS } },
    // 卡号追踪（只取 `arguments.id`）：最近在办哪张卡 / 多少轮带卡号
    cards: liveCards ? liveCards.state() : { turns: 0, lastCardId: '', lastAt: '' },
    // 诚实清单：还没在真机上验过的部分（不假装"全绿"）
    todo: [
      '规则段 / 一行现状 / 自证：已在单测与打包冒烟里验过，**真机待重启后复验**（看 health.prompt 与 tools.jsonl）',
      'compaction/summary.usage 是否与 assistant/message 重复（事实 10g）—— 等一次真实压缩再定',
      '② 第 5 环（不丢）真机补测：停方寸跑一轮，看 outbox 涨、恢复后归零',
      'health.proof.turns 来自 turns.jsonl（每轮一行、上限 500），跨重启累计；'
      + '但只有**装了这一版之后**的轮次才算，所以刚升级时数字是 0',
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

/**
 * 按方寸**自己的** status 数一遍。
 *
 * 为什么这不是"另算口径"：status 是方寸写进卡里的标签，我们只是数标签，
 * 没有重新判断优先级、没有重新分组、没有做摘要（③#8 的底线）。
 * 只数两个对"现在要不要动手"有用的：在办（进行中）、等人拍板（待验收/待审批）。
 */
export function countStatuses(tasks) {
  const counts = { doing: 0, waiting: 0 }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const s = String((t && t.status) || '')
    if (s === '进行中') counts.doing += 1
    else if (s === '待验收' || s === '待审批') counts.waiting += 1
  }
  return counts
}

/**
 * 挂件的「本次在办」：最近一次从 `tool/call` 里取到的卡号（`lib/cards.js`），
 * 标题从这次 `list_tasks` 的结果里**顺手匹配**（不多打一次管道、不猜）。
 * 卡不在可见列表里（已关掉 / 被项目过滤掉）就只给卡号，不给假标题。
 */
export function focusOf(cards, tasks) {
  let f = null
  try { f = cards && typeof cards.focus === 'function' ? cards.focus() : null } catch { f = null }
  if (!f || !f.id) return null
  const hit = (Array.isArray(tasks) ? tasks : []).find((t) => String((t && t.id) || '') === f.id)
  return {
    id: f.id,
    at: new Date(f.at).toISOString(),
    title: hit ? String(hit.title || '') : '',
    status: hit ? String(hit.status || '') : '',
  }
}

function isLoopback(address) {
  const a = String(address || '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/**
 * 方寸看板的地址：读数据根下的 `.tegula-port`。
 * 为什么不写死 8753：那是文档里的旧值，真正在跑的是方寸自己记的端口。
 * 文件格式是方寸写的「端口 / PID / 时间戳」三行（`tegula/core.py` 的 `_write_port_file`）。
 *
 * **只给活着的端口**：2026-11-07 真机踩到过 —— 文件停在 10 月 22 日的 8791，
 * 写它的进程早没了，挂件却照样把「打开看板」指向一个打不开的地址。方寸自己读这个文件时
 * 会校验 PID + 探活；插件不能探活（不发网络请求的硬边界），但**能校验 PID**。
 * PID 不在就返回空串：挂件按"没有看板入口"处理，宁可不给链接，也不给假地址。
 *
 * 旧文件/别家实现可能只有端口一行：没有 PID 就没有判活证据，保留旧行为（给链接）。
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程还在，只是不允许我们发信号；ESRCH = 不在了
    return Boolean(e && e.code === 'EPERM')
  }
}

export function resolveBoardUrl(env = process.env) {
  const { dir } = resolveDataDir(env)
  if (!dir) return ''
  try {
    const raw = fs.readFileSync(path.join(dir, '.tegula-port'), 'utf-8')
    const lines = String(raw).split(/\r?\n/)
    const port = Number(lines[0].trim())
    if (!(Number.isFinite(port) && port > 0 && port < 65536)) return ''
    const pid = lines.length > 1 ? Number(String(lines[1]).trim()) : 0
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return ''
    return `http://127.0.0.1:${port}`
  } catch { /* 没这个文件 = 看板没起过，正常 */ }
  return ''
}

function widgetHandler(req, res) {
  try {
    if (String(req?.method || 'GET').toUpperCase() !== 'GET') {
      res.setHeader?.('Allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    // 页面来的请求才算"真在页面里跑过"。两条判据：
    //  ① 注入行自己加的 `?from=page`（**主判据**：只有我们推的那一行会带）；
    //  ② `sec-fetch-*` / `referer`（浏览器通常带，但**桌面端 Electron 实测都不带** ——
    //     2026-11-03 真机 servedByPage 恒为 0，而挂件其实一直在跑。别只靠它）。
    const headers = req?.headers || {}
    const url = String(req?.url || '')
    if (url.indexOf('from=page') >= 0 || headers['sec-fetch-dest'] || headers['sec-fetch-site'] || headers.referer) {
      widgetProbe.servedByPage += 1
      widgetProbe.lastServedAt = new Date().toISOString()
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
 * 页面自证上报（GET + 1px Image 信标）。只收本机、只留最近 12 条，
 * 回 204 空体：它是**证据入口**，不是功能，别让页面等它。
 */
function widgetReportHandler(req, res) {
  try {
    if (String(req?.method || 'GET').toUpperCase() !== 'GET') {
      res.setHeader?.('Allow', 'GET')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!isLoopback(req?.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: '只能从本机访问' })
      return
    }
    const raw = String(req?.url || '')
    const at = raw.indexOf('?')
    const qs = at >= 0 ? raw.slice(at + 1) : ''
    const params = new URLSearchParams(qs)
    const event = String(params.get('e') || '').slice(0, 40) || 'unknown'
    params.delete('t') // 时间戳有 at 字段，别把噪声塞进历史
    widgetPage.count += 1
    widgetPage.lastAt = new Date().toISOString()
    widgetPage.events.push({ at: widgetPage.lastAt, e: event, q: params.toString().slice(0, 220) })
    if (widgetPage.events.length > WIDGET_PAGE_EVENTS) {
      widgetPage.events.splice(0, widgetPage.events.length - WIDGET_PAGE_EVENTS)
    }
    res.statusCode = 204
    res.setHeader('Cache-Control', 'no-store')
    res.end()
  } catch (e) {
    try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch { /* 已结束 */ }
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
    // 装机判定要带回去：挂件据此决定显示「去下载」还是「方寸未连接」
    const install = collectInstall()

    let client = null
    try {
      client = new McpPipeClient({ pipePath: resolvePipePath(), version: PLUGIN_VERSION })
      // 与"一行现状"用**同一个**项目范围：不然设了 FANGCUN_PROJECT 之后，
      // 角标还在报全部项目、上下文里那行却只报一个项目，两边各说各的。
      const project = String(process.env.FANGCUN_PROJECT || '').trim()
      const args = { view: 'active' }
      if (project) args.project = project
      const result = await client.callTool('list_tasks', args)
      const tasks = toolResultToJson(result)
      if (!Array.isArray(tasks)) throw new Error('list_tasks 返回的不是数组')
      const open = tasks.filter((t) => !CLOSED_STATUSES.has(String((t && t.status) || '')))
      const body = {
        ok: true,
        total: open.length,
        // 数方寸自己的 status（不是我们自己的分组），见 countStatuses 注释
        counts: countStatuses(open),
        // 本次在办：最近一次工具调用动过的卡（只取过 id，不读参数正文）
        focus: focusOf(liveCards, open),
        // 角标/面板据此说明"这是哪个项目的数字"
        scope: project || '全部项目',
        items: open.slice(0, 20).map((t) => ({
          id: String((t && t.id) || ''),
          title: String((t && t.title) || ''),
          status: String((t && t.status) || ''),
          project: Array.isArray(t && t.project) ? t.project.join(' / ') : String((t && t.project) || ''),
        })),
        // 看板真实端口（读不到就是空串，挂件不会显示一个打不开的链接）
        boardUrl: resolveBoardUrl(),
        installed: install.installed,
        downloadUrl: install.installed ? '' : DOWNLOAD_URL,
        at: new Date().toISOString(),
      }
      taskCache = { at: now, body }
      sendJson(res, 200, body)
    } catch (e) {
      taskCache = { at: 0, body: null }
      sendJson(res, 503, {
        ok: false,
        error: '方寸未连接：' + String((e && e.message) || e),
        // 连不上也分两种：压根没装（给下载页）／装了没开（提示去启动）
        installed: install.installed,
        downloadUrl: install.installed ? '' : DOWNLOAD_URL,
      })
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
  { kind: 'exact', path: REPORT_ROUTE, handler: widgetReportHandler },
  { kind: 'exact', path: '/fangcun/api/tasks', handler: tasksHandler },
]

export default {
  name: PLUGIN_NAME,
  apply(root) {
    // ① 注入行必须**最先**注册：宿主在启动时把这张表收集一次（见 AGENTS.md 事实 7），
    //    晚一步就永远进不去，桌面端挂件会"装了但看不见"。
    const injectRow = (table) => {
      try {
        widgetProbe.injected += 1
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_ROUTE) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: BOOTSTRAP_JS })
        widgetProbe.pushed += 1
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

    // ② 用量上报 + 自证：订阅会话事件。**不依赖任何服务**，所以放在 inject 之前。
    const logWarn = (msg) => {
      try { root.logger?.warn?.('[dsh-fangcun] ' + msg) } catch { /* logger 可选 */ }
    }
    // 自证 sidecar：方寸工具被调用就落一行（契约 ②⑦–⑩ 的判据从这里读）
    const proof = new ToolProof({ onError: logWarn })
    liveProof = proof

    if (typeof root.effect === 'function' && typeof root.on === 'function') {
      root.effect(() => {
        // 卡号追踪：只从 `tool/call` 的 `arguments.id` 里白名单取卡号（见 lib/cards.js）。
        // 两个用途：账本的 note 带上它（方寸可按卡归因 token）、挂件显示"本次在办"。
        const cards = new CardTracker({})
        liveCards = cards
        const ledger = new UsageLedger({
          pipePath: resolvePipePath(),
          clientVersion: PLUGIN_VERSION,
          onError: logWarn,
          // 一轮只带一张卡：note 上限 120 字，塞不下就不塞（见 lib/usage.js 的 noteFor）
          cardsFor: (id, turn) => {
            const ids = cards.idsFor(id, turn)
            return ids.length ? ids[0] : ''
          },
        })
        liveLedger = ledger
        const offs = []
        const subscribe = (name, fn) => {
          // `{ global: true }`：宿主 `EventOptions` 原文是 "Receive the event regardless of
          // context filter checks"。子代理会话的事件也要收 —— 那是真花出去的钱。
          // 只有**带参调用抛异常**（老宿主不认第三个参数）才退回两参形式，
          // 绝不两次都注册，否则每轮会被记两遍。
          let off
          let rejectedOptions = false
          try { off = root.on(name, fn, { global: true }) } catch { rejectedOptions = true }
          if (rejectedOptions) {
            try { off = root.on(name, fn) } catch { return }
          }
          if (typeof off === 'function') offs.push(off)
        }
        subscribe('session/event', (session, event) => {
          cards.observe(session, event) // 先记卡号：账本结算时要用（只取 id）
          ledger.onSessionEvent(session, event)
          proof.record(session, event) // 自证：只认方寸工具，参数不落盘
        })
        // 宿主传的是 Session 对象（id 在 session.id），归一化交给 UsageLedger.sessionIdOf
        subscribe('session/disposed', (session) => {
          ledger.onSessionDisposed(session) // 先结算半轮（这一步要用卡号）
          proof.finalizeSession(session) // 再收掉它有轮次没收尾的自证
          cards.forgetSession(session)
        })
        // 方寸没开时队列会攒着；定时重试，别等下一轮对话才想起
        const timer = setInterval(() => { void ledger.flush() }, 60_000)
        if (typeof timer.unref === 'function') timer.unref()
        void ledger.flush()
        return () => {
          clearInterval(timer)
          for (const off of offs) { try { off() } catch { /* ignore */ } }
          ledger.dispose()
          if (liveLedger === ledger) liveLedger = null
          if (liveCards === cards) liveCards = null
        }
      }, PLUGIN_NAME + ': usage')
    }

    // ③ 提示词：规则段（静态）+ 一行现状（动态快照）。
    //
    // 为什么用 `root.get` 而不是 `root.inject`：`systemPrompt` 是宿主核心服务，
    // 但**老宿主可能没有**；写进 inject 会让整个插件一直等这个服务，连挂件和记账都不工作
    // （AGENTS.md 事实 11）。所以：现在有就注册，没有就 3 秒后再看一次，仍没有就如实写进 health。
    const setupPrompt = () => {
      let disposed = false
      // 每次注册都从"没注册上"开始算：别让上一轮的状态冒充这一轮
      promptState.rules = false
      promptState.status = false
      promptState.error = ''
      const board = new BoardStatus({
        pipePath: resolvePipePath(),
        project: String(process.env.FANGCUN_PROJECT || '').trim(),
        clientVersion: PLUGIN_VERSION,
        // 没装本体时那行写「未安装」，不写「未连接」—— 两种情况的下一步不一样
        installed: collectInstall().installed,
        onError: logWarn,
      })
      liveBoard = board
      void board.refresh()
      const refreshTimer = setInterval(() => { if (!disposed) void board.refresh() }, 60_000)
      if (typeof refreshTimer.unref === 'function') refreshTimer.unref()

      let disposePrompt = () => {}
      let retryTimer = null
      const attach = (sp) => {
        if (disposed || !sp || typeof sp.section !== 'function') return false
        disposePrompt = registerPrompt(sp, { line: () => board.line() })
        promptState.rules = true
        promptState.status = typeof sp.context === 'function'
        promptState.error = ''
        return true
      }
      const findService = () => (typeof root.get === 'function' ? root.get('systemPrompt') : undefined)

      // 服务可能还没装配好：最多追 10 次、每次 1 秒。为什么不 inject：
      // 老宿主根本没有这个服务，inject 会让插件一直等它（AGENTS 事实 11）。
      let attempts = 0
      const tryAttach = () => {
        if (disposed) return
        if (attach(findService())) { retryTimer = null; return }
        attempts += 1
        if (attempts >= 10) {
          retryTimer = null
          promptState.error = 'systemPrompt 服务不可用（老宿主？）—— 规则段没有注册'
          return
        }
        promptState.error = `systemPrompt 服务暂不可用，正在重试（${attempts}/10）`
        retryTimer = setTimeout(tryAttach, 1000)
        if (typeof retryTimer.unref === 'function') retryTimer.unref()
      }
      tryAttach()

      return () => {
        disposed = true
        if (retryTimer) clearTimeout(retryTimer)
        clearInterval(refreshTimer)
        try { disposePrompt() } catch { /* ignore */ }
        promptState.rules = false
        promptState.status = false
        if (liveBoard === board) liveBoard = null
      }
    }
    if (typeof root.effect === 'function') root.effect(setupPrompt, PLUGIN_NAME + ': prompt')
    else setupPrompt()

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
