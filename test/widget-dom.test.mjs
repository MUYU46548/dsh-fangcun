/**
 * 待办挂件的**行为**测试：用替身 DOM 真执行 `WIDGET_JS`。
 *
 * 为什么不能只像 `widget.test.mjs` 那样断言字符串里有没有某个词：
 * 那段脚本只在浏览器里跑，语法对、关键词都在、**一执行就抛**是完全可能的
 * （拼错属性、`firstChild` 不存在、`localStorage` 没兜住……），而这类错
 * 在真机上表现是"装上了但页面没角标"，得看宿主日志才能查。
 *
 * 替身只实现脚本真正用到的那些 API：不追求像浏览器，够跑就行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WIDGET_JS, WIDGET_ROUTE } from '../lib/widget.js'

/** 极简 DOM 替身 */
function makeDom() {
  const byId = new Map()

  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      this.children = []
      this.childNodes = this.children
      this.className = ''
      this.textContent = ''
      this.title = ''
      this.style = {}
      this.onclick = null
      this.id = ''
      this.parentNode = null
      this._listeners = {}
    }
    get firstChild() { return this.children[0] || null }
    appendChild(node) {
      node.parentNode = this
      this.children.push(node)
      return node
    }
    removeChild(node) {
      const i = this.children.indexOf(node)
      if (i >= 0) this.children.splice(i, 1)
      node.parentNode = null
      return node
    }
    addEventListener(name, fn) { (this._listeners[name] ||= []).push(fn) }
    setAttribute(k, v) { if (k === 'id') this.id = v }
    /** 供测试读：整棵子树的文字 */
    text() {
      return (this.textContent || '') + this.children.map((c) => c.text()).join('')
    }
    find(pred, out = []) {
      for (const c of this.children) { if (pred(c)) out.push(c); c.find(pred, out) }
      return out
    }
  }

  const body = new Node('body')
  const document = {
    readyState: 'complete',
    body,
    createElement(tag) { const n = new Node(tag); return n },
    getElementById(id) { return byId.get(id) || null },
    addEventListener() {},
  }
  // appendChild 之后才能按 id 找到（脚本挂完会 getElementById(ROOT_ID)）
  const origAppend = body.appendChild.bind(body)
  body.appendChild = (node) => {
    const r = origAppend(node)
    if (node.id) byId.set(node.id, node)
    return r
  }
  // 脚本会先 createElement('div')、设 id、再 append 到 body；style 元素同理
  const createElement = document.createElement
  document.createElement = (tag) => {
    const n = createElement(tag)
    return n
  }
  // 让 byId 能拿到通过 id 属性挂上去的元素
  const origAppend2 = Node.prototype.appendChild
  Node.prototype.appendChild = function (node) {
    const r = origAppend2.call(this, node)
    if (node.id && !byId.has(node.id)) byId.set(node.id, node)
    return r
  }

  const storage = new Map()
  const window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    open() {},
  }
  return { document, window, storage, body, byId }
}

/** 在替身环境里跑一次 WIDGET_JS，返回挂载后的根节点与观察到的请求 */
function runWidget(dom, { reply, onFetch } = {}) {
  const timers = []
  const fetch = (url) => {
    const snapshot = onFetch ? onFetch(url) : undefined
    const value = typeof reply === 'function' ? reply(url, snapshot) : reply
    return Promise.resolve({ json: () => Promise.resolve(value) })
  }
  const sandbox = {
    window: dom.window,
    document: dom.document,
    navigator: { clipboard: null },
    fetch,
    setTimeout: (fn) => { timers.push(fn); return 0 },
    setInterval: (fn) => { timers.push(fn); return 0 },
    console,
  }
  const names = Object.keys(sandbox)
  // 脚本是 IIFE，直接在函数作用域里注入同名变量
  const factory = new Function(...names, WIDGET_JS)
  factory(...names.map((n) => sandbox[n]))
  return {
    root: () => dom.document.getElementById('fc-todo-widget'),
    timers,
    flush: () => new Promise((r) => setImmediate(r)),
  }
}

const TASKS = {
  ok: true,
  total: 3,
  boardUrl: 'http://127.0.0.1:8791',
  items: [
    { id: 't1', title: '要做的', status: '待办', project: 'fangcun-base' },
    { id: 't2', title: '在做', status: '进行中', project: 'fangcun-base' },
    { id: 't3', title: '没填状态', status: '', project: '' },
  ],
}

test('① 挂件能跑起来：角标显示总数，代码不抛', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  const root = w.root()
  assert.ok(root, '必须挂到 body 上并带 fc-todo-widget 这个 id')
  assert.match(root.text(), /方寸 · 3/, '角标要显示未完成数')
  assert.equal(w.timers.length, 1, '应当有且只有一个 60 秒轮询定时器')
})

test('② 点开列出标题；默认收起（没记忆时不弹面板）', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  const root = w.root()
  assert.doesNotMatch(root.className, /fc-open/, '默认收起，别挡 DSH 自己的控件')

  const pill = root.find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0]
  assert.ok(pill, '要有一个可点的角标')
  pill.onclick()
  assert.match(root.className, /fc-open/, '点一下展开')
  assert.match(root.text(), /要做的/)
  assert.match(root.text(), /在做/)
})

test('③ 展开状态记忆：重开页面还在展开', async () => {
  const dom = makeDom()
  dom.storage.set('fc-todo-widget:open', '1')
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  assert.match(w.root().className, /fc-open/, '上次展开的，这次应当还是展开')
})

test('④ 点条目只复制 id（只读动作），不写方寸', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  w.root().find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()

  const row = w.root().find((n) => n.className === 'fc-row')[0]
  assert.ok(row, '要列出行')
  row.onclick()
  assert.match(w.root().text(), /id：t1|已复制 t1/, '点了要把 id 给出来')
})

test('⑤ 方寸没连上：显示"方寸未连接"且点一下会重试', async () => {
  const dom = makeDom()
  let calls = 0
  const w = runWidget(dom, {
    reply: () => {
      calls += 1
      if (calls === 1) throw new Error('管道不可用')
      return TASKS
    },
  })
  await w.flush()
  assert.match(w.root().text(), /方寸未连接/, '要区分"没连上"和"没有卡"')

  w.root().find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()
  const retry = w.root().find((n) => /fc-empty/.test(n.className) && /重试/.test(n.textContent))[0]
  assert.ok(retry, '错误态要能点一下重试')
  retry.onclick()
  await w.flush()
  assert.match(w.root().text(), /方寸 · 3/, '重试成功后要恢复')
})

test('⑥ 关掉之后留一个能捞回来的入口，并且记住"关掉了"', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  const root = w.root()
  root.find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()

  const close = root.find((n) => /fc-link/.test(n.className) && /收起挂件/.test(n.textContent))[0]
  assert.ok(close, '面板里要有收起入口')
  close.onclick()
  assert.equal(dom.storage.get('fc-todo-widget:hidden'), '1', '要记住关掉了')

  const mini = root.find((n) => /fc-mini/.test(n.className))[0]
  assert.ok(mini, '关掉不是消失：得留一个能点回来的小点')
  mini.onclick()
  assert.equal(dom.storage.get('fc-todo-widget:hidden'), '0')
  assert.match(root.text(), /方寸 · 3/, '点回来要恢复')
})

test('⑦ 有看板端口才显示入口（端口读不到就不给假链接）', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: { ...TASKS, boardUrl: '' } })
  await w.flush()
  w.root().find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()
  assert.doesNotMatch(w.root().text(), /打开看板/, '没有 boardUrl 就不该出现看板链接')

  const dom2 = makeDom()
  const w2 = runWidget(dom2, { reply: TASKS })
  await w2.flush()
  w2.root().find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()
  assert.match(w2.root().text(), /打开看板/, '有 boardUrl 才显示')
})

test('⑧ 脚本只读：不出现写接口，也不 import 方寸代码', () => {
  assert.match(WIDGET_JS, new RegExp(WIDGET_ROUTE.replace(/\./g, '\\.') + '|' + '/fangcun/api/tasks'))
  assert.doesNotMatch(WIDGET_JS, /method:\s*['"]POST['"]/, '只读，不许 POST')
  assert.doesNotMatch(WIDGET_JS, /create_task|update_task|move_status/, '不许写方寸')
  // 深色主题：不许写死白底
  assert.match(WIDGET_JS, /prefers-color-scheme:\s*dark/, '要有深色主题')
  assert.match(WIDGET_JS, /var\(--fc-bg\)/, '颜色要走变量，别写死')
})
