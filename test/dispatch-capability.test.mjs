/**
 * 派单「工具面」留痕（2026-11-24 · 卡 `948feaa9` 守卫层）
 *
 * 暮雨：「A 居然还没修好，我快吐了，还以为都修完了。」
 *
 * 为什么这条守卫必须存在（不是形式主义）：
 *   卡 `a87d57bf` 上明写「三件事 3/3，工具档真的生效了」，
 *   而下一单从**同一个入口**派出来，一个文件工具都没有。
 *   **「验证过一次通过」和「现在通过」是两件事，而卡片正文分不清这两者。**
 *
 * 所以判据不是"读卡"，而是：**每次派单成功，audit 里必须有一行回答
 * "这一单实际挂到了哪个档"**。没有这一行 = 这单的工具面没人认领。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendDispatchAudit, readDispatchAudit } from '../lib/dispatch.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cap-'))

test('㉖ 派单成功必须落一行 dispatch-capability（回答"这单实际什么档"）', () => {
  const dir = tmp()
  // 模拟派单成功时写的那一行（与 lib/index.js 里的字段一致）
  appendDispatchAudit(dir, {
    ok: true, source: 'gui', project: 'sitian', kind: 'work',
    sessionId: 'fangcun-dispatch-x', file: 'dispatch-sitian-1.md',
    capability: 'dispatch-capability',
    preset: 'agentPreset=standard（defaultId）',
    presetResolved: true,
  })
  const rows = readDispatchAudit(dir)
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.capability, 'dispatch-capability')
  assert.equal(r.presetResolved, true)
  assert.match(String(r.preset), /standard/)
})

test('㉗ 【反例】没解析出档时，那一行必须写 presetResolved:false（不许冒充成功）', () => {
  const dir = tmp()
  appendDispatchAudit(dir, {
    ok: true, source: 'gui', project: 'sitian', kind: 'work',
    sessionId: 's', file: 'f.md',
    capability: 'dispatch-capability',
    preset: '没解析出默认档（defaultId / resolve / list 都没给）—— 本单只有插件工具、没有文件/终端',
    presetResolved: false,
  })
  const r = readDispatchAudit(dir)[0]
  assert.equal(r.presetResolved, false)
  assert.match(String(r.preset), /只有插件工具/)
})

test('㉘ 源码守卫：派单成功分支里真的有 capability 这一行（不是只写在测试里）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'index.js'), 'utf-8')
  // 必须出现在 appendDispatchAudit 的 ok:true 分支附近
  const idx = src.indexOf('ok: true, source: \'gui\'')
  assert.ok(idx > 0, '找不到派单成功的审计写入点')
  const around = src.slice(idx, idx + 1200)
  assert.match(around, /capability: 'dispatch-capability'/, '派单成功的审计行里没有 capability')
  assert.match(around, /presetResolved: Boolean\(dispatchState\.presetResolved\)/, '没有记录 presetResolved')
})

test('㉙ 源码守卫：解析档不许再退回 rows[0]（bug2 复发的拦网）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'index.js'), 'utf-8')
  // 允许出现在注释里解释"为什么不能这么做"，但不允许作为**代码**出现
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  const bad = codeLines.filter((l) => /rows\.find\([^)]*isDefault[^)]*\)\s*\|\|\s*rows\[0\]/.test(l))
  assert.equal(bad.length, 0, '又退回 rows[0] 了：' + bad.join(' | '))
})

test('㉚ 源码守卫：解析档不许再传空串给 resolve（bug1 复发的拦网）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'index.js'), 'utf-8')
  // ⚠ 只扫**代码行**：注释里要解释"为什么不能这么写"，
  //   把注释也算进来的话，守卫会把解释当成违规（第一版就这样假绿/假红各一次）。
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  const bad = codeLines.filter((l) => /presets\.resolve\(\s*wanted\s*\)/.test(l))
  assert.equal(
    bad.length, 0,
    "又用空串 wanted 调 resolve 了 —— 宿主的 '' ?? defaultId 等于空串，会被静默吞掉：" + bad.join(' | '),
  )
})
