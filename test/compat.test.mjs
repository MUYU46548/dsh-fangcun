/**
 * 宿主兼容性自检的测试（2026-11-17 用户拍板）。
 *
 * 用户原话："DSH 升级是经常发生的事情，插件应该只提醒而不是退出服务，
 * 能不能用随缘，插件永远只保适配版本。"
 *
 * 核实过的宿主行为（`@deepseek-ai/dsh-app-boot` 的 `loadProfileDirectory`）：
 *   `engines.dsh` 不满足 → `throw` → 被 catch 成 `skippedBundles` → **整个插件静默消失**。
 * 所以 package.json 里**不写上界**（这条由 `test('① package.json 不设 DSH 上界')` 钉住）。
 *
 * 但"不写上界"不等于"永远能用"。这一层的职责是：**照常干活 + 把缺口说出来**。
 * 判据必须是运行时真实形状，不是版本号比较（版本号相等不代表 API 没变）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHost, HOST_CAPABILITIES } from '../lib/compat.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'))

/** 造一个"全能力宿主" */
function fullHost() {
  return {
    on() { return () => {} },
    effect(fn) { fn() },
    get(name) {
      if (name === 'webServer') return { register: () => () => {} }
      if (name === 'systemPrompt') return { section: () => () => {}, context: () => () => {} }
      if (name === 'tools') return { register: () => () => {} }
      return undefined
    },
  }
}

test('① package.json 不设 DSH 上界 —— 否则升级后插件被静默跳过', () => {
  // 这是本轮最重要的一条：`<0.3.0` 会让 DSH 一旦升到 0.3 就把整个插件 skip 掉，
  // 挂件/记账/工具全消失，而且界面上只会显示"没装"。宁可能用+提醒，也不要静默退出。
  for (const field of ['engines.dsh', 'dsh.compatibility.dsh']) {
    const range = field.split('.').reduce((o, k) => (o == null ? o : o[k]), pkg)
    assert.equal(typeof range, 'string', field + ' 必须存在')
    assert.ok(!/<\s*\d/.test(range), field + ` 不能写上界（现在是 "${range}"）—— 那会让升级后插件静默消失`)
    assert.match(range, /^>=/, field + ' 应当只有下限')
  }
  // 下限不能缺：太老的宿主确实没有这些服务
  assert.match(pkg.engines.dsh, /0\.2\.1/)
})

test('② 全能力宿主：无警告，summary 说正常', () => {
  const r = checkHost(fullHost())
  assert.deepEqual(r.warnings, [])
  assert.match(r.summary, /全部 6 项宿主能力正常/)
  for (const cap of HOST_CAPABILITIES) {
    assert.equal(r.capabilities[cap.key], 'ok', cap.key + ' 应当是 ok')
  }
})

test('③ 空宿主（真正的老宿主）：全 missing，但**不抛**', () => {
  // 关键：绝不抛。抛出去等于插件把整个宿主启动搞挂 —— 那是"退出服务"最严重的形式。
  const r = checkHost({})
  assert.equal(r.warnings.length, HOST_CAPABILITIES.length)
  for (const cap of HOST_CAPABILITIES) {
    assert.equal(r.capabilities[cap.key], 'missing')
  }
  assert.match(r.summary, /0\/6 项正常/)
  // 每条警告都要说人话（带"这块不可用"或"可能部分失效"）
  for (const w of r.warnings) assert.match(w, /不可用|可能部分失效/)
})

test('④ 形状变了（服务在但方法不对）= degraded，与 missing 区分开', () => {
  // 这是 DSH 升级最常见的样子：服务还在，签名改了。
  const host = {
    on() { return () => {} },
    effect(fn) { fn() },
    get(name) {
      if (name === 'webServer') return { notRegister: true }         // 没有 register
      if (name === 'tools') return { register: 'not a function' }    // register 不是函数
      if (name === 'systemPrompt') return {}                          // 空对象
      return undefined
    },
  }
  const r = checkHost(host)
  assert.equal(r.capabilities.webServer, 'degraded')
  assert.equal(r.capabilities.tools, 'degraded')
  assert.equal(r.capabilities.systemPrompt, 'degraded')
  // degraded 的提示要指出"宿主大概改过 API"，而不是含糊
  assert.ok(r.warnings.some((w) => /形状不像预期/.test(w) && /改过 API/.test(w)))
})

test('⑤ 探测本身抛异常也不外泄：记成缺口，插件照常', () => {
  const host = {
    on() { throw new Error('宿主炸了') },
    effect(fn) { fn() },
    get() { throw new Error('get 炸了') },
  }
  const r = checkHost(host)
  assert.equal(r.capabilities.webServer, 'missing')
  // ⚠ `on` 存在但一调就抛 = degraded 而不是 missing：
  //   两者对插件是"收不到事件"同一件事，但报告上要区分"没有"和"坏了"，否则排查会找错方向。
  assert.equal(r.capabilities['session/event'], 'degraded')
  assert.equal(r.capabilities['webserver/index-inject'], 'degraded')
  assert.ok(r.warnings.length > 0)
})

test('⑤b 只判 typeof 会漏掉"能调用但会抛"的 on —— 必须真调一次', () => {
  // 这条钉住 2026-11-17 抓到的真 bug：最初只 `typeof root.on === 'function'` 就判 ok，
  // 于是"宿主有 on 但一订阅就抛"被当成健康 —— 记账与自证实际全哑却报绿。
  const host = { on() { throw new Error('nope') }, effect(fn) { fn() }, get() { return undefined } }
  const r = checkHost(host)
  assert.notEqual(r.capabilities['session/event'], 'ok', 'on 会抛就不能报 ok')
})

test('⑥ 结论形状固定：health 直接能读，且带时间戳', () => {
  const r = checkHost(fullHost())
  assert.equal(typeof r.checkedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(r.checkedAt)), 'checkedAt 要是可解析时间')
  assert.equal(typeof r.summary, 'string')
  assert.ok(Array.isArray(r.warnings))
  assert.equal(typeof r.capabilities, 'object')
})
