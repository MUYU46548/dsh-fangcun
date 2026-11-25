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
  // ⚠ 这里钉的是**契约的两个键**，不是那一行的字面量。
  // 2026-11-25：`presetLabel` 为了能被真跑断言而一并导出（它决定"这单能不能干活"这句话），
  // 旧断言 `/return \{ inject: \['slots'\], apply \}/` 是**逐字节**匹配，多一个字段就红 ——
  // 那会让"多导出一个纯函数"看起来像破坏了宿主契约。
  // 真正的契约由 ③（真执行工厂、断言 resolve 出的 inject 与 apply）兜着，这里只管源码形态。
  assert.match(src, /return \{[^}]*\binject: \['slots'\]/, '工厂必须声明 inject: [\'slots\']')
  assert.match(src, /return \{[^}]*\bapply\b/, '工厂必须返回 apply')
  assert.match(src, /return \{[^}]*presetLabel\b/, 'presetLabel 必须可被测试直接调用（不许埋在闭包里）')
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

/**
 * ⑤ 「这一单到底能不能干活」必须在界面上说得出来。
 *
 * ## 这条为什么必须存在
 *
 * `presetResolved` / `presetNote` 从 2026-11-24 起就写进 `health.dispatch` 了，
 * 但 `client.js` **一次都没渲染过它** —— 「写了没接线」，正是 D-181 判据③。
 * 后果：界面上「派单成功」和「派单成功但空手」长得一模一样，
 * 而卡 `948feaa9` 正文点名要治的就是这句：「界面永远显示派单成功」。
 *
 * 所以判据不是"字符串出现在源码里"，而是**真调用那个函数**，三种状态各说各的话：
 *   · true  → 说清挂到了哪一档；
 *   · false → **必须明说没有文件/终端工具**（不美化、不省略）；
 *   · 没字段 → 空串（不猜、不编）。
 */
test('⑤ presetLabel 真跑：三种状态各说各的话，空手必须说出来', () => {
  let def = null
  const fakeWindow = {
    __ModuleLoader__: { load(d) { def = d } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    open() {},
  }
  new Function('window', 'fetch', src)(fakeWindow, async () => ({}))
  const mod = def.factory(() => ({
    createElement: () => ({}), useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }),
  }))
  assert.equal(typeof mod.presetLabel, 'function', 'presetLabel 必须导出才能被真跑断言')

  // ① 挂上了默认档：要带出档名
  const okText = mod.presetLabel({ presetResolved: true, presetNote: 'agentPreset=standard（defaultId）' })
  assert.match(okText, /standard/, '挂上了哪一档必须看得见')

  // ② 挂上了但 note 空：仍要说"挂上了"，不许空手而归
  assert.notEqual(mod.presetLabel({ presetResolved: true, presetNote: '' }), '')

  // ③ 空手（**这条是本测试的要害**）：必须明说没有文件/终端工具
  const badText = mod.presetLabel({ presetResolved: false, presetNote: '没解析出默认档' })
  assert.match(badText, /没有文件\/终端工具/, '空手必须明说，不许只写"派单成功"')
  assert.match(badText, /没解析出默认档/, '还要带上原因（否则和"没派过单"分不清）')

  // ④ 老插件 / 还没派过单：不猜
  assert.equal(mod.presetLabel({}), '', '没有这个字段就不渲染，别编一个')
  assert.equal(mod.presetLabel(null), '', 'null 也不许炸')

  // ⑤ 源码守卫：那一行真的被渲染成**值**，而不只是拿去做条件判断。
  //
  // ⚠ 2026-11-25 第一版这里是假绿：只写了 `/presetLabel\(health(?: && health)?\.dispatch\)/`，
  // 它匹配到的是三元表达式的**条件那一处**（`presetLabel(health && health.dispatch) ? h(...)`），
  // 于是把 `h('span', …, presetLabel(health.dispatch))` 换成写死的 `'派单成功'` 之后**照样绿** ——
  // 「算了却不显示」这个真缺陷它抓不住。反例自证当场发现了这一点。
  // 现在钉的是**值的那个位置**：`styles.value` 后面接的必须是 presetLabel(...)，不是字面量。
  assert.match(
    src,
    /style:\s*styles\.value\s*\}\s*,\s*presetLabel\(/,
    '工具档那一行必须真的渲染 presetLabel(...) 的结果 —— 只拿去当条件判断 = 算了却不显示',
  )
})
