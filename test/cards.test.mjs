/**
 * 卡号追踪 + 逐轮度量 + 账本归因的测试。
 *
 * 这三件事是 2026-11-05 用户要的"让 DSH 真正和方寸联动起来，而不是摆设"：
 *  ① `proof` 记**顺序**（先查后改 / 有没有回写）→ 契约 ②⑦⑧ 从"人翻日志"变成 health 出数；
 *  ② `cards` 从 `tool/call` 的 `arguments.id` 白名单取卡号 → 挂件能说"本次在办哪张"；
 *  ③ `usage_report` 的 note 带上卡号 → 方寸账本可按卡归因 token。
 *
 * 边界同样钉在这里：**只取 id**，参数里其它字段一个都不许落盘/进 note。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CardTracker, CARD_ID_TOOLS, cardIdFromCall,
} from '../lib/cards.js'
import {
  ToolProof, summarize, verdictOf, FANGCUN_TOOL_PREFIX,
} from '../lib/proof.js'
import { UsageLedger, usagePaths, NOTE_MAX } from '../lib/usage.js'
import { countStatuses, focusOf } from '../lib/index.js'

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cards-'))
const session = (id) => ({ id, header: { id } })

test('① 只从白名单工具取 id：日志 id、检索词、正文一律不碰', () => {
  // 取得到
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_task', { id: 'card-a' }), 'card-a')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'update_task', { id: 'card-b', fields: { title: '秘密' } }), 'card-b')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'move_status', { id: 'card-c', status: '完成' }), 'card-c')
  // 参数是 JSON 字符串也认（宿主两种都可能给）
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_task', '{"id":"card-d"}'), 'card-d')

  // 不该取的：执行日志的 id 不是卡号（混进来就是假卡号）
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_log', { id: 'log_2026' }), '')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'update_log', { id: 'log_2026' }), '')
  // 没有 id 的调用、非方寸工具、脏值
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'list_tasks', { view: 'active' }), '')
  assert.equal(cardIdFromCall('edit', { id: 'x' }), '')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_task', { id: 42 }), '')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_task', { id: 'a\nb' }), '')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_task', { id: 'x'.repeat(121) }), '')
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'get_task', '{坏 json'), '')
  assert.ok(CARD_ID_TOOLS.has('get_task'))
})

test('①b 插件自己的工具也要能取卡号（0.4.0 的坑，2026-11-17）', () => {
  // 病：加了 fangcun_card / fangcun_write，但 CARD_ID_TOOLS 只列 MCP 短名，
  // 于是模型明明动了卡，proof 与 cards 全都不认 —— 挂件「本次在办」永远是空的。
  assert.equal(cardIdFromCall('fangcun_card', { id: 'card-x' }), 'card-x')
  assert.equal(cardIdFromCall('fangcun_write', { action: 'move', id: 'card-y', status: '待验收' }), 'card-y')
  assert.equal(cardIdFromCall('fangcun_write', { action: 'update', id: 'card-z', title: 'T' }), 'card-z')

  // create 没有 id —— 新建卡不是"在办某张卡"，必须取不到（否则会造一个空卡号）
  assert.equal(cardIdFromCall('fangcun_write', { action: 'create', title: 'T' }), '')
  // 列卡不算在办某张卡
  assert.equal(cardIdFromCall('fangcun_tasks', { id: 'card-w' }), '')
  // 两条路径都要真能取到（同一个能力两种叫法）
  assert.equal(cardIdFromCall(FANGCUN_TOOL_PREFIX + 'update_task', { id: 'card-m' }), 'card-m')
})

test('② 一轮里动过的卡按出现顺序去重；焦点有 TTL；会话销毁就忘掉', () => {
  let now = 1_000_000
  const cards = new CardTracker({ now: () => now, ttlMs: 60_000 })
  const s = session('session-aaaa1111')

  const call = (turn, tool, id) => cards.observe(s, {
    type: 'tool/call',
    data: { turn, name: FANGCUN_TOOL_PREFIX + tool, arguments: { id } },
  })
  assert.ok(call(1, 'get_task', 'card-a'))
  call(1, 'get_task', 'card-a') // 同一张不重复
  call(1, 'move_status', 'card-b')
  assert.deepEqual(cards.idsFor('session-aaaa1111', 1), ['card-a', 'card-b'])
  assert.deepEqual(cards.idsFor('session-aaaa1111', 2), [], '别的轮次不受影响')

  // 焦点 = 最近一张，带 TTL
  assert.equal(cards.focus().id, 'card-b')
  now += 61_000
  assert.equal(cards.focus(), null, '过期的不许冒充"本次在办"')
  call(2, 'get_task', 'card-c')
  assert.equal(cards.focus().id, 'card-c')

  // 会话销毁：它的轮次与焦点一起清掉
  assert.equal(cards.forgetSession(s), 2)
  assert.equal(cards.focus(), null)
  assert.deepEqual(cards.idsFor('session-aaaa1111', 2), [])
})

test('②b 追踪不会无上限涨：超过 maxTurns 丢最旧的', () => {
  const cards = new CardTracker({ maxTurns: 3 })
  const s = session('s1')
  for (let t = 1; t <= 6; t++) {
    cards.observe(s, { type: 'tool/call', data: { turn: t, name: FANGCUN_TOOL_PREFIX + 'get_task', arguments: { id: 'c' + t } } })
  }
  assert.equal(cards.state().turns, 3, '只留最近 3 轮')
  assert.equal(cards.idsFor('s1', 1).length, 0, '最旧的被丢')
  assert.equal(cards.idsFor('s1', 6)[0], 'c6')
})

test('③ 逐轮度量：先查后改 / 改了没回写 / 只查不干，各自数得出来', () => {
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const s = session('session-bbbb2222')
  const call = (turn, name) => proof.record(s, { type: 'tool/call', data: { turn, name } })
  const end = (turn) => proof.record(s, { type: 'turn/end', data: { turn } })

  // 第 1 轮：先查方寸（list_tasks）→ 读文件 → 改文件 → 回写（move_status）→ 收尾
  call(1, FANGCUN_TOOL_PREFIX + 'list_tasks')
  call(1, 'read')
  call(1, 'edit')
  call(1, 'pwsh')
  call(1, FANGCUN_TOOL_PREFIX + 'move_status')
  const row1 = end(1)
  assert.ok(row1, 'turn/end 要收尾这一轮')
  assert.equal(row1.turn, 1)
  assert.equal(row1.first, FANGCUN_TOOL_PREFIX + 'list_tasks', '第一次调用是方寸')
  let v = verdictOf(row1)
  assert.equal(v.withEdit, true)
  assert.equal(v.readBeforeEdit, true, '②7：先查后改')
  assert.equal(v.wroteBack, true, '②8：动过 move_status')
  assert.equal(v.withShell, true, 'pwsh 单独计数（分不出有没有写文件）')

  // 第 2 轮：直接改文件，没查也没回写
  call(2, 'write')
  const row2 = end(2)
  v = verdictOf(row2)
  assert.equal(v.withEdit, true)
  assert.equal(v.readBeforeEdit, false, '没先查就是没先查，不许虚报')
  assert.equal(v.editFirst, true, '首工具就是写文件 —— ②7 的可行动口径')
  assert.equal(v.wroteBack, false)

  // 第 3 轮：只查了方寸，别的没动（②10 的可疑信号）
  call(3, FANGCUN_TOOL_PREFIX + 'list_tasks')
  const row3 = end(3)
  assert.equal(verdictOf(row3).readOnly, true)

  const stats = summarize([row1, row2, row3])
  assert.deepEqual(stats, { turns: 3, withEdit: 2, readBeforeEdit: 1, editFirst: 1, wroteBack: 1, readOnly: 1, withShell: 1 })
  assert.deepEqual(proof.state().turns, stats, 'health 读的就是这份汇总')

  // 重启（新建实例）：数字从 turns.jsonl 读回来，不归零
  const again = new ToolProof({ home })
  assert.deepEqual(again.state().turns, stats, '跨重启累计 —— 不然"这几天有没有联动"证明不了')
  fs.rmSync(home, { recursive: true, force: true })
})

test('③f 首工具就是编辑的轮次单独立账（editFirst），不与 readBeforeEdit 混为一谈', () => {
  // 为什么单独立：2026-11-18 复核 210 个改文件轮次 —— readBeforeEdit 29.5% 看着像规则失效，
  // 拆开看"首工具就是编辑"的只有 7.6%，其余多是"上一轮已经查过"的续作轮次。
  // 所以可行动的指标是 editFirst，不是拿 30% 去改提示词。
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const s = session('session-ffff6666')
  const call = (turn, name) => proof.record(s, { type: 'tool/call', data: { turn, name } })
  const end = (turn) => proof.record(s, { type: 'turn/end', data: { turn } })

  // ① 上来就 apply_patch：editFirst（首工具是编辑）
  call(1, 'apply_patch')
  const rowA = end(1)
  const a = verdictOf(rowA)
  assert.equal(a.withEdit, true)
  assert.equal(a.editFirst, true)
  assert.equal(a.readBeforeEdit, false)

  // ② 先 read 再 edit：不是 editFirst（读了文件，但没查方寸 —— 这是另一件事）
  call(2, 'read')
  call(2, 'edit')
  const rowB = end(2)
  const b = verdictOf(rowB)
  assert.equal(b.editFirst, false)
  assert.equal(b.readBeforeEdit, false)

  // ③ 先查方寸再改：readBeforeEdit，但不是 editFirst
  call(3, 'fangcun_tasks')
  call(3, 'write')
  const rowC = end(3)
  const c = verdictOf(rowC)
  assert.equal(c.editFirst, false)
  assert.equal(c.readBeforeEdit, true)

  // ④ 没改文件：editFirst 恒 false（哪怕首工具不是编辑）
  call(4, 'pwsh')
  assert.equal(verdictOf(end(4)).editFirst, false)

  const stats = summarize([rowA, rowB, rowC])
  assert.equal(stats.editFirst, 1, '三轮里只有一轮是"上来就改"')
  fs.rmSync(home, { recursive: true, force: true })
})

test('③d 插件工具也算联动（0.4.0）：fangcun_tasks 算查、fangcun_write 算回写', () => {
  // 病（2026-11-17 自己挖的）：0.4.0 让模型可以不走 MCP 客户端，
  // 但 proof 只认 mcp__fangcun__* → 用插件工具干的活**全都不计入**，
  // 于是 proof.turns 看起来"退步"，而实际是口径没跟上。这条钉住两条路径都认。
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const s = session('session-dddd4444')
  const call = (turn, name) => proof.record(s, { type: 'tool/call', data: { turn, name } })
  const end = (turn) => proof.record(s, { type: 'turn/end', data: { turn } })

  // 第 1 轮：插件工具走一遍完整顺序
  call(1, 'fangcun_tasks')   // 查
  call(1, 'read')
  call(1, 'edit')
  call(1, 'fangcun_write')   // 回写
  const row = end(1)
  assert.equal(row.first, 'fangcun_tasks', '第一次调用是方寸（插件工具）')
  const v = verdictOf(row)
  assert.equal(v.readBeforeEdit, true, '②7：fangcun_tasks 也要算"先查"')
  assert.equal(v.wroteBack, true, '②8：fangcun_write 要算"回写"')

  // 第 2 轮：只读插件工具 → 仍是"只查不干"
  call(2, 'fangcun_card')
  assert.equal(verdictOf(end(2)).readOnly, true, 'fangcun_card 算方寸读')

  // 第 3 轮：混用两条路径也得数得对（同一台机器上可能同时存在）
  call(3, 'fangcun_tasks')
  call(3, 'edit')
  call(3, FANGCUN_TOOL_PREFIX + 'move_status')
  const v3 = verdictOf(end(3))
  assert.equal(v3.readBeforeEdit, true)
  assert.equal(v3.wroteBack, true)

  const stats = summarize([row, ...[]])
  assert.equal(stats.turns, 1)
  fs.rmSync(home, { recursive: true, force: true })
})

test('③e 只读插件工具不能算成回写（否则"只查不干"会被误报）', () => {
  // fangcun_tasks / fangcun_card 是只读：算进 CARD_WRITE_TOOLS 会把
  // "只查不干"的可疑轮次（②10）判成正常回写 —— 那是把病掩盖掉。
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const s = session('session-eeee5555')
  const call = (turn, name) => proof.record(s, { type: 'tool/call', data: { turn, name } })
  call(1, 'fangcun_tasks')
  call(1, 'fangcun_card')
  const row = proof.record(s, { type: 'turn/end', data: { turn: 1 } })
  const v = verdictOf(row)
  assert.equal(v.wroteBack, false, '只读工具绝不能算回写')
  assert.equal(v.readOnly, true, '两把都是读 → 只查不干')
  fs.rmSync(home, { recursive: true, force: true })
})

test('③b 没收尾的轮次不丢：会话销毁时一起结算', () => {
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const s = session('session-cccc3333')
  proof.record(s, { type: 'tool/call', data: { turn: 7, name: 'edit' } })
  assert.equal(proof.state().open, 1)
  assert.equal(proof.finalizeSession(s), 1)
  assert.equal(proof.state().open, 0)
  assert.equal(proof.state().turns.turns, 1, '半轮也要算进数字')
  fs.rmSync(home, { recursive: true, force: true })
})

/**
 * ③c `turn/end` 不带 `data.turn` 是很可能的宿主差异（账本那边也是靠 agg.turn 反查）。
 * 这时要收"这个会话最新那一轮"，不能让 open 越攒越多、数字永远不动。
 */
test('③c turn/end 没带轮次：收这个会话最新的一轮，不丢数', () => {
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const s = session('session-ffff6666')
  proof.record(s, { type: 'tool/call', data: { turn: 4, name: 'edit' } })
  const row = proof.record(s, { type: 'turn/end', data: {} })
  assert.ok(row, '没带 turn 也要能收尾')
  assert.equal(row.turn, 4)
  assert.equal(proof.state().open, 0)
  assert.equal(proof.state().turns.withEdit, 1)
  fs.rmSync(home, { recursive: true, force: true })
})

test('④ note 带卡号：放得下才加，放不下宁可只报会话', () => {
  const home = tmpHome()
  const ledger = new UsageLedger({
    home,
    pipePath: 'unused',
    cardsFor: (id, turn) => (turn === 1 ? 'card-a' : turn === 2 ? 'x'.repeat(120) : ''),
  })
  const s = session('session-dddd4444')
  const msg = (turn) => ({
    type: 'assistant/message',
    data: { turn, usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 7 }, message: { source: { model: 'm' } } },
  })
  const end = (turn) => ({ type: 'turn/end', data: { turn } })

  ledger.onSessionEvent(s, msg(1))
  ledger.onSessionEvent(s, end(1))
  ledger.onSessionEvent(s, msg(2))
  ledger.onSessionEvent(s, end(2))
  ledger.onSessionEvent(s, msg(3))
  ledger.onSessionEvent(s, end(3))

  const rows = fs.readFileSync(usagePaths(home).outbox, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
  const noteOf = (t) => rows.find((r) => r.key === 'session-dddd4444#' + t).payload.note
  assert.match(noteOf(1), /card=card-a/, '有卡号就带上：方寸可以按卡归因 token')
  assert.match(noteOf(1), /cache_read=5/, '原有口径不能被挤掉')
  assert.doesNotMatch(noteOf(2), /card=/, '放不下就不加 —— 不许写半截卡号')
  assert.doesNotMatch(noteOf(3), /card=/, '没有卡号就没有')
  for (const r of rows) assert.ok(r.payload.note.length <= NOTE_MAX, 'note 不许超过方寸的 120 字上限')
  fs.rmSync(home, { recursive: true, force: true })
})

test('⑤ 状态计数与"本次在办"都照方寸的口径来，不自己发明', () => {
  const tasks = [
    { id: 'a', title: '甲', status: '进行中' },
    { id: 'b', title: '乙', status: '进行中' },
    { id: 'c', title: '丙', status: '待验收' },
    { id: 'd', title: '丁', status: '待审批' },
    { id: 'e', title: '戊', status: '待办' },
    { id: 'f', title: '己', status: '' },
  ]
  // 数的是方寸写进卡里的 status，不是我们自己判的优先级
  assert.deepEqual(countStatuses(tasks), { doing: 2, waiting: 2 })
  assert.deepEqual(countStatuses(null), { doing: 0, waiting: 0 })

  const cards = new CardTracker({})
  const s = session('session-eeee5555')
  cards.observe(s, {
    type: 'tool/call',
    data: { turn: 1, name: FANGCUN_TOOL_PREFIX + 'get_task', arguments: { id: 'a' } },
  })
  const f = focusOf(cards, tasks)
  assert.equal(f.id, 'a')
  assert.equal(f.title, '甲', '标题从这次 list_tasks 的结果里顺手匹配')

  // 卡不在可见列表（已关掉/被项目过滤）：只给卡号，不许编标题
  cards.observe(s, {
    type: 'tool/call',
    data: { turn: 1, name: FANGCUN_TOOL_PREFIX + 'get_task', arguments: { id: 'zzz' } },
  })
  const g = focusOf(cards, tasks)
  assert.equal(g.id, 'zzz')
  assert.equal(g.title, '')
  assert.equal(g.status, '')

  assert.equal(focusOf(null, tasks), null, '没有追踪器就没有这一行')
  assert.equal(focusOf(new CardTracker({}), tasks), null, '没动过卡就没有这一行')
})
