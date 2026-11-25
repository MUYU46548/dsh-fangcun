/**
 * v3 自动绑定 · 每会话文件作用域（2026-11-25）
 *
 * 判据不是"能记"，是**只记该记的、分得清会话、忘得掉**：
 *  ① 只认读/写/改文件的工具（`read/write/edit/...`），`pwsh` / `grep` 目录一律不认；
 *  ② 路径只做 `\`→`/` 归一，不解析相对/绝对（解析错比不解析更坏）；
 *  ③ 同文件只留一条；每会话上限 24，超了丢最旧；
 *  ④ 会话之间不串；`forget()` 真删；
 *  ⑤ 坏事件（非 tool/call、坏 JSON、缺 id）返回空数组、不抛。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionScopes, sessionIdOf } from '../lib/scopes.js'

const call = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

test('① 只认文件工具，路径归一，同文件去重', () => {
  const s = new SessionScopes()
  const session = { id: 's1' }
  assert.deepEqual(s.observe(session, call('read', { file_path: 'E:\\a.ts' })), ['file:E:/a.ts'])
  assert.deepEqual(s.list('s1'), ['file:E:/a.ts'])

  // 同文件再观察不重复
  assert.deepEqual(s.observe(session, call('write', { file_path: 'E:/a.ts' })), [])
  // 改文件也记
  assert.deepEqual(s.observe(session, call('edit', { file_path: 'E:/b.ts' })), ['file:E:/b.ts'])
  // 非文件工具不认
  assert.deepEqual(s.observe(session, call('pwsh', { command: 'cat x' })), [])
  // grep 的 path 是目录范围，不是"某个文件上次做到哪"
  assert.deepEqual(s.observe(session, call('grep', { pattern: 'x', path: 'E:/dir' })), [])
  // 参数是对象（不是 JSON 串）也认
  assert.deepEqual(
    s.observe(session, { type: 'tool/call', data: { name: 'read', arguments: { file_path: 'E:/c.ts' } } }),
    ['file:E:/c.ts'],
  )
  assert.deepEqual(s.list('s1'), ['file:E:/a.ts', 'file:E:/b.ts', 'file:E:/c.ts'])
})

test('② 每会话上限 24，超了丢最旧', () => {
  const s = new SessionScopes()
  for (let i = 0; i < 30; i++) s.observe({ id: 's1' }, call('read', { file_path: `E:/f${i}.ts` }))
  const list = s.list('s1')
  assert.equal(list.length, 24)
  assert.equal(list[0], 'file:E:/f6.ts', '最旧的 0–5 被挤掉')
  assert.equal(list[list.length - 1], 'file:E:/f29.ts')
})

test('③ 会话之间不串；forget 真删', () => {
  const s = new SessionScopes()
  s.observe({ id: 's1' }, call('read', { file_path: 'E:/a.ts' }))
  s.observe({ id: 's2' }, call('read', { file_path: 'E:/b.ts' }))
  assert.deepEqual(s.list('s1'), ['file:E:/a.ts'])
  assert.deepEqual(s.list('s2'), ['file:E:/b.ts'])
  assert.equal(s.size(), 2)
  s.forget('s1')
  assert.deepEqual(s.list('s1'), [])
  assert.equal(s.size(), 1)
})

test('④ 坏事件不抛、返回空；空 id 不记', () => {
  const s = new SessionScopes()
  assert.deepEqual(s.observe({ id: 's1' }, { type: 'turn/end' }), [])
  assert.deepEqual(s.observe({ id: 's1' }, { type: 'tool/call', data: { name: 'read', arguments: 'not json' } }), [])
  assert.deepEqual(s.observe({ id: 's1' }, { type: 'tool/call', data: { name: 'read', arguments: { file_path: '   ' } } }), [])
  assert.deepEqual(s.observe(null, call('read', { file_path: 'E:/a.ts' })), [])
  assert.equal(s.size(), 0)
})

test('⑤ sessionIdOf：认字符串与 {id}，其余给空串', () => {
  assert.equal(sessionIdOf('abc'), 'abc')
  assert.equal(sessionIdOf({ id: 'def' }), 'def')
  assert.equal(sessionIdOf(null), '')
  assert.equal(sessionIdOf({}), '')
  assert.equal(sessionIdOf(42), '')
})
