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

/** 工具名 → 它转发的方寸 MCP 工具。**只白名单**：不做任意工具转发（那是提权）。 */
export const TOOL_ROUTES = {
  fangcun_tasks: 'list_tasks',
  fangcun_card: 'get_task',
  fangcun_write: null, // 特殊：按 action 分发到 update_task / move_status / create_task
}

/** `fangcun_write` 允许的 action → 方寸工具名 */
export const WRITE_ACTIONS = {
  create: 'create_task',
  update: 'update_task',
  move: 'move_status',
}

const MAX_ITEMS = 30
const MAX_BODY = 4000

/**
 * 把 `list_tasks` 的结果压成**有界**输出（tool-design.md：bounded outputs）。
 * 只给模型做决定需要的东西：id / 标题 / 状态 / 项目。正文一律不塞。
 * @param {any} raw - 方寸 `list_tasks` 的返回
 * @param {{status?: string, project?: string}} scope - 本次查询的范围
 */
export function shapeTasks(raw, scope = {}) {
  const tasks = Array.isArray(raw) ? raw : []
  const items = tasks.slice(0, MAX_ITEMS).map((t) => ({
    id: String((t && t.id) || ''),
    title: String((t && t.title) || ''),
    status: String((t && t.status) || ''),
    project: Array.isArray(t && t.project) ? t.project.join(' / ') : String((t && t.project) || ''),
  }))
  return {
    total: tasks.length,
    returned: items.length,
    // 截断必须说出来，别让模型以为看全了
    truncated: tasks.length > items.length,
    scope: scope.project || '全部项目',
    items,
  }
}

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
    return { tool, args: { id, status } }
  }
  // update：只放模型真给了的字段
  const fields = {}
  for (const key of ['title', 'body', 'status', 'priority']) {
    if (args[key] !== undefined && args[key] !== null && String(args[key]) !== '') {
      fields[key] = String(args[key])
    }
  }
  if (Array.isArray(args.tags)) fields.tags = args.tags.map(String)
  if (Object.keys(fields).length === 0) throw new Error('update 至少要给一个字段')
  return { tool, args: { id, fields } }
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
    parameters: {
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          scope: { type: 'string', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                project: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
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
        // 方寸没开是常态（用户关掉它是正常动作），回空列表而不是抛：
        // 模型看到"0 张未结"会自己判断，看到异常堆栈只会白白烧上下文。
        return shapeTasks([], { project })
      }
      if (!Array.isArray(raw)) return shapeTasks([], { project })
      return shapeTasks(raw, { project })
    },
    presentCall: (args) => ({ card: 'generic', title: '查方寸待办', kind: 'other', rawInput: args }),
  }

  const cardTool = {
    name: 'fangcun_card',
    description:
      'Read one 方寸 (tegula) task card by id, including its body. Read-only. '
      + 'The body is capped; when `bodyTruncated` is true, read the file on the board for the rest. '
      + 'Call it before changing or reporting on a specific card.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Exact 方寸 card id, e.g. task-20261107-004.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          project: { type: 'string', required: true },
          priority: { type: 'string', required: true },
          body: { type: 'string', required: true },
          bodyTruncated: { type: 'boolean', required: true },
          bodyLength: { type: 'integer', required: true },
        },
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

  const writeTool = {
    name: 'fangcun_write',
    description:
      'Write to 方寸 (tegula): create a card, update one, or move one to another status. '
      + 'This is the ONLY way this plugin writes, and it writes only what you pass — nothing is inferred or added. '
      + 'Move a finished card to 待验收 and let the human sign it off; never set 完成 or 驳回.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'update', 'move'],
        description: 'create a new card | update fields of an existing one | move one to another status.',
      },
      id: {
        type: 'string',
        description: 'Card id. Required for update and move.',
      },
      title: { type: 'string', description: 'Card title. Required for create.' },
      body: { type: 'string', description: 'Card body in Markdown.' },
      status: { type: 'string', description: 'Target status for move, e.g. 待验收. For update, a status field.' },
      priority: { type: 'string', description: '高 / 中 / 低.' },
      project: { type: 'string', description: 'Project id for create.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          result: { type: 'string', required: true },
        },
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
        // 连不上/超时也如实回，不假装写进去了
        return { ok: false, action, tool: call.tool, result: String((e && e.message) || e) }
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

  return [tasksTool, cardTool, writeTool]
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
