/**
 * 发布包冒烟：从**真打出来的 tgz** 里 import 插件，确认它装得上、跑得起来。
 *
 * 为什么单独一条：`npm test` 测的是工作区里的源码，而用户装的是 tgz。
 * 两者差一层打包（`files` 白名单、CRLF、被 .npmignore 吃掉的文件），
 * 正是"本地全绿、发出去装了就挂"的经典现场。CI 里在 `npm pack` 之后跑这条。
 *
 * 用法：node test/smoke-packed.mjs <解包后的 package 目录>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pkgDir = path.resolve(process.argv[2] || '')
assert.ok(pkgDir && fs.existsSync(pkgDir), '请传入解包后的 package 目录')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-smoke-'))
process.env.DSH_HOME = home
process.env.FANGCUN_MCP_PIPE = '' // 不连管道，只验接线

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'))
const mod = await import(pathToFileURL(path.join(pkgDir, 'lib/index.js')).href)

assert.equal(mod.default.name, pkg.name, 'apply 的 name 必须是包名（挂载 id 也要一致）')
assert.equal(mod.PLUGIN_VERSION, pkg.version, 'PLUGIN_VERSION 与 package.json 漂移了')

const registered = []
const listeners = new Map()
mod.default.apply({
  on(name, fn) { listeners.set(name, fn); return () => {} },
  effect(fn) { fn() },
  inject(_list, cb) {
    cb({ webServer: { register: (r) => { registered.push(r); return () => {} } }, effect: (fn) => { fn() } })
  },
})

assert.deepEqual(
  registered.map((r) => r.path).sort(),
  ['/fangcun/api/tasks', '/fangcun/health.json', '/fangcun/widget.js'],
  '发布包里的路由必须齐',
)

let body = ''
const healthRoute = registered.find((r) => r.path === '/fangcun/health.json')
healthRoute.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(s) { body = String(s) } })
const health = JSON.parse(body)
assert.equal(health.ok, true)
assert.equal(health.plugin.version, pkg.version)
assert.ok(health.widget, 'health 必须有 widget 证据链')

// 挂件脚本：发布包里那一份必须能把样式表挂进文档（0.2.0 的"裸奔"就是漏了这一步）
let widgetJs = ''
registered.find((r) => r.path === '/fangcun/widget.js')
  .handler({ method: 'GET', headers: {} }, { statusCode: 0, setHeader() {}, end(s) { widgetJs = String(s) } })
assert.ok(widgetJs.includes('host.appendChild(s)'), '样式表要真挂进文档，否则挂件以纯文本排在页面末尾')
assert.ok(widgetJs.includes("root.style.position = 'fixed'"), '根节点要自带内联定位兜底')
assert.ok(widgetJs.includes('data-corner'), '位置要写进 DOM（四角可选）')
assert.ok(widgetJs.includes("var DEFAULT_CORNER = 'tr'"), '默认右上角 —— 右下角是鲸鱼挂件的（事实 14）')

// 用量接线：宿主给的是 Session 对象，落地必须是真 id（不是 [object Object]）
const emit = listeners.get('session/event')
assert.equal(typeof emit, 'function', '必须订阅 session/event')
const session = { id: 'session-smoke001', header: { id: 'session-smoke001' } }
emit(session, {
  type: 'assistant/message',
  data: { turn: 1, usage: { inputTokens: 5, cacheReadTokens: 1, outputTokens: 2 }, message: { source: { model: 'm' } } },
})
emit(session, { type: 'turn/end', data: { turn: 1 } })

const outbox = path.join(home, 'dsh-fangcun', 'outbox.jsonl')
const rows = fs.readFileSync(outbox, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
assert.equal(rows[0].key, 'session-smoke001#1', '发布包里的接线也必须落真 id')
assert.equal(rows[0].payload.prompt_tokens, 6, 'prompt 必须含 cache_read')

fs.rmSync(home, { recursive: true, force: true })
console.log(`SMOKE OK  version=${pkg.version}  routes=${registered.length}  lib=${fs.readdirSync(path.join(pkgDir, 'lib')).join(',')}`)
