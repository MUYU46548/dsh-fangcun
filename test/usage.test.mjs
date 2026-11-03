/**
 * 用量上报的契约测试（真起一个假方寸管道，不依赖 DSH、不依赖真方寸）
 *
 * 钉住四件事：
 *  ① **不丢**：方寸没开（管道不存在 / 空路径）→ 记录留在 outbox，进程不炸；
 *  ② **能发**：方寸开了 → initialize + tools/call(usage_report)，口径 = prompt 含 cache、
 *     completion = output，发完 outbox 清空、sent 记账；
 *  ③ **不重**：同一 `sessionId#turn` 结算两次 / 进程重启后重放 → 不重复上报；
 *  ④ **不被毒记录卡死**：方寸明确拒绝（ok:false）→ 丢掉这条并报错，不挡后面的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { UsageLedger, usagePaths } from '../lib/usage.js'

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-usage-'))
const uniquePipe = () => `\\\\.\\pipe\\dsh-fangcun-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`

/** 假方寸：换行分隔 JSON-RPC，initialize 回握手，tools/call 记账并按 reply 回包 */
function startFakeFangcun(pipePath, { reply } = {}) {
  const calls = []
  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let req
        try { req = JSON.parse(line) } catch { continue }
        if (req.id === undefined || req.id === null) continue // 通知不回包
        if (req.method === 'initialize') {
          socket.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fangcun', version: 'test' } },
          }) + '\n')
        } else if (req.method === 'tools/call') {
          calls.push(req.params)
          const value = typeof reply === 'function' ? reply(req.params) : { ok: true, recorded: req.params.arguments }
          socket.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
          }) + '\n')
        } else {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not found' } }) + '\n')
        }
      }
    })
    socket.on('error', () => { /* 断开是常态 */ })
  })
  return new Promise((resolve) => server.listen(pipePath, () => resolve({ server, calls })))
}

/** 造一轮会话：两步 assistant/message（含 cache）+ 一个 turn/end */
function feedTurn(ledger, sessionId, turn, steps) {
  for (const step of steps) {
    ledger.onSessionEvent(sessionId, {
      type: 'assistant/message',
      data: {
        turn,
        usage: { inputTokens: step.input, cacheReadTokens: step.cache, outputTokens: step.output },
        message: { source: { model: 'deepseek/deepseek-v4.1-flash' } },
      },
    })
  }
  ledger.onSessionEvent(sessionId, { type: 'turn/end', data: { turn } })
}

test('① 方寸没开：记录留在 outbox，不抛、不丢', () => {
  const home = tmpHome()
  try {
    const ledger = new UsageLedger({ home, pipePath: '' })
    feedTurn(ledger, 'sess-offline', 1, [{ input: 100, cache: 900, output: 50 }])
    assert.equal(ledger.pendingCount(), 1)
    const rows = fs.readFileSync(usagePaths(home).outbox, 'utf-8').trim().split('\n')
    assert.equal(rows.length, 1)
    const rec = JSON.parse(rows[0])
    assert.equal(rec.key, 'sess-offline#1')
    assert.equal(rec.payload.prompt_tokens, 1000, 'prompt 必须含 cache_read')
    assert.equal(rec.payload.completion_tokens, 50)
    assert.equal(rec.payload.model, 'deepseek/deepseek-v4.1-flash')
    assert.match(rec.payload.note, /cache_read=900/)
    assert.equal(rec.payload.cost, undefined, '不许报金额（DSH 没有供应商报价）')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('② 方寸开了：握手 + tools/call(usage_report)，发完清空并记账', async () => {
  const home = tmpHome()
  const pipePath = uniquePipe()
  const fake = await startFakeFangcun(pipePath)
  try {
    // 先用"方寸没开"的路径攒一条，再用真路径的 ledger 发出去（模拟下次重试）
    const offline = new UsageLedger({ home, pipePath: '' })
    feedTurn(offline, 'sess-e2e', 3, [{ input: 200, cache: 1800, output: 120 }])
    assert.equal(offline.pendingCount(), 1)

    const ledger = new UsageLedger({ home, pipePath, clientVersion: '0.2.0' })
    assert.equal(ledger.pendingCount(), 1, '新 ledger 应当从 outbox 接上未发的记录')
    await ledger.flush()

    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].name, 'usage_report')
    const args = fake.calls[0].arguments
    assert.equal(args.client, 'dsh')
    assert.equal(args.prompt_tokens, 2000)
    assert.equal(args.completion_tokens, 120)
    assert.equal(ledger.pendingCount(), 0)

    const sent = fs.readFileSync(usagePaths(home).sent, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(sent[0].key, 'sess-e2e#3')
  } finally {
    fake.server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('③ 幂等：同一轮结算两次 / 重启后重放，都不重复上报', async () => {
  const home = tmpHome()
  const pipePath = uniquePipe()
  const fake = await startFakeFangcun(pipePath)
  try {
    const first = new UsageLedger({ home, pipePath })
    feedTurn(first, 'sess-dup', 7, [{ input: 10, cache: 0, output: 5 }])
    await first.flush()
    assert.equal(fake.calls.length, 1)

    // 同一个 turn/end 又来一次
    first.onSessionEvent('sess-dup', { type: 'turn/end', data: { turn: 7 } })
    await first.flush()
    assert.equal(fake.calls.length, 1, '重复结算不该再发')

    // 进程重启：新 ledger 读 sent.jsonl，重放同一轮事件也不该再发
    const second = new UsageLedger({ home, pipePath })
    feedTurn(second, 'sess-dup', 7, [{ input: 10, cache: 0, output: 5 }])
    await second.flush()
    assert.equal(fake.calls.length, 1, '重放已发过的轮次不该再发')
  } finally {
    fake.server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('④ 方寸明确拒绝（ok:false）：丢掉这条并报错，不卡住队列', async () => {
  const home = tmpHome()
  const pipePath = uniquePipe()
  const fake = await startFakeFangcun(pipePath, { reply: () => ({ ok: false, error: 'bad payload' }) })
  const errors = []
  try {
    const ledger = new UsageLedger({ home, pipePath, onError: (m) => errors.push(m) })
    feedTurn(ledger, 'sess-bad', 1, [{ input: 1, cache: 0, output: 1 }])
    await ledger.flush()
    assert.equal(fake.calls.length, 1)
    assert.equal(ledger.pendingCount(), 0, '毒记录必须丢掉，否则会永远堵在队头')
    assert.ok(errors.some((e) => /拒绝/.test(e)), JSON.stringify(errors))
  } finally {
    fake.server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * ⑥ 真机契约：宿主派发的是 **Session 对象**，不是字符串。
 *
 * 2026-11-03 真机事故：`session/event` 的签名是 `(session, event)`，`session` 是对象，
 * id 在 `session.id`。旧实现直接 `String(session)` → 所有会话都变成 `"[object Object]"`，
 * 幂等键退化成 `[object Object]#<turn>`：**不同会话的同一 turn 互相顶掉**，
 * 表现为"某些轮次静默漏报"（方寸账本里 note 写着 `session=[object`）。
 *
 * 这条测试钉住：① 对象形状能取出真 id；② 两个不同会话的同一轮都要报出去。
 */
test('⑥ Session 对象形状：取出真 id，且不同会话的同一轮不互相顶掉', () => {
  const home = tmpHome()
  try {
    const ledger = new UsageLedger({ home, pipePath: '' })
    // 真宿主给的对象：id 与 header.id 都在（见 DSH 源码 session.header.id / session.id）
    const sessionA = { id: 'session-aaaa1111-2222-3333-4444-555566667777', header: { id: 'session-aaaa1111-2222-3333-4444-555566667777' } }
    const sessionB = { id: 'session-bbbb1111-2222-3333-4444-555566667777', header: { id: 'session-bbbb1111-2222-3333-4444-555566667777' } }

    feedTurn(ledger, sessionA, 1, [{ input: 100, cache: 0, output: 10 }])
    feedTurn(ledger, sessionB, 1, [{ input: 200, cache: 0, output: 20 }])

    assert.equal(ledger.pendingCount(), 2, '两个会话的第 1 轮都必须在队列里（旧实现会退化成同一条）')

    const rows = fs.readFileSync(usagePaths(home).outbox, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const keys = rows.map((r) => r.key).sort()
    assert.deepEqual(keys, [
      'session-aaaa1111-2222-3333-4444-555566667777#1',
      'session-bbbb1111-2222-3333-4444-555566667777#1',
    ])
    for (const r of rows) {
      assert.doesNotMatch(r.key, /\[object Object\]/, '绝不允许把会话对象拍成字符串当 id')
      assert.doesNotMatch(r.payload.note, /\[object/, 'note 里不能出现 [object Object]')
    }

    // note 要能区分是哪个会话：不能是 "session=session-"
    const notes = rows.map((r) => r.payload.note).sort()
    assert.match(notes[0], /session=aaaa1111/)
    assert.match(notes[1], /session=bbbb1111/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('⑥b 取不出 id 时不猜、不污染账本，只报一次错', () => {
  const home = tmpHome()
  const errors = []
  try {
    const ledger = new UsageLedger({ home, pipePath: '', onError: (m) => errors.push(m) })
    const noId = { header: {} }
    feedTurn(ledger, noId, 1, [{ input: 5, cache: 0, output: 5 }])
    assert.equal(ledger.pendingCount(), 0, '没有 id 就不该落一条假记录')
    assert.equal(errors.length, 1, '要报错，但只报一次（别每轮刷日志）')
    assert.match(errors[0], /会话/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * ⑦ 子代理标记：宿主里**没有** `subagent/start|end` 事件，
 * 判据在 `SessionHeader`（`origin:'subagent'` / `parentSession` / `delegationDepth`）。
 * 子代理的 token 是真花的钱，照样要报，但要在 note 里标出来。
 */
test('⑦ 子代理会话：照报，但 note 带 subagent=1；主会话不带', () => {
  const home = tmpHome()
  try {
    const ledger = new UsageLedger({ home, pipePath: '' })
    const main = { id: 'session-main0001', header: { id: 'session-main0001', createdAt: 1 } }
    const child = {
      id: 'session-child001',
      header: { id: 'session-child001', origin: 'subagent', parentSession: 'session-main0001', delegationDepth: 1 },
    }

    feedTurn(ledger, main, 1, [{ input: 10, cache: 0, output: 2 }])
    feedTurn(ledger, child, 1, [{ input: 40, cache: 0, output: 8 }])

    assert.equal(ledger.pendingCount(), 2, '子代理的账不能丢')
    const rows = fs.readFileSync(usagePaths(home).outbox, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.payload]))
    assert.match(byKey['session-main0001#1'].note, /session=main0001/)
    assert.doesNotMatch(byKey['session-main0001#1'].note, /subagent/)
    assert.match(byKey['session-child001#1'].note, /subagent=1/)
    assert.equal(byKey['session-child001#1'].prompt_tokens, 40, '子代理的 token 要原样报，不能因为标记就丢')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * ⑧ outbox 上限：方寸长期不开时 outbox 会一直涨，而它每轮整份重写。
 * 超了要丢**最旧**的并吵一声（静默丢账是最坏的结果）。
 */
test('⑧ outbox 超上限：丢最旧的、报错、且不超过上限', () => {
  const home = tmpHome()
  const errors = []
  try {
    const ledger = new UsageLedger({ home, pipePath: '', onError: (m) => errors.push(m) })
    const session = { id: 'session-cap00001', header: { id: 'session-cap00001' } }
    for (let turn = 1; turn <= 510; turn++) {
      feedTurn(ledger, session, turn, [{ input: 1, cache: 0, output: 1 }])
    }
    assert.ok(ledger.pendingCount() <= 500, '不能无限涨：' + ledger.pendingCount())
    const rows = fs.readFileSync(usagePaths(home).outbox, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(rows.length <= 500)
    assert.equal(rows[rows.length - 1].key, 'session-cap00001#510', '最新的必须留着')
    assert.ok(!rows.some((r) => r.key === 'session-cap00001#1'), '最旧的应当被丢掉')
    assert.ok(errors.some((e) => /outbox 超过/.test(e)), '丢数据必须报错：' + JSON.stringify(errors.slice(0, 2)))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * ⑨ 轮次回绕：正常不会发生（宿主 turn 来自持久投影），但一旦发生，
 * 撞键会让整轮**静默消失**。这里钉的是"宁可吵，不可静默"。
 */
test('⑨ 轮次回绕撞上已发键：不重复报，但必须报错说明丢了一轮', () => {
  const home = tmpHome()
  const errors = []
  try {
    const ledger = new UsageLedger({ home, pipePath: '', onError: (m) => errors.push(m) })
    const session = { id: 'session-rewind001', header: { id: 'session-rewind001' } }
    feedTurn(ledger, session, 3, [{ input: 10, cache: 0, output: 1 }])
    assert.equal(ledger.pendingCount(), 1)

    // 模拟"已发过第 1 轮"，然后轮次回绕到 1
    ledger.sent.add('session-rewind001#1')
    feedTurn(ledger, session, 1, [{ input: 99, cache: 0, output: 9 }])
    assert.equal(ledger.pendingCount(), 1, '撞键的这轮不能重复入队（否则就是多报账）')
    assert.ok(errors.some((e) => /回绕/.test(e)), '丢了必须吵：' + JSON.stringify(errors))

    // 未撞键的回绕（该轮次从没发过）应当正常上报，不能被误杀
    feedTurn(ledger, session, 2, [{ input: 7, cache: 0, output: 3 }])
    assert.equal(ledger.pendingCount(), 2, '没撞键的回绕不该丢')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('⑤ 零 token 的轮次不产生记录；会话销毁时结算未结算的半轮', () => {
  const home = tmpHome()
  try {
    const ledger = new UsageLedger({ home, pipePath: '' })
    ledger.onSessionEvent('sess-empty', { type: 'turn/end', data: { turn: 1 } })
    assert.equal(ledger.pendingCount(), 0)

    // 只来了 assistant/message，没有 turn/end → 会话销毁时补结算
    ledger.onSessionEvent('sess-half', {
      type: 'assistant/message',
      data: { turn: 2, usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 4 }, message: { source: { model: 'm' } } },
    })
    assert.equal(ledger.pendingCount(), 0, '还没结算')
    ledger.onSessionDisposed('sess-half')
    assert.equal(ledger.pendingCount(), 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
