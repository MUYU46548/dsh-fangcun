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
  BoardStatus, countOpen, formatStatusLine, CLOSED_STATUSES, STATUS_REFRESH_MS,
} from '../lib/status.js'
import { ToolProof, isFangcunTool, MAX_PROOF_ROWS, proofPaths, FANGCUN_TOOL_PREFIX } from '../lib/proof.js'
import {
  RULES_TEXT, RULES_SECTION_NAME, STATUS_CONTEXT_NAME, RULES_ORDER, STATUS_ORDER, registerPrompt,
} from '../lib/prompt.js'

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-prompt-'))

test('① 规则段钉住四个触发点（⑦开工先查 / ⑧收工回写 / ⑨新问题建卡 / ⑩不过度触发）', () => {
  assert.match(RULES_TEXT, /开工先查/)
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

test('② registerPrompt：段 + context 都注册，名字/顺序/文本对得上，disposer 能撤', () => {
  const calls = []
  const sp = {
    section(input) { calls.push(['section', input]); return () => calls.push(['off-section']) },
    context(input) { calls.push(['context', input]); return () => calls.push(['off-context']) },
  }
  const dispose = registerPrompt(sp, { line: () => '全部项目 · 未完成 3 张 · 截至 18:30' })

  const section = calls.find(([kind]) => kind === 'section')[1]
  const context = calls.find(([kind]) => kind === 'context')[1]
  assert.equal(section.name, RULES_SECTION_NAME)
  assert.equal(section.order, RULES_ORDER)
  assert.equal(section.text, RULES_TEXT, '规则段是静态文本，不掺动态数据（提示词缓存靠这个）')

  assert.equal(context.name, STATUS_CONTEXT_NAME)
  assert.equal(context.order, STATUS_ORDER)
  assert.equal(context.text(), '全部项目 · 未完成 3 张 · 截至 18:30')

  dispose()
  assert.deepEqual(calls.slice(2), [['off-section'], ['off-context']], 'disposer 要把两个都撤掉')
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
