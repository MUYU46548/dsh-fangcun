/**
 * 给模型调的方寸工具（REV-014 ②）。
 *
 * 为什么要有它：0.3.0 及之前这个插件只有 4 条 HTTP 路由（给浏览器/挂件看）。
 * 那是**挂件**，不是智能层 —— 模型没有任何一个工具能"调方寸做事"，
 * 全靠提示词里那段写死的 RULES_TEXT 求模型自觉。这一段补的就是那个缺口。
 *
 * 四条纪律（与 usage / proof / cards 同源，越界即错）：
 *  ① **零依赖**：不 import `@deepseek-ai/dsh-tools`，也不 import 方寸代码。
 *     `defineTool` 只是给对象做类型标注 + 校验，返回的就是原对象；
 *     所以我们直接交裸对象给 `ctx.tools.register`，形状按 contracts.ts 对齐。
 *  ② **不碰网络、不起进程**：所有方寸操作只走既有的命名管道 MCP（lib/mcp-pipe.js）。
 *  ③ **不内置模型、不存密钥**：工具只转发，判断留给模型自己。
 *  ④ **写操作不自动吞**：`update_task` / `move_status` 只按模型给的参数调用，
 *     不在插件里"顺手补一步"。插件不是决策者。
 *
 * ⚠ 命名：宿主里方寸 MCP 工具叫 `mcp__fangcun__<tool>`；我们注册的这两个叫
 *   `fangcun_*`。不重名是刻意的 —— 方寸 MCP 客户端断开时（卡
 *   `dsh-里的-fangcun-mcp-客-140864fa`），这两个仍然可用，因为插件自己走管道。
 */

import { McpPipeClient, toolResultToJson, toolResultText } from './mcp-pipe.js'
import { DOWNLOAD_URL } from './detect.js'

/** 工具名 → 它转发的方寸 MCP 工具。**只白名单**：不做任意工具转发（那是提权）。 */
export const TOOL_ROUTES = {
  fangcun_tasks: 'list_tasks',
  fangcun_card: 'get_task',
  fangcun_search: 'search_tasks',
  fangcun_logs: 'list_logs',
  fangcun_log: 'get_log',
  fangcun_context: null, // 特殊：组合 charter + decisions + tasks 三处，见下
  fangcun_write: null, // 特殊：按 action 分发到 update_task / move_status / create_task
  // ── 记忆层 5 个出口（2026-11-25 · P16.1）─────────────────────────
  // 病根：`lib/prompt.js` 从 0.7.1 起就教模型「先 memory_search」，而插件**一个记忆工具都没有**
  // （0.7.8 实测：工具面 7 个，memory_* 0 个）。教了没给 = 模型只能空转。
  // 方寸 MCP 侧 2026-11-17 就有这 5 个口，这里只做白名单转发，不重写逻辑。
  // ⚠ `memory_write` 也是转发：它永远落「待审批」，审批在用户手里，插件不替谁批。
  fangcun_memory_search: 'memory_search',
  fangcun_memory_read: 'memory_read',
  fangcun_memory_core: 'memory_core',
  fangcun_memory_briefing: 'memory_briefing',
  fangcun_memory_organize: 'memory_organize',
  fangcun_memory_write: 'memory_write',
}

/**
 * **永不做**：这些方寸工具**永远不进白名单**（用户 2026-11-17 原话：「delete_task 永不做」）。
 *
 * 为什么把它写成一张显式名单而不是"没写就是不做"：
 * 白名单的默认行为是"不在里面就转发不了"，但**没人会去数"漏了哪些"**。
 * 写成显式名单，测试就能钉住它 —— 将来谁想加，`tool ②b` 会红，他就必须回来读这段。
 *
 * `delete_task` 不做的理由（三条，2026-11-17 逐条查过）：
 *  ① **补了模型也会被拒**：方寸 `writeGate.ts` 的 `DESTRUCTIVE_TOOLS` 含 `delete_task`，
 *    而本机档位是「读写」（不含破坏性）→ 真机原话："已被拒绝"。
 *     发一把永远打不开的钥匙，模型只会把失败当成"方寸坏了"，白花一次调用。
 *  ② **删卡不是 agent 该做的决定**：卡的去留是人的签字（与 `SIGNOFF_STATUSES` 同一条治理口径）。
 *  ③ **真实需求为零**：P0 里唯一那次 `delete_task` 是模型想删自己造的探针卡，
 *    最后改用「驳回」收的 —— 那是习惯问题，不是能力缺口。
 */
export const NEVER_ROUTED = new Set(['delete_task'])

/**
 * `fangcun_context` 拉哪几处方寸数据 —— 一屏说完"这个项目是什么 + 现在该干什么"。
 *
 * 为什么要有这个工具（暮雨 2026-11-17：「方寸要不要直接把记忆层一步到位」+
 * 「好让 DSH 和方寸的组合更顺一点」）：
 *
 *   原来模型开工前只知道"有方寸这个看板"，不知道**这个项目的使命/目标/边界是什么**。
 *   于是它照着通用常识干活 —— 那正是"AI 写代码没全局意识、天天乱改、忘记东西"。
 *
 *   `contextPack`（方寸侧）早就把这六处拼好了，**但它只生成文件，界面上没有"派给 agent"的口子**。
 *   这个工具就是那个口子：模型自己调一次，拿到可用的项目背景。
 *
 * 三处而不是六处：契约（在各仓 repo 里，要额外读盘）与执行日志（很长）先不拉 ——
 * **宁可少给也不塞爆上下文**（暮雨：「上下文空间占满就死了」）。
 */
export const CONTEXT_SOURCES = ['project_charter', 'decision_list', 'list_tasks', 'list_logs', 'memory_core']

/** `fangcun_context` 默认最多带几条决策 / 几张卡 / 几条最近日志 / 几条记忆 */
const MAX_DECISIONS = 8
const MAX_CARDS = 12
const MAX_LOGS = 3

/** 「上次做到哪」里的一段文字上限：日志正文可能几万字，只要下一步 + 结尾结论 */
const MAX_LOG_BLURB = 600

/** `fangcun_write` 允许的 action → 方寸工具名 */
export const WRITE_ACTIONS = {
  create: 'create_task',
  update: 'update_task',
  move: 'move_status',
  // ── 2026-11-24（K3 拍板：A. 现在就做，四个口一起补）──────────────────
  // 原话见问卷《方寸-决策机制三岔路》K3。背景是 2026-11-23 查实的**机器真因**：
  // 插件只注册了 7 个工具、`fangcun_write` 只有 create/update/move，
  // 而技能卡 fangcun-bridge ①.9 早写着「有 ≥2 件要拍板 → 用 qn_propose 出卷」——
  // **技能教了，工具没有**。实测 500 条插件日志 / 14 个会话，问卷类调用 0 次。
  //
  // 四个口一起补的理由（而不是"先开一个试试"）：它们四个共用一个通道、
  // 一样的三道闸（写入闸档位 / 落盘前校验 / 用户签字不由 agent 代劳），
  // 分四次做等于把同一套闸写四遍、也要让你重装四次插件。
  //
  // ⚠ 这四个口**都是"出卷/提议"，不是"拍板"**：
  //   · questionnaire → 落一份待答的卷（用户答完才生效）；
  //   · decision      → 只能落「待审批」（用户点头才转正，REV-005 边界②）；
  //   · stage_plan    → 落一张「待裁决」的阶段卡（用户冻结才生效）；
  //   · smap          → 落一张「待审批」卡，**不碰 policies/**。
  //   任何一个能自己把自己批了，这套闸就白立了。
  qn_propose: 'qn_propose',
  decision_propose: 'decision_propose',
  stage_plan_propose: 'stage_plan_propose',
  smap_propose: 'smap_propose',
}

/**
 * **闸外状态黑名单**：这些状态是用户的验收签字，agent 永远不许设。
 *
 * 两道锁，这是第一道（第二道在方寸本体 `desktop/src/main/mcp/tools.ts` 的 `move_status`，
 * 那里会直接 `isError` 拒绝）。为什么这道也要有：
 *
 *   · **不该先撞墙才知道**。方寸拒绝时会回一条错误，模型那一轮就白花了一次调用；
 *     在这里先挡掉，模型看到的是"这个词不许用"，一次就明白。
 *   · **不许赌锁的位置**。哪天方寸的重构把硬拒挪走了，插件这道还在，
 *     不会一夜之间变成"agent 能自己签收自己"。
 *   · 用户 2026-11-17 的硬规则："DSH 也得过闸……智能层不豁免治理层。"
 *
 * ⚠ 这条名单**只增不减**。要放开某个状态，先去方寸那边确认它不再是签字语义。
 */
export const SIGNOFF_STATUSES = new Set(['完成', '驳回'])

const MAX_ITEMS = 30
const MAX_BODY = 4000

/**
 * 把 `list_tasks` 的结果压成**有界**输出（tool-design.md：bounded outputs）。
 * 只给模型做决定需要的东西：id / 标题 / 状态 / 项目。正文一律不塞。
 *
 * ⚠ `connected` 是 2026-11-17 补的（暮雨："缺什么提示什么"）：
 *   0.4.1 最初在管道失败时返回 `total: 0`，模型会读成「方寸里没有卡」——**那是撒谎**。
 *   「连不上」与「连上了但没卡」对模型的下一步完全不同：
 *   前者要提示用户开方寸，后者才该去建卡。所以两者必须分开。
 *
 * @param {any} raw - 方寸 `list_tasks` 的返回
 * @param {{status?: string, project?: string}} scope - 本次查询的范围
 * @param {boolean} [connected] - 管道通没通（false = 没连上方寸，不是"没有卡"）
 */
export function shapeTasks(raw, scope = {}, connected = true) {
  const tasks = Array.isArray(raw) ? raw : []
  const items = tasks.slice(0, MAX_ITEMS).map((t) => ({
    id: String((t && t.id) || ''),
    title: String((t && t.title) || ''),
    status: String((t && t.status) || ''),
    project: Array.isArray(t && t.project) ? t.project.join(' / ') : String((t && t.project) || ''),
  }))
  return {
    connected: Boolean(connected),
    // 没连上时这句必须给可执行的下一步，而不是让模型自己猜
    hint: connected ? '' : OFFLINE_HINT,
    total: tasks.length,
    returned: items.length,
    // 截断必须说出来，别让模型以为看全了
    truncated: tasks.length > items.length,
    scope: scope.project || '全部项目',
    items,
  }
}

/**
 * 方寸没在跑时的提示。**给下一步，不给道歉。**
 *
 * 三件套里哪一环断了，提示必须指向**那一个**（用户 2026-11-17：
 * "缺插件提示下插件，缺DSH提示下DSH"）—— 所以这句话只覆盖"方寸本体"这一环，
 * 插件/DSH 的缺口由 `lib/compat.js` 与 `detect.js` 各自报，不在这里混说。
 */
export const OFFLINE_HINT =
  '方寸桌面版没有在运行（命名管道连不上）。请让用户打开方寸后重试；'
  + '如果本机还没装方寸，下载页：' + DOWNLOAD_URL

/**
 * 把「章程 + 有效决策 + 未结卡」压成一屏项目背景。
 *
 * 这是**记忆层的可用面**：模型不再只知道"有方寸这个看板"，
 * 而是知道"这个项目要变成什么、最近定过什么、手上还有什么"。
 *
 * ⚠ 三条边界：
 *   ① **有界**：决策 8 条、卡 12 张，超了明说 —— 不放全文，正文让模型按 id 自己取；
 *   ② **不编**：章程哪节空着就写"（未填写）"，不许拿项目名脑补；
 *   ③ **缺什么说什么**：哪一处没拉到就单独标出来，不让整包变成"看起来齐全"。
 *
 * @param {{charter?: any, decisions?: any, tasks?: any, logs?: any, memories?: any}} raw - 五处方寸返回
 * @param {string} project - 项目 id
 * @param {boolean} [connected]
 * @param {boolean} [memoryConnected] - 记忆那一处拉没拉到（false = 别把"没拉到"说成"没有记忆"）
 */
export function shapeContext(raw, project, connected = true, memoryConnected = true) {
  const r = raw || {}
  const charter = r.charter && typeof r.charter === 'object' ? r.charter : {}
  const decisions = Array.isArray(r.decisions) ? r.decisions : []
  const tasks = Array.isArray(r.tasks) ? r.tasks : []
  const logs = Array.isArray(r.logs) ? r.logs : []

  // 章程四节：空就是空，标注出来（`project_charter` 自己的提示也说"缺的是真没写"）
  const section = (v) => {
    const s = String(v || '').trim()
    return s && s !== '（未填写）' ? s : ''
  }
  const missingSections = []
  const mission = section(charter.mission)
  const goal = section(charter.goal)
  const scenario = section(charter.scenario)
  const boundary = section(charter.boundary)
  if (!mission) missingSections.push('使命')
  if (!goal) missingSections.push('目标')
  if (!scenario) missingSections.push('场景')
  if (!boundary) missingSections.push('边界')

  const decItems = decisions.slice(0, MAX_DECISIONS).map((d) => ({
    id: String((d && d.id) || ''),
    // 决策内容是长句，砍到 120 字；要全文让模型自己去查
    text: String((d && (d['内容'] || d.text || d.content)) || '').slice(0, 120),
    date: String((d && d['日期']) || ''),
    status: String((d && d['状态']) || ''),
  }))
  const cardItems = tasks
    .filter((t) => !CLOSED_FOR_CONTEXT.has(String((t && t.status) || '')))
    .slice(0, MAX_CARDS)
    .map((t) => ({
      id: String((t && t.id) || ''),
      title: String((t && t.title) || ''),
      status: String((t && t.status) || ''),
    }))

  // 「上次做到哪」—— 这一格才是 MCP 那条路真正缺的东西：
  // `project_charter` / `decision_list` / `list_tasks` 三处拼起来只回答"这个项目是什么"，
  // **不回答"上一轮干到哪、下一步是什么"**。而后者恰恰是模型开工时最需要、
  // 又最容易凭记忆瞎猜的东西（"AI 忘记东西"的病根）。
  // 只取最新一条日志的**标题 + 下一步 + 状态**，正文一律不塞（日志可以几万字）。
  const logRows = Array.isArray(logs) ? logs : []
  const latest = logRows[0] || null
  const lastLog = latest
    ? {
      id: String(latest.id || ''),
      title: String(latest.title || ''),
      status: String(latest.status || ''),
      created: String(latest.created || ''),
      nextSteps: latest.nextSteps
        ? String(latest.nextSteps).trim().slice(0, MAX_LOG_BLURB)
        : '',
    }
    : { id: '', title: '', status: '', created: '', nextSteps: '' }

  // 记忆层（2026-11-19 重构）：**只注入固定核心块，不注入归档**。
  // 抄 Letta 的 core memory（小、常驻、字符上限）+ Claude memory tool 的 just-in-time。
  // 归档有几条、标题是什么，都不自动塞；模型要细节自己 fangcun_memory_search / fangcun_memory_read。
  const memoryCore = String(r.memoryCore || '')
  const memoryChars = Number.isFinite(Number(r.memoryChars)) ? Number(r.memoryChars) : memoryCore.length
  const memoryBudget = Number.isFinite(Number(r.memoryBudget)) ? Number(r.memoryBudget) : 800
  const memoryArchived = Number.isFinite(Number(r.memoryArchived)) ? Number(r.memoryArchived) : 0
  const memoryTruncated = r.memoryTruncated === true
  // 2026-11-20：方寸记忆开关（缺省开）——关掉时说"已关闭"，不说"core.md 没写"
  const memoryEnabled = r.memoryEnabled !== false

  return {
    connected: Boolean(connected),
    hint: connected ? '' : OFFLINE_HINT,
    project: String(project || ''),
    mission,
    goal,
    scenario,
    boundary,
    // 哪几节没人写过 —— 这是"价值观锚缺了哪块"，比"齐全"重要
    missingSections,
    structureMapAgeDays: Number(charter.structureMapAgeDays) || 0,
    decisions: decItems,
    decisionsTotal: decisions.length,
    decisionsTruncated: decisions.length > decItems.length,
    cards: cardItems,
    // 截断口径按**未结卡**算：拿 `tasks.length` 去比会把"关掉的卡"也算成"还有更多"，
    // 真机上就出现过"只列前 6 张"其实一张没少（2026-11-17 真机读出来的）。
    cardsTruncated: tasks.filter((t) => !CLOSED_FOR_CONTEXT.has(String((t && t.status) || ''))).length > cardItems.length,
    lastLog,
    logsTotal: logRows.length,
    memoryCore,
    memoryChars,
    memoryBudget,
    memoryArchived,
    memoryTruncated,
    memoryEnabled,
    // 拉失败 ≠ 没有记忆。这两个必须分开说（同 connected 与 total=0 的口径）。
    memoryUnavailable: !memoryConnected,
  }
}

/** `fangcun_context` 里不算"手上还有的活"的状态（已关掉的卡不该出现在背景里） */
const CLOSED_FOR_CONTEXT = new Set(['完成', '驳回'])

/**
 * 把 `get_task` 的结果裁到有界长度。
 * 卡正文可能上万字；全塞回去等于把上下文烧光（用户 2026-11-17 的原话：
 * "每次一共就那么多上下文空间，占满对话就死了"）。
 * @param {any} raw - 方寸 `get_task` 的返回
 */
export function shapeCard(raw) {
  // ⚠ 每个分支都必须填满 output.schema 声明的 required 字段：
  //   少一个字段，宿主在 output 校验那步就会拒掉整次调用 —— 那样"连不上方寸"
  //   会以"工具坏了"的样子出现，比直接说没读到更糟。
  if (!raw || typeof raw !== 'object') {
    return {
      id: '', title: '', status: '', project: '', priority: '',
      body: '方寸没有返回这张卡（可能没连上，或卡号不存在）',
      bodyTruncated: false, bodyLength: 0,
    }
  }
  const body = String(raw.body || raw.content || raw.error || '')
  return {
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    status: String(raw.status || ''),
    project: Array.isArray(raw.project) ? raw.project.join(' / ') : String(raw.project || ''),
    priority: String(raw.priority || ''),
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
    bodyTruncated: body.length > MAX_BODY,
    bodyLength: body.length,
  }
}

/**
 * 日志三件套的形状。**为什么日志和卡分开成两个工具**（2026-11-17 真机数据定的）：
 *
 * P0 调查（`tools.jsonl` 500 行 + 会话原文）算出一件事：插件工具真通之后，
 * 新会话里模型 **63 次走插件、只有 6 次走 MCP**，而那 6 次里 **5 次是插件根本没有的能力**
 * （`search_tasks` ×2、`delete_task` ×1，以及 3 次 `list_tasks` 中 2 次是重复调用/掉线报错）。
 *
 * 也就是说：**"模型不选插件"这个前提是错的** —— 有能力时它就走插件。
 * 剩下的 MCP 流量几乎全是缺口，而缺口里最要命的是日志：
 * `list_logs` / `get_log` / `create_log` / `update_log` / `set_log_status` 插件一个都没有。
 *
 * 为什么这不是"顺手补个读口"：暮雨 2026-11-17 明确说
 * 「**真正派活最常用的是从日志走**，之前因为不透明等原因砍掉了。既然直连 DSH 有希望做好」。
 * 所以日志是**派活的正路**，不是附属品 —— 缺了它，`fangcun_context` 那个
 * 「上次做到哪」就是插件唯一能看到日志的地方，而且只能看最新一条。
 *
 * 有界口径与卡一致：列表 20 条、正文 4000 字，超了必须说出来。
 */
const MAX_LOGS_LIST = 20

/** 把 `list_logs` 压成有界输出。没连上时同样**不许**回 0 条冒充"没有日志"。 */
export function shapeLogs(raw, scope = {}, connected = true) {
  const rows = Array.isArray(raw) ? raw : []
  const items = rows.slice(0, MAX_LOGS_LIST).map((l) => ({
    id: String((l && l.id) || ''),
    title: String((l && l.title) || ''),
    status: String((l && l.status) || ''),
    project: String((l && l.project) || ''),
    created: String((l && l.created) || ''),
    running: Boolean(l && l.running),
    continuesFrom: String((l && l.continuesFrom) || ''),
  }))
  return {
    connected: Boolean(connected),
    hint: connected ? '' : OFFLINE_HINT,
    total: rows.length,
    returned: items.length,
    truncated: rows.length > items.length,
    scope: scope.project || '全部项目',
    filter: scope.status || '',
    items,
  }
}

/**
 * 把 `get_log` 裁成有界。日志正文可能几万字 —— 全塞回去等于把上下文烧光。
 *
 * 为什么保留 `chain`：方寸的日志是**接力链**（上游/下游）。派活时"上一棒是怎么交给我的"
 * 比正文更值钱，而它很小。attachments 只给数量 + 绝对路径提示，不展开。
 */
export function shapeLog(raw) {
  // ⚠ 每个分支都要填满 output.schema 的 required：少一个字段宿主会拒掉整次调用
  //
  // ⚠ 2026-11-17 探针抓到的真 bug：方寸对不存在的日志号回的是
  //   `{ok:false,error:'Log not found: …'}`（`isError:true`），而第一版这里只判"不是对象"，
  //   于是 `{ok:false,...}` 被当成正常日志 → 模型看到 `ok:true` + 一片空白正文。
  //   那是最坏的一种错：**读失败伪装成"这条日志是空的"**。现在如实标 ok:false 并把原因写进 body。
  if (raw && typeof raw === 'object' && raw.ok === false) {
    return {
      ok: false, id: '', title: '', status: '', project: '', created: '', completed: '',
      running: false, agentName: '',
      body: '方寸拒绝了这次读：' + String(raw.error || '未知原因'),
      nextSteps: '', continuesFrom: '', attachmentCount: 0, attachmentsHint: '',
      upstream: [], downstream: [], bodyTruncated: false, bodyLength: 0,
    }
  }
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false, id: '', title: '', status: '', project: '', created: '', completed: '',
      running: false, agentName: '', body: '方寸没有返回这条日志（可能没连上，或日志号不存在）',
      nextSteps: '', continuesFrom: '', attachmentCount: 0, attachmentsHint: '',
      upstream: [], downstream: [], bodyTruncated: false, bodyLength: 0,
    }
  }
  const body = String(raw.content || raw.body || '')
  const chain = raw.chain && typeof raw.chain === 'object' ? raw.chain : {}
  const slim = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 8).map((x) => ({
    id: String((x && x.id) || ''),
    title: String((x && x.title) || ''),
    status: String((x && x.status) || ''),
  }))
  const atts = Array.isArray(raw.attachments) ? raw.attachments : []
  return {
    ok: true,
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    status: String(raw.status || ''),
    project: String(raw.project || ''),
    created: String(raw.created || ''),
    completed: String(raw.completed || ''),
    running: Boolean(raw.running),
    agentName: String(raw.agentName || ''),
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
    nextSteps: String(raw.nextSteps || ''),
    continuesFrom: String(raw.continuesFrom || ''),
    attachmentCount: atts.length,
    attachmentsHint: String(raw.attachmentsHint || ''),
    upstream: slim(chain.upstream),
    downstream: slim(chain.downstream),
    bodyTruncated: body.length > MAX_BODY,
    bodyLength: body.length,
  }
}

/**
 * 日志写口：**已对 agent 关闭**（2026-11-19 暮雨拍板）。
 *
 * 原话：「AI 自动写日志我记得已经禁了（因为很乱，日志本来就是用户自己存上下文的地方，
 *        AI 自己写让人搞不懂哪些没做）」。
 *
 * 历史：这里曾有 `LOG_WRITE_ACTIONS` / `logWriteCallOf` / `fangcun_log_write` 三件。
 * 但 `userAsked` 是模型自己填的（闸只证明"模型说用户同意"）；`update_log` 在方寸侧
 * 当时**没有任何闸**；CLI 还有一条完全绕开审计的旁路。
 * 所以现在插件**不再提供任何日志写工具** —— 日志只读（`fangcun_logs` / `fangcun_log`），
 * 写入只允许在方寸界面里做。收工回写走 `fangcun_write` 改卡 + 移「待验收」。
 * 别把 `fangcun_log_write` 加回来：工具在，模型就会用。
 */

/**
 * `fangcun_search` 的形状。与 `shapeTasks` 分开，因为**口径不同**：
 *
 * `list_tasks` 看的是"这个项目手上还有哪些活"（未结卡 + 范围）；
 * 搜索看的是"我说的那个东西在哪"（**跨全部项目、含已完成/驳回**）。
 * 后者要是也按未结卡过滤，模型就永远搜不到"上次是怎么解决这个问题的"。
 *
 * 2026-11-17 真管道实测：`query='派单'` → 9–10 条跨三个项目，其中多数在
 * `list_tasks(project=dsh-fangcun, active)` 里根本看不见。
 */
export function shapeSearch(raw, query, connected = true) {
  const rows = Array.isArray(raw) ? raw : []
  const items = rows.slice(0, MAX_ITEMS).map((t) => ({
    id: String((t && t.id) || ''),
    title: String((t && t.title) || ''),
    status: String((t && t.status) || ''),
    project: Array.isArray(t && t.project) ? t.project.join(' / ') : String((t && t.project) || ''),
  }))
  return {
    connected: Boolean(connected),
    hint: connected ? '' : OFFLINE_HINT,
    query: String(query || ''),
    total: rows.length,
    returned: items.length,
    truncated: rows.length > items.length,
    items,
  }
}

/**
 * `qn_propose`：出一份问卷卷（2026-11-24 · K3 A）。
 *
 * 方寸那边的硬校验（`tools.ts` case 'qn_propose' 与 `data/questionnaires.ts`）：
 *   · 每题要有 id（如 S1）、**至少 2 个选项**、每个选项要有**代价说明 `d`**、每题要有**验收线 `line`**；
 *   · 已有同名卷**绝不覆盖**（修订要换卷名）—— 覆盖掉一份用户正在答的卷是数据事故。
 *
 * 为什么这里也要判一遍：让模型**一次就写对**，而不是撞墙后拿报错返工。
 * 判据只有一份真源（方寸侧），这里只是提前拦明显缺项 —— 方寸仍然会再判一次。
 */
function qnProposeCallOf(args) {
  const title = String(args.title || '').trim()
  if (!title) throw new Error('qn_propose 需要 title（卷标题）')
  const questions = Array.isArray(args.questions) ? args.questions : []
  if (!questions.length) throw new Error('qn_propose 需要 questions（至少一题）')
  const out = questions.map((q, i) => {
    const id = String((q && q.id) || '').trim()
    if (!id) throw new Error(`第 ${i + 1} 题缺 id（形如 S1）—— 用户要靠它选答案`)
    const opts = Array.isArray(q && q.options) ? q.options : []
    if (opts.length < 2) throw new Error(`第 ${i + 1} 题（${id}）只有 ${opts.length} 个选项 —— 至少要 2 个才叫选择题`)
    const line = String((q && q.line) || '').trim()
    if (!line) throw new Error(`第 ${i + 1} 题（${id}）缺验收线（line）—— 没有它，选完了也判不了`)
    return {
      id,
      nav: q.nav ? String(q.nav) : '',
      ask: q.ask ? String(q.ask) : '',
      options: opts.map((o, j) => {
        const k = String((o && o.k) || '').trim()
        if (!k) throw new Error(`第 ${i + 1} 题（${id}）的第 ${j + 1} 个选项缺 k（A/B/C）`)
        const d = String((o && o.d) || '').trim()
        if (!d) throw new Error(`第 ${i + 1} 题（${id}）的选项 ${k} 缺代价说明（d）—— 没有代价的选项等于没给选择`)
        return { k, t: String((o && o.t) || ''), d }
      }),
      look: q.look ? String(q.look) : '',
      src: q.src ? String(q.src) : '',
      line,
    }
  })
  const call = { title, questions: out }
  if (args.deck) call.deck = String(args.deck)
  if (args.project) call.project = String(args.project)
  if (args.boundary) call.boundary = String(args.boundary)
  return { tool: WRITE_ACTIONS.qn_propose, args: call }
}

/**
 * `decision_propose`：把一件定下来的事记成**决策卡**（2026-11-24 · K3 A）。
 *
 * ⚠ 这道闸是 K1 拍板那句话的落点：「审批就不该走任务卡，不要什么都混进任务卡里面。
 *   决策应该有自己的审批入口。」
 *
 * 所以它落的是**决策卡**（`task-data/decisions.md` 的条目），不是任务卡；
 * 而且**只能落「待审批」** —— 用户点头才转正（REV-005 边界②「AI 不能背着你往方寸里塞东西」）。
 * agent 没有"把决策设成有效"的工具，这里是唯一入口，且它说了不算。
 */
function decisionProposeCallOf(args) {
  const content = String(args.content || args.内容 || '').trim()
  if (!content) throw new Error('decision_propose 需要 content（这条决策的内容，一句话说清定了什么）')
  const source = String(args.source || args.出处 || '').trim()
  if (!source) {
    throw new Error('decision_propose 需要 source（出处：哪次对话 / 哪份问卷 / 哪条证据）'
      + ' —— 没有出处的决策是谣言，用户没法核')
  }
  const call = { content, source }
  // 范围与落地：有就给，没有就不传（方寸侧老卡没有这两字段，空值不该落盘）
  if (args.scope) call.scope = String(args.scope)
  if (args.landing) call.landing = String(args.landing)
  if (args.project) call.project = String(args.project)
  if (args.agent) call.agent = String(args.agent)
  // ⚠ 故意**不接受** status / 状态：能不能转正是用户的事，模型传了也不认
  if (args.status || args.状态) {
    throw new Error('decision_propose 不接受 status —— 决策只能落「待审批」，转正由用户点')
  }
  return { tool: WRITE_ACTIONS.decision_propose, args: call }
}

/**
 * `stage_plan_propose`：提议一张**阶段卡**（2026-11-24 · K3 A）。
 *
 * 方寸侧的硬校验：三块（技术方案 / 照抄点 / 判据）**缺一不可**，
 * 判据每行必须以 `cmd:` / `str:` / `num:` / `file:` 开头 —— 否则闸永远判它"判不了"。
 * 落的是「待裁决」：用户冻结才生效。
 */
function stagePlanProposeCallOf(args) {
  const file = String(args.file || (args.project ? `${args.project}.md` : '')).trim()
  if (!file) throw new Error('stage_plan_propose 需要 file（如 fangcun-base.md）或 project')
  const title = String(args.title || '').trim()
  if (!title) throw new Error('stage_plan_propose 需要 title（这一阶段交付什么，一句话）')
  const approach = Array.isArray(args.approach) ? args.approach.map(String) : []
  const criteria = Array.isArray(args.criteria) ? args.criteria.map(String) : []
  const copyRows = Array.isArray(args.copyRows) ? args.copyRows : []
  if (!approach.length) throw new Error('stage_plan_propose 缺「技术方案」（approach）—— 三块缺一不可')
  if (!criteria.length) throw new Error('stage_plan_propose 缺「判据」（criteria）—— 三块缺一不可')
  if (!copyRows.length) throw new Error('stage_plan_propose 缺「照抄点」（copyRows）—— 三块缺一不可；'
    + '没有可照抄的就写一行说明抄自哪里，别留空')
  // 判据前缀：让模型当场知道格式，而不是等方寸拒了再返工
  const bad = criteria.find((c) => !/^(cmd|str|num|file):/.test(String(c).trim()))
  if (bad) {
    throw new Error(`判据必须以 cmd: / str: / num: / file: 开头 —— 这条不合规：${String(bad).slice(0, 60)}`)
  }
  const call = { file, title, approach, criteria, copyRows }
  if (args.what) call.what = String(args.what)
  if (args.stageId) call.stageId = String(args.stageId)
  if (args.deck) call.deck = String(args.deck)
  return { tool: WRITE_ACTIONS.stage_plan_propose, args: call }
}

/**
 * `smap_propose`：提议新版**结构地图**（2026-11-24 · K3 A）。
 *
 * 两条硬边界（方寸侧钉着）：
 *   ① 它**不碰** `policies/<project>.md`，只落一张「待审批」卡；
 *   ② `mapText` 必须带 `最后核实：YYYY-MM-DD` —— 否则是"谁都不敢信的地图"。
 * `reason` 要写清你**扫了什么**（目击证据），空着用户只能猜。
 */
function smapProposeCallOf(args) {
  const project = String(args.project || '').trim()
  if (!project) throw new Error('smap_propose 需要 project（项目 id，如 fangcun-base）')
  const mapText = String(args.mapText || '').trim()
  if (!mapText) throw new Error('smap_propose 需要 mapText（新版结构地图正文）')
  if (!/最后核实[:：]\s*\d{4}-\d{2}-\d{2}/.test(mapText)) {
    throw new Error('mapText 必须含一行 `最后核实：YYYY-MM-DD` —— 没有核实日期的结构地图没人敢信')
  }
  const call = { project, mapText }
  if (args.reason) call.reason = String(args.reason)
  if (args.agent) call.agent = String(args.agent)
  return { tool: WRITE_ACTIONS.smap_propose, args: call }
}

/** 组装 `fangcun_write` 要转发的方寸调用。参数不全就抛 —— 绝不猜。 */
export function writeCallOf(args) {
  const action = String((args && args.action) || '').trim()
  const tool = WRITE_ACTIONS[action]
  if (!tool) {
    throw new Error('action 必须是 create / update / move / qn_propose / decision_propose / '
      + 'stage_plan_propose / smap_propose 之一')
  }
  // ── 四个"出卷 / 提议"口（2026-11-24 · K3 A）──────────────────────────
  // 共同纪律：**只落草稿态，不许自批**；参数不齐一律抛（绝不猜一个默认值填进去）。
  if (action === 'qn_propose') return qnProposeCallOf(args)
  if (action === 'decision_propose') return decisionProposeCallOf(args)
  if (action === 'stage_plan_propose') return stagePlanProposeCallOf(args)
  if (action === 'smap_propose') return smapProposeCallOf(args)
  if (action === 'create') {
    const title = String(args.title || '').trim()
    if (!title) throw new Error('create 需要 title')
    const call = { title }
    if (args.project) call.project = String(args.project)
    if (args.body) call.body = String(args.body)
    if (args.priority) call.priority = String(args.priority)
    if (Array.isArray(args.tags)) call.tags = args.tags.map(String)
    // ⚠ 2026-11-17 真机抓到的 bug：这里原本**根本没映射 status**。
    //   模型传 status:'草稿'，插件直接忽略 → 方寸用默认值「待办」。
    //   症状是"我建了草稿，它却进了待办队列"——而「待办」在方寸里是**要过进队列闸**的
    //   正式状态（可能需要已批准的澄清问卷），「草稿」不是。静默改状态比报错更糟：
    //   模型以为按计划落了卡，人以为那张卡已经排进队。
    //   同理，「完成」/「驳回」是用户的签字，**创建时也不许直接落成终态**（与 move 同一道锁）。
    const status = String(args.status || '').trim()
    if (status) {
      if (SIGNOFF_STATUSES.has(status)) {
        throw new Error(
          `不能直接创建成「${status}」—— 那是用户的验收签字，新建的卡只能是草稿/待办/进行中这类。`,
        )
      }
      call.status = status
    }
    return { tool, args: call }
  }
  const id = String(args.id || '').trim()
  if (!id) throw new Error(action + ' 需要 id')
  if (action === 'move') {
    const status = String(args.status || '').trim()
    if (!status) throw new Error('move 需要 status')
    // 第一道锁：完成/驳回是用户的签字，agent 不许设（第二道在方寸本体）
    if (SIGNOFF_STATUSES.has(status)) {
      throw new Error(
        `「${status}」是用户的验收签字，agent 不能设。`
        + '最多移到「待验收」，然后由用户自己裁决 —— 这是治理层的锁，不要绕。',
      )
    }
    return { tool, args: { id, status } }
  }
  // update：只放模型真给了的字段
  const fields = {}
  for (const key of ['title', 'body', 'status', 'priority']) {
    if (args[key] !== undefined && args[key] !== null && String(args[key]) !== '') {
      fields[key] = String(args[key])
    }
  }
  // update 也能带 status，同样要过闸
  if (fields.status && SIGNOFF_STATUSES.has(fields.status)) {
    throw new Error(
      `「${fields.status}」是用户的验收签字，agent 不能设。`
      + '要改状态请用 action=move 且只移到「待验收」。',
    )
  }
  if (Array.isArray(args.tags)) fields.tags = args.tags.map(String)
  if (Object.keys(fields).length === 0) throw new Error('update 至少要给一个字段')
  return { tool, args: { id, fields } }
}

/**
 * 模型工具的 `parameters` 必须是**完整 JSON Schema**。
 *
 * 宿主（DSH）的 `tools.register` 只校验 `output.schema`，**不编译** parameters：
 * 我们交什么，它就原样发给 provider。若写成「字段名→子 schema」的扁平映射，
 * 等于把属性名摊到 schema 根部 —— 参数里只要有个叫 `title` 的，根上的 `title`
 * 就成了对象，而 JSON Schema 规定 `title` 必须是字符串，prefill 端直接 400，
 * 整轮对话连不上（2026-11-17 真机：Tool 9 的 title 撞保留字）。
 */
function objectParams(properties) {
  return { type: 'object', properties }
}

/**
 * 造两个工具定义。`deps.callTool` 注入是为了单测能替身（不起真管道）。
 * @param {{callTool: (name: string, args?: object) => Promise<any>}} deps
 */
export function buildTools(deps) {
  const callTool = deps.callTool

  const tasksTool = {
    name: 'fangcun_tasks',
    description:
      'List 方寸 (tegula) task cards on this machine. Read-only. Use at the start of work that '
      + 'changes something, so decisions follow what is already recorded instead of memory. '
      + 'Returns id, title, status and project only, capped; bodies stay on the board. '
      + 'Do not call it for chat or pure questions.',
    parameters: objectParams({
      status: {
        type: 'string',
        description: 'Only cards in this 方寸 status, e.g. 待办 / 进行中 / 待验收. Omit for all open cards.',
      },
      project: {
        type: 'string',
        description: 'Only cards of this project id, e.g. dsh-fangcun. Omit for every project.',
      },
      view: {
        type: 'string',
        enum: ['active', 'archive', 'all'],
        description: 'Which view to read. Defaults to active (unfinished cards).',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          hint: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          truncated: { type: 'boolean' },
          scope: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                project: { type: 'string' },
              },
              required: ["id","title","status","project"],
            },
          },
        },
        required: ["connected","hint","total","returned","truncated","scope","items"],
      },
      render: (_args, value) => {
        // 没连上时**不许报"0 张未结"** —— 那是撒谎，模型会去建重复的卡
        if (!value.connected) {
          return [{ type: 'text', text: '方寸未连接 —— 查不到待办（不是"没有卡"）。\n' + value.hint }]
        }
        const head = `方寸 · ${value.scope}：${value.total} 张未结`
          + (value.truncated ? `（只列出前 ${value.returned} 张，还有 ${value.total - value.returned} 张未显示）` : '')
        const lines = value.items.map((t) => `- ${t.id} [${t.status}] ${t.title}`)
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    async execute(args) {
      const view = String((args && args.view) || 'active')
      const project = String((args && args.project) || '').trim()
      const status = String((args && args.status) || '').trim()
      const call = { view }
      if (project) call.project = project
      if (status) call.status = status
      let raw
      try {
        raw = toolResultToJson(await callTool('list_tasks', call))
      } catch {
        // 方寸没开是常态（用户关掉它是正常动作），所以不抛；但**必须说清是"没连上"**，
        // 不能回一个空的 0 —— 那会让模型以为方寸里没有卡（0.4.1 的设计失误，11-17 修）。
        return shapeTasks([], { project }, false)
      }
      if (!Array.isArray(raw)) {
        // 方寸回了但形状不对（工具名改了 / 契约变了）：同样是"没拿到"，不是"没有卡"
        return shapeTasks([], { project }, false)
      }
      return shapeTasks(raw, { project }, true)
    },
    presentCall: (args) => ({ card: 'generic', title: '查方寸待办', kind: 'other', rawInput: args }),
  }

  const cardTool = {
    name: 'fangcun_card',
    description:
      'Read one 方寸 (tegula) task card by id, including its body. Read-only. '
      + 'The body is capped; when `bodyTruncated` is true, read the file on the board for the rest. '
      + 'Call it before changing or reporting on a specific card.',
    parameters: objectParams({
      id: {
        type: 'string',
        description: 'Exact 方寸 card id, e.g. task-20261107-004.',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          project: { type: 'string' },
          priority: { type: 'string' },
          body: { type: 'string' },
          bodyTruncated: { type: 'boolean' },
          bodyLength: { type: 'integer' },
        },
        required: ["id","title","status","project","priority","body","bodyTruncated","bodyLength"],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `# ${value.title}`,
          `id=${value.id} status=${value.status} project=${value.project} priority=${value.priority}`,
          value.bodyTruncated ? `（正文 ${value.bodyLength} 字，此处只给前 ${value.body.length} 字）` : '',
          '',
          value.body,
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute(args) {
      const id = String((args && args.id) || '').trim()
      if (!id) throw new Error('需要 id')
      let raw
      try {
        raw = toolResultToJson(await callTool('get_task', { id }))
      } catch (e) {
        // 读不到就说读不到（带 id），不抛堆栈
        return shapeCard({ ok: false, id, error: String((e && e.message) || e) })
      }
      return shapeCard(raw)
    },
    presentCall: (args) => ({ card: 'generic', title: '读方寸卡', kind: 'other', rawInput: args }),
  }

  const contextTool = {
    name: 'fangcun_context',
    description:
      'Load one 方寸 (tegula) project\'s background in a single call: charter (mission, goal, scenario, '
      + 'boundary), recent valid decisions, open cards, the FIXED memory core (a small curated block, hard-capped; '
      + 'full archival memories are NOT injected — use fangcun_memory_search / fangcun_memory_read on demand), AND where the last '
      + 'working round left off (latest execution log title + its next steps). Read-only. '
      + 'Call it BEFORE working on a project you have not seen in this conversation — it is how this '
      + 'project intends to become, what has already been decided, and what the previous round handed over. '
      + 'This is the 方寸 equivalent of calling project_charter + decision_list + list_tasks + list_logs + get_log '
      + 'separately: one call instead of five. '
      + 'Sections nobody has written come back empty and are listed in `missingSections`; do not invent them.',
    parameters: objectParams({
      project: {
        type: 'string',
        description: 'Exact 方寸 project id, e.g. fangcun-base / sitian / dsh-fangcun.',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          hint: { type: 'string' },
          project: { type: 'string' },
          mission: { type: 'string' },
          goal: { type: 'string' },
          scenario: { type: 'string' },
          boundary: { type: 'string' },
          missingSections: { type: 'array', items: { type: 'string' } },
          structureMapAgeDays: { type: 'integer' },
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                date: { type: 'string' },
                status: { type: 'string' },
              },
              required: ["id","text","date","status"],
            },
          },
          decisionsTotal: { type: 'integer' },
          decisionsTruncated: { type: 'boolean' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
              },
              required: ["id","title","status"],
            },
          },
          cardsTruncated: { type: 'boolean' },
          lastLog: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
              created: { type: 'string' },
              nextSteps: { type: 'string' },
            },
            required: ["id","title","status","created","nextSteps"],
          },
          logsTotal: { type: 'integer' },
          memoryCore: { type: 'string' },
          memoryChars: { type: 'integer' },
          memoryBudget: { type: 'integer' },
          memoryArchived: { type: 'integer' },
          memoryTruncated: { type: 'boolean' },
          memoryEnabled: { type: 'boolean' },
          memoryUnavailable: { type: 'boolean' },
        },
        required: ["connected","hint","project","mission","goal","scenario","boundary","missingSections","structureMapAgeDays","decisions","decisionsTotal","decisionsTruncated","cards","cardsTruncated","lastLog","logsTotal","memoryCore","memoryChars","memoryBudget","memoryArchived","memoryTruncated","memoryEnabled","memoryUnavailable"],
      },
      render: (_args, value) => {
        if (!value.connected) {
          return [{ type: 'text', text: '方寸未连接 —— 拿不到项目背景。\n' + value.hint }]
        }
        const miss = value.missingSections.length
          ? `\n⚠ 章程缺这几节（**真没写，不许替它填**）：${value.missingSections.join(' / ')}`
          : ''
        const head = [
          `# 项目背景：${value.project}`,
          value.mission ? `使命：${value.mission}` : '',
          value.goal ? `目前目标：${value.goal}` : '',
          value.scenario ? `应用场景：${value.scenario}` : '',
          value.boundary ? `方针边界：${value.boundary}` : '',
          value.structureMapAgeDays > 0 ? `（结构地图最后核实：${value.structureMapAgeDays} 天前）` : '',
        ].filter(Boolean).join('\n') + miss
        const dec = value.decisions.length
          ? '\n\n## 最近有效决策\n' + value.decisions
            .map((d) => `- ${d.id}${d.date ? ' ' + d.date : ''} ${d.text}`).join('\n')
            + (value.decisionsTruncated ? `\n（共 ${value.decisionsTotal} 条，只列前 ${value.decisions.length} 条）` : '')
          : ''
        const cards = value.cards.length
          ? '\n\n## 手上还有的活\n' + value.cards
            .map((c) => `- ${c.id} [${c.status}] ${c.title}`).join('\n')
            + (value.cardsTruncated ? `\n（卡还有更多，只列前 ${value.cards.length} 张）` : '')
          : ''
        // 「上次做到哪」必须明说"这是日志，不是任务卡" —— 否则模型会把它当计划照抄
        const log = value.lastLog && value.lastLog.title
          ? [
            '',
            '',
            '## 上次做到哪（最近一条执行日志，**不是任务卡**）',
            `- ${value.lastLog.id} [${value.lastLog.status}] ${value.lastLog.title}`
              + (value.lastLog.created ? ` · ${value.lastLog.created}` : ''),
            value.lastLog.nextSteps ? `- 它留下的下一步：${value.lastLog.nextSteps}` : '- （那条日志没写下一步）',
            value.logsTotal > 1 ? `（这个项目共 ${value.logsTotal} 条相关日志，只取最新一条）` : '',
          ].filter((x, i) => i < 2 || x).join('\n')
          : ''
        const mem = value.memoryEnabled === false
          ? '\n\n## 记忆核心（已关闭）\n'
            + '- 在方寸 → 设置 → 通用 → 记忆 里开启；数据还在，记忆页照常可看可管。'
          : value.memoryUnavailable
            ? '\n\n## 记忆核心（固定注入）\n'
              + '- （**没拉到记忆核心**：方寸版本可能还没有 `memory_core`，或记忆读口失败。'
              + '这不等于没有记忆 —— 别据此说"这个项目没踩过坑"。）'
            : value.memoryCore
              ? '\n\n## 记忆核心（固定注入，上限 ' + value.memoryBudget + ' 字 · 当前 ' + value.memoryChars + ' 字）\n'
                + value.memoryCore
                + (value.memoryTruncated ? `\n（核心超过 ${value.memoryBudget} 字，已截断；请减少钉住条目或精简 core.manual.md）` : '')
                + `\n\n（另有 ${value.memoryArchived} 条归档记忆，**不自动注入**；要细节用 fangcun_memory_search / fangcun_memory_read。）`
              : '\n\n## 记忆核心（固定注入）\n- （memory/core.md 还没写；归档有 '
                + value.memoryArchived + ' 条，按需 fangcun_memory_search —— 不是没有记忆。）'
        return [{ type: 'text', text: head + dec + cards + log + mem }]
      },
    },
    async execute(args) {
      const project = String((args && args.project) || '').trim()
      if (!project) throw new Error('需要 project')
      // 五处**并行**拉：串行会慢五倍，而且五处互不依赖
      const [charterRaw, decisionsRaw, tasksRaw, logsRaw, memoriesRaw] = await Promise.all([
        callTool('project_charter', { project }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
        callTool('decision_list', { project, limit: MAX_DECISIONS }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
        callTool('list_tasks', { view: 'active', project }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
        callTool('list_logs', { project, limit: MAX_LOGS }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
        // 记忆那一处是 2026-11-19 加的；老版方寸没有这个工具时它会失败，
        // 但**不能因此把整个 context 判成没连上** —— 记忆读不到要单独说。
        // 只拉**固定核心**，不拉归档（抄 Letta core + Claude just-in-time）。
        callTool('memory_core', {}).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
      ])
      // 五处**全都**失败才算"没连上"；只要有一处成功，就说明方寸在，缺的那处单独标
      const allFailed = !charterRaw.ok && !decisionsRaw.ok && !tasksRaw.ok && !logsRaw.ok && !memoriesRaw.ok
      if (allFailed) return shapeContext({}, project, false)
      const decisions = decisionsRaw.ok && decisionsRaw.v && Array.isArray(decisionsRaw.v.decisions)
        ? decisionsRaw.v.decisions
        : (decisionsRaw.ok && Array.isArray(decisionsRaw.v) ? decisionsRaw.v : [])
      const logs = logsRaw.ok && Array.isArray(logsRaw.v) ? logsRaw.v.slice(0, MAX_LOGS) : []
      // `list_logs` 不返回下一步 —— 那要 `get_log`。只为**最新一条**补这一跳：
      // 多一跳换"上次做到哪 / 下一步是什么"，这是整个工具最值钱的一格。
      if (logs.length && logs[0] && logs[0].id) {
        try {
          const full = toolResultToJson(await callTool('get_log', { id: String(logs[0].id) }))
          if (full && typeof full === 'object') {
            logs[0] = { ...logs[0], nextSteps: full.nextSteps || '' }
          }
        } catch { /* 拿不到下一步不算失败：标题与状态已经够指路了 */ }
      }
      // 只有**真拿到 text 字符串**才算核心读到了；老版方寸没有这个工具、
      // 或工具回 `{ok:false}` 时，都不能被渲染成"这个项目没有记忆"。
      const memoryOk = !!(memoriesRaw.ok && memoriesRaw.v && typeof memoriesRaw.v.text === 'string')
      const mv = memoryOk ? memoriesRaw.v : {}
      return shapeContext({
        charter: charterRaw.ok ? charterRaw.v : {},
        decisions,
        tasks: tasksRaw.ok ? tasksRaw.v : [],
        logs,
        memoryCore: memoryOk ? String(mv.text || '') : '',
        memoryChars: memoryOk ? Number(mv.chars) || 0 : 0,
        memoryBudget: memoryOk ? Number(mv.budget) || 800 : 800,
        memoryArchived: memoryOk ? Number(mv.archived) || 0 : 0,
        memoryTruncated: memoryOk ? mv.truncated === true : false,
        // 老版方寸没有 enabled 字段 → 缺省按开；只有显式 false 才是用户关了
        memoryEnabled: memoryOk ? mv.enabled !== false : true,
      }, project, true, memoryOk)
    },
    presentCall: (args) => ({ card: 'generic', title: '读项目背景', kind: 'other', rawInput: args }),
  }

  const writeTool = {
    name: 'fangcun_write',
    description:
      'Write to 方寸 (tegula). Seven actions, two families:\n'
      + '· CARD: create / update / move a task card. This is the ONLY way this plugin writes cards, and it writes '
      + 'only what you pass — nothing is inferred or added. Move a finished card to 待验收 and let the human sign it '
      + 'off; never set 完成 or 驳回.\n'
      + '· PROPOSE (2026-11-24): qn_propose (ask the user a questionnaire) / decision_propose (record a decision) / '
      + 'stage_plan_propose (propose a stage card) / smap_propose (propose a new 结构地图). '
      + 'These exist because the skill always told you to use them and the tools did not exist. '
      + 'ALL FOUR land as drafts the user must approve — none of them can approve itself, and none of them touches '
      + 'the user\'s signed-off data. Use them whenever you have ≥2 things that need the user\'s ruling instead of '
      + 'asking in chat and losing the answer.',
    parameters: objectParams({
      action: {
        type: 'string',
        enum: ['create', 'update', 'move', 'qn_propose', 'decision_propose', 'stage_plan_propose', 'smap_propose'],
        description: 'create/update/move a card | qn_propose ask the user | decision_propose record a decision | '
          + 'stage_plan_propose propose a stage card | smap_propose propose a 结构地图.',
      },
      id: {
        type: 'string',
        description: 'Card id. Required for update and move.',
      },
      title: { type: 'string', description: 'Card title (create) / deck title (qn_propose) / stage title (stage_plan_propose).' },
      body: { type: 'string', description: 'Card body in Markdown.' },
      status: {
        type: 'string',
        description:
          'Target status for move, e.g. 待验收. 完成 and 驳回 are the user\'s sign-off and are rejected.',
      },
      priority: { type: 'string', description: '高 / 中 / 低.' },
      project: { type: 'string', description: 'Project id (create / qn_propose / decision_propose / smap_propose).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
      // ── qn_propose ──────────────────────────────────────────────────
      deck: { type: 'string', description: 'qn_propose: file stem (omit to derive from title). Never overwrites.' },
      boundary: { type: 'string', description: 'qn_propose: 使用边界 sentence for the deck.' },
      questions: {
        type: 'array',
        description: 'qn_propose: questions in order. Every one needs id, ≥2 options (each with a cost `d`), and a `line`.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'S1 / M2 — letters + digits, unique.' },
            nav: { type: 'string', description: 'Short nav name.' },
            ask: { type: 'string', description: 'The question itself.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  k: { type: 'string', description: 'A / B / C' },
                  t: { type: 'string', description: 'Option title' },
                  d: { type: 'string', description: 'What it is + what it costs (required).' },
                },
                required: ['k', 't', 'd'],
              },
            },
            look: { type: 'string', description: '【看一眼】reference / entry point.' },
            src: { type: 'string', description: '【出处】where the evidence comes from.' },
            line: { type: 'string', description: '【验收线】what counts as a violation after choosing (required).' },
          },
          required: ['id', 'options', 'line'],
        },
      },
      // ── decision_propose ────────────────────────────────────────────
      content: { type: 'string', description: 'decision_propose: what was decided (one sentence).' },
      source: { type: 'string', description: 'decision_propose: where it came from (quote / deck / evidence) — required.' },
      scope: { type: 'string', description: 'decision_propose: 生效范围 (本卷 / 全局 / a project id).' },
      landing: { type: 'string', description: 'decision_propose: 落地 (task id / commit / 不做(理由)).' },
      agent: { type: 'string', description: 'Who proposes (smap_propose / decision_propose).' },
      // ── stage_plan_propose ──────────────────────────────────────────
      file: { type: 'string', description: 'stage_plan_propose: plan file name, e.g. fangcun-base.md.' },
      stageId: { type: 'string', description: 'stage_plan_propose: e.g. P8 (omit for the next free number).' },
      what: { type: 'string', description: 'stage_plan_propose: one-sentence scope.' },
      approach: { type: 'array', items: { type: 'string' }, description: 'stage_plan_propose: 技术方案 bullets (required).' },
      copyRows: {
        type: 'array',
        description: 'stage_plan_propose: 照抄点 rows [["项","来源","原文"], …] (required; header row optional).',
        items: { type: 'array', items: { type: 'string' } },
      },
      criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'stage_plan_propose: 判据 lines (required). Each MUST start with cmd: / str: / num: / file:.',
      },
      // ── smap_propose ────────────────────────────────────────────────
      mapText: { type: 'string', description: 'smap_propose: new 结构地图 body; must contain 最后核实：YYYY-MM-DD.' },
      reason: { type: 'string', description: 'smap_propose: what you actually scanned (files/dirs).' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          tool: { type: 'string' },
          result: { type: 'string' },
        },
        required: ["ok","action","tool","result"],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `方寸 · ${value.action} 成功（${value.tool}）`
          : `方寸 · ${value.action} 失败：${value.result}`,
      }],
    },
    async execute(args) {
      const action = String((args && args.action) || '').trim()
      const call = writeCallOf(args)   // 参数不全会在这里抛，模型能看到原因
      let raw
      try {
        raw = toolResultToJson(await callTool(call.tool, call.args))
      } catch (e) {
        // 连不上/超时也如实回，不假装写进去了；**并且给下一步**
        // （与读工具的 `hint` 同一口径：缺什么说什么，别让模型自己猜）
        return {
          ok: false,
          action,
          tool: call.tool,
          result: String((e && e.message) || e) + '\n' + OFFLINE_HINT,
        }
      }
      const ok = !(raw && raw.ok === false)
      return {
        ok,
        action,
        tool: call.tool,
        result: ok ? JSON.stringify(raw).slice(0, MAX_BODY) : String((raw && raw.error) || JSON.stringify(raw)),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '写方寸', kind: 'other', rawInput: args }),
  }

  /**
   * 日志列表。**为什么先于卡写口补齐**：暮雨 2026-11-17
   * 「真正派活最常用的是从日志走，之前因为不透明等原因砍掉了」——
   * 也就是说日志是派活的正路。插件此前对它完全失明。
   */
  /**
   * 关键词搜索。**为什么不复用 `fangcun_tasks`**：两者口径根本不同 ——
   * `fangcun_tasks` 回答"这个项目手上还有哪些活"（某项目 + 未结卡）；
   * 本工具回答"我说的那个东西在哪"（**跨全部项目 + 含已完成/驳回**）。
   * 后者要是也按未结卡过滤，模型就永远搜不到"上次是怎么解决这个问题的"。
   *
   * ⚠ **空查询必须拒**（2026-11-17 真管道实测）：`search_tasks('')` 回 **396 条**。
   *   放了它等于让模型用一个空字符串把整张看板拉进上下文 —— 正是用户说的
   *   "每次一共就那么多上下文空间，占满对话就死了"。所以空 query 直接抛，不算搜索。
   */
  const searchTool = {
    name: 'fangcun_search',
    description:
      'Full-text search across 方寸 (tegula) card titles, bodies and tags — EVERY project and EVERY status, '
      + 'including 完成/驳回. Read-only. Use it when you remember a card about something but do not know its '
      + 'id or which project it is in; fangcun_tasks cannot do this (it lists one project\'s open cards, with no '
      + 'keyword filter). Returns id/title/status/project only, capped — read one with fangcun_card. '
      + 'The query must be non-empty.',
    parameters: objectParams({
      query: {
        type: 'string',
        description: 'Search words. Required and non-empty — an empty query would return the whole board.',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          hint: { type: 'string' },
          query: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          truncated: { type: 'boolean' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                project: { type: 'string' },
              },
              required: ["id","title","status","project"],
            },
          },
        },
        required: ["connected","hint","query","total","returned","truncated","items"],
      },
      render: (_args, value) => {
        if (!value.connected) {
          return [{ type: 'text', text: '方寸未连接 —— 搜不到卡（不是"没有匹配"）。\n' + value.hint }]
        }
        if (value.total === 0) {
          // 「搜了但没中」与「没连上」必须能区分，措辞也不许含糊
          return [{ type: 'text', text: `方寸 · 搜「${value.query}」：没有匹配的卡。` }]
        }
        const head = `方寸 · 搜「${value.query}」：${value.total} 条（跨全部项目与状态）`
          + (value.truncated ? `（只列出前 ${value.returned} 条）` : '')
        const lines = value.items.map((t) => `- ${t.id} [${t.status}] ${t.project} · ${t.title}`)
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    async execute(args) {
      // 空查询 = 拉整张看板（实测 396 条），必须拒
      const query = String((args && args.query) || '').trim()
      if (!query) throw new Error('query 不能为空 —— 空查询会把整张看板拉进上下文，那不是搜索')
      let raw
      try {
        raw = toolResultToJson(await callTool('search_tasks', { query }))
      } catch {
        return shapeSearch([], query, false)
      }
      if (!Array.isArray(raw)) return shapeSearch([], query, false)
      return shapeSearch(raw, query, true)
    },
    presentCall: (args) => ({ card: 'generic', title: '搜方寸卡', kind: 'other', rawInput: args }),
  }

  const logsTool = {
    name: 'fangcun_logs',
    description:
      'List 方寸 (tegula) execution logs (执行日志) — where work actually gets handed over between rounds. '
      + 'Read-only. This is the main dispatch path: read the latest log before starting, because it says what '
      + 'the previous round did and what it left for you. Returns id/title/status/project/created only; '
      + 'use fangcun_log for the body. Do not call it for chat or pure questions.',
    parameters: objectParams({
      project: { type: 'string', description: 'Only logs of this project id, e.g. dsh-fangcun.' },
      status: { type: 'string', description: 'Only logs in this status, e.g. 进行中 / 已完成 / 已归档.' },
      limit: { type: 'integer', description: 'Max rows (default 20).' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          hint: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          truncated: { type: 'boolean' },
          scope: { type: 'string' },
          filter: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                project: { type: 'string' },
                created: { type: 'string' },
                running: { type: 'boolean' },
                continuesFrom: { type: 'string' },
              },
              required: ["id","title","status","project","created","running","continuesFrom"],
            },
          },
        },
        required: ["connected","hint","total","returned","truncated","scope","filter","items"],
      },
      render: (_args, value) => {
        if (!value.connected) {
          return [{ type: 'text', text: '方寸未连接 —— 读不到执行日志（不是"没有日志"）。\n' + value.hint }]
        }
        const head = `方寸 · ${value.scope} 执行日志：${value.total} 条（${value.filter || '全部状态'}）`
          + (value.truncated ? `（只列出前 ${value.returned} 条）` : '')
        const lines = value.items.map((l) => `- ${l.id} [${l.status}] ${l.title}`
          + (l.running ? ' ·进行中' : '') + (l.continuesFrom ? ` ← ${l.continuesFrom}` : ''))
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    async execute(args) {
      const project = String((args && args.project) || '').trim()
      const status = String((args && args.status) || '').trim()
      const limit = Number((args && args.limit)) > 0 ? Number(args.limit) : MAX_LOGS_LIST
      const call = { limit: Math.min(limit, MAX_LOGS_LIST) }
      if (project) call.project = project
      if (status) call.status = status
      let raw
      try {
        raw = toolResultToJson(await callTool('list_logs', call))
      } catch {
        return shapeLogs([], { project, status }, false)
      }
      if (!Array.isArray(raw)) return shapeLogs([], { project, status }, false)
      return shapeLogs(raw, { project, status }, true)
    },
    presentCall: (args) => ({ card: 'generic', title: '查方寸日志', kind: 'other', rawInput: args }),
  }

  const logTool = {
    name: 'fangcun_log',
    description:
      'Read ONE 方寸 (tegula) execution log by id: body, next steps, status, and its relay chain (接力链 '
      + 'upstream/downstream) so you can walk the chain yourself. Read-only. This is the hand-over record — '
      + 'read it before resuming work someone else left unfinished. The body is capped; when `bodyTruncated` '
      + 'is true, read the file on the board for the rest. '
      + 'Log writing is USER-ONLY (2026-11-19): there is no agent tool for it — write the result into a card instead.',
    parameters: objectParams({
      id: { type: 'string', description: 'Exact 方寸 log id, e.g. log_20261117132156_aqar1n.' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          project: { type: 'string' },
          created: { type: 'string' },
          completed: { type: 'string' },
          running: { type: 'boolean' },
          agentName: { type: 'string' },
          body: { type: 'string' },
          nextSteps: { type: 'string' },
          continuesFrom: { type: 'string' },
          attachmentCount: { type: 'integer' },
          attachmentsHint: { type: 'string' },
          upstream: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
              },
              required: ["id","title","status"],
            },
          },
          downstream: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
              },
              required: ["id","title","status"],
            },
          },
          bodyTruncated: { type: 'boolean' },
          bodyLength: { type: 'integer' },
        },
        required: ["ok","id","title","status","project","created","completed","running","agentName","body","nextSteps","continuesFrom","attachmentCount","attachmentsHint","upstream","downstream","bodyTruncated","bodyLength"],
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.body }]
        const up = value.upstream.length ? value.upstream.map((x) => `- ${x.id} [${x.status}] ${x.title}`) : []
        const down = value.downstream.length ? value.downstream.map((x) => `- ${x.id} [${x.status}] ${x.title}`) : []
        return [{
          type: 'text',
          text: [
            `# ${value.title}`,
            `id=${value.id} status=${value.status} project=${value.project}`
              + (value.running ? ' ·进行中' : '') + (value.agentName ? ` by=${value.agentName}` : ''),
            value.created ? `创建 ${value.created}` + (value.completed ? ` · 结束 ${value.completed}` : '') : '',
            value.bodyTruncated ? `（正文 ${value.bodyLength} 字，此处只给前 ${value.body.length} 字）` : '',
            '',
            value.body,
            value.nextSteps ? `\n## 下一步\n${value.nextSteps}` : '\n（这条日志没写下一步）',
            up.length ? '\n## 接力链上游\n' + up.join('\n') : '',
            down.length ? '\n## 接力链下游\n' + down.join('\n') : '',
            value.attachmentCount > 0 ? `\n（附件 ${value.attachmentCount} 个${value.attachmentsHint ? '：' + value.attachmentsHint : ''}）` : '',
          ].filter(Boolean).join('\n'),
        }]
      },
    },
    async execute(args) {
      const id = String((args && args.id) || '').trim()
      if (!id) throw new Error('需要 id')
      let raw
      try {
        raw = toolResultToJson(await callTool('get_log', { id }))
      } catch (e) {
        return shapeLog({ ok: false, id, content: String((e && e.message) || e) })
      }
      return shapeLog(raw)
    },
    presentCall: (args) => ({ card: 'generic', title: '读方寸日志', kind: 'other', rawInput: args }),
  }

  // 2026-11-19：`fangcun_log_write` 已整体移除（日志写口对 agent 关闭，见文件上方注释）。
  // 保留读口 `fangcun_logs` / `fangcun_log`；写入只允许在方寸界面做。

  // ── 记忆层 5 个出口（2026-11-25 · P16.1）──────────────────────────────
  // 与上方四条纪律同源：
  //  ① 只白名单转发（不造第二条读写路径）；
  //  ② 输出有界：search / briefing 只给 claim 行，证据要显式 read；
  //  ③ 没连上就如实说"读不到"，不许说成"没有记忆"（本仓四态混淆栽过四次）；
  //  ④ 写口只说「已落待审批」，不假装已经生效（自批在方寸侧也是拒的）。
  const MEMORY_LIMIT = 4000
  const MEMORY_READ_LIMIT = 8000
  const clipText = (s, n) => {
    const t = String(s == null ? '' : s)
    return t.length > n ? t.slice(0, n) + `\n（已截断：原文 ${t.length} 字，只给前 ${n} 字）` : t
  }
  const parseMaybeJson = (text) => { try { return JSON.parse(text) } catch { return null } }
  /**
   * 方寸 MCP 的提示语里写的是 `memory_read` 这类**MCP 工具名**；插件里模型拿到的是
   * `fangcun_memory_read`。不换名就是"提示让用、工具面里没有"的老病（P16.1 的病根）。
   * 只换裸名字，不碰已经带 fangcun_ 前缀的。
   */
  const pluginMemoryHint = (s) => String(s == null ? '' : s)
    .replace(/(?<!fangcun_)memory_(search|read|write|core|briefing)/g, 'fangcun_memory_$1')

  function memoryToolOf(opts) {
    const limit = opts.limit || MEMORY_LIMIT
    return {
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            connected: { type: 'boolean' },
            enabled: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['ok', 'connected', 'enabled', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        let result
        try {
          result = await callTool(opts.route, args || {})
        } catch {
          return {
            ok: false, connected: false, enabled: true,
            text: '方寸未连接 —— 记忆读不到（不是"没有记忆"）。\n' + OFFLINE_HINT,
          }
        }
        const text = toolResultText(result)
        const raw = parseMaybeJson(text)
        if (raw && raw.ok === false) {
          return {
            ok: false, connected: true, enabled: raw.enabled !== false,
            text: `方寸 · 记忆操作失败：${raw.error || '未知错误'}`
              + (raw.hint ? '\n' + raw.hint : ''),
          }
        }
        // 纯文本回包：memory_read 是正文；其它工具收到纯文本 = 方寸报错/老版本没这个工具。
        // 如实转给模型，不装作成功（也不许说成"没有记忆"）。
        if (!raw && opts.rawText !== true) {
          return {
            ok: false, connected: true, enabled: true,
            text: clipText(text || '方寸记忆返回了看不懂的内容', limit),
          }
        }
        const enabled = !(raw && raw.enabled === false)
        let out
        try {
          out = opts.format(raw, text, args || {})
        } catch (e) {
          out = '方寸 · 记忆返回的形状不认识：' + String((e && e.message) || e)
        }
        return { ok: true, connected: true, enabled, text: clipText(out, limit) }
      },
      presentCall: (args) => ({ card: 'generic', title: '方寸记忆', kind: 'other', rawInput: args }),
    }
  }

  const memorySearchTool = memoryToolOf({
    name: 'fangcun_memory_search',
    route: 'memory_search',
    description:
      'Search 方寸记忆 (memory/): past incidents, lessons and cross-project 纪律. Read-only. '
      + 'Answers "what happened / which rule was bought with a real loss", NOT "what to do next" (that is a card). '
      + 'Returns one-line claims + metadata; use fangcun_memory_read for the verbatim evidence. '
      + 'Revoked entries are excluded unless includeRevoked; pending proposals are excluded unless includePending. '
      + 'An empty q returns the whole store — only for an explicit "show me everything".',
    parameters: objectParams({
      q: { type: 'string', description: 'Full-text keyword, searched over claim / tags / evidence / id' },
      type: { type: 'string', description: 'One of: 事故 / 教训 / 纪律 / 决定 / 偏好 / 事实' },
      scope: { type: 'string', description: '适用范围, e.g. 跨项目' },
      project: { type: 'string', description: 'Project id, e.g. fangcun-base' },
      includeRevoked: { type: 'boolean', description: 'Include 已撤销 entries (default false)' },
      includePending: { type: 'boolean', description: 'Include 待审批 proposals (default false)' },
      includeLedgers: { type: 'boolean', description: 'Also search the four ledgers (pointers only)' },
      ledgerKind: { type: 'string', description: 'With includeLedgers: decision / log / card / charter' },
      limit: { type: 'integer', description: 'Max rows (default 10, max 50)' },
    }),
    format(raw) {
      if (!raw) return '方寸 · 记忆返回了看不懂的内容'
      const items = Array.isArray(raw.items) ? raw.items : []
      const head = `方寸记忆 · ${raw.total || 0} 条命中（返回 ${raw.returned == null ? items.length : raw.returned}）`
        + (raw.truncated ? ' · 已截断' : '')
      const lines = items.map((x) => `- [${x.type || '?'}] ${x.id} · ${x.project || '跨项目'} · ${x.claim || ''}`
        + (x.score != null ? `（${Number(x.score).toFixed(2)}）` : ''))
      return [head, ...lines, pluginMemoryHint(raw.hint), pluginMemoryHint(raw.next)].filter(Boolean).join('\n')
    },
  })

  const memoryReadTool = memoryToolOf({
    name: 'fangcun_memory_read',
    route: 'memory_read',
    limit: MEMORY_READ_LIMIT,
    rawText: true,
    description:
      'Read one memory entry by its `file` path returned by fangcun_memory_search (e.g. memory/claims/x.md). '
      + 'Read-only. Returns the verbatim evidence; pass `anchor` (e.g. D5) to return only that section — '
      + 'a missing anchor is an error, never a silent full-file dump. Truncation is reported, never silent.',
    parameters: objectParams({
      file: { type: 'string', description: 'Relative path from fangcun_memory_search, e.g. memory/claims/x.md' },
      maxChars: { type: 'integer', description: 'Max characters (default 8000, max 200000)' },
      anchor: { type: 'string', description: 'Section heading inside the evidence file, e.g. D5' },
    }),
    format(_raw, text) { return text || '（空）' },
  })

  const memoryCoreTool = memoryToolOf({
    name: 'fangcun_memory_core',
    route: 'memory_core',
    description:
      'Fixed core memory (memory/core.md): the small generated block of pinned claims that is safe to inject '
      + 'into every session. Read-only. Full evidence is NEVER injected — use fangcun_memory_search / '
      + 'fangcun_memory_read on demand. If the memory switch (or the 「开工自动注入核心」 sub-switch) is off, '
      + 'it says so and still reports how many entries exist instead of pretending the core is missing.',
    parameters: objectParams({
      force: {
        type: 'boolean',
        description: 'Return the core even if the 「开工自动注入核心」 sub-switch is off (one-off read).',
      },
    }),
    format(raw) {
      if (!raw) return '（空）'
      if (raw.enabled === false) return raw.hint || '记忆已关闭；数据还在。'
      if (raw.subEnabled === false) return raw.hint || '「开工自动注入核心」关着；库里的记忆还在。'
      const head = `方寸记忆核心（${raw.chars || 0}/${raw.budget || 0} 字 · 钉住 ${raw.pinnedCount || 0} 条）`
      return [head, raw.text || '', pluginMemoryHint(raw.hint)].filter(Boolean).join('\n')
    },
  })

  const memoryBriefingTool = memoryToolOf({
    name: 'fangcun_memory_briefing',
    route: 'memory_briefing',
    description:
      'Bounded briefing of EFFECTIVE memories relevant to one project (that project + 跨项目), ranked by '
      + 'importance / freshness / usage. Read-only. Pending and revoked entries are excluded; each row is a '
      + 'one-line claim only — use fangcun_memory_read for the verbatim evidence. Call it before starting work '
      + 'on a project.',
    parameters: objectParams({
      project: { type: 'string', description: 'Project id, e.g. fangcun-base' },
      limit: { type: 'integer', description: 'Max rows (default 5, max 20)' },
      force: {
        type: 'boolean',
        description: 'Return it even if the 「按项目开工简报」 sub-switch is off (one-off read).',
      },
    }),
    format(raw) {
      if (!raw) return '（空）'
      const items = Array.isArray(raw.items) ? raw.items : []
      const head = `方寸记忆简报 · ${raw.project || ''}：${raw.total || 0} 条（返回 ${raw.returned == null ? items.length : raw.returned}）`
        + (raw.reviewOverdue ? ` · ${raw.reviewOverdue} 条待复核` : '')
      const lines = items.map((x) => `- [${x.type || '?'}] ${x.id} · ${x.claim || ''}`
        + (x.reviewOverdue ? '（已过复核周期）' : ''))
      return [head, ...lines, pluginMemoryHint(raw.hint)].filter(Boolean).join('\n')
    },
  })

  const memoryOrganizeTool = memoryToolOf({
    name: 'fangcun_memory_organize',
    route: 'memory_organize',
    limit: 16000,
    description:
      'Build the 方寸 「整理包」 (READ-ONLY): recent execution logs + finished/rejected cards as candidate sources, '
      + 'plus the hard rules for turning them into memories. It does NOT call a model and writes NOTHING. Use it at '
      + 'the end of a piece of work or when the user asks to 整理记忆: read the package, then call '
      + 'fangcun_memory_write per candidate (≤8, always 待审批); skip anything without a [source] id, and search '
      + 'first (fangcun_memory_search) so the same lesson is not recorded twice.',
    parameters: objectParams({
      project: { type: 'string', description: 'Project id, e.g. fangcun-base (omit for all projects)' },
      limit: { type: 'integer', description: 'Max candidate sources (default 24, max 24)' },
    }),
    format(raw) {
      if (!raw) return '（空）'
      const head = `方寸记忆整理包 · ${raw.count == null ? 0 : raw.count} 条候选来源（只读，未写任何东西）`
      return [head, raw.prompt || ''].filter(Boolean).join('\n\n')
    },
  })

  const memoryWriteTool = memoryToolOf({
    name: 'fangcun_memory_write',
    route: 'memory_write',
    description:
      'PROPOSE one 方寸 memory entry for user approval. It ALWAYS lands as 状态: 待审批 — the user approves it '
      + 'in the 记忆 page; you cannot make it effective, and default search will not return it until then. '
      + 'One memory = one claim (1–2 sentences) + verbatim evidence + a traceable source. Use when the user '
      + 'says "记住", or when a lesson was bought with a real loss. Task-card content does NOT belong here.',
    parameters: objectParams({
      type: { type: 'string', description: '事故 / 教训 / 纪律 / 决定 / 偏好 / 事实' },
      claim: { type: 'string', description: 'One-sentence claim (≤200 chars, ideally ≤120) — the only text that gets recalled' },
      evidence: { type: 'string', description: 'Verbatim original text / verified facts; do not summarize' },
      source: { type: 'string', description: 'Where it came from: user quote / incident / file path (required)' },
      confidence: { type: 'number', description: '0–1; agent proposals are capped at 0.8' },
      importance: { type: 'integer', description: '1–5; 5 = irreversible loss / safety' },
      project: { type: 'string', description: 'Project id, or 跨项目' },
      scope: { type: 'string', description: '适用范围, e.g. 跨项目' },
      tags: { type: 'array', items: { type: 'string' } },
      pinned: { type: 'boolean', description: 'Pin into the generated core (only a few)' },
      supersedes: { type: 'string', description: 'Id of the memory this one replaces; old one becomes 已撤销 on approval' },
      evidencePath: { type: 'string', description: 'Pointer to a long evidence file under memory/' },
      evidenceAnchor: { type: 'string', description: 'Section heading in that evidence file' },
    }),
    format(raw) {
      if (!raw) return '方寸 · 记忆返回了看不懂的内容'
      return `方寸记忆 · 已提交（${raw.status || '待审批'}）：${raw.id || ''}`
        + (raw.file ? ` · ${raw.file}` : '')
        + '\n' + pluginMemoryHint(raw.hint || '用户在记忆页点通过后才生效；你现在还不能当作现行规矩用。')
    },
  })

  return [
    tasksTool, cardTool, contextTool, writeTool, searchTool, logsTool, logTool,
    memorySearchTool, memoryReadTool, memoryCoreTool, memoryBriefingTool, memoryOrganizeTool, memoryWriteTool,
  ]
}

/** 真跑时用的 callTool：每次调用开一条管道连接，用完即关（方寸没开就抛，由 execute 兜） */
export function makePipeCallTool(opts) {
  return async (name, args) => {
    const client = new McpPipeClient({ pipePath: opts.pipePath, version: opts.version })
    try {
      return await client.callTool(name, args)
    } finally {
      try { client.close() } catch { /* ignore */ }
    }
  }
}
