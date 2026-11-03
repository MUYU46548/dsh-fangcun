/**
 * dsh-fangcun 契约测试（node --test）
 *
 * 这个仓是**独立仓**（2026-11-03 从方寸仓 `git subtree split -P dsh` 拆出）。
 * 这里钉的不是"代码长什么样"，而是"拆出去还能不能用、发布会不会翻车"：
 *
 *  ① 包元数据自洽：patch 指向的文件真存在、main 真存在、files 白名单没漏；
 *     `repository` 必须指向本仓 —— 它是 DSH 自动更新**唯一的来源线索**，缺了就没有更新。
 *  ② 挂载声明 id/name 必须等于包名（不一致 = 装了但插件不出现）。
 *  ③ 边界：不许 import 方寸代码 / 不许 import electron（守住它，两仓才互不锁死）。
 *  ④ 路由形状必须是 `{ kind: 'exact', path, handler }`（不是 `{ method, … }`）。
 *  ⑤ health 只说能自证的事实；认不出数据根时返回空串，不猜路径。
 *  ⑥ 对象级 inject 必须不存在（否则 apply 被推迟，index-inject 行永远进不了表）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')
const pkg = JSON.parse(read('package.json'))
const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href)

test('① 包元数据自洽', () => {
  assert.equal(pkg.name, 'dsh-fangcun')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)), 'patch 文件不存在')
  assert.ok(pkg.main && fs.existsSync(path.join(ROOT, pkg.main)), 'main 文件不存在')
  assert.ok(Array.isArray(pkg.files))
  for (const must of ['lib', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(must), `files 里漏了 ${must}（发布时会丢文件）`)
  }
  assert.ok(pkg.icon && fs.existsSync(path.join(ROOT, pkg.icon)), 'icon 声明的文件不存在')
  assert.ok(fs.existsSync(path.join(ROOT, 'locale/en.json')))
  assert.ok(fs.existsSync(path.join(ROOT, 'locale/zh.json')))
})

test('①b repository 指向本仓（自动更新唯一的来源线索）', () => {
  const url = String(pkg.repository?.url || '')
  assert.match(url, /github\.com\/MUYU46548\/dsh-fangcun(\.git)?$/, url)
  assert.match(String(pkg.homepage || ''), /github\.com\/MUYU46548\/dsh-fangcun/)
})

test('② 挂载声明 id 与 name 都等于包名', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^-\s*insert:/m)
  assert.match(patch, new RegExp('id:\\s*' + pkg.name))
  assert.match(patch, new RegExp('name:\\s*' + pkg.name))
})

test('③ 边界：不 import 方寸代码、不 import electron', () => {
  const lib = read('lib/index.js')
  assert.doesNotMatch(lib, /from\s+['"]\.\.\/\.\.\/(desktop|tegula)/)
  assert.doesNotMatch(lib, /from\s+['"]@\//)
  assert.doesNotMatch(lib, /from\s+['"]electron['"]/)
  assert.match(lib, /node:fs|from 'fs'/, '应当只用 node 内置模块')
})

test('④ 路由形状 = { kind: exact, path, handler }，且没有 method 字段', () => {
  assert.ok(Array.isArray(mod.ROUTES) && mod.ROUTES.length >= 1)
  for (const r of mod.ROUTES) {
    assert.equal(r.kind, 'exact', 'kind 必须是 exact')
    assert.equal(typeof r.path, 'string')
    assert.ok(r.path.startsWith('/'), r.path)
    assert.equal(typeof r.handler, 'function')
    assert.equal(r.method, undefined, '宿主不认 method 字段，方法要在 handler 里判')
  }
  assert.ok(mod.ROUTES.some((r) => r.path === '/fangcun/health.json'))
})

test('④b handler 真能返回可解析 JSON，且非 GET 被拒', async () => {
  const route = mod.ROUTES.find((r) => r.path === '/fangcun/health.json')
  const call = async (method) => {
    let body = ''
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(s) { body = String(s) } }
    await route.handler({ method }, res)
    return { status: res.statusCode, json: JSON.parse(body) }
  }
  const ok = await call('GET')
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.plugin.name, pkg.name)
  assert.equal(ok.json.plugin.version, pkg.version, 'PLUGIN_VERSION 与 package.json 漂移了')
  const bad = await call('POST')
  assert.equal(bad.status, 405)
})

test('⑤ health 只说能自证的事实：认不出数据根就空串', () => {
  assert.equal(mod.collectHealth({ APPDATA: path.join(os.tmpdir(), 'definitely-not-here') }).fangcun.dataDir, '')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-health-'))
  try {
    fs.writeFileSync(path.join(dir, 'registry.yaml'), 'projects: []\n')
    fs.mkdirSync(path.join(dir, 'task-data'))
    const h = mod.collectHealth({ FANGCUN_DATA_DIR: dir, APPDATA: path.join(dir, 'nope') })
    assert.equal(h.fangcun.source, 'env')
    assert.deepEqual(h.fangcun.found, { registry: true, taskData: true, policies: false })
    assert.ok(Array.isArray(h.todo) && h.todo.length >= 1, 'todo 不许空（别让用户以为功能齐了）')
    assert.equal(h.contract.version, 1)
    // 凭据类字段一个都不许出现在 health 里
    const s = JSON.stringify({ plugin: h.plugin, fangcun: h.fangcun, contract: h.contract })
    assert.doesNotMatch(s, /api[_-]?key|password|secret|bearer|sk-[A-Za-z0-9]{8}/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('⑥ apply 等 webServer 就绪后注册路由；无对象级 inject', () => {
  assert.equal(mod.default.name, pkg.name)
  assert.equal(mod.default.inject, undefined, '对象级 inject 会推迟 apply，index-inject 行进不了表')

  const registered = []
  const deps = []
  const fakeRoot = {
    inject(list, cb) {
      deps.push(list)
      cb({
        webServer: { register: (r) => { registered.push(r); return () => {} } },
        effect: (fn) => { fn() },
      })
    },
  }
  mod.default.apply(fakeRoot)
  assert.deepEqual(deps, [['webServer']])
  assert.equal(registered.length, mod.ROUTES.length)
  assert.equal(registered[0].path, '/fangcun/health.json')
})

/**
 * ⑦ 接线：`apply()` 订阅 `session/event` 时，必须把**宿主的原样参数**交给账本。
 *
 * ⑥ 只钉了账本类能处理对象；真机上出错的恰恰是"接线把对象变成字符串"这一层。
 * 所以这里从 `apply()` 出发、模拟宿主派发一个 Session 对象，一路走到 outbox 的 key。
 */
test('⑦ 接线：宿主派发 Session 对象 → outbox 的 key 是真 id（不是 [object Object]）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-wire-'))
  const prevHome = process.env.DSH_HOME
  const prevPipe = process.env.FANGCUN_MCP_PIPE
  process.env.DSH_HOME = home
  process.env.FANGCUN_MCP_PIPE = '' // 空 = 不连管道，只落 outbox
  try {
    const listeners = new Map()
    mod.default.apply({
      on(name, fn) { listeners.set(name, fn); return () => {} },
      effect(fn) { fn() },
      inject(_l, cb) { cb({ webServer: { register: () => () => {} }, effect: (fn) => { fn() } }) },
    })

    const emit = listeners.get('session/event')
    assert.equal(typeof emit, 'function', '必须订阅 session/event')

    const session = { id: 'session-9f8e7d6c-1111-2222-3333-444455556666', header: { id: 'session-9f8e7d6c-1111-2222-3333-444455556666' } }
    emit(session, {
      type: 'assistant/message',
      data: { turn: 1, usage: { inputTokens: 30, cacheReadTokens: 0, outputTokens: 7 }, message: { source: { model: 'm' } } },
    })
    emit(session, { type: 'turn/end', data: { turn: 1, reason: 'done' } })

    const outbox = path.join(home, 'dsh-fangcun', 'outbox.jsonl')
    const rows = fs.readFileSync(outbox, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, 'session-9f8e7d6c-1111-2222-3333-444455556666#1')
    assert.match(rows[0].payload.note, /session=9f8e7d6c/)
    assert.equal(rows[0].payload.prompt_tokens, 30)
    assert.equal(rows[0].payload.completion_tokens, 7)

    // health 此时应当报的是活账本的状态（能看到这次积压）
    assert.equal(mod.collectHealth().usage.outboxPending, 1)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevPipe === undefined) delete process.env.FANGCUN_MCP_PIPE
    else process.env.FANGCUN_MCP_PIPE = prevPipe
    fs.rmSync(home, { recursive: true, force: true })
  }
})
