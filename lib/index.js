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
import { buildTools, makePipeCallTool } from './tool.js'
import { checkHost, LATE_CAPABILITIES } from './compat.js'
import {
  appendDispatchAudit, checkDispatchGate, consumeDispatch, countToday, dispatchPrompt, listDispatches,
  parseDispatch, projectRepoOf, readDispatchAudit, readDispatchSecret, readDispatchSettings,
  resolveDispatchSecret, validateDispatchSettingsPatch, verifyDispatchSignature, writeDispatchSettings,
} from './dispatch.js'
import { describeSettings, mergeSettings, normalizeSettings, validateSettingsPatch } from './settings.js'

/** 与 package.json 的 version 必须一致（测试会比，防两处漂移） */
export const PLUGIN_NAME = 'dsh-fangcun'
export const PLUGIN_VERSION = '0.7.10'

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
  // 设置页写进 Loader 行的覆盖优先于环境变量：用户在 DSH 里显式设过，就不该被机器上
  // 一个残留的 FANGCUN_DATA_DIR 悄悄顶掉。留空 = 没覆盖，继续往下找。
  const fromConfig = String(liveSettings.dataDir || '').trim()
  if (fromConfig) return { dir: fromConfig, source: 'config' }

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

/**
 * 设置页写进 Loader 行的三项覆盖（数据根 / 管道 / 项目范围）。
 * `apply(root, config)` 时从宿主给的 config 归一；留空 = 不覆盖，继续走环境变量与自动探测。
 * 为什么放模块级：`resolveDataDir` / `resolvePipePath` 是对外导出的纯函数（测试直接调），
 * 把它们改成必须传 config 会破坏调用方；这里让它们按"当前生效设置"读。
 */
let liveSettings = normalizeSettings(null)

/** 适配层根上下文：设置路由要用它现取 `configEditor` 与本插件那一行 */
let liveRoot = null

/** 设置能否写（health 如实报；拿不到 configEditor 就是 false，不假装保存） */
const settingsState = { entryId: '', writable: false, error: '' }

/**
 * 客户端半是否已进 DSH 的模块表。
 *
 * `package.json` 的 `dsh.client` 只在 Loader 条目启动/重启时被重读（dsh-client-modules
 * README 的 "A manifest edit alone is not observed"）；这里直接问 clientModules 要路径，
 * 有路径 = 已登记；没有 = 还没重启条目 / 组合失败。
 */
function clientModuleState() {
  try {
    const root = liveRoot
    const cm = root && typeof root.get === 'function' ? root.get('clientModules') : undefined
    if (!cm || typeof cm.clientPath !== 'function') return { available: false, path: '' }
    const p = cm.clientPath(PLUGIN_NAME)
    return { available: Boolean(p), path: p ? String(p) : '' }
  } catch {
    return { available: false, path: '' }
  }
}

/** 规则段 / 一行现状到底注册上没。拿不到 `systemPrompt` 服务时是 false（老宿主），不假装成功 */
const promptState = { rules: false, status: false, error: '' }

/**
 * 模型工具到底注册上没（REV-014 ②）。拿不到 `tools` 服务时是 false，
 * 与 promptState 同一个口径：**不假装成功**，如实进 health。
 */
const toolState = { registered: false, names: [], error: '' }

/**
 * 宿主兼容性体检结果（见 `lib/compat.js`）。**只提醒、不退出**：
 * DSH 升级后如果某块 API 改了，插件继续干它能干的，同时把缺口写进 health。
 */
let hostCompat = null

/**
 * 派单消费的现状（那根管子）。进 `health.dispatch` —— 界面说"已派给 DSH"，
 * 但用户真正想知道的是"**DSH 那边到底开没开**"，所以这件事必须能自证。
 */
const dispatchState = {
  lastAt: '',
  lastProject: '',
  lastResult: null,
  lastError: '',
  // 2026-11-20（父卡「派单防滥用」）：最近一次拒绝 + 今日已开数
  lastReject: '',
  todayCount: 0,
  secretFound: false,
  // 2026-11-24：**这一单到底挂到了哪个预设档**。
  // 为什么必须留痕：工具面退化成空手时，界面上「派单成功」看着一模一样，
  // 只有把"解析到没有"记下来，事后才查得清（卡 `a87d57bf` 写着 3/3 通过、下一单照样空手，
  // 就是因为没有一个字段回答"这单实际是什么档"）。
  presetResolved: false,
  presetNote: '',
}

/**
 * 解析这一单该挂哪个 Agent 预设档（= 决定工具面的那个东西）。
 *
 * 暮雨 2026-11-24：「A 居然还没修好，我快吐了，还以为都修完了。」
 * 背景：`D-200` 定的是「派单默认授予全部工具，工具缺失是要修的故障」，
 * 而现场是同一个项目同一天：11-22 那单有 read/write/pwsh，11-24 09:38 那单**只有插件工具**。
 *
 * ## 真机取证（这一条是本题的现场证据，不是推测）
 *
 * 读 `session.v4.jsonl` 的第一行（会话头）：
 * ```
 * 11-24 09:38  {"type":"session",...}                                  ← 没有 agentPreset
 * 11-24 01:23  {"type":"session",...,"agentPreset":"standard"}
 * 11-23 08:44  {"type":"session",...,"agentPreset":"standard"}
 * ```
 * 头里没有 `agentPreset` = 这单**没进任何预设档** = 只剩宿主最小档（插件工具）。
 *
 * ## 两个真 bug（都在这里）
 *
 * 【bug 1】原来调 `presets.resolve(wanted)`，而 wanted 此时是**空字符串**。
 *   宿主实现是 `async resolve(id) { const wanted = id ?? this.defaultId; ... }` ——
 *   `'' ?? x` **等于 `''`**（`??` 只挡 null/undefined，**不挡空串**），
 *   于是它拿 `''` 去 `definitions` 里查 → throw `Unknown agent preset:` →
 *   落到外层 catch **被静默吞掉** → agentPreset 留空 → 不传 meta、不传 setup → 空手。
 *
 * 【bug 2】`list()` 的返回项是 `{ id, name, description, order, broken }` ——
 *   **根本没有 `isDefault` 字段**（读宿主 `dsh-agent-preset-registry` 的实现确认）。
 *   所以 `rows.find(x => x.isDefault) || rows[0]` 永远退化成 `rows[0]`，
 *   而 rows 按 `order` 排序，第一个**不是默认档**（很可能正是最小档）。
 *   即使 bug 1 修好了，这条也会把"查默认"变成"随便挑一个"。
 *
 * ## 修法（按权威程度排序，不是按代码顺序）
 *
 * ① `presets.defaultId`：宿主自己的 getter（`selectedDefault ?? config.default`），最权威；
 * ② `presets.resolve()` —— **不带参**，让宿主自己走 defaultId；
 * ③ `presets.list()` 里**只认 `isDefault === true`**，查不到就**不猜**（绝不退回 rows[0]）。
 *
 * 返回 `{ id, resolved, note }`：`resolved=false` 时**必须留痕** ——
 * "档案写着 standard、跑的是空壳"比不传更难查。
 *
 * @param {object|undefined} presets 宿主 `agentPresets` 服务
 * @returns {Promise<{id: string, resolved: boolean, note: string}>}
 */
export async function resolveDispatchPreset(presets) {
  if (!presets || typeof presets !== 'object') {
    return { id: '', resolved: false, note: '宿主没有 agentPresets 服务 —— 本单只有插件工具、没有文件/终端' }
  }
  // ① 宿主的 defaultId（权威）
  try {
    const d = presets.defaultId
    if (typeof d === 'string' && d) return { id: d, resolved: true, note: 'agentPreset=' + d + '（defaultId）' }
  } catch { /* getter 抛错就往下走 */ }
  // ② resolve() **不带参**
  if (typeof presets.resolve === 'function') {
    try {
      const got = await presets.resolve()
      if (got && got.id) return { id: String(got.id), resolved: true, note: 'agentPreset=' + got.id + '（resolve）' }
    } catch { /* 继续 */ }
  }
  // ③ list() 只认 isDefault === true（**不许**退回 rows[0]）
  if (typeof presets.list === 'function') {
    try {
      const rows = await presets.list()
      const def = Array.isArray(rows) ? rows.find((x) => x && x.isDefault === true) : null
      if (def && def.id) return { id: String(def.id), resolved: true, note: 'agentPreset=' + def.id + '（list.isDefault）' }
    } catch { /* 继续 */ }
  }
  return {
    id: '',
    resolved: false,
    note: '没解析出默认档（defaultId / resolve / list 都没给）—— 本单只有插件工具、没有文件/终端',
  }
}

/** 会话 id：DSH 的 `SessionId` 是带 brand 的字符串，随便给一个唯一值即可 */
function randomSessionId() {
  const rnd = Math.random().toString(36).slice(2, 10)
  return 'fangcun-dispatch-' + Date.now().toString(36) + '-' + rnd
}

/**
 * 只收**绝对路径**的目录。
 *
 * 宿主的会话头要求 `cwd` 是绝对路径（否则 prepare 直接 throw），
 * 而派单文件是方寸写的、registry 是人手改的 —— 两处都可能出现相对路径或脏值。
 * 宁可这条不传（宿主用默认目录），也不许把一个错路径塞进去。
 */
function absoluteDirOf(value) {
  const v = String(value || '').trim()
  if (!v) return ''
  try {
    return path.isAbsolute(v) ? v : ''
  } catch {
    return ''
  }
}

/**
 * 逐轮判定的空汇总（插件没 apply 时 health 用它）。
 * 形状必须与 `lib/proof.js` 的 `summarize([])` 一致，否则"没数据"会被读成"全是 0 分"。
 */
const EMPTY_TURNS = { turns: 0, withEdit: 0, readBeforeEdit: 0, editFirst: 0, wroteBack: 0, readOnly: 0, withShell: 0 }

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
      mcpPipe: resolvePipePath(env),
    },
    // 设置页的现状：三项覆盖、能不能写、拿不到哪一环（不假装保存成功）
    // ⚠ 必须**当场问**宿主，不能照抄 apply 时那一拍：`configEditor` 比本插件晚就绪，
    //   照抄的结果是页面明明能保存、health 却一直写 false（2026-11-19 真机踩到）。
    settings: {
      ...settingsStatus(),
      ...describeSettings(liveSettings),
    },
    // 客户端半（设置页）到底进没进 DSH 的模块表：manifest 改了但没重启条目时，
    // 这里是 false —— 比"设置里看不到方寸"更早一步给出原因。
    client: clientModuleState(),
    // 三件套的连通状态（只报插件看得见的那两环；DSH 那一环由方寸侧报）
    link: probeFangcunLink(env, install),
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
    // 模型工具注册状态（REV-014 ②）：false = 模型调不到方寸做事，只有挂件能看
    tools: {
      registered: toolState.registered,
      names: toolState.names.slice(),
      error: toolState.error,
    },
    // 宿主兼容性体检（只提醒、不退出）：DSH 升级后哪块 API 改了，这里会说出来
    compat: hostCompat || { checkedAt: '', capabilities: {}, warnings: [], summary: '尚未体检' },
    // 派单消费现状（那根管子）：用户点了「派给 DSH」，这里能证明 DSH 那边开没开
    dispatch: (() => {
      const settingsInfo = readDispatchSettings(dir)
      const auditRows = readDispatchAudit(dir)
      const gate = checkDispatchGate({ project: '', settings: settingsInfo.settings, rows: auditRows })
      const lastRow = auditRows.length ? auditRows[auditRows.length - 1] : null
      return {
        lastAt: dispatchState.lastAt,
        lastProject: dispatchState.lastProject,
        // 只报"成没成 + 会话 id"，不把上下文正文写进 health（那可能是私事）
        lastOk: dispatchState.lastResult ? Boolean(dispatchState.lastResult.ok) : false,
        lastSessionId: (dispatchState.lastResult && dispatchState.lastResult.sessionId) || '',
        lastError: dispatchState.lastError
          || (dispatchState.lastResult && dispatchState.lastResult.error) || '',
        // 2026-11-20：签名与限流自证（用户能看出"为什么没开会话"）
        lastReject: dispatchState.lastReject,
        // 2026-11-24：**上一单实际挂到哪个预设档**。
        // 这是「派单出去却没有文件/终端」唯一能事后查到的字段 ——
        // 没有它，界面永远显示"派单成功"，而那张卡会谎报"工具档 3/3 生效"。
        presetResolved: dispatchState.presetResolved,
        presetNote: dispatchState.presetNote,
        // 2026-11-21：总闸四项的真源（与方寸设置页同一个文件）
        enabled: settingsInfo.settings.enabled,
        settings: settingsInfo.settings,
        settingsFile: settingsInfo.path,
        settingsExists: settingsInfo.exists,
        settingsError: settingsInfo.error,
        gate,
        lastAudit: lastRow,
        todayCount: gate.today,
        dailyCap: settingsInfo.settings.dailyCap,
        cooldownMs: settingsInfo.settings.cooldownSec * 1000,
        concurrency: settingsInfo.settings.concurrency,
        secretFound: dispatchState.secretFound,
      }
    })(),
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

/** 管道路径：允许设置页 / 环境变量覆盖（多实例 / 测试 / 非默认部署） */
export function resolvePipePath(env = process.env) {
  const fromConfig = String(liveSettings.pipePath || '').trim()
  if (fromConfig) return fromConfig
  const fromEnv = String(env.FANGCUN_MCP_PIPE || '').trim()
  return fromEnv || mcpPipePath()
}

/** 项目范围：设置页 > 环境变量；留空 = 全部项目（与挂件、一行现状同一口径） */
export function resolveProjectScope(env = process.env) {
  const fromConfig = String(liveSettings.project || '').trim()
  if (fromConfig) return fromConfig
  return String(env.FANGCUN_PROJECT || '').trim()
}

/**
 * 三件套连通状态（用户 2026-11-17：「缺插件提示下插件，缺DSH提示下DSH，
 * 插件本身也能提醒下方寸」）。
 *
 * 插件只能看见**自己能看见的两环**：
 *   ① 方寸本体装没装（`detect.js` 只读文件痕迹）
 *   ② 方寸在不在跑（命名管道在不在）
 *
 * 「DSH 装没装」在插件里没有意义 —— 插件就活在 DSH 进程里，它跑起来了就说明 DSH 在。
 * 所以那一环由**方寸侧**报（`services/dshPlugin.ts`），两边各报自己看得见的那半边，
 * 合起来才是完整的三件套。合成一句话时必须说清"这一环是谁报的"，不许混说。
 *
 * @param {object} [env]
 * @param {{installed?: boolean}} [install] 已算好的装机结论（避免重复读盘）
 */
export function probeFangcunLink(env = process.env, install) {
  const pipePath = resolvePipePath(env)
  const inst = install || collectInstall(env)
  let running = false
  try {
    // Windows 上 `\\.\pipe\xxx` 能直接 stat 到；非 Windows 是普通 socket 文件
    running = fs.existsSync(pipePath)
  } catch { running = false }

  let hint = ''
  if (!inst.installed) {
    hint = '本机没装方寸桌面版 —— 去下载：' + DOWNLOAD_URL
  } else if (!running) {
    hint = '方寸装了但没在运行 —— 打开方寸即可（打开后自动通，不用重启 DSH）'
  }
  return { installed: inst.installed, running, pipePath, hint, ready: inst.installed && running }
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
      const project = resolveProjectScope()
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
 * 本插件在 Loader 里的那一行 + configEditor。
 *
 * 为什么不用 `settings` 服务：0.2 线的 Settings 只对**导出了 `Config` 的 volatile 字段**
 * 生成表单，而 `Config` 需要 `@deepseek-ai/schemastery` —— 本仓零依赖，不能引。
 * 所以走官方 `references/configuration.md` 的另一条正路：`configEditor.edit(entry, …)`
 * 写 profile patch；保存后 Loader 会重启本插件，`apply(root, config)` 拿到新值。
 */
function configTarget() {
  const root = liveRoot
  if (!root) return { error: '插件上下文还没就绪' }
  let entry = null
  try {
    entry = root.fiber && root.fiber.entry ? root.fiber.entry : null
  } catch { entry = null }
  if (!entry) return { error: '拿不到本插件的 Loader 行（宿主形状变了）—— 设置只能读' }
  let editor
  try {
    editor = typeof root.get === 'function' ? root.get('configEditor') : undefined
  } catch { editor = undefined }
  if (!editor || typeof editor.edit !== 'function') {
    return { error: '宿主没有 configEditor 服务 —— 设置只能读，不能保存' }
  }
  return { entry, editor }
}

/** Loader 行的 id（宿主形状变了就回空串，不猜） */
function entryIdOf(entry) {
  try {
    const id = entry && entry.options ? entry.options.id : ''
    return id ? String(id) : ''
  } catch { return '' }
}

/**
 * health 用的设置状态：**当场**问一次宿主。
 *
 * 为什么不在 apply 时算一次就存着：`configEditor` 是后挂的服务，插件 apply 那一刻
 * 它常常还没进上下文 —— 存下来就会把"能写"永久记成 false，而 GET 路由当场问是对的。
 * 同一个 health 里两个答案，排查时只会把人带沟里。
 */
function settingsStatus() {
  if (!liveRoot) return { ...settingsState }
  const target = configTarget()
  return {
    entryId: entryIdOf(target.entry) || settingsState.entryId,
    writable: Boolean(target.entry && target.editor),
    error: target.error || '',
  }
}

/**
 * 写操作的来源校验：Host 必须是本机，跨站 Origin 一律拒。
 *
 * 桌面端页面是 `dsh-app://app/`，请求由主进程转发；它的 `Origin` 可能是 `dsh-app://app`，
 * 也可能没有（Electron 实测不带 sec-fetch-* / referer）。这两种都放行 ——
 * Host 已限定 loopback，而普通网页的跨站写必然带 `Origin`，会被下面那条挡住。
 */
function isSameOriginMutation(req) {
  const headers = req?.headers || {}
  const host = headers.host
  if (typeof host !== 'string' || !host) return false
  let hostname
  try { hostname = new URL('http://' + host).hostname } catch { return false }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (!loopbackHost) return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin) {
    if (origin.startsWith('dsh-app://')) return true
    try { return new URL(origin).host === host } catch { return false }
  }
  return true
}

/** 读 JSON 请求体（上限 64 KiB）。只接受对象，数组/标量一律拒 —— 设置是键值对。 */
async function readJsonBody(req, limit = 64 * 1024) {
  let text = ''
  if (typeof req?.setEncoding === 'function') req.setEncoding('utf8')
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (Buffer.byteLength(text) > limit) throw new Error('请求体太大（上限 64 KiB）')
    }
  } else {
    throw new Error('读不到请求体（宿主请求形状变了）')
  }
  if (!text.trim()) throw new Error('请求体不能为空')
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return value
}

/**
 * 派单四项的**当前真身**（与方寸设置页同一个 JSON 文件）。
 * GET / PUT / health 都用这一份，不许各算一个数。
 */
function dispatchSettingsBlock() {
  const data = resolveDataDir()
  const st = readDispatchSettings(data.dir)
  const rows = readDispatchAudit(data.dir)
  const gate = checkDispatchGate({ project: '', settings: st.settings, rows })
  const preset = String((liveSettings && liveSettings.dispatchPreset) || '')
  return {
    settings: st.settings,
    settingsFile: st.path,
    settingsExists: st.exists,
    settingsError: st.error,
    gate,
    // 2026-11-24（暮雨第 3 条）：「方寸插件能不能增加一个设置选项，
    // 可以让用户更改派单任务的默认权限（当前默认为工作区内修改）？」
    //
    // 能 —— **权重档就是这个 `dispatchPreset`**（= Agent 预设档 / agentPreset）。
    // 它决定派单会话挂哪些工具（含文件与终端写权限），改它不用碰 DSH 的 Agent 预设本体
    // （暮雨原话：「DSH的Agent预设太复杂，别去碰它」）。
    // 留空 = 跟宿主当前默认档走（推荐，也是出厂行为）；填了就按那一档。
    dispatchPreset: {
      configured: preset,
      followsHostDefault: !preset.trim(),
      note: '派单会话用哪个 Agent 预设档 —— 这就是"派单任务的默认权限"。'
        + '留空 = 跟宿主当前默认档一致；填了就按那一档（DSH 的 Agent 预设本体不会被改动）。',
    },
  }
}

/**
 * 把 PUT 请求体拆成「派单四项（写共享文件）」与「宿主三项（写 Loader 行）」。
 * 兼容旧字段 `dispatchCooldownMin`（分钟）→ 新字段 `dispatchCooldownSec`（秒）。
 */
function splitDispatchPatch(body) {
  const rest = { ...(body && typeof body === 'object' ? body : {}) }
  const dispatchPatch = {}
  if (Object.prototype.hasOwnProperty.call(rest, 'dispatchEnabled')) {
    dispatchPatch.enabled = rest.dispatchEnabled
    delete rest.dispatchEnabled
  }
  if (Object.prototype.hasOwnProperty.call(rest, 'dispatchCooldownSec')) {
    dispatchPatch.cooldownSec = rest.dispatchCooldownSec
    delete rest.dispatchCooldownSec
  } else if (Object.prototype.hasOwnProperty.call(rest, 'dispatchCooldownMin')) {
    const n = Number(rest.dispatchCooldownMin)
    dispatchPatch.cooldownSec = Number.isFinite(n) ? n * 60 : rest.dispatchCooldownMin
    delete rest.dispatchCooldownMin
  }
  if (Object.prototype.hasOwnProperty.call(rest, 'dispatchDailyCap')) {
    dispatchPatch.dailyCap = rest.dispatchDailyCap
    delete rest.dispatchDailyCap
  }
  if (Object.prototype.hasOwnProperty.call(rest, 'dispatchConcurrency')) {
    dispatchPatch.concurrency = rest.dispatchConcurrency
    delete rest.dispatchConcurrency
  }
  return { dispatchPatch, rest }
}

/**
 * 设置页的后端：`GET` 读现状，`PUT` 写三项覆盖 + 派单四项。
 *
 * 写入分两处（各归各的真源）：
 *   · 数据根 / 管道 / 项目范围 → `configEditor`（profile patch）；
 *   · 启用派单 / 冷却 / 日上限 / 在途 → `<数据根>/.dispatch-dsh/dispatch-settings.json`
 *     （方寸与插件共用；立即生效，不需要重启插件）。
 */
async function settingsHandler(req, res) {
  try {
    const method = String(req?.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'PUT') {
      res.setHeader?.('Allow', 'GET, PUT')
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!isLoopback(req?.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: '只能从本机访问' })
      return
    }
    if (method === 'PUT' && !isSameOriginMutation(req)) {
      sendJson(res, 403, { ok: false, error: '跨站写被拒绝（只接受本机页面）' })
      return
    }
    if (method === 'PUT') {
      const type = String(req?.headers?.['content-type'] || '').toLowerCase()
      if (!type.startsWith('application/json')) {
        sendJson(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' })
        return
      }
    }

    const target = configTarget()
    if (method === 'GET') {
      const data = resolveDataDir()
      sendJson(res, 200, {
        ok: true,
        writable: Boolean(target.entry && target.editor),
        entryId: entryIdOf(target.entry) || settingsState.entryId,
        error: target.error || '',
        ...describeSettings(liveSettings),
        // 派单四项的真身（与方寸设置页同一个文件；默认关）
        dispatch: dispatchSettingsBlock(),
        // 2026-11-24（暮雨第 3 条）：派单会话用哪个 Agent 预设档 ——
        // 这就是"派单任务的默认权限"。空串 = 跟宿主默认档走（不退化成最小档）。
        dispatchPreset: {
          configured: String((liveSettings && liveSettings.dispatchPreset) || ''),
          /** 这个值是不是"跟宿主默认走" */
          followsHostDefault: !String((liveSettings && liveSettings.dispatchPreset) || '').trim(),
        },
        effective: {
          dataDir: data.dir || '',
          dataDirSource: data.source,
          pipePath: resolvePipePath(),
          project: resolveProjectScope(),
        },
        boardUrl: resolveBoardUrl(),
      })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
      return
    }
    const { dispatchPatch, rest } = splitDispatchPatch(body)
    const dispatchKeys = Object.keys(dispatchPatch)

    // ① 派单四项：写共享文件，**不需要 configEditor**（方寸设置页也写同一份）。
    let dispatchChanged = false
    if (dispatchKeys.length) {
      const checkedD = validateDispatchSettingsPatch(dispatchPatch)
      if (!checkedD.ok) {
        sendJson(res, 400, { ok: false, error: checkedD.error })
        return
      }
      // 如果同一请求里改了数据根，派单设置写到**新根**（否则用户以为设置跟着走了）
      const wantDir = typeof rest.dataDir === 'string' && rest.dataDir.trim()
        ? rest.dataDir.trim()
        : resolveDataDir().dir
      if (!wantDir) {
        sendJson(res, 400, { ok: false, error: '还没有方寸数据根 —— 派单设置不知道往哪写（先设数据根，或用方寸设置页）' })
        return
      }
      const wr = writeDispatchSettings(wantDir, checkedD.patch)
      if (!wr.ok) {
        sendJson(res, 409, { ok: false, error: wr.error || '派单设置写不进去' })
        return
      }
      dispatchChanged = wr.changed === true
    }

    const restKeys = Object.keys(rest)
    if (!restKeys.length) {
      // 只改派单四项：立即生效，不重启插件，也不碰 profile。
      const data = resolveDataDir()
      sendJson(res, 200, {
        ok: true,
        restarting: false,
        message: dispatchChanged
          ? '已保存（派单设置立即生效，不需要重启插件）'
          : '已保存：没有变化',
        ...describeSettings(liveSettings),
        dispatch: dispatchSettingsBlock(),
        effective: {
          dataDir: data.dir || '',
          dataDirSource: data.source,
          pipePath: resolvePipePath(),
          project: resolveProjectScope(),
        },
      })
      return
    }

    // ② 宿主三项：走 configEditor，缺它就只能读不能写（如实 501）。
    if (!target.entry || !target.editor) {
      sendJson(res, 501, { ok: false, error: target.error || '设置不可写' })
      return
    }
    const checked = validateSettingsPatch(rest)
    if (!checked.ok) {
      sendJson(res, 400, { ok: false, error: checked.error })
      return
    }
    // 三项都没变就别演戏：不写 profile、不重启、也不谎报"会重启一次"。
    // 真机 2026-11-19：用户点保存时三项都空，editor 仍把 patch 重写了一遍（内容不变），
    // 而 UI 回的是"已保存；插件会重启一次" —— 用户的原话是"感觉没什么用"。
    const nextSettings = normalizeSettings(mergeSettings(liveSettings, checked.patch))
    const changed = JSON.stringify(nextSettings) !== JSON.stringify(liveSettings)
    if (!changed) {
      const data = resolveDataDir()
      sendJson(res, 200, {
        ok: true,
        restarting: false,
        message: '已保存：没有变化（三项都空 = 不覆盖，继续用环境变量 / 自动探测）',
        ...describeSettings(liveSettings),
        dispatch: dispatchSettingsBlock(),
        effective: {
          dataDir: data.dir || '',
          dataDirSource: data.source,
          pipePath: resolvePipePath(),
          project: resolveProjectScope(),
        },
      })
      return
    }
    try {
      await target.editor.edit(target.entry, (current) => mergeSettings(current, checked.patch))
    } catch (e) {
      // 写入失败必须当场说：用户改的是真配置，不能"看着保存了其实没写"
      sendJson(res, 409, { ok: false, error: '保存失败：' + String((e && e.message) || e) })
      return
    }
    liveSettings = nextSettings
    const data = resolveDataDir()
    sendJson(res, 200, {
      ok: true,
      restarting: true,
      message: '已保存；宿主三项会在插件重启后生效（派单四项立即生效）',
      ...describeSettings(liveSettings),
      dispatch: dispatchSettingsBlock(),
      effective: {
        dataDir: data.dir || '',
        dataDirSource: data.source,
        pipePath: resolvePipePath(),
        project: resolveProjectScope(),
      },
    })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
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
  { kind: 'exact', path: '/fangcun/api/settings', handler: settingsHandler },
]

export default {
  name: PLUGIN_NAME,
  apply(root, config) {
    // 设置页写在 Loader 行 config 里的三项覆盖。放最前面：后面的所有接线
    // （管道、数据根、项目范围）都要读它，晚一步就会先按环境变量连一次。
    liveRoot = root
    liveSettings = normalizeSettings(config)
    {
      const target = configTarget()
      // 这一拍只作**兜底**：health / GET 每次都会当场再问一遍（settingsStatus），
      // 因为 configEditor 常常比本插件晚就绪。
      settingsState.entryId = entryIdOf(target.entry)
      settingsState.writable = Boolean(target.entry && target.editor)
      settingsState.error = target.error || ''
    }

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
        project: resolveProjectScope(),
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
        disposePrompt = registerPrompt(sp, {
          line: () => board.contextLine(),
          memoryLine: () => board.memoryLine(),
        })
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

    // ④ 模型工具（REV-014 ②）：让 agent 能"调方寸做事"，而不是只看挂件。
    //
    // 为什么用 `root.get('tools')` 而不是 inject：与 systemPrompt 同一个理由 ——
    // 老宿主可能没有这个服务，inject 会让整个插件一直等它，连挂件和记账都不工作
    // （AGENTS.md 事实 11）。所以：有就注册，没有就如实写进 health。
    const setupTools = () => {
      let disposed = false
      toolState.registered = false
      toolState.names = []
      toolState.error = ''

      const attach = (svc) => {
        if (disposed || !svc || typeof svc.register !== 'function') return false
        const tools = buildTools({
          callTool: makePipeCallTool({ pipePath: resolvePipePath(), version: PLUGIN_VERSION }),
        })
        const offs = []
        try {
          for (const def of tools) {
            const off = svc.register(def)
            if (typeof off === 'function') offs.push(off)
            toolState.names.push(def.name)
          }
        } catch (e) {
          // 单个工具注册失败不连坐：已经注册上的照常工作，但状态如实记
          toolState.error = '注册失败：' + String((e && e.message) || e)
          for (const off of offs) { try { off() } catch { /* ignore */ } }
          toolState.names = []
          return false
        }
        toolState.registered = toolState.names.length > 0
        if (toolState.registered) toolState.error = ''
        return toolState.registered
      }

      let attempts = 0
      let retryTimer = null
      const tryAttach = () => {
        if (disposed) return
        const svc = typeof root.get === 'function' ? root.get('tools') : undefined
        if (attach(svc)) { retryTimer = null; return }
        attempts += 1
        if (attempts >= 10) {
          retryTimer = null
          if (!toolState.error) toolState.error = 'tools 服务不可用（老宿主？）—— 模型工具没有注册'
          return
        }
        if (!toolState.error) toolState.error = `tools 服务暂不可用，正在重试（${attempts}/10）`
        retryTimer = setTimeout(tryAttach, 1000)
        if (typeof retryTimer.unref === 'function') retryTimer.unref()
      }
      tryAttach()

      return () => {
        disposed = true
        if (retryTimer) clearTimeout(retryTimer)
        toolState.registered = false
        toolState.names = []
      }
    }
    if (typeof root.effect === 'function') root.effect(setupTools, PLUGIN_NAME + ': tools')
    else setupTools()

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

    // ⑤ 宿主兼容性体检（用户 2026-11-17："只提醒而不是退出服务，能不能用随缘"）。
    //
    // 为什么放在**最后**：前面的注册都跑完了，`root` 上该有的服务此时才定型；
    // 在这之前判会把"还没轮到注册"误报成"宿主没这个服务"。
    //
    // 为什么宽限重试：宿主装配有先后，`webServer` / `tools` 可能比插件晚到几十毫秒。
    // 一次就下结论会造出假警报 —— 假警报比不报更糟（会让人以为 DSH 升级坏了）。
    const runCompatCheck = () => {
      let rounds = 0
      let timer = null
      const tick = () => {
        const result = checkHost(root)
        hostCompat = result
        // 全都正常就定稿；有缺口再等一轮，避免把"还没注册完"当成"没有"。
        // ⚠ 后挂服务（configEditor / clientModules / agents）实测比插件晚几秒才进上下文：
        //   只差这几项时把窗口拉到 ~15 秒，别把"还没挂上"报成"宿主没有" —— 假警报比不报更糟。
        const bad = Object.entries(result.capabilities).filter(([, v]) => v !== 'ok').map(([k]) => k)
        const hardBad = bad.some((k) => !LATE_CAPABILITIES.has(k))
        rounds += 1
        if (bad.length === 0) return
        if (hardBad && rounds >= 3) return
        if (rounds >= (hardBad ? 3 : 10)) return
        timer = setTimeout(tick, 1500)
        if (typeof timer.unref === 'function') timer.unref()
      }
      tick()
      return () => { if (timer) clearTimeout(timer) }
    }
    if (typeof root.effect === 'function') root.effect(runCompatCheck, PLUGIN_NAME + ': compat')
    else runCompatCheck()

    // ⑥ 派单消费（那根管子 · 2026-11-17）。
    //
    // 方向：**方寸 → DSH**。方寸在界面上点「派给 DSH」→ 落一份派单文件 →
    // 插件在这里看见 → 在 DSH 里开一个新会话，第一条消息就是那个项目的上下文包。
    //
    // 为什么由插件做而不是方寸做：方寸连"DSH 装没装"都只是只读探测，
    // 让它去 spawn 一个 GUI 应用会踩一串环境坑（PATH / 单实例锁 / 谁来收结果）。
    // 插件本来就在 DSH 进程里跑着，天然知道 profile、也知道干完怎么回写方寸。
    //
    // ⚠ **不开新的 agent 循环**（REV-014 定案：借 DSH，不自研）——
    //   这里只调宿主的 `agents.create`，循环归宿主。
    const runDispatch = () => {
      const dir = collectHealth().fangcun.dataDir
      if (!dir) return () => {}       // 没找到数据根 = 没法知道派单在哪，安静退场
      let active = 0
      const inFlight = new Set()
      let timer = null

      const openSession = async (payload) => {
        // `agents` 是可选的（老宿主没有）——拿不到就**明说派不出去**，不假装
        const agents = typeof root.get === 'function' ? root.get('agents') : undefined
        if (!agents || typeof agents.create !== 'function') {
          return { ok: false, error: '宿主没有 agents 服务（老宿主？）—— 派单建不了会话' }
        }
        const sessionId = randomSessionId()
        // 派单用途（work / plan）要能被看出来：否则用户在侧边栏看到两个同名会话，
        // 不知道哪个是"干活"哪个是"做规划"。
        const kind = payload && payload.kind === 'plan' ? 'plan' : 'work'
        const title = `方寸派单 · ${kind === 'plan' ? '规划' : '开工'} · ${(payload && payload.project) || ''}`
        // 仓库目录：**落错地方等于派进真空**（2026-11-17 真机会话落在 `_no-cwd`）。
        // 先认派单文件里的 cwd（方寸知道），再回退到 registry.yaml 里的 repo。
        // 两个都没有就**不传** —— 让宿主用默认目录，而不是瞎猜一个。
        const cwd = absoluteDirOf(payload && payload.cwd)
          || absoluteDirOf(projectRepoOf(dir, payload && payload.project))
        // 技能档（2026-11-21 · 卡 `ee53ff26`）：
        // 真机取证：手开会话的 `session.v4` 头有 `"agentPreset":"standard"`，
        // 派单会话没有这一行 → 落到最小档，只有插件工具，**没有文件/终端**，
        // 于是"派出去能读板子、改不了一行代码"。
        // DSH 的 `agents.create` 支持 `meta.agentPreset`（官方 session-controller 同写法），
        // 这里取宿主**当前默认档**，与手开会话对齐；取不到就不传（不因查档失败丢掉整单）。
        let agentPreset = ''
        let presets
        try {
          presets = typeof root.get === 'function' ? root.get('agentPresets') : undefined
          // 2026-11-24（暮雨第 3 条）：「方寸插件能不能增加一个设置选项，
          // 可以让用户更改派单任务的默认权限（当前默认为工作区内修改）？」
          //
          // 能。**权限档就是这个 `agentPreset`** —— 它不是"记账字段"，
          // 而是真正决定挂哪些工具（含文件/终端写权限）的那个档。
          // 所以"改默认权限"= 改这一档，而不用碰 DSH 的 Agent 预设本体
          // （暮雨原话：「DSH的Agent预设太复杂，别去碰它」）。
          //
          // 优先级：**设置页显式指定 > 宿主当前默认档 > 不传（宿主兜底）**。
          // 显式指定为空 = 跟宿主默认走（不是"最小档"，那样会静默降权）。
          const wanted = String((liveSettings && liveSettings.dispatchPreset) || '').trim()
          if (wanted) {
            // 设置页显式指定，优先。
            agentPreset = wanted
            dispatchState.presetResolved = true
            dispatchState.presetNote = 'agentPreset=' + agentPreset + '（设置页显式指定）'
          } else if (presets) {
            // ⚠ 2026-11-24 修两个真 bug —— 详见 `resolveDispatchPreset()` 的注释。
            const r = await resolveDispatchPreset(presets)
            agentPreset = r.id
            dispatchState.presetResolved = r.resolved
            dispatchState.presetNote = r.note
          }
        } catch (e) { /* 查不到默认档：退回宿主默认行为，但这单仍要能派出去 */
          dispatchState.presetResolved = false
          dispatchState.presetNote = '解析默认档抛错：' + String((e && e.message) || e)
        }
        const meta = {
          ...(cwd ? { cwd } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        }
        // 模型路由：**不传就等于建了一个不会思考的会话**。
        // 宿主的 `agent.model.current()` 在没有 provider/model 时会抛
        // "has no provider/model: set AgentOptions.provider and AgentOptions.model"
        // —— 那正是"会话开出来了，但你说话它不回"的样子。
        // 口径与宿主自己的新会话完全一致：取 `agentDefaultModel` 的当前选择。
        const defaults = typeof root.get === 'function' ? root.get('agentDefaultModel') : undefined
        let agentOptions
        try {
          const sel = defaults && typeof defaults.currentSelection === 'function'
            ? defaults.currentSelection()
            : undefined
          if (sel && sel.provider && sel.model) {
            agentOptions = {
              provider: String(sel.provider),
              model: String(sel.model),
              ...sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort },
            }
          }
        } catch { /* 拿不到就退化成宿主默认；真跑不起来时 flush/followup 的错会如实报 */ }
        // ⚠ **`meta.agentPreset` 只是记账，不装配**（2026-11-21 真机取证）：
        // 派单会话头里已经有 `"agentPreset":"standard"`，可它依然只有插件工具、
        // 没有文件/终端 —— 因为 header 只记录"这单是哪个档"，**真正把该档的工具挂到
        // agent 作用域上的，是 create 时的 `setup` 回调**。
        // 宿主自己的 `session.create` 就是两件事一起做（见 dsh-api-session-controller
        // 的 composeAgent：先 `presets.resolve()`，再 `setup: (agentCtx) => presets.mount(agentCtx, id)`）。
        // 只传 meta 不传 setup = 档案写着 standard、跑的是空壳，比不传更难查。
        const setupPreset = presets && agentPreset && typeof presets.mount === 'function'
          ? async (agentCtx) => { await presets.mount(agentCtx, agentPreset) }
          : undefined
        let handle
        try {
          handle = await agents.create({
            sessionId,
            meta,
            ...agentOptions === undefined ? {} : { agentOptions },
            ...setupPreset === undefined ? {} : { setup: setupPreset },
          })
        } catch (e) {
          return { ok: false, error: '建会话失败：' + String((e && e.message) || e) }
        }
        const agent = handle && handle.agent
        const session = agent && agent.session
        // 把上下文包作为这个会话的**第一条用户消息**塞进去。
        // 为什么不是 systemPrompt：包是"这一次派单的快照"，属于这一轮历史，
        // 不该跟着每一轮重新装配（那会让历史里出现一份永远在变的"派单"）。
        //
        // ⚠ 2026-11-17 真机抓到的两个 bug（本机探针派的那个会话是空的）：
        //   ① **直接 `session.append('user/message')` 不会让 agent 跑起来** ——
        //      宿主的轮次由 Agent 的 inbox 驱动（`agent.followup(message)`），
        //      往日志里补一条消息只是"历史里多了一句"，模型永远不会被叫醒。
        //   ② 手写的消息**必须有 `id` 与 `source`** —— 校验（assertMessageEventShape）
        //      要求 `id` 非空、`source.kind` 非空，缺了就是坏事件。
        //   所以走 `followup`，并且自己造一个合法的 UserMessage。
        if (agent && typeof agent.followup === 'function') {
          const message = {
            id: 'fangcun-dispatch-msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text: dispatchPrompt(payload) }],
            source: { kind: 'user' },
          }
          try {
            agent.followup(message)
          } catch (e) {
            return { ok: false, sessionId: String(sessionId), error: '投递上下文包失败：' + String((e && e.message) || e) }
          }
        } else if (session && typeof session.append === 'function') {
          // 老/异形宿主没有 followup：退回"只补历史"，但**明说它不会自己跑**
          try {
            session.append('user/message', {
              id: 'fangcun-dispatch-msg-' + Date.now().toString(36),
              role: 'user',
              content: [{ type: 'text', text: dispatchPrompt(payload) }],
              source: { kind: 'user' },
            }, { surfaceOp: 'append' })
          } catch (e) {
            return { ok: false, sessionId: String(sessionId), error: '塞上下文包失败：' + String((e && e.message) || e) }
          }
        } else {
          return { ok: false, sessionId: String(sessionId), error: '会话建了但拿不到 agent（形状变了）' }
        }
        // 让它进侧边栏、有个能认的名字；两件事都是 best-effort ——
        // 做不到也不许把整根管子弄断（会话已经带着包开着了）。
        if (session) {
          const titles = typeof root.get === 'function' ? root.get('sessionTitle') : undefined
          if (titles && typeof titles.rename === 'function') {
            try { titles.rename(session, title) } catch { /* 名字是锦上添花 */ }
          }
          const registry = typeof root.get === 'function' ? root.get('workspaceRegistry') : undefined
          if (registry && cwd && typeof registry.resolveByPath === 'function') {
            try {
              const ws = await registry.resolveByPath(cwd)
              if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sessionId)
            } catch { /* 没挂进工作区也比派不出去强 */ }
          }
          // **落盘**：不 flush 的话这条消息只活在内存里（探针会话在磁盘上只有头）。
          const sessions = typeof root.get === 'function' ? root.get('sessions') : undefined
          if (sessions && typeof sessions.flush === 'function') {
            try { await sessions.flush(session) } catch { /* 下一轮结束还会冲一次 */ }
          }
        }
        return { ok: true, sessionId: String(sessionId) }
      }

      const reject = (row, reason, payload, source) => {
        // 移到 rejected/ 保留证据；主目录只看 dispatch-*.md，不会再被消费
        const rejDir = path.join(dir, '.dispatch-dsh', 'rejected')
        try {
          fs.mkdirSync(rejDir, { recursive: true })
          fs.renameSync(row.path, path.join(rejDir, `${Date.now()}-${path.basename(row.path)}`))
        } catch { /* 移不动也别重复开；下一轮还会看到同一份，至少审计已经写过 */ }
        appendDispatchAudit(dir, {
          ok: false,
          reason,
          source: source || 'agent',
          claimedSource: payload ? String(payload.source || '') : '',
          project: payload ? String(payload.project || '') : '',
          kind: payload ? String(payload.kind || '') : '',
          file: row.name,
        })
        dispatchState.lastReject = reason
        dispatchState.lastError = '派单被拒：' + reason
      }

      const handleRow = async (row, settingsInfo, inFlightBefore) => {
        let raw = ''
        try { raw = fs.readFileSync(row.path, 'utf-8') } catch { return }
        const payload = parseDispatch(raw)
        if (!payload) { reject(row, 'bad-format', null, 'agent'); return }
        // ① 用户手势凭证：只有方寸 GUI 写的派单才有 source=gui + nonce + sig
        if (payload.source !== 'gui' || !payload.nonce || !payload.sig) {
          reject(row, 'unsigned', payload, 'agent'); return
        }
        // ② 密钥：从 userData 读，读不到就**拒绝**，绝不退回无签名直开
        const secret = readDispatchSecret(resolveDispatchSecret())
        dispatchState.secretFound = !!secret
        if (!secret) { reject(row, 'no-secret', payload, 'gui'); return }
        // ③ 签名：正文/元数据改一个字都对不上
        if (!verifyDispatchSignature(secret, payload, payload.sig)) {
          reject(row, 'bad-signature', payload, 'agent'); return
        }
        // ④ 统一闸门（与方寸写侧、health 同一个判据）：
        //    总闸 / 日上限 / 在途 / 同项目冷却。只数真实开过的会话，被拒文件不占额度。
        const gate = checkDispatchGate({
          project: payload.project,
          settings: settingsInfo.settings,
          rows: readDispatchAudit(dir),
          inFlight: Math.max(0, Number(inFlightBefore) || 0),
        })
        dispatchState.todayCount = Number(gate.today) || 0
        if (!gate.ok) { reject(row, gate.reason, payload, 'gui'); return }
        // ⑤ 并发上限由 tick 控制；成功才删文件，失败留着下次重试
        const r = await consumeDispatch(row, openSession)
        if (r.ok) {
          dispatchState.lastAt = new Date().toISOString()
          appendDispatchAudit(dir, {
            ok: true, source: 'gui', project: payload.project, kind: payload.kind,
            sessionId: r.sessionId || '', file: row.name,
            // ── 2026-11-24（卡 `948feaa9` / `e50f0a18` 的守卫层）──
            // 暮雨：「本来就是 AI 自己的问题，要弹也是去弹给 AI 看」+「A 居然还没修好」。
            //
            // 这一行回答一个界面永远答不出的问题：**这一单实际挂到了哪个档**。
            // 现场教训：卡 `a87d57bf` 明写「三件事 3/3，工具档真的生效了」，
            // 而下一单从同一个入口派出来**一个文件工具都没有** ——
            // 「验证过一次通过」和「现在通过」是两件事，而卡面分不清。
            //
            // 所以每次派单成功都留一行 `dispatch-capability`：
            //   presetResolved=false（或 preset 为空）= 这一单**只会拿到插件工具**，
            //   事后一查就知道，不用等人记得去翻 session.v4。
            capability: 'dispatch-capability',
            preset: dispatchState.presetNote || '',
            presetResolved: Boolean(dispatchState.presetResolved),
          })
        } else {
          appendDispatchAudit(dir, {
            ok: false, reason: 'open-failed', source: 'gui', project: payload.project,
            kind: payload.kind, file: row.name, error: r.error || '',
          })
        }
        dispatchState.lastResult = r
        if (r.project) dispatchState.lastProject = r.project
        // 今天已开几个 = 只数 ok:true（被拒的行不占额度）
        dispatchState.todayCount = countToday(readDispatchAudit(dir), Date.now())
      }

      const tick = () => {
        try {
          const settingsInfo = readDispatchSettings(dir)
          // 出厂默认关：**整目录拒收**（不是延迟消费、不是"文件在就开"）。
          // 手写文件、别的 agent 写、旧残留被重建 —— 一样开不出会话，并逐份留审计。
          if (!settingsInfo.settings.enabled) {
            for (const row of listDispatches(dir)) {
              if (inFlight.has(row.name)) continue
              let payload = null
              try { payload = parseDispatch(fs.readFileSync(row.path, 'utf-8')) } catch { payload = null }
              reject(row, 'disabled', payload, payload && payload.source === 'gui' ? 'gui' : 'agent')
            }
            return
          }
          const lim = settingsInfo.settings
          if (active >= lim.concurrency) return
          const rows = listDispatches(dir)
          for (const row of rows) {
            if (active >= lim.concurrency) break
            if (inFlight.has(row.name)) continue
            inFlight.add(row.name)
            active += 1
            handleRow(row, settingsInfo, active - 1)
              .catch((e) => { dispatchState.lastError = String((e && e.message) || e) })
              .finally(() => { inFlight.delete(row.name); active -= 1 })
          }
        } catch (e) {
          dispatchState.lastError = String((e && e.message) || e)
        }
      }
      // 8 秒一拍：比 usage 的 60 秒快，因为这是"人点了按钮在等着看"。
      // 再快就是空转（人不会每 2 秒点一次）。
      timer = setInterval(tick, 8_000)
      if (typeof timer.unref === 'function') timer.unref()
      tick()
      return () => { if (timer) clearInterval(timer) }
    }
    if (typeof root.effect === 'function') root.effect(runDispatch, PLUGIN_NAME + ': dispatch')
    else runDispatch()
  },
}
