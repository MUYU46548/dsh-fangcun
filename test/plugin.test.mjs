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
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { signDispatch } from '../lib/dispatch.js'

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

test('⑩ 看板链接只指向活着的方寸看板：端口文件的 PID 不在就不给链接', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-board-'))
  try {
    const env = { FANGCUN_DATA_DIR: dir, APPDATA: path.join(dir, 'nope') }

    // 端口 + 活着的 PID（自己）→ 给链接
    fs.writeFileSync(path.join(dir, '.tegula-port'), '8791\n' + process.pid + '\n1792676596\n')
    assert.equal(mod.resolveBoardUrl(env), 'http://127.0.0.1:8791')

    // 端口 + 已经退出的 PID → 不给。2026-11-07 真机：文件停在 10 月 22 日，
    // 写它的进程早没了，挂件却把「打开看板」指向一个打不开的地址。
    const dead = spawnSync(process.execPath, ['-e', '0'])
    assert.equal(typeof dead.pid, 'number', '拿不到一个已退出的 PID，测试无法继续')
    fs.writeFileSync(path.join(dir, '.tegula-port'), '8791\n' + dead.pid + '\n1792676596\n')
    assert.equal(mod.resolveBoardUrl(env), '')

    // 只有端口（旧格式）：没有判活证据，保留旧行为
    fs.writeFileSync(path.join(dir, '.tegula-port'), '8791\n')
    assert.equal(mod.resolveBoardUrl(env), 'http://127.0.0.1:8791')

    // 脏值不猜
    fs.writeFileSync(path.join(dir, '.tegula-port'), 'not-a-port\n')
    assert.equal(mod.resolveBoardUrl(env), '')
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

/**
 * ⑧ 提示词与自证的接线：`apply()` 拿到 `systemPrompt` 就注册规则段 + 一行现状，
 * 并且 `tool/call` 里的方寸工具会落进 `tools.jsonl`。
 *
 * 为什么要在 apply 层面测：这两块都在"装了但没生效"的盲区里 ——
 * 单测过了、注册没发生，真机只能靠 health 才看得出来。
 */
test('⑧ apply：注册规则段 + 一行现状，方寸工具调用落自证日志', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-prompt-'))
  const prevHome = process.env.DSH_HOME
  const prevPipe = process.env.FANGCUN_MCP_PIPE
  process.env.DSH_HOME = home
  process.env.FANGCUN_MCP_PIPE = `\\\\.\\pipe\\dsh-fangcun-absent-${process.pid}-${Date.now()}`
  try {
    const sections = []
    const contexts = []
    const toolDefs = []
    const listeners = new Map()
    mod.default.apply({
      on(name, fn) { listeners.set(name, fn); return () => {} },
      effect(fn) { fn() },
      inject(_l, cb) { cb({ webServer: { register: () => () => {} }, effect: (fn) => { fn() } }) },
      get(name) {
        if (name === 'tools') {
          return { register(def) { toolDefs.push(def); return () => {} } }
        }
        if (name !== 'systemPrompt') return undefined
        return {
          section(input) { sections.push(input); return () => {} },
          context(input) { contexts.push(input); return () => {} },
        }
      },
    })

    assert.equal(sections.length, 1, '规则段必须注册')
    assert.equal(sections[0].name, 'dsh-fangcun:rules')
    assert.match(sections[0].text, /开工第一件事/, '开工那一步必须点名 fangcun_context，不能含糊成"先查方寸"')
    assert.match(sections[0].text, /fangcun_context/)
    assert.equal(contexts.length, 1, '一行现状必须注册')
    assert.equal(contexts[0].name, 'dsh-fangcun:status')
    assert.equal(typeof contexts[0].text, 'function', '一行现状是动态 provider')
    assert.equal(typeof contexts[0].text(), 'string', 'provider 必须同步给字符串')

    // REV-014 ②：模型工具真的注册上了（这是"挂件 vs 智能层"的分界线）
    assert.deepEqual(toolDefs.map((d) => d.name).sort(), [
      'fangcun_card', 'fangcun_context', 'fangcun_log',
      'fangcun_logs', 'fangcun_search', 'fangcun_tasks', 'fangcun_write',
    ])
    for (const d of toolDefs) {
      assert.ok(d.output && d.output.schema, d.name + ' 缺 output.schema')
      assert.equal(typeof d.execute, 'function')
    }
    const ht = mod.collectHealth().tools
    assert.equal(ht.registered, true)
    assert.equal(ht.names.length, 7)
    assert.equal(ht.error, '')

    const hp = mod.collectHealth().prompt
    assert.equal(hp.rules, true)
    assert.equal(hp.status, true)
    assert.equal(hp.error, '')
    assert.ok(typeof hp.line === 'string')

    // 自证：方寸工具调用 → tools.jsonl 一行；别的工具不留
    const emit = listeners.get('session/event')
    const session = { id: 'session-aaaabbbb', header: { id: 'session-aaaabbbb' } }
    emit(session, { type: 'tool/call', data: { turn: 2, name: 'mcp__fangcun__list_tasks', arguments: '{}' } })
    emit(session, { type: 'tool/call', data: { turn: 2, name: 'pwsh', arguments: '{}' } })

    const proofFile = path.join(home, 'dsh-fangcun', 'tools.jsonl')
    const rows = fs.readFileSync(proofFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows.length, 1, '只该记方寸那一条')
    assert.equal(rows[0].tool, 'mcp__fangcun__list_tasks')
    assert.equal(rows[0].session, 'session-aaaabbbb')
    assert.equal(mod.collectHealth().proof.rows, 1)
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevPipe === undefined) delete process.env.FANGCUN_MCP_PIPE
    else process.env.FANGCUN_MCP_PIPE = prevPipe
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('⑩ 派单消费：真的投给 Agent（followup），不是往会话日志里补一句话', async () => {
  // 2026-11-17 真机探针抓到的 bug：`session.append('user/message')` 只让历史里多了一句，
  // **agent 永远不会跑**（轮次由 inbox 驱动），而且手写的消息缺 `id`/`source` 是坏事件。
  // 所以这里钉住：必须有 followup、消息形状合法、没 followup 时才退回 append。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-dispatch-'))
  const dataDir = path.join(home, 'fangcun')
  const prevHome = process.env.DSH_HOME
  const prevData = process.env.FANGCUN_DATA_DIR
  const prevPipe = process.env.FANGCUN_MCP_PIPE
  const prevSecret = process.env.FC_DISPATCH_SECRET_PATH
  process.env.DSH_HOME = home
  process.env.FANGCUN_DATA_DIR = dataDir
  process.env.FANGCUN_MCP_PIPE = `\\\\.\\pipe\\dsh-fangcun-absent3-${process.pid}-${Date.now()}`
  // 2026-11-20：派单必须有 GUI 签名；测试自己造一把临时密钥并签
  const secret = 'a'.repeat(64)
  const secretPath = path.join(home, 'dispatch-secret')
  fs.writeFileSync(secretPath, secret + '\n', 'utf-8')
  process.env.FC_DISPATCH_SECRET_PATH = secretPath

  const followups = []
  const appends = []
  const renamed = []
  const flushed = []
  const created = []
  // 造一份派单，落在插件会去读的目录
  const dispatchDir = path.join(dataDir, '.dispatch-dsh')
  fs.mkdirSync(dispatchDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'registry.yaml'),
    'projects:\n  - id: dsh-fangcun\n    repo: "E:\\\\CODE\\\\CangKu\\\\dsh-fangcun"\n', 'utf-8')
  const body = '# 项目背景\n使命：把方寸接进 DSH。'
  const nonce = 'b'.repeat(32)
  const at = '2026-11-17T12:00:00.000Z'
  const sig = signDispatch(secret, {
    source: 'gui', project: 'dsh-fangcun', at, kind: 'plan', nonce,
    chars: body.length, missing: [], body,
  })
  fs.writeFileSync(path.join(dispatchDir, 'dispatch-dsh-fangcun-20261117120000.md'), [
    '<!-- fangcun-dispatch v1',
    'project: dsh-fangcun',
    'at: ' + at,
    'kind: plan',
    'source: gui',
    'nonce: ' + nonce,
    'sig: ' + sig,
    'chars: ' + body.length,
    '-->',
    '',
    body,
  ].join('\n'), 'utf-8')

  try {
    const handled = new Promise((resolve) => {
      mod.default.apply({
        on() { return () => {} },
        effect(fn) { fn() },
        inject(_l, cb) { cb({ webServer: { register: () => () => {} }, effect: (fn) => { fn() } }) },
        get(name) {
          if (name === 'agents') {
            return {
              async create(opts) {
                created.push(opts)
                const session = {
                  header: { cwd: opts && opts.meta && opts.meta.cwd },
                  append: (type, data, o) => appends.push({ type, data, o }),
                }
                const agent = {
                  id: opts.sessionId,
                  session,
                  followup(message) {
                    followups.push(message)
                    resolve()
                  },
                }
                return { agent, dispose: async () => {} }
              },
            }
          }
          if (name === 'sessionTitle') return { rename: (s, t) => renamed.push(t) }
          if (name === 'sessions') return { flush: async (s) => { flushed.push(s); return true } }
          if (name === 'agentDefaultModel') {
            return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4.1', reasoningEffort: 'medium' }) }
          }
          return undefined
        },
      })
    })

    await Promise.race([handled, new Promise((r) => setTimeout(r, 3000))])

    assert.equal(followups.length, 1, '必须走 agent.followup —— 否则模型永远不会被叫醒')
    assert.equal(appends.length, 0, '有 followup 时就不许再往日志里硬塞一条')
    const msg = followups[0]
    assert.equal(msg.role, 'user')
    assert.ok(msg.id && msg.id.length > 5, '消息必须有 id（校验要求非空，缺了就是坏事件）')
    assert.deepEqual(msg.source, { kind: 'user' }, 'source.kind 必须给，否则 assertMessageEventShape 会拒')
    assert.match(msg.content[0].text, /方寸派单 · 规划/)
    assert.match(msg.content[0].text, /使命：把方寸接进 DSH/)
    // 名字挂上、落盘冲一次 —— 落盘那一步不做的话，磁盘上只有会话头
    assert.ok(renamed.some((t) => /方寸派单 · 规划 · dsh-fangcun/.test(t)), '会话要有能认的名字')
    assert.equal(flushed.length, 1, '派单消息必须 flush，否则只活在内存里')

    // 模型路由：不传 provider/model，会话建得出来但第一轮就抛
    // "has no provider/model" —— 用户看到的是"开出来了，但说话不回"。
    assert.equal(created.length, 1)
    assert.deepEqual(created[0].agentOptions, {
      provider: 'deepseek', model: 'deepseek-v4.1', reasoningEffort: 'medium',
    }, '必须把宿主默认模型带过去，否则新会话不会思考')
    // 落目录：派单文件没写 cwd 时回退到 registry.yaml 的 repo
    // （插件不实现 YAML 反转义：`"E:\\CODE\\…"` 原样取出，Windows 认重复分隔符，
    //   所以这里按分隔符归一后比 —— 别为了一个断言去写半截 YAML 解析器）
    assert.equal(String(created[0].meta.cwd).replace(/\\\\/g, '\\').replace(/\//g, '\\'),
      'E:\\CODE\\CangKu\\dsh-fangcun', '落在项目仓库里，不是 _no-cwd')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevData === undefined) delete process.env.FANGCUN_DATA_DIR
    else process.env.FANGCUN_DATA_DIR = prevData
    if (prevPipe === undefined) delete process.env.FANGCUN_MCP_PIPE
    else process.env.FANGCUN_MCP_PIPE = prevPipe
    if (prevSecret === undefined) delete process.env.FC_DISPATCH_SECRET_PATH
    else process.env.FC_DISPATCH_SECRET_PATH = prevSecret
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('⑨ 宿主没有 systemPrompt 服务时：不假装注册，health 如实写原因，其它功能照旧', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fangcun-noprompt-'))
  const prevHome = process.env.DSH_HOME
  const prevPipe = process.env.FANGCUN_MCP_PIPE
  process.env.DSH_HOME = home
  process.env.FANGCUN_MCP_PIPE = `\\\\.\\pipe\\dsh-fangcun-absent2-${process.pid}-${Date.now()}`
  try {
    const registered = []
    mod.default.apply({
      on() { return () => {} },
      effect(fn) { fn() },
      inject(_l, cb) { cb({ webServer: { register: (r) => { registered.push(r); return () => {} } }, effect: (fn) => { fn() } }) },
      get() { return undefined }, // 老宿主：没有 systemPrompt，也没有 tools
    })
    const hp = mod.collectHealth().prompt
    assert.equal(hp.rules, false, '没注册就写 false，不许假装成功')
    assert.match(hp.error, /重试|不可用/)
    // REV-014 ②：没有 tools 服务时同样不假装，如实写原因
    const ht = mod.collectHealth().tools
    assert.equal(ht.registered, false, '没注册工具就写 false')
    assert.deepEqual(ht.names, [])
    assert.match(ht.error, /重试|不可用/)
    assert.equal(registered.length, mod.ROUTES.length, '提示词拿不到时，路由照旧注册')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevPipe === undefined) delete process.env.FANGCUN_MCP_PIPE
    else process.env.FANGCUN_MCP_PIPE = prevPipe
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ── ⑪ 路由名单两处同步（2026-11-19）─────────────────────────────────────────
//
// 病：0.7.0 加了 `/fangcun/api/settings`（5 条路由），而 `test/smoke-packed.mjs`
// 仍钉着 4 条的旧名单。`npm test` 的脚本列表里**没有** smoke-packed（它要求先 npm pack），
// 所以本地 152/152 全绿，**打 tag 后 CI 必红** —— 与 0.6.7 工具名单那次是同一类事故。
// 修法不是"下次记得"：这里读 smoke 源码，把期望数组抠出来跟 `ROUTES` 比。
test('⑪ 路由名单两处同步：smoke-packed 的旧名单不许漂移（CI 才跑的那份）', () => {
  const src = read('test/smoke-packed.mjs')
  const m = /registered\.map\(\(r\)\s*=>\s*r\.path\)\.sort\(\),\s*\[([\s\S]*?)\]/.exec(src)
  assert.ok(m, 'smoke-packed.mjs 里找不到路由断言 —— 结构变了就更新本条')
  const listed = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort()
  const need = mod.ROUTES.map((r) => r.path).sort()
  assert.deepEqual(listed, need,
    'smoke-packed.mjs 的路由名单与 ROUTES 漂移了（这条只有 CI 会红，所以必须在这里先红）')
})
