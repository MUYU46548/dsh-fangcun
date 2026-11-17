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
  consumeDispatch, dispatchDirOf, dispatchPrompt, listDispatches, parseDispatch, projectRepoOf,
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

// ── 派单用途（2026-11-17 暮雨定案：「以后可以直接在 DSH 里派活做规划」）──
//
// 同一根管子上跑两种活：work = 马上干活，plan = 先做规划。
// 两者的话术必须不同 —— 拿开工的话术去让它规划，它会直接开始改代码。

test('⑧ 缺省 kind = work（老派单文件行为零破坏）', () => {
  const raw = [
    '<!-- fangcun-dispatch v1',
    'project: sitian',
    '-->',
    '',
    '正文',
  ].join('\n')
  assert.equal(parseDispatch(raw).kind, 'work', '没有 kind 字段的老派单必须是 work')
})

test('⑨ kind: plan 能解析，且乱写的值回落成 work（不抛、不猜新类型）', () => {
  const mk = (k) => ['<!-- fangcun-dispatch v1', 'project: sitian', 'kind: ' + k, '-->', '', '正文'].join('\n')
  assert.equal(parseDispatch(mk('plan')).kind, 'plan')
  assert.equal(parseDispatch(mk('PLAN')).kind, 'plan', '大小写不敏感')
  assert.equal(parseDispatch(mk('work')).kind, 'work')
  assert.equal(parseDispatch(mk('乱写')).kind, 'work', '认不出的用途回落 work，不许静默变成 plan')
})

test('⑩ 规划派单的话术：要求出判据、不许拿砍功能当规划、要问用户拍板', () => {
  const text = dispatchPrompt({
    project: 'sitian', projectName: '司天', kind: 'plan', body: '# 司天现状',
  })
  assert.match(text, /方寸派单 · 规划/, '标题要标出这是规划派单')
  assert.match(text, /不是让你马上改代码/, '要明确拦住直接开干')
  for (const pre of ['cmd:', 'str:', 'num:', 'file:']) {
    assert.ok(text.includes(pre), '四类判据前缀必须都提到，实际缺：' + pre)
  }
  assert.match(text, /写不出判据的条目不要写/, '没判据的条目不许写')
  assert.match(text, /引不出依据的条目\*\*不许编/, '要禁止编依据')
  assert.match(text, /不砍功能/, '用户 11-08 已定：不拿砍功能当规划')
  assert.match(text, /只有用户能拍板/, '判断半必须回给用户')
  assert.match(text, /fangcun_write/, '要告诉它怎么回写')
  assert.doesNotMatch(text, /请据此判断\*\*下一步该做什么\*\*/, '规划派单不许复用开工话术')
})

test('⑪ 开工派单的话术不许带上规划那套（否则老用户突然被要求写判据）', () => {
  const text = dispatchPrompt({ project: 'sitian', kind: 'work', body: '# 司天现状' })
  assert.match(text, /方寸派单 · 开工/)
  assert.match(text, /下一步该做什么/)
  assert.doesNotMatch(text, /不是让你马上改代码/, 'work 派单不该说这句')
  assert.doesNotMatch(text, /四类前缀|cmd:.*str:.*num:/, 'work 派单不该要求四类判据')
})

test('⑫ 两种派单的正文都原样带上（不许因为换用途把上下文丢了）', () => {
  for (const kind of ['work', 'plan']) {
    const text = dispatchPrompt({ project: 'sitian', kind, body: '使命：世界观地图可视化' })
    assert.match(text, /使命：世界观地图可视化/, kind + ' 派单丢了正文')
  }
})

// ── 会话落在哪个目录（2026-11-17 真机：派单会话落在 `_no-cwd`，等于派进真空）──

test('⑬ projectRepoOf：从 registry.yaml 里认出仓库，边界收得很紧', () => {
  const dir = tmpData()
  fs.writeFileSync(path.join(dir, 'registry.yaml'), [
    '# 注释',
    'members:',
    '  - human',
    'projects:',
    '  - id: fangcun-base',
    '    name: 方寸',
    '    repo: "E:/CODE/CangKu/fangcun"',
    '  - id: dsh-fangcun',
    '    name: 方寸-DSH插件',
    '    repo: "E:\\CODE\\CangKu\\dsh-fangcun"',
    '    tools: []',
    '  - id: no-repo',
    '    name: 没有仓库的项目',
    'released:',
    '  - id: old',
    '    repo: E:/x/old',
  ].join('\n'), 'utf-8')

  assert.equal(projectRepoOf(dir, 'fangcun-base'), 'E:/CODE/CangKu/fangcun')
  assert.equal(projectRepoOf(dir, 'dsh-fangcun'), 'E:\\CODE\\CangKu\\dsh-fangcun')
  // 该项目没写 repo → 空串；**不许**串到下一块
  assert.equal(projectRepoOf(dir, 'no-repo'), '')
  // `released:` 段里的条目同样是 `- id:` 开头 —— 认它是**对的**（归档项目也可能被派单），
  // 这里钉的是"按 id 找块"这件事本身没被段名干扰。
  assert.equal(projectRepoOf(dir, 'old'), 'E:/x/old')
  // 不存在的项目、没数据根、文件缺失都不抛
  assert.equal(projectRepoOf(dir, 'nope'), '')
  assert.equal(projectRepoOf('', 'x'), '')
  assert.equal(projectRepoOf(path.join(dir, 'nowhere'), 'x'), '')
})

test('⑬b projectRepoOf：相对路径不认（落错地方比不落更糟）', () => {
  const dir = tmpData()
  fs.writeFileSync(path.join(dir, 'registry.yaml'), [
    'projects:',
    '  - id: rel',
    '    repo: ./relative/path',
  ].join('\n'), 'utf-8')
  assert.equal(projectRepoOf(dir, 'rel'), '', '相对路径在不同进程的 cwd 下含义不同，一律不认')
})

test('⑭ parseDispatch：可选的 cwd 字段（方寸知道就带，不知道不影响老派单）', () => {
  const withCwd = parseDispatch([
    '<!-- fangcun-dispatch v1',
    'project: sitian',
    'cwd: E:\\CODE\\CangKu\\SiTian',
    '-->',
    '',
    '正文',
  ].join('\n'))
  assert.equal(withCwd.cwd, 'E:\\CODE\\CangKu\\SiTian')

  const noCwd = parseDispatch(['<!-- fangcun-dispatch v1', 'project: sitian', '-->', '', '正文'].join('\n'))
  assert.equal(noCwd.cwd, '', '老派单没有 cwd 行 → 空串，由插件回退到 registry 或宿主的默认目录')
})
