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

import { McpPipeClient, toolResultToJson } from './mcp-pipe.js'
import { DOWNLOAD_URL } from './detect.js'

/** 工具名 → 它转发的方寸 MCP 工具。**只白名单**：不做任意工具转发（那是提权）。 */
export const TOOL_ROUTES = {
  fangcun_tasks: 'list_tasks',
  fangcun_card: 'get_task',
  fangcun_context: null, // 特殊：组合 charter + decisions + tasks 三处，见下
  fangcun_write: null, // 特殊：按 action 分发到 update_task / move_status / create_task
}

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
export const CONTEXT_SOURCES = ['project_charter', 'decision_list', 'list_tasks']

/** `fangcun_context` 默认最多带几条决策 / 几张卡 */
const MAX_DECISIONS = 8
const MAX_CARDS = 12

/** `fangcun_write` 允许的 action → 方寸工具名 */
export const WRITE_ACTIONS = {
  create: 'create_task',
  update: 'update_task',
  move: 'move_status',
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
 * @param {{charter?: any, decisions?: any, tasks?: any}} raw - 三处方寸返回
 * @param {string} project - 项目 id
 * @param {boolean} [connected]
 */
export function shapeContext(raw, project, connected = true) {
  const r = raw || {}
  const charter = r.charter && typeof r.charter === 'object' ? r.charter : {}
  const decisions = Array.isArray(r.decisions) ? r.decisions : []
  const tasks = Array.isArray(r.tasks) ? r.tasks : []

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
    cardsTruncated: tasks.length > cardItems.length,
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

/** 组装 `fangcun_write` 要转发的方寸调用。参数不全就抛 —— 绝不猜。 */
export function writeCallOf(args) {
  const action = String((args && args.action) || '').trim()
  const tool = WRITE_ACTIONS[action]
  if (!tool) {
    throw new Error('action 必须是 create / update / move 之一')
  }
  if (action === 'create') {
    const title = String(args.title || '').trim()
    if (!title) throw new Error('create 需要 title')
    const call = { title }
    if (args.project) call.project = String(args.project)
    if (args.body) call.body = String(args.body)
    if (args.priority) call.priority = String(args.priority)
    if (Array.isArray(args.tags)) call.tags = args.tags.map(String)
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
      + 'boundary), recent valid decisions, and open cards. Read-only. '
      + 'Call it BEFORE working on a project you have not seen in this conversation — it is how this '
      + 'project intends to become, and what has already been decided. '
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
        },
        required: ["connected","hint","project","mission","goal","scenario","boundary","missingSections","structureMapAgeDays","decisions","decisionsTotal","decisionsTruncated","cards","cardsTruncated"],
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
        return [{ type: 'text', text: head + dec + cards }]
      },
    },
    async execute(args) {
      const project = String((args && args.project) || '').trim()
      if (!project) throw new Error('需要 project')
      // 三处**并行**拉：串行会慢三倍，而且三处互不依赖
      const [charterRaw, decisionsRaw, tasksRaw] = await Promise.all([
        callTool('project_charter', { project }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
        callTool('decision_list', { project, limit: MAX_DECISIONS }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
        callTool('list_tasks', { view: 'active', project }).then((x) => ({ ok: true, v: toolResultToJson(x) })).catch((e) => ({ ok: false, e })),
      ])
      // 三处**全都**失败才算"没连上"；只要有一处成功，就说明方寸在，缺的那处单独标
      const allFailed = !charterRaw.ok && !decisionsRaw.ok && !tasksRaw.ok
      if (allFailed) return shapeContext({}, project, false)
      const decisions = decisionsRaw.ok && decisionsRaw.v && Array.isArray(decisionsRaw.v.decisions)
        ? decisionsRaw.v.decisions
        : (decisionsRaw.ok && Array.isArray(decisionsRaw.v) ? decisionsRaw.v : [])
      return shapeContext({
        charter: charterRaw.ok ? charterRaw.v : {},
        decisions,
        tasks: tasksRaw.ok ? tasksRaw.v : [],
      }, project, true)
    },
    presentCall: (args) => ({ card: 'generic', title: '读项目背景', kind: 'other', rawInput: args }),
  }

  const writeTool = {
    name: 'fangcun_write',
    description:
      'Write to 方寸 (tegula): create a card, update one, or move one to another status. '
      + 'This is the ONLY way this plugin writes, and it writes only what you pass — nothing is inferred or added. '
      + 'Move a finished card to 待验收 and let the human sign it off; never set 完成 or 驳回.',
    parameters: objectParams({
      action: {
        type: 'string',
        enum: ['create', 'update', 'move'],
        description: 'create a new card | update fields of an existing one | move one to another status.',
      },
      id: {
        type: 'string',
        description: 'Card id. Required for update and move.',
      },
      title: { type: 'string', description: 'Card title. Required for create.' },
      body: { type: 'string', description: 'Card body in Markdown.' },
      status: {
        type: 'string',
        description:
          'Target status for move, e.g. 待验收. 完成 and 驳回 are the user\'s sign-off and are rejected.',
      },
      priority: { type: 'string', description: '高 / 中 / 低.' },
      project: { type: 'string', description: 'Project id for create.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
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

  return [tasksTool, cardTool, contextTool, writeTool]
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
