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
import { mergeSettings, normalizeSettings, validateSettingsPatch } from '../lib/settings.js'

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
})

test('② 归一 / 合并：空值删掉覆盖，不把"没设置"变成显式空值', () => {
  assert.deepEqual(normalizeSettings({ dataDir: ' C:\\a ', weird: 1 }), {
    dataDir: 'C:\\a', pipePath: '', project: '',
  })
  assert.deepEqual(normalizeSettings(null), { dataDir: '', pipePath: '', project: '' })
  assert.deepEqual(
    mergeSettings({ dataDir: 'C:\\a', pipePath: '\\\\.\\pipe\\x', legacy: 1 }, { dataDir: '', project: 'p' }),
    { pipePath: '\\\\.\\pipe\\x', legacy: 1, project: 'p' },
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
    })
    assert.equal(health.settings.overridden.dataDir, true)
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
  assert.deepEqual(cleared.json.values, { dataDir: '', pipePath: '', project: '' })
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

test('⑥ health 的 settings 当场问宿主，不照抄 apply 时那一拍', () => {
  // 真机踩过：configEditor 比本插件晚就绪，apply 时记成 false 之后 health 一直写 false，
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
