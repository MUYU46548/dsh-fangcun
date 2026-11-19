/**
 * client half 的契约：它必须能被 DSH 的模块加载器认出来，并注册到 `settings.section`。
 *
 * 这里不渲染 React（那要整套 DOM），只钉三件容易在打包/清单上翻车的事：
 *  ① package.json 的 `dsh.client` / `./client` / files 三处齐全；
 *  ② 模块格式是 `window.__ModuleLoader__.load({ id: <包名>, factory })`；
 *  ③ apply 真的把「方寸」注册成 settings.section，且不碰 Node API、不 append body。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf-8')

test('① 清单：dsh.client / ./client / files 三处同步', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(fs.existsSync(path.join(ROOT, 'client.js')))
  assert.equal(pkg.dependencies, undefined, '零依赖')
  assert.equal(pkg.peerDependencies, undefined, '零依赖（连 peer 都不许）')
})

test('② 模块格式：__ModuleLoader__.load + id 等于包名 + 工厂返回 apply/inject', () => {
  assert.match(src, /window\.__ModuleLoader__\.load\(\s*\{/)
  assert.match(src, new RegExp("id:\\s*'" + pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'"))
  assert.match(src, /factory\s*\(\s*require\s*\)/)
  assert.match(src, /return \{ inject: \['slots'\], apply \}/)
  assert.doesNotMatch(src, /^\s*import\s/m, '浏览器侧模块不许用 ESM import')
  assert.doesNotMatch(src, /from\s+['"]node:/, '不许碰 Node 内置模块')
  assert.doesNotMatch(src, /document\.body\.appendChild|document\.body\.append\(/, '不许往 body 塞第二个应用')
})

test('③ 真执行工厂：apply 注册 settings.section「方寸」', () => {
  let def = null
  const storage = new Map()
  const fakeWindow = {
    __ModuleLoader__: { load(d) { def = d } },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    open() {},
  }
  const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
  // client.js 是给浏览器直接执行的非模块脚本：用 Function 注入 window/fetch
  const run = new Function('window', 'fetch', src)
  run(fakeWindow, fakeFetch)
  assert.ok(def, '必须调用 __ModuleLoader__.load')
  assert.equal(def.id, 'dsh-fangcun')

  const fakeReact = {
    createElement: () => ({}),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  const mod = def.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])

  const registered = []
  const slots = {
    inject(name, fn) {
      assert.equal(name, 'settings.section')
      fn()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  }
  mod.apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  assert.equal(registered.length, 1, '必须注册一节')
  assert.equal(registered[0].options.name, 'settings.section')
  assert.equal(registered[0].options.id, 'dsh-fangcun')
  assert.equal(typeof registered[0].options.label, 'function')
  assert.equal(registered[0].options.label(), '方寸')
  assert.equal(typeof registered[0].component, 'function')
})

test('④ 没 slots 服务时安静退场（老宿主不炸）', () => {
  let def = null
  const fakeWindow = {
    __ModuleLoader__: { load(d) { def = d } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    open() {},
  }
  new Function('window', 'fetch', src)(fakeWindow, async () => ({}))
  const fakeReact = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }) }
  const mod = def.factory(() => fakeReact)
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }))
})
