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
  TOOL_ROUTES, WRITE_ACTIONS,
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
  assert.equal(tools.length, 3)
  const t = byName(tools)
  assert.deepEqual(Object.keys(t).sort(), ['fangcun_card', 'fangcun_tasks', 'fangcun_write'])

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

test('③b 输出有界：list_tasks 封顶 30 条，且 truncation 说出来', () => {
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

test('④ 方寸没开：读工具回空、写工具如实报失败，都不假装成功', async () => {
  const boom = {
    async callTool() { throw new Error('连接失败：pipe 不存在') },
  }
  const t = byName(buildTools(boom))

  // 读：方寸没开是常态，回空列表而不是抛
  const listed = await t.fangcun_tasks.execute({})
  assert.equal(listed.total, 0)
  assert.equal(listed.truncated, false)

  // 写：必须如实说失败（用户看不到"已写入"的谎）
  const w = await t.fangcun_write.execute({ action: 'move', id: 'c1', status: '待验收' })
  assert.equal(w.ok, false)
  assert.match(w.result, /连接失败/)
  assert.equal(w.tool, 'move_status')

  // 渲染文案要跟着 ok 走
  const text = t.fangcun_write.output.render({}, w)[0].text
  assert.match(text, /失败/)
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

test('⑥ makePipeCallTool 造出来的东西形状对（不真连管道）', () => {
  // 只验它是个函数、不抛：真连由 e2e/真机负责
  const fn = makePipeCallTool({ pipePath: '\\\\.\\pipe\\不存在', version: '0.0.0' })
  assert.equal(typeof fn, 'function')
})
