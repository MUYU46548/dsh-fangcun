/**
 * 模型工具（REV-014 ②）的测试。
 *
 * 这三条是"插件是挂件还是智能层"的分界线：
 *  ① 注册上的是**真工具定义**（name/description/parameters/output/execute 齐全，形状按 contracts.ts）；
 *  ② 只白名单转发（不做任意工具转发 —— 那是提权），参数不全就抛、绝不猜；
 *  ③ 输出**有界**（用户 2026-11-17："每次一共就那么多上下文空间，占满对话就死了"）。
 *
 * 并且钉住：方寸没开时**如实说没连上**，不假装写进去了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTools, makePipeCallTool, shapeTasks, shapeCard, writeCallOf,
  TOOL_ROUTES, WRITE_ACTIONS, SIGNOFF_STATUSES,
} from '../lib/tool.js'

/** 假管道：按工具名回预设结果，并记录调用 */
function fakeDeps(resultByTool = {}) {
  const calls = []
  return {
    calls,
    deps: {
      async callTool(name, args) {
        calls.push({ name, args })
        const r = resultByTool[name]
        if (typeof r === 'function') return r(name, args)
        if (r === undefined) return { content: [{ type: 'text', text: '[]' }] }
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      },
    },
  }
}

const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]))

test('① 造出三个真工具，定义字段齐全', () => {
  const { deps } = fakeDeps()
  const tools = buildTools(deps)
  assert.equal(tools.length, 4)
  const t = byName(tools)
  assert.deepEqual(Object.keys(t).sort(), ['fangcun_card', 'fangcun_context', 'fangcun_tasks', 'fangcun_write'])

  for (const def of tools) {
    // contracts.ts：ToolDefinition extends ToolSchema，且 output 是**必须**的
    assert.equal(typeof def.name, 'string')
    assert.ok(def.description.length > 20, def.name + ' 的描述太短，模型看不出用途')
    assert.equal(typeof def.parameters, 'object')
    assert.ok(def.output && def.output.schema, def.name + ' 缺 output.schema')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function', def.name + ' 缺 execute')
  }

  // 命名不能撞 mcp__fangcun__*：MCP 客户端断开时这两个仍要能用（卡 140864fa）
  for (const def of tools) assert.ok(!def.name.startsWith('mcp__'), def.name + ' 不该占 MCP 命名空间')
})

test('② 只白名单转发：读只碰 list_tasks / get_task，写只碰三个写工具', async () => {
  // TOOL_ROUTES 只能指向读工具或 null（null = 按 action 分发）
  assert.equal(TOOL_ROUTES.fangcun_tasks, 'list_tasks')
  assert.equal(TOOL_ROUTES.fangcun_card, 'get_task')
  assert.equal(TOOL_ROUTES.fangcun_write, null)
  assert.deepEqual(Object.keys(WRITE_ACTIONS).sort(), ['create', 'move', 'update'])

  const { calls, deps } = fakeDeps({ list_tasks: [], get_task: { id: 'c1', title: 't' } })
  const t = byName(buildTools(deps))

  await t.fangcun_tasks.execute({ view: 'active' })
  assert.equal(calls[0].name, 'list_tasks')

  await t.fangcun_card.execute({ id: 'c1' })
  assert.equal(calls[1].name, 'get_task')

  // 不允许调用任意工具名（提权）：action 不在白名单就是抛
  await assert.rejects(() => t.fangcun_write.execute({ action: 'delete_task', id: 'c1' }))
  await assert.rejects(() => t.fangcun_write.execute({ action: 'get_data_dir' }))
})

test('③ writeCallOf：参数不全就抛，绝不猜；只放模型真给了的字段', () => {
  // create 必须有 title
  assert.throws(() => writeCallOf({ action: 'create' }), /title/)
  assert.deepEqual(writeCallOf({ action: 'create', title: '新卡' }), {
    tool: 'create_task', args: { title: '新卡' },
  })
  // 全字段都带上
  const full = writeCallOf({
    action: 'create', title: 'T', project: 'p', body: 'B', priority: '高', tags: ['a', 'b'],
  })
  assert.deepEqual(full.args, { title: 'T', project: 'p', body: 'B', priority: '高', tags: ['a', 'b'] })

  // update / move 必须有 id
  assert.throws(() => writeCallOf({ action: 'update', title: 'x' }), /id/)
  assert.throws(() => writeCallOf({ action: 'move', status: '待验收' }), /id/)
  // move 必须有 status
  assert.throws(() => writeCallOf({ action: 'move', id: 'c1' }), /status/)
  assert.deepEqual(writeCallOf({ action: 'move', id: 'c1', status: '待验收' }), {
    tool: 'move_status', args: { id: 'c1', status: '待验收' },
  })

  // update：空字段等于没给，必须抛（别发一个什么都没改的写请求）
  assert.throws(() => writeCallOf({ action: 'update', id: 'c1' }), /至少/)
  // update：只带真给了的字段
  assert.deepEqual(writeCallOf({ action: 'update', id: 'c1', title: 'T', body: '' }), {
    tool: 'update_task', args: { id: 'c1', fields: { title: 'T' } },
  })
  assert.deepEqual(writeCallOf({ action: 'update', id: 'c1', tags: ['x'] }), {
    tool: 'update_task', args: { id: 'c1', fields: { tags: ['x'] } },
  })
})

test('③b 闸门：完成 / 驳回 是用户签字，agent 不许设（第一道锁）', () => {
  // 第二道锁在方寸本体（desktop/src/main/mcp/tools.ts 的 move_status，会 isError）。
  // 这道在插件侧先挡，理由：不该先撞墙才知道、且不许赌锁的位置。
  // 用户 2026-11-17 硬规则："DSH 也得过闸……智能层不豁免治理层。"
  assert.deepEqual([...SIGNOFF_STATUSES].sort(), ['完成', '驳回'])

  // move 到这两个状态：抛，且提示要能指导模型下一步
  for (const bad of ['完成', '驳回']) {
    assert.throws(
      () => writeCallOf({ action: 'move', id: 'c1', status: bad }),
      /签字|待验收/,
      `move 到「${bad}」必须被拒`,
    )
  }
  // 待验收照常放行（那是 agent 该做的最后一格）
  assert.deepEqual(writeCallOf({ action: 'move', id: 'c1', status: '待验收' }), {
    tool: 'move_status', args: { id: 'c1', status: '待验收' },
  })

  // update 也能带 status —— 同一个词必须同样被拒（否则绕路就破了）
  assert.throws(
    () => writeCallOf({ action: 'update', id: 'c1', status: '完成' }),
    /签字/,
    'update 带 status 也要过闸，不能留后门',
  )
})

test('③c 闸门不能误伤正常状态', () => {
  for (const ok of ['待办', '进行中', '待验收', '待审批']) {
    assert.doesNotThrow(() => writeCallOf({ action: 'move', id: 'c1', status: ok }))
  }
})

test('③d 输出有界：list_tasks 封顶 30 条，且 truncation 说出来', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({
    id: 'c' + i, title: 't' + i, status: '进行中', body: '很长的正文'.repeat(100),
  }))
  const shaped = shapeTasks(many)
  assert.equal(shaped.total, 45)
  assert.equal(shaped.returned, 30)
  assert.equal(shaped.truncated, true)
  // 正文一律不进列表（省上下文）
  assert.equal(shaped.items[0].body, undefined)
  assert.deepEqual(Object.keys(shaped.items[0]).sort(), ['id', 'project', 'status', 'title'])

  const few = shapeTasks(many.slice(0, 3))
  assert.equal(few.truncated, false)
  // 脏输入不炸
  assert.equal(shapeTasks(null).total, 0)
  assert.equal(shapeTasks('不是数组').total, 0)
})

test('③c 单卡正文也封顶，超了要说出来', () => {
  const long = 'X'.repeat(10_000)
  const c = shapeCard({ id: 'c1', title: 'T', status: '待办', body: long })
  assert.equal(c.body.length, 4000)
  assert.equal(c.bodyTruncated, true)
  assert.equal(c.bodyLength, 10_000)
  // project 是数组时拍平成一个字符串
  assert.equal(shapeCard({ project: ['a', 'b'] }).project, 'a / b')
  // 空/脏输入不炸，但**必须填满所有 required 字段**（否则 output 校验会拒掉整次调用）
  const empty = shapeCard(null)
  for (const k of ['id', 'title', 'status', 'project', 'priority', 'body']) {
    assert.equal(typeof empty[k], 'string', 'shapeCard 漏了 ' + k)
  }
  assert.equal(typeof empty.bodyTruncated, 'boolean')
  assert.equal(typeof empty.bodyLength, 'number')
})

test('④ 方寸没开：读工具如实报「未连接」，写工具如实报失败 —— 都不许撒谎', async () => {
  const boom = {
    async callTool() { throw new Error('连接失败：pipe 不存在') },
  }
  const t = byName(buildTools(boom))

  // 读：**不许回 "0 张未结"** —— 那会让模型以为方寸里没有卡，去建重复的（0.4.1 的坑）
  const listed = await t.fangcun_tasks.execute({})
  assert.equal(listed.connected, false, '连不上必须 connected=false')
  assert.equal(listed.total, 0)
  assert.match(listed.hint, /没在运行|下载/, 'hint 要给下一步，不能只说"失败"')
  // 渲染文案必须说"未连接"，且明说不是"没有卡"
  const text = t.fangcun_tasks.output.render({}, listed)[0].text
  assert.match(text, /未连接/)
  assert.match(text, /不是"没有卡"/)

  // 写：必须如实说失败（用户看不到"已写入"的谎）
  const w = await t.fangcun_write.execute({ action: 'move', id: 'c1', status: '待验收' })
  assert.equal(w.ok, false)
  assert.match(w.result, /连接失败/)
  assert.equal(w.tool, 'move_status')

  // 渲染文案要跟着 ok 走
  const wtext = t.fangcun_write.output.render({}, w)[0].text
  assert.match(wtext, /失败/)
})

test('④b 连上但没有卡：connected=true 且 total=0（与"没连上"必须能区分）', async () => {
  const { deps } = fakeDeps({ list_tasks: [] })
  const t = byName(buildTools(deps))
  const listed = await t.fangcun_tasks.execute({})
  assert.equal(listed.connected, true, '连上了就是 true，哪怕一张卡都没有')
  assert.equal(listed.total, 0)
  assert.equal(listed.hint, '', '连上时不该给"去开方寸"这种提示')
  const text = t.fangcun_tasks.output.render({}, listed)[0].text
  assert.match(text, /0 张未结/)
  assert.ok(!/未连接/.test(text))
})

test('⑤ 工具真发对参数：list_tasks 带 view/project/status，create 带全字段', async () => {
  const { calls, deps } = fakeDeps({ list_tasks: [], create_task: { ok: true } })
  const t = byName(buildTools(deps))

  await t.fangcun_tasks.execute({ project: 'dsh-fangcun', status: '待验收' })
  assert.deepEqual(calls[0], {
    name: 'list_tasks',
    args: { view: 'active', project: 'dsh-fangcun', status: '待验收' },
  })

  const w = await t.fangcun_write.execute({
    action: 'create', title: 'T', project: 'p', body: 'B', priority: '中', tags: ['x'],
  })
  assert.equal(w.ok, true)
  assert.equal(calls[1].name, 'create_task')
  assert.deepEqual(calls[1].args, { title: 'T', project: 'p', body: 'B', priority: '中', tags: ['x'] })
})

test('⑦ fangcun_context：一屏说完「项目要变成什么 + 定过什么 + 手上还有什么」', async () => {
  const { deps, calls } = fakeDeps({
    project_charter: {
      mission: '世界观地图可视化。',
      goal: '做完底图生成。',
      scenario: '',                 // 空着 → 不许编
      boundary: '只认机检。',
      structureMapAgeDays: 51,
    },
    decision_list: { decisions: [{ id: 'D-101', '内容': '选 A 主线', '日期': '2026-11-12', '状态': '有效' }], total: 1 },
    list_tasks: [
      { id: 'c1', title: '做底图', status: '进行中' },
      { id: 'c2', title: '已关的', status: '完成' },
    ],
  })
  const t = byName(buildTools(deps))
  const r = await t.fangcun_context.execute({ project: 'sitian' })

  assert.equal(r.connected, true)
  assert.equal(r.mission, '世界观地图可视化。')
  assert.equal(r.boundary, '只认机检。')
  // 空节必须标出来，而不是空字符串糊过去
  assert.deepEqual(r.missingSections, ['场景'])
  assert.equal(r.structureMapAgeDays, 51)
  // 决策与卡都带上了
  assert.equal(r.decisions[0].id, 'D-101')
  assert.equal(r.cards.length, 1, '关掉的卡不许出现在「手上还有的活」里')
  assert.equal(r.cards[0].id, 'c1')

  // 三处是并行拉的（不串行）
  assert.deepEqual(calls.map((c) => c.name).sort(), ['decision_list', 'list_tasks', 'project_charter'])

  // 渲染：缺节那句必须说"真没写，不许替它填"
  const text = t.fangcun_context.output.render({}, r)[0].text
  assert.match(text, /使命：世界观地图可视化/)
  assert.match(text, /真没写/)
  assert.match(text, /场景/)
})

test('⑦b 三处都没拉到才算"没连上"；只缺一处仍算连上', async () => {
  // 全挂 → connected:false
  const allDown = { async callTool() { throw new Error('no pipe') } }
  const t1 = byName(buildTools(allDown))
  const down = await t1.fangcun_context.execute({ project: 'x' })
  assert.equal(down.connected, false)
  assert.match(down.hint, /没在运行|下载/)

  // 只有 charter 成功 → 仍算连上，其余空
  const partial = {
    async callTool(name) {
      if (name === 'project_charter') {
        return { content: [{ type: 'text', text: JSON.stringify({ mission: 'M' }) }] }
      }
      throw new Error('boom')
    },
  }
  const t2 = byName(buildTools(partial))
  const r = await t2.fangcun_context.execute({ project: 'x' })
  assert.equal(r.connected, true, '有一处通就说方寸在')
  assert.equal(r.mission, 'M')
  assert.deepEqual(r.decisions, [])
  assert.deepEqual(r.cards, [])
})

test('⑦c 缺 project 就抛（不许默认成"全部项目"去猜）', async () => {
  const { deps } = fakeDeps()
  const t = byName(buildTools(deps))
  await assert.rejects(() => t.fangcun_context.execute({}), /project/)
})

test('⑥ makePipeCallTool 造出来的东西形状对（不真连管道）', () => {
  // 只验它是个函数、不抛：真连由 e2e/真机负责
  const fn = makePipeCallTool({ pipePath: '\\\\.\\pipe\\不存在', version: '0.0.0' })
  assert.equal(typeof fn, 'function')
})

// ── ⑦ 工具 schema 必须是**宿主认的标准 JSON Schema** ─────────────────────
//
// 病（2026-11-17 真机抓到，0.6.0 装上后）：
//   `health.tools.registered = false`
//   unsupported JSON schema: schema.properties.connected.required is not supported
//   on type "boolean"; …items.items.properties.id.required is not supported on type "string"
//
// 因为 `lib/tool.js` 把必填写成了**属性上的布尔值**：
//   `connected: { type: 'boolean', required: true }`
// 而宿主认的是标准 JSON Schema：`required` 是父对象上的**字符串数组**：
//   `{ type: 'object', properties: {...}, required: ['connected', ...] }`
//
// ⚠ 为什么原有那批断言全绿也没抓到：它们只断"定义了 output.schema"，
//   **从没把 schema 喂给宿主的校验规则**。下面两条就是那台缺席的校验器。

/** 宿主拒绝规则的口径：任何属性对象里出现 required 布尔值 → 整次注册失败 */
function collectPropertyLevelRequired(node, p, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((x, i) => collectPropertyLevelRequired(x, p + '[' + i + ']', out)); return }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('required' in v && typeof v.required === 'boolean') out.push(p + '.' + k + '.required')
      collectPropertyLevelRequired(v, p + '.' + k, out)
    }
  }
}

/** required 数组里的每个名字都必须真的在**同层** properties 里 */
function collectDanglingRequired(node, p, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((x, i) => collectDanglingRequired(x, p + '[' + i + ']', out)); return }
  if (Array.isArray(node.required) && node.properties) {
    for (const k of node.required) {
      if (!(k in node.properties)) out.push(p + ' 要求了不存在的字段 ' + k)
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') collectDanglingRequired(v, p + '.' + k, out)
  }
}

/**
 * required **数组**挂在了 properties 里面（0.6.1 的病，比 0.6.0 更隐蔽）。
 *
 * 两种写法都长这样，看着都"像标准写法"：
 *
 *   对：{ type:'object', properties:{ id:{type:'string'} }, required:['id'] }
 *   错：{ type:'object', properties:{ id:{type:'string'}, required:['id'] } }
 *                                            ^^^^^^^^ 落在 properties 里面了
 *
 * 错的这种，`required` 会被当成一个叫 "required" 的**字段**，
 * 它的值是个数组 → 宿主说 `properties.required must be a schema object` → 整批拒注册。
 *
 * ⚠ 我第一版的 ⑦ 只抓 `required: true`（布尔值）—— 于是 0.6.1 那批
 *   **数组形式**的错写法一条都没抓到，121 条全绿，真机上四个工具照样全灭。
 *   一条只能抓一半的守卫，比没有更危险：它让人以为验过了。
 */
function collectRequiredInsideProperties(node, p, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((x, i) => collectRequiredInsideProperties(x, p + '[' + i + ']', out)); return }
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    if (Object.hasOwn(node.properties, 'required')) {
      out.push(p + '.properties.required（required 数组被塞进了 properties，宿主会当成字段）')
    }
    for (const [k, v] of Object.entries(node.properties)) {
      collectRequiredInsideProperties(v, p + '.properties.' + k, out)
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties') continue
    if (v && typeof v === 'object') collectRequiredInsideProperties(v, p + '.' + k, out)
  }
}

test('⑦ output.schema 里不许出现属性级 required 布尔值（宿主会拒注册整批工具）', () => {
  const tools = buildTools({ callTool: async () => ({ ok: true }) })
  const defs = Array.isArray(tools) ? tools : Object.values(tools)
  assert.ok(defs.length > 0, '一个工具都没建出来')
  const bad = []
  for (const d of defs) {
    if (d.output && d.output.schema) collectPropertyLevelRequired(d.output.schema, d.name + '.output.schema', bad)
    if (d.parameters) collectPropertyLevelRequired(d.parameters, d.name + '.parameters', bad)
  }
  assert.deepEqual(bad, [],
    '属性级 required 布尔值会被宿主拒掉整次注册 —— 改成父级 required: ["字段名"] 数组')
})

test('⑦a required 数组不许落在 properties 里面（0.6.1 的病）', () => {
  const tools = buildTools({ callTool: async () => ({ ok: true }) })
  const defs = Array.isArray(tools) ? tools : Object.values(tools)
  const bad = []
  for (const d of defs) {
    if (d.output && d.output.schema) collectRequiredInsideProperties(d.output.schema, d.name + '.output.schema', bad)
    if (d.parameters) collectRequiredInsideProperties(d.parameters, d.name + '.parameters', bad)
  }
  assert.deepEqual(bad, [],
    'required 数组被塞进 properties 里了 —— 它必须在 properties 的**同级**，否则宿主整批拒注册')
})

test('⑦b 每个 required 数组里的名字都真的在同层 properties 里（防拼错）', () => {
  const tools = buildTools({ callTool: async () => ({ ok: true }) })
  const defs = Array.isArray(tools) ? tools : Object.values(tools)
  const bad = []
  for (const d of defs) {
    if (d.output && d.output.schema) collectDanglingRequired(d.output.schema, d.name + '.output.schema', bad)
    if (d.parameters) collectDanglingRequired(d.parameters, d.name + '.parameters', bad)
  }
  assert.deepEqual(bad, [], 'required 里的名字必须在同层 properties 里 —— 拼错会被宿主拒')
})

test('⑦c parameters 必须是完整 JSON Schema：根上不许摊着属性名', () => {
  // 真机 2026-11-17：fangcun_write 的 parameters 写成了「字段名→子 schema」的扁平映射，
  // 宿主 tools.register 不编译，原样发给 provider → 根上的 `title` 成了对象，
  // 而 JSON Schema 规定 title 是字符串 → prefill 端 400，整轮对话连不上。
  const tools = buildTools({ callTool: async () => ({ ok: true }) })
  const defs = Array.isArray(tools) ? tools : Object.values(tools)
  const ALLOWED_ROOT = ['type', 'properties', 'required', 'description', 'additionalProperties', 'title']
  const bad = []
  for (const d of defs) {
    const p = d.parameters
    if (!p || typeof p !== 'object' || Array.isArray(p)) { bad.push(`${d.name}.parameters 不是对象`); continue }
    if (p.type !== 'object') bad.push(`${d.name}.parameters.type 必须是 'object'，现在是 ${JSON.stringify(p.type)}`)
    if (!p.properties || typeof p.properties !== 'object' || Array.isArray(p.properties)) {
      bad.push(`${d.name}.parameters.properties 缺失 —— 参数得放进 properties 里`)
    }
    for (const k of Object.keys(p)) {
      if (!ALLOWED_ROOT.includes(k)) bad.push(`${d.name}.parameters.${k} 摊在 schema 根部 —— 属性名必须在 properties 里`)
    }
    if (Object.hasOwn(p, 'title') && typeof p.title !== 'string') {
      bad.push(`${d.name}.parameters.title 不是字符串 —— 撞 JSON Schema 的 title 注解，provider 直接 400`)
    }
  }
  assert.deepEqual(bad, [],
    'parameters 必须是 { type:"object", properties:{…} } —— 交扁平映射等于把属性名摊到 schema 根部')
})


