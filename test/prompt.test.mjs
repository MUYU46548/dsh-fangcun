/**
 * 提示词（规则段 + 一行现状）与自证 sidecar 的测试。
 *
 * 这里的判据都对应契约 ②⑦–⑩：开工触发 / 收工回写 / 新问题建卡 / 不过度触发。
 * 它们原本只能"人看对话"，现在由三样东西变成机器可读：
 *  · 规则段文本里有四个触发点（模型看得到才会照做）；
 *  · 一行现状是同步缓存（不卡每一轮）、方寸没开就明说未连接；
 *  · `tool/call` 落 `tools.jsonl`（事后对账用）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  BoardStatus, countOpen, formatStatusLine, formatContextLine, CLOSED_STATUSES, STATUS_REFRESH_MS,
} from '../lib/status.js'
import { ToolProof, isFangcunTool, MAX_PROOF_ROWS, proofPaths, FANGCUN_TOOL_PREFIX } from '../lib/proof.js'
import {
  RULES_TEXT, RULES_SECTION_NAME, STATUS_CONTEXT_NAME, MEMORY_CONTEXT_NAME,
  RULES_ORDER, STATUS_ORDER, registerPrompt,
} from '../lib/prompt.js'

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-prompt-'))

test('①b 规则段必须同时给出两条路径（MCP 掉线时不能变成死指令）', () => {
  // 2026-11-17：原来只写 `mcp__fangcun__*`。那批属于方寸 MCP 客户端，
  // 掉线时工具表里根本没有这些名字 → 模型照着调会报"没有这个工具"。
  // 所以规则段要同时给出插件工具名，并说明优先用哪个。
  assert.match(RULES_TEXT, /fangcun_tasks/, '要给出插件工具名')
  assert.match(RULES_TEXT, /fangcun_card/)
  assert.match(RULES_TEXT, /fangcun_write/)
  assert.match(RULES_TEXT, /mcp__fangcun__list_tasks/, 'MCP 那套也要留着（连上时它更直接）')
  assert.match(RULES_TEXT, /不依赖 MCP 客户端/, '要说清插件工具为什么不依赖 MCP')
  assert.match(RULES_TEXT, /优先插件工具/, '两个都有时要给明确优先级，别让模型自己猜')
})

test('①c 规则段钉住「只到待验收」—— 两道锁的第一道（第二道在方寸本体）', () => {
  // 梅林 2026-11-17："DSH 也得过闸……智能层不豁免治理层"。
  // 真正的硬拒在方寸 `mcp/tools.ts` 的 move_status（完成/驳回直接报错），
  // 但模型不该先撞墙才知道 —— 规则段要提前说清。
  assert.match(RULES_TEXT, /待验收/, '要写明只到待验收')
  assert.match(RULES_TEXT, /完成.*驳回.*签字|签字/, '要说清完成/驳回是用户的签字')
  assert.match(RULES_TEXT, /拒绝|硬拒/, '要说明方寸会拒绝，别让模型去试')
})

test('①d 「待验收」= 验收项全部验过，不是「差不多了」（用户 2026-11-17 的原话）', () => {
  // 用户："没做完的东西就不该这样放，我除了签完成只有驳回"。
  // 我把一张标题写着"待重启复核"的卡送进待验收，逼他在两个都不对的选项里选 —— 这条钉住它。
  assert.match(RULES_TEXT, /验收项全部验过/, '要把"待验收"的定义写死，不能只写"移到待验收就停手"')
  assert.match(RULES_TEXT, /不是"差不多了"|不是「差不多了」/, '要显式否掉"差不多了"这个理解')
  // 三类"还没验完"的字样必须被点名：卡上留着这些就不许送签
  for (const word of ['待复核', '待真机', '待重启']) {
    assert.ok(RULES_TEXT.includes(word), '要点名「' + word + '」这类字样 —— 卡上留着它就不许进待验收')
  }
  assert.match(RULES_TEXT, /留在 `进行中`/, '没验完该去哪儿：留在进行中')
  assert.match(RULES_TEXT, /二选一/, '要说清害处：逼用户在完成/驳回里二选一，两个都不对')
  assert.match(RULES_TEXT, /我的错/, '这是 agent 的错，不许写成用户的负担')
})

test('① 规则段钉住四个触发点（⑦开工第一件事 / ⑧收工回写 / ⑨新问题建卡 / ⑩不过度触发）', () => {
  // 2026-11-17 改：`开工先查` → `开工第一件事是 fangcun_context`。
  // 原话术只说"先查"，模型可以理解成"先 list_tasks 看一眼"（真机实测：插件工具 0 次使用）。
  // 现在把**具体是哪个工具、为什么不是 MCP 那五跳**写死在规则段里。
  assert.match(RULES_TEXT, /开工第一件事/)
  assert.match(RULES_TEXT, /fangcun_context/, '必须点名这一次调用，不能说"先查方寸"了事')
  assert.match(RULES_TEXT, /五次/, '要说清 MCP 那条路要五跳 —— 这是模型换用插件工具的唯一理由')
  assert.match(RULES_TEXT, /收工回写/)
  assert.match(RULES_TEXT, /新问题建卡/)
  // 「不过度触发」是反例条款：闲聊不查
  assert.match(RULES_TEXT, /闲聊/)
  // 不许假装写成功
  assert.match(RULES_TEXT, /不要声称已经改好/)
  // 工具名要写对（模型照着调），并且明确不许手改数据文件
  assert.match(RULES_TEXT, /mcp__fangcun__list_tasks/)
  assert.match(RULES_TEXT, /不要手改 `task-data\/`/)
})

test('①b 记忆规则：工具名真实存在、写口只说待审批、收尾自检有整理包入口', () => {
  // 2026-11-25（P16.1/P16.2）：提示词点名的记忆工具必须和工具面一致 ——
  // 0.7.8 的病根就是「教了 memory_search、工具面没有」，模型只能空转。
  for (const name of [
    'fangcun_memory_search',
    'fangcun_memory_read',
    'fangcun_memory_write',
    'fangcun_memory_organize',
  ]) {
    assert.match(RULES_TEXT, new RegExp(name), '提示词必须点名 ' + name)
  }
  assert.match(RULES_TEXT, /待审批/, '写口必须说清永远落待审批')
  assert.match(RULES_TEXT, /不能自批/, '要显式禁止自批')
  assert.match(RULES_TEXT, /收尾自检/, '要有收尾自检（会话结束前的自动提案规则）')
  assert.doesNotMatch(RULES_TEXT, /(?<!fangcun_)memory_(search|read|write|organize)/, '不许出现裸的 MCP 名')
})

test('② registerPrompt：段 + 两块 context（现状 / 记忆）都注册，名字/顺序对得上，disposer 全撤', () => {
  const calls = []
  const sp = {
    section(input) { calls.push(['section', input]); return () => calls.push(['off-section']) },
    context(input) { calls.push(['context', input]); return () => calls.push(['off-context']) },
  }
  // ⚠ 2026-11-24 改（问卷 B6=C：自动推一屏）：context 从 1 块变成 2 块 ——
  //   `status`（一行现状，随卡数微动）与 `memory`（记忆核心，只在记忆真改了才动）**节奏不同**，
  //   合在一处会让"卡数变一次 → 记忆也重发一次"。
  const dispose = registerPrompt(sp, {
    line: () => '全部项目 · 未完成 3 张 · 截至 18:30',
    memoryLine: () => '- [D5] 禁止 agent 自行 kill 宿主。 → mem-1',
  })

  const section = calls.find(([kind]) => kind === 'section')[1]
  const contexts = calls.filter(([kind]) => kind === 'context').map(([, v]) => v)
  assert.equal(section.name, RULES_SECTION_NAME)
  assert.equal(section.order, RULES_ORDER)
  assert.equal(section.text, RULES_TEXT, '规则段是静态文本，不掺动态数据（提示词缓存靠这个）')

  assert.equal(contexts.length, 2, '现状 + 记忆，两块')

  const status = contexts.find((c) => c.name === STATUS_CONTEXT_NAME)
  assert.equal(status.order, STATUS_ORDER)
  assert.equal(status.text(), '全部项目 · 未完成 3 张 · 截至 18:30')

  const memory = contexts.find((c) => c.name === MEMORY_CONTEXT_NAME)
  assert.ok(memory, '记忆块必须注册（否则 agent 永远看不到记忆 —— 这就是「开一百次会话一次不看」）')
  assert.equal(memory.order, STATUS_ORDER + 1, '记忆排在现状之后')
  assert.match(memory.text(), /禁止 agent 自行 kill/, '记忆块的正文来自 memory_core')

  dispose()
  assert.deepEqual(
    calls.slice(3),
    [['off-section'], ['off-context'], ['off-context']],
    'disposer 要把三块都撤掉（漏一块就会留一条僵尸提示）',
  )
})

test('②b 记忆块：内容必须**稳定**（不稳定会让 DSH 每分钟重发一条运行时提醒）', () => {
  // 这不是洁癖：formatContextLine 上面那段事故说明——DSH 拿所有 section 的**原文**逐字比较，
  // 变了就追加一条 system-reminder。方寸那行原来带分钟级时间戳，结果**每分钟一条**，
  // 把 DSH 自己 10 分钟的时钟节流完全绕过。记忆块若带"刚刚刷新/截至 HH:MM"就是同一个病。
  const calls = []
  const sp = {
    section() { return () => {} },
    context(input) { calls.push(input); return () => {} },
  }
  registerPrompt(sp, {
    line: () => '全部项目 · 未完成 3 张',
    memoryLine: () => '- [D5] 禁止 agent 自行 kill 宿主。 → mem-1',
  })
  const memory = calls.find((c) => c.name === MEMORY_CONTEXT_NAME)
  const a = memory.text()
  // 隔开一段时间再取一次 —— 真实现里这中间会刷新 N 次
  const b = memory.text()
  assert.equal(a, b, '同样输入必须给同样输出')
  assert.doesNotMatch(a, /\d{1,2}:\d{2}/, '**不许带时刻**（HH:MM 会让 DSH 每分钟判定"变了"）')
  assert.doesNotMatch(a, /截至|刚刚|刚刚刷新/, '不许带"截至/刚刚"这类会随时间变的词')
})

test('②c 记忆块为空时不许编、不许说"没有记忆"', () => {
  const calls = []
  const sp = {
    section() { return () => {} },
    context(input) { calls.push(input); return () => {} },
  }
  // memoryLine 给空串（= 没连上 / 记忆关着 / core 为空）时，context 的文本必须是空串，
  // 而不是"（没有记忆）"这种谎话 —— 空、关、读失败、没连上是四件事。
  registerPrompt(sp, { line: () => 'x', memoryLine: () => '' })
  const memory = calls.find((c) => c.name === MEMORY_CONTEXT_NAME)
  assert.equal(memory.text(), '', '空就是空，不许编一句话')
})

test('③ provider 抛错不能带崩整轮提示词装配', () => {
  let captured = null
  const sp = {
    section() { return () => {} },
    context(input) { captured = input; return () => {} },
  }
  registerPrompt(sp, { line: () => { throw new Error('方寸炸了') } })
  assert.equal(captured.text(), '', 'provider 抛错要吞掉并给空串')
})

test('④ 一行现状的格式：全部项目 / 指定项目 / 未连接 / 未知都不糊弄', () => {
  const at = new Date(2026, 10, 3, 18, 6).getTime()
  assert.equal(formatStatusLine({ total: 114, at, project: '' }), '全部项目 · 未完成 114 张 · 截至 18:06')
  assert.equal(formatStatusLine({ total: 54, at, project: 'sitian' }), 'sitian · 未完成 54 张 · 截至 18:06')
  assert.equal(formatStatusLine({ total: null, at, error: 'ECONNREFUSED' }), '方寸 · 未连接')
  assert.equal(formatStatusLine({ total: null, at }), '方寸 · 未连接', '没数据就说没连上，不显示 0 张')
  assert.equal(formatStatusLine({ total: null, at, installed: false }), '方寸 · 未安装',
    '没装本体 ≠ 没连上：前者要请用户去下载')
  assert.equal(formatStatusLine({ total: 3, at, installed: false }), '方寸 · 未安装', '未安装优先于任何旧数字')
  assert.equal(formatStatusLine(null), '方寸 · 未连接')
})

test('④-b 给 agent 的 context 行**不带时间戳**（否则 DSH 每分钟重发一条运行时快照）', () => {
  const a = formatContextLine({ total: 114, at: new Date(2026, 10, 3, 18, 6).getTime(), project: '' })
  const b = formatContextLine({ total: 114, at: new Date(2026, 11, 22, 23, 59).getTime(), project: '' })
  assert.equal(a, '全部项目 · 未完成 114 张')
  assert.equal(a, b, '时间不同、数字相同 → 文本必须逐字相同（DSH 靠这个判定"没变"）')
  assert.ok(!a.includes('截至'), 'agent 那份不许出现“截至”')
  assert.equal(formatContextLine({ total: 54, at: 1, project: 'sitian' }), 'sitian · 未完成 54 张')
  assert.equal(formatContextLine({ total: null, at: 1, error: 'ECONNREFUSED' }), '方寸 · 未连接')
  assert.equal(formatContextLine({ total: null, at: 1, installed: false }), '方寸 · 未安装')
  assert.equal(formatContextLine({ total: 3, at: 1, installed: false }), '方寸 · 未安装')
  assert.equal(formatContextLine(null), '方寸 · 未连接')
  // 给人看的那一份仍然保留时间（health 要靠它说"最后一次成功是什么时候"）
  assert.match(formatStatusLine({ total: 114, at: 1, project: '' }), /截至 \d\d:\d\d$/)
})

test('⑤ 未完成口径：完成/驳回不算，空状态算（没填 ≠ 做完）', () => {
  assert.deepEqual([...CLOSED_STATUSES], ['完成', '驳回'])
  const tasks = [
    { status: '待办' }, { status: '进行中' }, { status: '' },
    { status: '完成' }, { status: '驳回' }, null, {},
  ]
  assert.equal(countOpen(tasks), 4)
  assert.equal(countOpen(null), 0)
})

/** 起一个假方寸管道，只答 list_tasks */
async function fakePipe(pipePath, { tasks, fail }) {
  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const req = JSON.parse(line)
        if (req.id === undefined) continue
        const reply = (result) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
        if (req.method === 'initialize') {
          reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fangcun', version: 'test' } })
        } else if (req.method === 'tools/call') {
          if (fail) {
            reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false }) }], isError: true })
            continue
          }
          reply({ content: [{ type: 'text', text: JSON.stringify(tasks) }] })
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(pipePath, resolve))
  return server
}

const uniquePipe = () => `\\\\.\\pipe\\dsh-fangcun-status-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`

test('⑥ BoardStatus：刷新后只读内存，数字来自 list_tasks；方寸没开就是未连接', async () => {
  const pipePath = uniquePipe()
  const server = await fakePipe(pipePath, {
    tasks: [{ status: '待办' }, { status: '完成' }, { status: '进行中' }, { status: '' }],
  })
  try {
    const board = new BoardStatus({ pipePath, clientVersion: 'test' })
    assert.equal(board.line(), '方寸 · 未连接', '还没刷新时不能说 0 张')
    await board.refresh()
    assert.match(board.line(), /^全部项目 · 未完成 3 张 · 截至 \d\d:\d\d$/)
    assert.equal(board.contextLine(), '全部项目 · 未完成 3 张',
      '注册给 agent 的那一行不带时间戳（否则每分钟都算“快照变了”）')
    assert.equal(board.state().total, 3)

    // provider 只读快照：再调一百次也不碰管道
    const before = Date.now()
    for (let i = 0; i < 100; i++) assert.match(board.line(), /未完成 3 张/)
    assert.ok(Date.now() - before < 1000, 'line() 必须是纯内存')
    assert.equal(STATUS_REFRESH_MS, 60_000)
  } finally {
    server.close()
  }

  // 管道不在：不抛，给"未连接"
  const dead = new BoardStatus({ pipePath: uniquePipe(), clientVersion: 'test' })
  await dead.refresh()
  assert.equal(dead.line(), '方寸 · 未连接')
  assert.ok(dead.state().error, '失败原因要留在 state 里')
})

test('⑦ 一行现状按项目过滤时把项目名带上', async () => {
  const pipePath = uniquePipe()
  const server = await fakePipe(pipePath, { tasks: [{ status: '待办' }, { status: '' }] })
  try {
    const board = new BoardStatus({ pipePath, project: 'sitian', clientVersion: 'test' })
    await board.refresh()
    assert.match(board.line(), /^sitian · 未完成 2 张 · 截至 \d\d:\d\d$/)
    assert.equal(board.contextLine(), 'sitian · 未完成 2 张')
    assert.equal(board.state().project, 'sitian')
  } finally {
    server.close()
  }
})

test('⑧ 自证 sidecar：只记方寸工具、只记名字不记参数、按会话归一化 id', () => {
  const home = tmpHome()
  const proof = new ToolProof({ home })
  const session = { id: 'session-abc12345', header: { id: 'session-abc12345' } }

  const row = proof.record(session, {
    type: 'tool/call',
    data: { turn: 3, step: 1, callId: 'c1', name: FANGCUN_TOOL_PREFIX + 'list_tasks', arguments: '{"secret":"x"}' },
  })
  assert.ok(row)
  assert.equal(row.session, 'session-abc12345')
  assert.equal(row.turn, 3)
  assert.equal(row.tool, FANGCUN_TOOL_PREFIX + 'list_tasks')
  assert.equal(JSON.stringify(row).includes('secret'), false, '参数里有用户私事，绝不落盘')

  // 非方寸工具、非 tool/call、取不出会话 id —— 都不记
  assert.equal(proof.record(session, { type: 'tool/call', data: { name: 'read' } }), null)
  assert.equal(proof.record(session, { type: 'assistant/message', data: { name: FANGCUN_TOOL_PREFIX + 'list_tasks' } }), null)
  assert.equal(proof.record('[object Object]', { type: 'tool/call', data: { name: FANGCUN_TOOL_PREFIX + 'list_tasks' } }), null)

  const file = proofPaths(home).tools
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1, '只该有那一条')
  assert.equal(proof.state().rows, 1)
  assert.ok(proof.state().lastAt, '要记最后一次时间')
  assert.equal(isFangcunTool('mcp__fangcun__create_task'), true)
  assert.equal(isFangcunTool('mcp__other__x'), false)

  fs.rmSync(home, { recursive: true, force: true })
})

test('⑨ 自证日志有上限：超了丢最旧的，不许无限长', () => {
  const home = tmpHome()
  const proof = new ToolProof({ home })
  for (let i = 0; i < MAX_PROOF_ROWS + 3; i++) {
    proof.record({ id: 's1', header: { id: 's1' } }, { type: 'tool/call', data: { turn: i + 1, name: FANGCUN_TOOL_PREFIX + 'get_task' } })
  }
  const rows = fs.readFileSync(proofPaths(home).tools, 'utf-8').trim().split('\n')
  assert.equal(rows.length, MAX_PROOF_ROWS)
  const first = JSON.parse(rows[0])
  assert.equal(first.turn, 4, '丢掉的是最旧的那几条（前 3 轮）')
  assert.equal(proof.state().rows, MAX_PROOF_ROWS)
  fs.rmSync(home, { recursive: true, force: true })
})
