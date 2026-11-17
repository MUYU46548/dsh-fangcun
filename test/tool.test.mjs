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
import fs from 'node:fs'
import {
  buildTools, makePipeCallTool, shapeTasks, shapeCard, shapeLogs, shapeLog, shapeSearch,
  writeCallOf, logWriteCallOf, TOOL_ROUTES, WRITE_ACTIONS, SIGNOFF_STATUSES, NEVER_ROUTED,
  LOG_WRITE_ACTIONS, LOG_RUNNING_STATES,
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
  assert.equal(tools.length, 8)
  const t = byName(tools)
  assert.deepEqual(Object.keys(t).sort(), [
    'fangcun_card', 'fangcun_context', 'fangcun_log', 'fangcun_log_write',
    'fangcun_logs', 'fangcun_search', 'fangcun_tasks', 'fangcun_write',
  ])

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

test('② 只白名单转发：读只碰 list_tasks / get_task / list_logs / get_log，写只碰写工具', async () => {
  // TOOL_ROUTES 只能指向读工具或 null（null = 按 action 分发）
  assert.equal(TOOL_ROUTES.fangcun_tasks, 'list_tasks')
  assert.equal(TOOL_ROUTES.fangcun_card, 'get_task')
  assert.equal(TOOL_ROUTES.fangcun_search, 'search_tasks')
  assert.equal(TOOL_ROUTES.fangcun_logs, 'list_logs')
  assert.equal(TOOL_ROUTES.fangcun_log, 'get_log')
  assert.equal(TOOL_ROUTES.fangcun_write, null)
  assert.equal(TOOL_ROUTES.fangcun_log_write, null)
  assert.deepEqual(Object.keys(WRITE_ACTIONS).sort(), ['create', 'move', 'update'])
  assert.deepEqual(Object.keys(LOG_WRITE_ACTIONS).sort(), ['create', 'status', 'update'])

  const { calls, deps } = fakeDeps({
    list_tasks: [], get_task: { id: 'c1', title: 't' }, list_logs: [], get_log: { id: 'l1', title: 't' },
    search_tasks: [],
  })
  const t = byName(buildTools(deps))

  await t.fangcun_tasks.execute({ view: 'active' })
  assert.equal(calls[0].name, 'list_tasks')

  await t.fangcun_card.execute({ id: 'c1' })
  assert.equal(calls[1].name, 'get_task')

  await t.fangcun_search.execute({ query: '派单' })
  assert.equal(calls[2].name, 'search_tasks')
  assert.equal(calls[2].args.query, '派单')

  await t.fangcun_logs.execute({ project: 'dsh-fangcun' })
  assert.equal(calls[3].name, 'list_logs')

  await t.fangcun_log.execute({ id: 'l1' })
  assert.equal(calls[4].name, 'get_log')

  // 不允许调用任意工具名（提权）：action 不在白名单就是抛
  await assert.rejects(() => t.fangcun_write.execute({ action: 'delete_task', id: 'c1' }))
  await assert.rejects(() => t.fangcun_write.execute({ action: 'get_data_dir' }))
  await assert.rejects(() => t.fangcun_log_write.execute({ action: 'delete_task', id: 'l1' }))
  await assert.rejects(() => t.fangcun_log_write.execute({ action: 'inject_logs', id: 'l1' }))
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

  // ⚠ 2026-11-17 真机抓到的 bug：上面这条「全字段」断言**自己就漏了 status**，
  //   于是代码也漏了 —— 两边一起错，测试是绿的。症状：模型传 status:'草稿'，
  //   插件静默忽略 → 方寸落成默认的「待办」（那是要过进队列闸的正式状态，草稿不是）。
  //   ⭐ 教训：「全字段」这类断言必须**对着参数声明逐字段数**，不能凭记忆列。
  assert.deepEqual(
    writeCallOf({ action: 'create', title: 'T', status: '草稿' }),
    { tool: 'create_task', args: { title: 'T', status: '草稿' } },
    'create 必须转发 status（否则静默落成默认值「待办」）',
  )
  // 空 status = 没给，不许写进去凭空造一个
  assert.deepEqual(writeCallOf({ action: 'create', title: 'T', status: '   ' }),
    { tool: 'create_task', args: { title: 'T' } })
  // 创建时也不许直接落成终态 —— 与 move 同一道锁
  for (const s of ['完成', '驳回']) {
    assert.throws(() => writeCallOf({ action: 'create', title: 'T', status: s }), /签字|验收/,
      `create 不许直接把状态设成「${s}」`)
  }

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

test('⑦ fangcun_context：一屏说完「项目要变成什么 + 定过什么 + 手上还有什么 + 上次做到哪」', async () => {
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
    list_logs: [
      { id: 'log_1', title: '底图第一版', status: '待处理', created: '2026-11-16' },
      { id: 'log_0', title: '更早的一条', status: '已完成', created: '2026-11-10' },
    ],
    // 只有最新那条会被 get_log 补下一步
    get_log: { id: 'log_1', nextSteps: '先把路网画出来，再对一次坐标。' },
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
  // 「上次做到哪」：最新一条日志 + 它留下的下一步（这一步 MCP 那条路要多走两跳）
  assert.equal(r.lastLog.id, 'log_1')
  assert.equal(r.lastLog.nextSteps, '先把路网画出来，再对一次坐标。')
  assert.equal(r.logsTotal, 2)

  // 四处是并行拉的（不串行）；get_log 只补最新那一条
  const parallel = calls.filter((c) => c.name !== 'get_log').map((c) => c.name).sort()
  assert.deepEqual(parallel, ['decision_list', 'list_logs', 'list_tasks', 'project_charter'])
  const getLogs = calls.filter((c) => c.name === 'get_log')
  assert.equal(getLogs.length, 1, '只为最新一条日志补下一步，不是整页拉')

  // 渲染：缺节那句必须说"真没写，不许替它填"
  const text = t.fangcun_context.output.render({}, r)[0].text
  assert.match(text, /使命：世界观地图可视化/)
  assert.match(text, /真没写/)
  assert.match(text, /场景/)
  assert.match(text, /上次做到哪/)
  assert.match(text, /先把路网画出来/)
})

test('⑦b 四处都没拉到才算「没连上」；只缺一处仍算连上', async () => {
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
  assert.equal(r.lastLog.id, '', '没有日志时 lastLog 必须是空壳，不许编一条')
  assert.equal(r.logsTotal, 0)
})

test('⑦c 缺 project 就抛（不许默认成"全部项目"去猜）', async () => {
  const { deps } = fakeDeps()
  const t = byName(buildTools(deps))
  await assert.rejects(() => t.fangcun_context.execute({}), /project/)
})

// ── ⑧ 执行日志三件套（2026-11-17 补）──────────────────────────────────
//
// 为什么补这一组：P0 调查（tools.jsonl 500 行 + 会话原文）证明插件工具**有能力时模型就走插件**
// （新会话 63 : 6），剩下的 MCP 流量几乎全是**能力缺口**。日志是缺口里最要命的一处，
// 因为暮雨 2026-11-17 原话：「真正派活最常用的是从日志走」。缺了它，插件只能从
// `fangcun_context` 看见最新一条日志，翻第二条就得回 MCP。

test('⑧ fangcun_logs：有界、连不上不撒谎、截断说出来', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: 'log_' + i, title: 'T' + i, status: '进行中', project: 'p', running: i === 0,
    created: '2026-11-17T00:00:0' + (i % 10) + 'Z', continuesFrom: i === 1 ? 'log_0' : '',
  }))
  const v = shapeLogs(rows, { project: 'p' }, true)
  assert.equal(v.connected, true)
  assert.equal(v.total, 40)
  assert.equal(v.returned, 20, '列表封顶 20 条')
  assert.equal(v.truncated, true, '截断必须说出来')
  assert.equal(v.items[0].running, true)
  assert.equal(v.items[1].continuesFrom, 'log_0', '接力链上游要带上（派活靠它知道上一棒是谁）')

  // 连不上：**不许回 0 条冒充"没有日志"**（与 list_tasks 同一条纪律）
  const off = shapeLogs([], {}, false)
  assert.equal(off.connected, false)
  assert.match(off.hint, /没在运行|下载/)
})

test('⑧b fangcun_log：正文封顶；**日志号不存在时不许回 ok:true 装成空日志**', () => {
  const long = 'Y'.repeat(10_000)
  const v = shapeLog({ id: 'l1', title: 'T', content: long, chain: { upstream: [{ id: 'u', title: 'U' }], downstream: [] } })
  assert.equal(v.ok, true)
  assert.equal(v.body.length, 4000)
  assert.equal(v.bodyTruncated, true)
  assert.equal(v.bodyLength, 10_000)
  assert.equal(v.upstream.length, 1, '接力链上游要带')
  assert.equal(v.upstream[0].id, 'u')
  assert.deepEqual(v.downstream, [])

  // ⚠ 2026-11-17 真管道探针抓到的真 bug：方寸对不存在的日志号回
  //   `{ok:false,error:'Log not found: …'}` + isError，第一版把它当正常日志 →
  //   模型看到 ok:true 和一片空白。读失败伪装成"这条日志是空的"是最坏的错。
  const bad = shapeLog({ ok: false, error: 'Log not found: log_nope' })
  assert.equal(bad.ok, false, '读失败必须是 ok:false')
  assert.match(bad.body, /Log not found/, '原因要带给模型，别让它以为日志是空的')
  assert.equal(bad.bodyLength, 0)

  // 每个分支都要填满 required（少一个字段宿主会拒掉整次调用）
  for (const k of ['ok', 'id', 'title', 'status', 'project', 'created', 'completed', 'running',
    'agentName', 'body', 'nextSteps', 'continuesFrom', 'attachmentCount', 'attachmentsHint',
    'upstream', 'downstream', 'bodyTruncated', 'bodyLength']) {
    assert.ok(k in bad, 'shapeLog 漏了 ' + k)
  }
})

test('⑧c 日志写口三道硬约束（都来自方寸原文，不是我自己加的）', () => {
  // ① create 必须 userAsked=true —— 日志是用户的私人笔记本，不是 agent 汇报的垃圾桶
  assert.throws(() => logWriteCallOf({ action: 'create', title: 'x' }), /userAsked/)
  assert.throws(() => logWriteCallOf({ action: 'create', title: 'x', userAsked: false }), /userAsked/)
  assert.throws(() => logWriteCallOf({ action: 'create', userAsked: true }), /title/)
  assert.deepEqual(
    logWriteCallOf({ action: 'create', title: 'T', userAsked: true, project: 'p', content: 'c', nextSteps: 'n' }),
    { tool: 'create_log', args: { title: 'T', userAsked: true, project: 'p', content: 'c', nextSteps: 'n' } },
  )
  // userAsked 不许被插件"顺手补上" —— 补了就等于替用户同意
  assert.equal(logWriteCallOf({ action: 'create', title: 'T', userAsked: true }).args.userAsked, true)

  // ② 日志没有终态：status 只有 running / idle，`完成`/`驳回` 在这里不存在
  assert.deepEqual(LOG_RUNNING_STATES.slice().sort(), ['idle', 'running'])
  for (const bad of ['完成', '驳回', '待验收', '进行中', '']) {
    assert.throws(() => logWriteCallOf({ action: 'status', id: 'l', state: bad }), /running 或 idle/)
  }

  // ③ update 改不了 status（方寸原文："Lifecycle fields (status) are NOT here"）
  const up = logWriteCallOf({ action: 'update', id: 'l', title: 'T', status: '完成' })
  assert.equal(up.tool, 'update_log')
  assert.equal('status' in up.args.fields, false, 'update 不许夹带 status')

  // taskIds 空数组是**合法的清空**，不能当空串丢掉
  assert.deepEqual(logWriteCallOf({ action: 'update', id: 'l', taskIds: [] }).args.fields, { taskIds: [] })
  assert.throws(() => logWriteCallOf({ action: 'update', id: 'l' }), /至少/)
  assert.throws(() => logWriteCallOf({ action: 'status', state: 'running' }), /id/)
  assert.throws(() => logWriteCallOf({ action: 'move', id: 'l' }), /create \/ update \/ status/)
})

test('⑧d 连不上时日志写工具如实报失败（不假装写进去了）', async () => {
  const t = byName(buildTools({ async callTool() { throw new Error('管道已断开') } }))
  const w = await t.fangcun_log_write.execute({ action: 'status', id: 'l', state: 'running' })
  assert.equal(w.ok, false)
  assert.match(w.result, /管道已断开/)
  assert.equal(w.tool, 'set_log_status')
  assert.match(t.fangcun_log_write.output.render({}, w)[0].text, /失败/)

  // 读日志连不上同理
  const r = await t.fangcun_logs.execute({})
  assert.equal(r.connected, false)
  assert.match(t.fangcun_logs.output.render({}, r)[0].text, /不是"没有日志"/)
})

// ── ⑨ 关键词搜索（2026-11-17，用户：「search_tasks 必须补」）────────────

test('⑨ fangcun_search：跨全部状态、有界、空查询必须拒', async () => {
  // 口径必须与 fangcun_tasks 不同：搜索**含已完成/驳回**（否则永远搜不到"上次怎么解决的"）
  const rows = [
    { id: 'a', title: '派单管子', status: '待验收', project: 'dsh-fangcun' },
    { id: 'b', title: '派单旧方案', status: '完成', project: 'fangcun-base' },
    { id: 'c', title: '派单事故', status: '驳回', project: 'project-2' },
  ]
  const v = shapeSearch(rows, '派单', true)
  assert.equal(v.connected, true)
  assert.equal(v.query, '派单')
  assert.equal(v.total, 3)
  assert.equal(v.returned, 3)
  assert.equal(v.truncated, false)
  // 三种终态都要在结果里 —— 这是它区别于 list_tasks 的全部意义
  // ⚠ 别对中文用 .sort()：它按码点排，不是拼音（第一版就写错了，测试红而不是代码红）
  assert.deepEqual(new Set(v.items.map((x) => x.status)), new Set(['完成', '驳回', '待验收']))
  assert.equal(v.items[0].project, 'dsh-fangcun', 'project 是数组时拍平')

  // 有界：封顶 30，超了明说
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, title: 't', status: '待办', project: 'p' }))
  const big = shapeSearch(many, 'x', true)
  assert.equal(big.returned, 30)
  assert.equal(big.truncated, true)

  // 连不上：不许回"没有匹配"
  const off = shapeSearch([], '派单', false)
  assert.equal(off.connected, false)
  assert.match(off.hint, /没在运行|下载/)

  // ⚠ 空查询**必须拒**：2026-11-17 真管道实测 `search_tasks('')` 回 396 条 ——
  //   放了它 = 让模型用空字符串把整张看板拉进上下文（"占满对话就死了"）
  const t = byName(buildTools(fakeDeps({ search_tasks: rows }).deps))
  for (const bad of ['', '   ', undefined, null]) {
    await assert.rejects(() => t.fangcun_search.execute({ query: bad }), /query 不能为空/)
  }
  // 正常查询真转发
  const { calls, deps } = fakeDeps({ search_tasks: rows })
  const t2 = byName(buildTools(deps))
  const r = await t2.fangcun_search.execute({ query: ' 派单 ' })
  assert.equal(calls[0].name, 'search_tasks')
  assert.equal(calls[0].args.query, '派单', '两端空白要 trim 掉，但内容要原样')
  assert.equal(r.total, 3)

  // 「搜了没中」与「没连上」文案必须不同
  const none = await t2.fangcun_search.execute({ query: '不存在的词' })
  assert.match(t2.fangcun_search.output.render({}, { ...none, total: 0 })[0].text, /没有匹配/)
})

test('⑨b delete_task **永不进白名单**（用户 2026-11-17：「delete_task 永不做」）', () => {
  // 显式名单，不是"没写就是不做" —— 将来谁想加，这条会红，他就得回来读理由
  assert.ok(NEVER_ROUTED.has('delete_task'), 'delete_task 必须在 NEVER_ROUTED 里')

  // 白名单里**不许**出现它（任何形式：读路由、写路由、写口 action）
  for (const v of Object.values(TOOL_ROUTES)) {
    assert.notEqual(v, 'delete_task', 'TOOL_ROUTES 不许转发 delete_task')
  }
  assert.equal(Object.values(WRITE_ACTIONS).includes('delete_task'), false)
  assert.equal(Object.values(LOG_WRITE_ACTIONS).includes('delete_task'), false)
  assert.equal('delete_task' in WRITE_ACTIONS, false, '写口 action 里不许有 delete')

  // 运行时也必须打不出去：没有任何工具的 execute 会调它
  const routes = Object.values(TOOL_ROUTES).filter(Boolean)
    .concat(Object.values(WRITE_ACTIONS), Object.values(LOG_WRITE_ACTIONS))
  assert.equal(routes.filter((r) => r === 'delete_task').length, 0)
  // 而且它不在任何已注册工具的返回路由集合里
  assert.equal(routes.includes(NEVER_ROUTED.values().next().value), false)
})

// ── ⑩ 工具名单四处同步（2026-11-17 CI 红了一次才补的）──────────────
//
// 病：0.6.6/0.6.7 加了 `fangcun_log*` 与 `fangcun_search` 之后，`test/smoke-packed.mjs`
// 里仍钉着「四个」的旧名单 → **`npm test` 139/139 全绿，打 tag 后 CI 红**。
// 原因是 `npm test` 的脚本列表里**没有 smoke-packed.mjs**（它要先 `npm pack`），
// 所以"本地全绿"对这份名单毫无保障。工具名一共散在四处：
//   ① `lib/tool.js` buildTools（唯一真源）
//   ② `test/tool.test.mjs ①`
//   ③ `test/plugin.test.mjs ⑧`
//   ④ `test/smoke-packed.mjs`（CI 才跑）
// 本条把 ④ 也钉进 `npm test`：读它的源码，把期望数组抠出来跟真源比。
test('⑩ 工具名单四处同步：smoke-packed 的旧名单不许漂移（CI 才跑的那份）', async () => {
  const need = buildTools({ async callTool() { return { content: [{ type: 'text', text: '[]' }] } } })
    .map((t) => t.name).sort()

  const src = fs.readFileSync(new URL('./smoke-packed.mjs', import.meta.url), 'utf-8')
  // 抠出 `toolDefs.map((d) => d.name).sort(),` 后面那个数组字面量
  const m = /toolDefs\.map\(\(d\)\s*=>\s*d\.name\)\.sort\(\),\s*\[([\s\S]*?)\]/.exec(src)
  assert.ok(m, 'smoke-packed.mjs 里找不到工具名断言 —— 结构变了就更新本条')
  const listed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort()

  assert.deepEqual(listed, need,
    'smoke-packed.mjs 的工具名单与 lib/tool.js 漂移了（这条只有 CI 会红，所以必须在这里先红）')
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


