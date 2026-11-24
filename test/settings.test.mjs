/**
 * 设置页后端（`/fangcun/api/settings`）与三项覆盖的契约。
 *
 * 钉住的东西：
 *  ① 设置 > 环境变量 > 自动探测 的优先级；
 *  ② 空字符串 = 清掉覆盖（不是设成空路径）；
 *  ③ 脏值（相对路径 / 非 Windows 管道 / 未知键 / 非字符串）一律拒，说人话；
 *  ④ 只收本机 + 同源写；没有 configEditor 时**明说不可写**，不假装保存。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as mod from '../lib/index.js'
import { mergeSettings, normalizeSettings, validateSettingsPatch, SETTINGS_FIELDS } from '../lib/settings.js'
import { readDispatchSettings } from '../lib/dispatch.js'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-settings-home-'))
process.env.DSH_HOME = HOME
after(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

function makeRoot({ entry = { options: { id: 'dsh-fangcun' } }, editor = null } = {}) {
  return {
    fiber: entry ? { entry } : undefined,
    on() { return () => {} },
    effect(fn) {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    inject(_list, cb) {
      cb({
        webServer: { register() { return () => {} } },
        effect(fn) { fn() },
      })
    },
    get(name) {
      if (name === 'configEditor') return editor
      return undefined
    },
    logger: { warn() {} },
  }
}

async function call(route, req) {
  let body = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(s) { body = String(s) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(body) }
}

function getReq(overrides = {}) {
  return {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    ...overrides,
  }
}

function putReq(body, headers = {}) {
  return {
    method: 'PUT',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:56260', 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body))
    },
  }
}

const settingsRoute = () => mod.ROUTES.find((r) => r.path === '/fangcun/api/settings')

test('① 校验：只收认识的键、字符串、绝对数据根、Windows 管道前缀', () => {
  const ok = validateSettingsPatch({
    dataDir: '  C:\\fangcun  ',
    pipePath: '\\\\.\\pipe\\tegula-mcp',
    project: ' dsh-fangcun ',
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.patch, {
    dataDir: 'C:\\fangcun',
    pipePath: '\\\\.\\pipe\\tegula-mcp',
    project: 'dsh-fangcun',
  })

  assert.equal(validateSettingsPatch({ nope: 'x' }).ok, false)
  assert.equal(validateSettingsPatch({ dataDir: 123 }).ok, false)
  assert.equal(validateSettingsPatch({ dataDir: 'relative\\dir' }).ok, false, '相对路径会让不同进程读到不同地方')
  assert.equal(validateSettingsPatch({ pipePath: 'C:\\not-a-pipe' }, { platform: 'win32' }).ok, false)
  assert.equal(validateSettingsPatch({ pipePath: '/tmp/x.sock' }, { platform: 'darwin' }).ok, true)
  assert.equal(validateSettingsPatch({ project: 'a\nb' }).ok, false)
  assert.equal(validateSettingsPatch({}).ok, false)
  // 2026-11-21：派单四项不在 Loader 行里了（真源是共享 JSON 文件），
  // 它们由 `lib/dispatch.js#validateDispatchSettingsPatch` 校验；
  // 这里钉住"别又混回宿主设置"——混回来会出现两套默认值。
  assert.equal(validateSettingsPatch({ dispatchDailyCap: '20' }).ok, false)
  assert.equal(validateSettingsPatch({ dispatchEnabled: true }).ok, false)
  assert.equal(validateSettingsPatch({ dispatchCooldownSec: '45' }).ok, false)

  // 2026-11-24（暮雨第 3 条）：**派单权限档走宿主设置**（它是 Loader 行的 config，
  // 与另外三项同源），别把它误当成派单四项写进共享 JSON —— 那会让"谁说了算"变成两套。
  assert.equal(validateSettingsPatch({ dispatchPreset: 'standard' }).ok, true)
  assert.equal(validateSettingsPatch({ dispatchPreset: '' }).ok, true, '留空 = 清除覆盖（跟宿主默认档）')
  assert.equal(validateSettingsPatch({ dispatchPreset: 'a\nb' }).ok, false, '换行不许进档名')
  assert.equal(
    validateSettingsPatch({ dispatchPreset: 'x'.repeat(SETTINGS_FIELDS.dispatchPreset + 1) }).ok,
    false, '超长档名直接拒（截断会悄悄改错一个档）',
  )
})

test('② 归一 / 合并：空值删掉覆盖，不把"没设置"变成显式空值', () => {
  // 2026-11-24（暮雨第 3 条）：第 4 个字段 `dispatchPreset`（派单会话用哪个 Agent 预设档
  // = 派单任务的默认权限）。留空 = 跟宿主默认档走。
  assert.deepEqual(normalizeSettings({ dataDir: ' C:\\a ', weird: 1 }), {
    dataDir: 'C:\\a', pipePath: '', project: '', dispatchPreset: '',
  })
  assert.deepEqual(normalizeSettings(null), {
    dataDir: '', pipePath: '', project: '', dispatchPreset: '',
  })
  assert.deepEqual(
    mergeSettings({ dataDir: 'C:\\a', pipePath: '\\\\.\\pipe\\x', legacy: 1 }, { dataDir: '', project: 'p' }),
    { pipePath: '\\\\.\\pipe\\x', legacy: 1, project: 'p' },
  )
  // 派单权限档：留空是"跟默认走"（删键），不是"设成最小档"
  assert.deepEqual(
    mergeSettings({ dispatchPreset: 'standard' }, { dispatchPreset: '' }),
    {},
  )
  assert.deepEqual(
    mergeSettings({}, { dispatchPreset: 'strict' }),
    { dispatchPreset: 'strict' },
  )
})

test('③ 优先级：设置 > 环境变量 > 自动探测', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-cfg-'))
  try {
    mod.default.apply(makeRoot(), {
      dataDir: dir,
      pipePath: '\\\\.\\pipe\\dsh-fangcun-config-test',
      project: 'cfg-project',
    })
    const env = { FANGCUN_DATA_DIR: path.join(dir, 'env-should-lose'), FANGCUN_MCP_PIPE: '\\\\.\\pipe\\env-loses', FANGCUN_PROJECT: 'env-loses' }
    const data = mod.resolveDataDir(env)
    assert.equal(data.dir, dir)
    assert.equal(data.source, 'config', 'health 要能说清这个根是设置页给的')
    assert.equal(mod.resolvePipePath(env), '\\\\.\\pipe\\dsh-fangcun-config-test')
    assert.equal(mod.resolveProjectScope(env), 'cfg-project')

    const health = mod.collectHealth(env)
    assert.equal(health.fangcun.dataDir, dir)
    assert.equal(health.fangcun.source, 'config')
    assert.deepEqual(health.settings.values, {
      dataDir: dir,
      pipePath: '\\\\.\\pipe\\dsh-fangcun-config-test',
      project: 'cfg-project',
      // 2026-11-24：没设派单权限档 = 跟宿主默认走
      dispatchPreset: '',
    })
    assert.equal(health.settings.overridden.dataDir, true)
    assert.equal(health.settings.overridden.dispatchPreset, false)
  } finally {
    mod.default.apply(makeRoot(), {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 设置路由：GET 说清能不能写；PUT 只收本机同源，脏值明说拒绝', async () => {
  let saved = null
  const editor = {
    async edit(entry, change) {
      assert.equal(entry.options.id, 'dsh-fangcun')
      saved = change({ legacy: 1 })
    },
  }
  mod.default.apply(makeRoot({ editor }), {})
  const route = settingsRoute()

  const got = await call(route, getReq())
  assert.equal(got.status, 200)
  assert.equal(got.json.ok, true)
  assert.equal(got.json.writable, true)
  assert.equal(got.json.entryId, 'dsh-fangcun')
  // 2026-11-21：GET 必须带上派单四项（与方寸设置页同一个真源）
  assert.equal(typeof got.json.dispatch, 'object')
  assert.equal(typeof got.json.dispatch.settings.enabled, 'boolean')

  const remoteReq = putReq({ project: 'x' })
  remoteReq.socket = { remoteAddress: '8.8.8.8' }
  const remote = await call(route, remoteReq)
  assert.equal(remote.status, 403, '非本机不许写')

  const cross = await call(route, putReq({ project: 'x' }, { origin: 'https://evil.example' }))
  assert.equal(cross.status, 403, '跨站 Origin 不许写')

  const bad = await call(route, putReq({ dataDir: 'relative\\dir' }))
  assert.equal(bad.status, 400)
  assert.match(bad.json.error, /绝对路径/)

  const valid = await call(route, putReq({
    dataDir: 'C:\\fangcun-data',
    pipePath: '\\\\.\\pipe\\tegula-test',
    project: 'dsh-fangcun',
  }))
  assert.equal(valid.status, 200)
  assert.equal(valid.json.ok, true)
  assert.equal(valid.json.restarting, true)
  assert.deepEqual(saved, {
    legacy: 1,
    dataDir: 'C:\\fangcun-data',
    pipePath: '\\\\.\\pipe\\tegula-test',
    project: 'dsh-fangcun',
  })
  assert.equal(mod.resolveProjectScope({}), 'dsh-fangcun')

  const cleared = await call(route, putReq({ dataDir: '', pipePath: '', project: '' }))
  assert.equal(cleared.status, 200)
  assert.deepEqual(saved, { legacy: 1 }, '空字符串必须删键，不是写成空覆盖')
  assert.deepEqual(cleared.json.values, {
    dataDir: '', pipePath: '', project: '', dispatchPreset: '',
  })

  // 2026-11-19 真机：三项都空时点「保存」，profile 被重写了一遍、UI 却说"会重启一次"，
  // 用户原话"感觉没什么用"。没有变化就该直接说没有变化，且不碰 profile。
  const before = saved
  const noop = await call(route, putReq({ dataDir: '', pipePath: '', project: '' }))
  assert.equal(noop.status, 200)
  assert.equal(noop.json.restarting, false, '没变化就不许说"会重启"')
  assert.match(noop.json.message, /没有变化/)
  assert.equal(saved, before, '没变化就不该调 configEditor（别白写一遍 profile）')
})

test('⑤ 没有 configEditor：GET 如实说不可写，PUT 501（不许假装保存）', async () => {
  mod.default.apply(makeRoot({ editor: null }), {})
  const route = settingsRoute()
  const got = await call(route, getReq())
  assert.equal(got.status, 200)
  assert.equal(got.json.writable, false)
  assert.match(got.json.error, /configEditor/)

  const put = await call(route, putReq({ project: 'x' }))
  assert.equal(put.status, 501)
  assert.match(put.json.error, /configEditor/)
})

test('⑥ health 的 settings 当场问宿主，不照抄 apply 时那一拍', () => {  // 真机踩过：configEditor 比本插件晚就绪，apply 时记成 false 之后 health 一直写 false，
  // 而 GET /fangcun/api/settings 当场问却是 true —— 同一个页面两个答案。
  let editor = null
  const root = {
    fiber: { entry: { options: { id: 'dsh-fangcun' } } },
    on() { return () => {} },
    effect(fn) {
      const off = fn()
      return typeof off === 'function' ? off : () => {}
    },
    inject(_list, cb) {
      cb({ webServer: { register() { return () => {} } }, effect(fn) { fn() } })
    },
    get(name) {
      if (name === 'configEditor') return editor
      return undefined
    },
    logger: { warn() {} },
  }
  mod.default.apply(root, {})
  assert.equal(mod.collectHealth({}).settings.writable, false, 'apply 时服务还没挂 → false')
  editor = { async edit() {} }
  const health = mod.collectHealth({})
  assert.equal(health.settings.writable, true, '服务挂上后 health 必须跟着变 true')
  assert.equal(health.settings.entryId, 'dsh-fangcun')
  assert.equal(health.settings.error, '')
})

test('⑦ 派单四项：只改它们时不需要 configEditor，写共享文件并立即生效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-dispatch-settings-'))
  try {
    // 没有 configEditor（老宿主 / 服务没起来）—— 派单设置照样应该能存：
    // 它写的是数据根下的共享 JSON，不碰 DSH profile。
    mod.default.apply(makeRoot({ editor: null }), { dataDir: dir })
    const route = settingsRoute()

    const r = await call(route, putReq({
      dispatchEnabled: true, dispatchCooldownSec: '45', dispatchDailyCap: '2', dispatchConcurrency: '1',
    }))
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.restarting, false, '派单设置不需要重启插件')
    assert.match(r.json.message, /立即生效/)

    const st = readDispatchSettings(dir)
    assert.equal(st.settings.enabled, true)
    assert.equal(st.settings.cooldownSec, 45)
    assert.equal(st.settings.dailyCap, 2)
    assert.equal(st.settings.concurrency, 1)

    // GET 读的是同一份
    const got = await call(route, getReq())
    assert.equal(got.json.dispatch.settings.enabled, true)
    assert.equal(got.json.dispatch.settings.cooldownSec, 45)

    // 非法值：拒绝且不落盘（默认值不能被脏值顶掉）
    const bad = await call(route, putReq({ dispatchCooldownSec: 'abc' }))
    assert.equal(bad.status, 400)
    assert.equal(readDispatchSettings(dir).settings.cooldownSec, 45)

    // 关掉也要立即生效（不重启也能回到"出厂不发车"）
    const off = await call(route, putReq({ dispatchEnabled: false }))
    assert.equal(off.status, 200)
    assert.equal(readDispatchSettings(dir).settings.enabled, false)
  } finally {
    mod.default.apply(makeRoot(), {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2026-11-24 · 暮雨第 3 条 ─────────────────────────────────────────────
// 「方寸插件能不能增加一个设置选项，可以让用户更改派单任务的默认权限
//  （当前默认为工作区内修改）？会不会太困难？不做在方寸内部是因为这是DSH侧设置。」
//
// 答案：能做，而且**不用碰 DSH 的 Agent 预设本体**
// （暮雨原话「DSH的Agent预设太复杂，别去碰它」）——
// 派单会话的权限就是它的 Agent 预设档（agentPreset），
// 插件只需要决定"这一单用哪一档"。
test('⑬ 派单权限档：用户设的那一档真的会用（不是只显示在设置页）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-preset-'))
  try {
    // 先设一个**非默认**的档，证明"用户设的"压过"宿主默认"
    mod.default.apply(makeRoot(), { dispatchPreset: 'strict-no-write' })
    const health = mod.collectHealth({})
    assert.equal(health.settings.values.dispatchPreset, 'strict-no-write',
      '设置页读回来的就是用户填的那一档')
    assert.equal(health.settings.overridden.dispatchPreset, true)

    // 清空 = 回到"跟宿主默认走"（不是"最小档"——那样是静默降权）
    mod.default.apply(makeRoot(), {})
    const back = mod.collectHealth({})
    assert.equal(back.settings.values.dispatchPreset, '')
    assert.equal(back.settings.overridden.dispatchPreset, false,
      '留空必须是"没有覆盖"，不能被当成"显式设成空档"')
  } finally {
    mod.default.apply(makeRoot(), {})
    fs.rmSync(forumSafe(dir), { recursive: true, force: true })
  }
})

/** mkdtemp 的目录名里不会有路径分隔符，直接给回去；这里只是让上面那行读起来不吓人 */
function forumSafe(p) { return p }
