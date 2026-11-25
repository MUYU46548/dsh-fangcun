/**
 * 派单预设档解析（2026-11-24 · 卡 `948feaa9` 的根因层）
 *
 * 暮雨：「A 居然还没修好，我快吐了，还以为都修完了。」
 *
 * 这一组钉的是**真实宿主形状**下能不能解析出默认档。
 * 两个 bug 都在这条链上，而它们的共同特征是「静默降权之后界面照样显示派单成功」——
 * 所以每条断言都配一个**反例**，证明它抓得住原来那个写法。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDispatchPreset } from '../lib/index.js'

/** 宿主真实形状的假 presets（读 `dsh-agent-preset-registry` 的实现对齐） */
function realShape({ defaultId = 'standard', resolveFails = false, list = null } = {}) {
  return {
    get defaultId() { return defaultId },
    // 宿主实现：`async resolve(id) { const w = id ?? this.defaultId; ... throw if unknown }`
    async resolve(id) {
      const w = id ?? defaultId
      if (resolveFails || w === '' || w === null || w === undefined) {
        throw new Error(`Unknown agent preset: ${w}`)
      }
      if (w !== defaultId) throw new Error(`Unknown agent preset: ${w}`)
      return { id: w }
    },
    // 宿主实现：返回项是 { id, name, description, order, broken } —— **没有 isDefault**
    async list() {
      if (list) return list
      return [
        { id: 'minimal', order: 1 },
        { id: 'standard', order: 2 },
      ]
    },
  }
}

test('⑲ 默认档：用宿主 defaultId 解出来（最权威那条路）', async () => {
  const r = await resolveDispatchPreset(realShape({ defaultId: 'standard' }))
  assert.equal(r.id, 'standard')
  assert.equal(r.resolved, true)
})

test('⑳ 【反例·bug1】**不传参**才对；传空串会被宿主 resolve 抛错吞掉', async () => {
  const p = realShape({ defaultId: 'standard' })
  // 原来的写法：resolve('') —— 宿主的 `'' ?? defaultId` 等于 ''，于是抛
  let threw = false
  try { await p.resolve('') } catch { threw = true }
  assert.equal(threw, true, '宿主对空串确实抛错（这就是 bug1 的机制）')

  // 修好之后：resolveDispatchPreset 不带参 → 拿得到 standard
  const r = await resolveDispatchPreset(p)
  assert.equal(r.id, 'standard', '不带参才走宿主的 defaultId')
})

test('㉑ 【反例·bug2】list() 没有 isDefault 字段时，**不许**退回 rows[0]', async () => {
  // 模拟宿主真实返回：没有 isDefault，第一条是 minimal（order 最小）
  const p = {
    // 没有 defaultId、resolve 也失败 → 只能走 list
    async resolve() { throw new Error('no such service') },
    async list() {
      return [
        { id: 'minimal', order: 1 },
        { id: 'standard', order: 2 },
      ]
    },
  }
  const r = await resolveDispatchPreset(p)
  assert.equal(r.id, '', '没有 isDefault 就不许猜 —— 猜成 minimal 就是静默降权')
  assert.equal(r.resolved, false)
  assert.match(r.note, /没解析出默认档/)

  // 旧写法会挑到 minimal（rows[0]）—— 这就是 bug2 的危害
  const rows = await p.list()
  const oldPick = rows.find((x) => x.isDefault) || rows[0]
  assert.equal(oldPick.id, 'minimal', '旧写法确实会挑到最小档')
})

test('㉒ list() 里真有 isDefault:true 时才认它（不是永不使用 list）', async () => {
  const p = {
    async resolve() { throw new Error('nope') },
    async list() {
      return [
        { id: 'minimal', order: 1 },
        { id: 'standard', order: 2, isDefault: true },
      ]
    },
  }
  const r = await resolveDispatchPreset(p)
  assert.equal(r.id, 'standard')
  assert.equal(r.resolved, true)
})

test('㉓ 没有 agentPresets 服务 → 明说"只有插件工具"，不假装成功', async () => {
  const r = await resolveDispatchPreset(undefined)
  assert.equal(r.id, '')
  assert.equal(r.resolved, false)
  assert.match(r.note, /只有插件工具/)
})

test('㉔ 解析结果带 note（"这单实际什么档"必须能事后查到）', async () => {
  const r = await resolveDispatchPreset(realShape({ defaultId: 'standard' }))
  assert.match(r.note, /agentPreset=standard/)
  assert.ok(r.note.length > 0)
})

test('㉕ resolve 抛错时不许连带抛出去（这一单仍要能派）', async () => {
  const r = await resolveDispatchPreset({
    async resolve() { throw new Error('boom') },
    async list() { throw new Error('boom2') },
  })
  assert.equal(r.resolved, false)
  assert.doesNotThrow(() => r.id)
})
