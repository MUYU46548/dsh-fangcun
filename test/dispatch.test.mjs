/**
 * 派单消费（那根管子 · 方寸 → DSH）的测试。
 *
 * 暮雨 2026-11-17：「管子现在就做，它是其他一切的前提。」
 *
 * 这里钉的是**管子那一端**：插件看见方寸写的派单文件后怎么办。
 * 三条不能坏的纪律：
 *   ① 建成会话**才**删派单（建失败留着，下次还能试）；
 *   ② 坏派单**丢弃**，不许每轮都去读一个永远解不开的文件；
 *   ③ 坏文件/没目录都**不抛** —— 派单是锦上添花，不该拖垮记账与挂件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  consumeDispatch, dispatchDirOf, dispatchPrompt, listDispatches, parseDispatch,
} from '../lib/dispatch.js'

const tmpData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dispatch-'))

/** 造一份与方寸 `dispatchToDsh()` 同格式的派单文件 */
function writeDispatch(dataDir, { project = 'sitian', at = '2026-11-17T12:00:00.000Z', missing = [], body = '# 项目背景\n这是正文' } = {}) {
  const dir = dispatchDirOf(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const stamp = at.replace(/[-:T]/g, '').slice(0, 14)
  const p = path.join(dir, `dispatch-${project}-${stamp}.md`)
  const text = [
    '<!-- fangcun-dispatch v1',
    `project: ${project}`,
    `projectName: ${project} 项目`,
    `at: ${at}`,
    `chars: ${body.length}`,
    `missing: ${missing.join('|')}`,
    '-->',
    '',
    body,
  ].join('\n')
  fs.writeFileSync(p, text, 'utf-8')
  return p
}

test('① 派单目录口径：数据根下 .dispatch-dsh（与方寸同一处）', () => {
  assert.equal(dispatchDirOf('E:/x/fangcun'), path.join('E:/x/fangcun', '.dispatch-dsh'))
  // 没给数据根就返回空串 —— 不许拼出一个相对于 cwd 的路径
  assert.equal(dispatchDirOf(''), '')
  assert.equal(dispatchDirOf(null), '')
})

test('② 解析：头部取元数据，正文原样保留', () => {
  const raw = [
    '<!-- fangcun-dispatch v1',
    'project: dsh-fangcun',
    'projectName: 方寸-DSH插件',
    'at: 2026-11-17T12:00:00.000Z',
    'chars: 42',
    'missing: 边界|场景',
    '-->',
    '',
    '# 正文第一行',
    '正文第二行',
  ].join('\n')
  const p = parseDispatch(raw)
  assert.equal(p.project, 'dsh-fangcun')
  assert.equal(p.projectName, '方寸-DSH插件')
  assert.equal(p.at, '2026-11-17T12:00:00.000Z')
  assert.deepEqual(p.missing, ['边界', '场景'])
  assert.match(p.body, /# 正文第一行\n正文第二行/, '正文必须原样保留（少一行就是漏上下文）')

  // 没有 project 的头部 = 不是派单
  assert.equal(parseDispatch('<!-- fangcun-dispatch v1\nat: x\n-->\nbody'), null)
  // 根本不是派单
  assert.equal(parseDispatch('随便什么文本'), null)
  assert.equal(parseDispatch(''), null)
})

test('③ 列出派单：最新的在前；目录不存在不算错误', () => {
  const dir = tmpData()
  // 没人派过单 = 空数组，不抛
  assert.deepEqual(listDispatches(dir), [])
  assert.deepEqual(listDispatches(''), [])

  const a = writeDispatch(dir, { project: 'p-a', at: '2026-11-17T10:00:00.000Z' })
  const b = writeDispatch(dir, { project: 'p-b', at: '2026-11-17T12:00:00.000Z' })
  // 显式把 a 的 mtime 调早（不靠写入间隔 —— 同毫秒内两次写会撞在一起，测试就假红）
  const old = new Date('2026-11-17T09:00:00Z')
  fs.utimesSync(a, old, old)
  const fresh = new Date('2026-11-17T12:00:00Z')
  fs.utimesSync(b, fresh, fresh)

  const rows = listDispatches(dir)
  assert.equal(rows.length, 2)
  assert.match(rows[0].name, /p-b/, '最新的在前')
  assert.match(rows[1].name, /p-a/)

  // 非 dispatch-*.md 的文件不算派单
  fs.writeFileSync(path.join(dispatchDirOf(dir), 'note.md'), 'x')
  assert.equal(listDispatches(dir).length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('④ 建成会话才删派单；建失败必须留着（下次还能试）', async () => {
  const dir = tmpData()
  const f = writeDispatch(dir)
  const row = listDispatches(dir)[0]

  // 建失败 → 派单还在，且如实回错误
  const bad = await consumeDispatch(row, async () => ({ ok: false, error: 'agents 服务不可用' }))
  assert.equal(bad.ok, false)
  assert.match(bad.error, /agents/)
  assert.ok(fs.existsSync(f), '建失败了不许删派单 —— 否则用户点了没反应，派单也没了')

  // 再试，成功 → 派单被消费掉
  const good = await consumeDispatch(listDispatches(dir)[0], async () => ({ ok: true, sessionId: 'session-1' }))
  assert.equal(good.ok, true)
  assert.equal(good.project, 'sitian')
  assert.equal(good.sessionId, 'session-1')
  assert.ok(!fs.existsSync(f), '建成了才删')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('⑤ 坏派单：丢弃并说明，不许每轮都卡在它上面', async () => {
  const dir = tmpData()
  fs.mkdirSync(dispatchDirOf(dir), { recursive: true })
  const bad = path.join(dispatchDirOf(dir), 'dispatch-broken-20260101000000.md')
  fs.writeFileSync(bad, '这不是派单格式', 'utf-8')

  const r = await consumeDispatch({ path: bad }, async () => ({ ok: true }))
  assert.equal(r.ok, false)
  assert.match(r.error, /格式不对/)
  assert.ok(!fs.existsSync(bad), '坏派单要删掉，否则每一拍都读它')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('⑥ open 抛异常也不外泄（派单不该拖垮记账与挂件）', async () => {
  const dir = tmpData()
  writeDispatch(dir)
  const r = await consumeDispatch(listDispatches(dir)[0], async () => { throw new Error('宿主炸了') })
  assert.equal(r.ok, false)
  assert.match(r.error, /宿主炸了/)
  // 抛异常也算"没建成" → 派单留着
  assert.equal(listDispatches(dir).length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('⑦ 投给会话的第一条消息：带上下文 + 明说缺哪几节 + 点名写口与两道锁', () => {
  const text = dispatchPrompt({
    project: 'sitian',
    projectName: '司天',
    body: '# 项目背景\n使命：世界观地图可视化。',
    missing: ['场景', '边界'],
  })
  assert.match(text, /方寸派单/)
  assert.match(text, /sitian/)
  assert.match(text, /使命：世界观地图可视化/, '上下文正文必须在里面')
  assert.match(text, /缺：场景、边界/, '缺节要说出来')
  assert.match(text, /真没写/, '要点明那几处是真没有，不是没读到')
  assert.match(text, /不要替项目编/, '不许替项目编目标')
  assert.match(text, /fangcun_write/, '要告诉它怎么回写')
  assert.match(text, /完成.*驳回.*签字/, '要提前说清两道锁')
  assert.match(text, /下一步该做什么/, '这就是派单的目的')
})
