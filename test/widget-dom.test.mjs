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

/** 极简 DOM 替身。`titlebar: 40` 模拟桌面端被原生窗口按钮盖住的顶部安全区 */
function makeDom(options = {}) {
  const byId = new Map()
  const titlebar = Number(options.titlebar) || 0
  // 自由摆放要按真实尺寸夹进视口：给个"角标 96×28"的假布局（不给就恒 0，夹不住）
  const box = options.box ? { w: Number(options.box.w) || 0, h: Number(options.box.h) || 0 } : null

  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase()
      this.children = []
      this.childNodes = this.children
      this.className = ''
      this.textContent = ''
      this.title = ''
      this.style = {}
      this.attrs = {}
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
      if (node.id) byId.delete(node.id) // 摘掉之后 getElementById 必须真的找不到（否则"被摘掉"测不出来）
      return node
    }
    addEventListener(name, fn) { (this._listeners[name] ||= []).push(fn) }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v) }
    removeAttribute(k) { delete this.attrs[k] }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
    /** 供测试读：整棵子树的文字 */
    text() {
      return (this.textContent || '') + this.children.map((c) => c.text()).join('')
    }
    find(pred, out = []) {
      for (const c of this.children) { if (pred(c)) out.push(c); c.find(pred, out) }
      return out
    }
  }

  // 只有显式要求时才给布局能力：不然 mount 会排一个 probe 定时器，搅乱 ① 的计数断言
  if (titlebar > 0 || box) {
    Node.prototype.getBoundingClientRect = function () {
      // 1px 探针：它量的是 env(titlebar-area-height)，也就是顶部安全区
      if (this.style && typeof this.style.height === 'string'
        && this.style.height.indexOf('titlebar-area-height') >= 0) {
        return { width: 1, height: titlebar, left: 0, top: 0, right: 1, bottom: titlebar }
      }
      // 根节点：按内联定位算真实位置（left/top 优先，right/bottom 反向推），
      // 这样"拖动/换角之后量出来的盒子"跟浏览器里一致
      if (this.id === 'fc-todo-widget' && box) {
        const px = (v) => {
          const n = parseFloat(v)
          return Number.isFinite(n) ? n : null
        }
        const l = px(this.style.left)
        const t = px(this.style.top)
        const r = px(this.style.right)
        const b = px(this.style.bottom)
        const left = l !== null ? l : (r !== null ? 1280 - r - box.w : 0)
        const top = t !== null ? t : (b !== null ? 800 - b - box.h : 0)
        return { width: box.w, height: box.h, left, top, right: left + box.w, bottom: top + box.h }
      }
      return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }
    }
  }

  const head = new Node('head')
  const body = new Node('body')
  // 拖拽要在 document 上挂 pointermove/up，替身得真的记住这些监听
  const docListeners = {}
  const document = {
    readyState: 'complete',
    head,
    body,
    createElement(tag) { const n = new Node(tag); return n },
    getElementById(id) { return byId.get(id) || null },
    addEventListener(name, fn) { (docListeners[name] ||= []).push(fn) },
    removeEventListener(name, fn) {
      const arr = docListeners[name] || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
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
  // MutationObserver 替身：只记回调，测试里手动 fire（真浏览器由宿主重渲染触发）
  const observers = []
  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this) }
    observe() {}
    disconnect() {}
  }
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    open() {},
  }
  return { document, window, storage, body, head, byId, docListeners, MutationObserver, observers }
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
    MutationObserver: dom.MutationObserver,
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

/**
 * ⑨ 真机 2026-11-03 的教训：样式表建了但**没挂进文档** ⇒ 一条规则都不生效，
 * 挂件以纯文本排在页面末尾（用户看到的那"一堆丑丑的字"）。
 *
 * 为什么之前 8 条全绿还没抓到：替身 DOM 不做样式计算，"元素在不在文档里"是唯一
 * 能断言的事实 —— 所以这里直接钉"挂进去了"+"折叠不依赖 CSS"。
 */
test('⑨ 样式表真挂进了文档；根节点自带浮层定位；折叠态不依赖 CSS', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()

  const style = dom.document.getElementById('fc-todo-widget-style')
  assert.ok(style, 'style 元素必须挂进文档，否则所有规则都不生效')
  assert.equal(style.parentNode, dom.head, '应当挂在 <head> 里')
  assert.match(style.textContent, /#fc-todo-widget\{position:fixed/, '浮层定位规则要在')
  assert.match(style.textContent, /\.fc-panel\{display:none/, '折叠态 CSS 兜底要在')

  const root = w.root()
  assert.equal(root.style.position, 'fixed', '根节点要自带内联定位：不许排进页面正文')
  assert.equal(root.style.top, '14px', '默认右上角')
  assert.equal(root.style.right, '14px')

  const panel = root.find((n) => n.className === 'fc-panel')[0]
  assert.ok(panel, '面板要建出来')
  assert.equal(panel.style.display, 'none', '收起时面板必须内联 hidden，不能靠 CSS')

  root.find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()
  const opened = w.root().find((n) => n.className === 'fc-panel')[0]
  assert.equal(opened.style.display, 'block', '展开时面板要显示')
})

/**
 * ⑩ 位置：默认右上，可换四角并记住。
 *
 * 为什么默认不是右下：`dsh-whale-widget` 的根节点钉在 `right:0;bottom:0`（z-index 9999），
 * 0.2.1 挂件在右下角直接压在鲸鱼脸上（用户 2026-11-03 截图）。插件之间不抢同一块地方，
 * 但用户自己的偏好要能改 —— 四个角一键换，存 localStorage，不重启。
 */
test('⑩ 默认右上角；点一下换角并记住；脏值回默认', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()

  const root = w.root()
  assert.equal(root.attrs['data-corner'], 'tr', '默认右上角')
  assert.equal(root.style.top, '14px')
  assert.equal(root.style.right, '14px')
  assert.equal(root.style.bottom, '', '右上不该同时有 bottom')

  // 展开面板 → 点「左下」
  root.find((n) => /fc-pill/.test(n.className) && !/fc-mini/.test(n.className))[0].onclick()
  const btn = root.find((n) => /fc-posbtn/.test(n.className) && /左下/.test(n.textContent))[0]
  assert.ok(btn, '面板里要有位置按钮')
  btn.onclick()

  assert.equal(dom.storage.get('fc-todo-widget:corner'), 'bl', '选择要存住')
  const moved = w.root()
  assert.equal(moved.attrs['data-corner'], 'bl')
  assert.equal(moved.style.bottom, '14px')
  assert.equal(moved.style.left, '14px')
  assert.equal(moved.style.top, '', '换角要清掉上一组偏移')
  assert.equal(moved.style.right, '')
  assert.match(moved.className, /fc-open/, '换位置不该把面板关掉')

  // 下次打开页面还记住
  const dom2 = makeDom()
  dom2.storage.set('fc-todo-widget:corner', 'bl')
  const w2 = runWidget(dom2, { reply: TASKS })
  await w2.flush()
  assert.equal(w2.root().attrs['data-corner'], 'bl')

  // 脏值不认，回默认（不拿认不出的值去算位置）
  const dom3 = makeDom()
  dom3.storage.set('fc-todo-widget:corner', 'middle')
  const w3 = runWidget(dom3, { reply: TASKS })
  await w3.flush()
  assert.equal(w3.root().attrs['data-corner'], 'tr', '认不出来的值要回默认')
})

/** 面板里那个角标（不是收起后的小圆点） */
function pillOf(w) {
  return w.root().find((n) => /(^|\s)fc-pill(\s|$)/.test(n.className) && !/fc-mini/.test(n.className))[0]
}

/** 模拟一次拖拽：按住角标 → 移动 → 松手 */
function drag(w, dom, from, to) {
  const p = pillOf(w)
  const downs = p._listeners.pointerdown || []
  assert.ok(downs.length, '角标要挂 pointerdown')
  downs[0]({ button: 0, clientX: from.x, clientY: from.y })
  for (const fn of (dom.docListeners.pointermove || []).slice()) fn({ clientX: to.x, clientY: to.y, preventDefault() {} })
  for (const fn of (dom.docListeners.pointerup || []).slice()) fn({})
}

/**
 * ⑪ 拖动 = 自由摆放（拖到哪就停哪）+ 锁定开关。
 *
 * 为什么不再吸角（2026-11-05 真机反馈）：同一台机器上的鲸鱼挂件是真拖动，
 * 方寸却一松手就弹到最近的角 —— 用户只会说"它不听我的"。四角保留成快捷键，
 * 拖动本身只写 left/top 并落盘：不换角、不弹回。
 */
test('⑪ 拖动自由摆放：默认锁着拖不动；解锁后拖到哪停哪并记住；手抖算点击；拖完那一下点击被吞', async () => {
  const dom = makeDom({ box: { w: 96, h: 28 } })
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  assert.equal(w.root().attrs['data-corner'], 'tr')

  // 锁着：怎么拖都不动，也不落盘
  drag(w, dom, { x: 200, y: 150 }, { x: 1200, y: 760 })
  assert.equal(w.root().attrs['data-corner'], 'tr', '默认上锁时拖不动')
  assert.equal(dom.storage.get('fc-todo-widget:pos'), undefined, '锁着时不该落盘')

  // 打开面板 → 解锁
  pillOf(w).onclick()
  const lockBtn = w.root().find((n) => /fc-posbtn/.test(n.className) && /已锁定/.test(n.textContent))[0]
  assert.ok(lockBtn, '面板里要有拖动开关')
  lockBtn.onclick()
  assert.equal(dom.storage.get('fc-todo-widget:locked'), '0', '解锁要存住')
  assert.ok(w.root().find((n) => /可拖动/.test(n.textContent))[0], '解锁后开关文案要变')

  // 手抖（位移不到 6px）不算拖，照常当点击
  drag(w, dom, { x: 200, y: 150 }, { x: 202, y: 151 })
  assert.equal(dom.storage.get('fc-todo-widget:pos'), undefined, '手抖不该落盘')

  // 真拖：右上 (1170,14) 往左下拉 → 停在 (270,514)，不吸角
  drag(w, dom, { x: 1170, y: 14 }, { x: 270, y: 514 })
  const moved = w.root()
  assert.equal(dom.storage.get('fc-todo-widget:pos'), '270,514', '松手就落盘成自由坐标')
  assert.equal(moved.style.left, '270px')
  assert.equal(moved.style.top, '514px')
  assert.equal(moved.style.right, '', '自由摆放不再用 right 锚定')
  assert.equal(moved.style.bottom, '')
  assert.equal(moved.style.transform, '', '不再靠 transform 跟手，位置就是最终位置')
  assert.ok(moved.attrs['data-free'], '要标出"这是自由摆放"')
  assert.equal(moved.attrs['data-corner'], 'bl', '角属性只用来决定面板往哪边开')
  assert.equal(dom.storage.get('fc-todo-widget:corner'), undefined, '拖动不该再改角')

  // 面板改成绝对定位：开合面板不再把角标顶走
  const panel = moved.find((n) => n.className === 'fc-panel')[0]
  assert.equal(panel.style.position, 'absolute')
  assert.equal(panel.style.bottom, 'calc(100% + 8px)', '下半屏 ⇒ 面板翻到角标上面')
  assert.equal(panel.style.top, 'auto')
  assert.equal(panel.style.left, '0', '左半屏 ⇒ 面板贴左')
  assert.equal(panel.style.right, 'auto')

  // 拖出屏幕：夹回可见区，不许拖丢
  drag(w, dom, { x: 270, y: 514 }, { x: 5000, y: 5000 })
  assert.equal(dom.storage.get('fc-todo-widget:pos'), '1184,772', '夹到视口内（1280-96 / 800-28）')
  assert.equal(w.root().style.left, '1184px')

  // 四角按钮仍是快捷键：点了回角锚定，并清掉自由坐标
  const br = w.root().find((n) => /fc-posbtn/.test(n.className) && /右下/.test(n.textContent))[0]
  assert.ok(br, '面板里要保留四角按钮')
  br.onclick()
  assert.equal(dom.storage.get('fc-todo-widget:pos'), undefined, '点四角要清掉自由坐标')
  assert.equal(dom.storage.get('fc-todo-widget:corner'), 'br')
  assert.equal(w.root().style.right, '14px')
  assert.equal(w.root().style.left, '')

  // 刷新页面：自由坐标还在（脏值当没存，回默认角）
  const dom2 = makeDom({ box: { w: 96, h: 28 } })
  dom2.storage.set('fc-todo-widget:pos', '870,214')
  const w2 = runWidget(dom2, { reply: TASKS })
  await w2.flush()
  assert.equal(w2.root().style.left, '870px')
  assert.equal(w2.root().style.top, '214px')

  const dom3 = makeDom({ box: { w: 96, h: 28 } })
  dom3.storage.set('fc-todo-widget:pos', '乱七八糟')
  const w3 = runWidget(dom3, { reply: TASKS })
  await w3.flush()
  assert.equal(w3.root().attrs['data-corner'], 'tr', '认不出的坐标不许拿去摆位置')

  // 松手后浏览器补发的 click 不能顺手把面板也开了
  const openBefore = /fc-open/.test(moved.className)
  pillOf(w).onclick()
  assert.equal(/fc-open/.test(w.root().className), openBefore, '刚拖完那一下点击要被吞掉')
})

/**
 * ⑫ 真机 2026-11-04 的教训：挂件"消失了"，但脚本明明在轮询。
 * 也就是说它挂上去过，之后被人从 body 摘掉 —— 定时器还在跑，界面却没有。
 * 这类故障必须自己修复 + 留下证据（removed），不能靠用户去猜。
 */
test('⑫ 根节点被摘掉：自动补挂，且不重复起轮询', async () => {
  const dom = makeDom()
  let fetches = 0
  const w = runWidget(dom, { reply: TASKS, onFetch: () => { fetches += 1 } })
  await w.flush()
  const first = w.root()
  assert.ok(first, '先要挂上')
  assert.equal(fetches, 1, '挂载时拉一次')

  dom.document.body.removeChild(first)
  assert.equal(w.root(), null, '摘掉之后（替身里）也找不到')

  for (const o of dom.observers) o.cb([]) // 宿主重渲染 → childList 变动
  const pending = w.timers[w.timers.length - 1]
  assert.equal(typeof pending, 'function', '被摘掉要排一次补挂')
  pending()

  const again = w.root()
  assert.ok(again, '摘掉后必须自己挂回来')
  assert.notEqual(again, first, '要新建节点，别拿已经脱离文档的旧节点糊弄')
  assert.match(again.text(), /方寸 · 3/)
  assert.equal(fetches, 1, '补挂不该再拉一遍数据（轮询已经在跑）')
})

/**
 * ⑬ 没装方寸本体：角标直接说「未安装 · 去下载」，不是含糊的「未连接」。
 * 哪一种说法决定用户下一步是"装一个"还是"去开一下"，说错就是白折腾。
 */
test('⑬ 没装本体：角标/面板给下载入口，不冒充未连接', async () => {
  const dom = makeDom()
  const w = runWidget(dom, {
    reply: {
      ok: false,
      error: '方寸未连接：管道不存在',
      installed: false,
      downloadUrl: 'https://github.com/MUYU46548/fangcun/releases/latest',
    },
  })
  await w.flush()
  const root = w.root()
  assert.match(root.text(), /方寸未安装/, '角标要说未安装')
  assert.doesNotMatch(root.text(), /方寸未连接/, '别把"没装"说成"没连上"')

  pillOf(w).onclick()
  const text = w.root().text()
  assert.match(text, /去下载/)
  assert.match(text, /github\.com\/MUYU46548\/fangcun\/releases/)
})

test('⑭ 装了但没开：仍然说未连接，不给下载链接', async () => {
  const dom = makeDom()
  const w = runWidget(dom, {
    reply: { ok: false, error: '方寸未连接：管道不存在', installed: true, downloadUrl: '' },
  })
  await w.flush()
  assert.match(w.root().text(), /方寸未连接/)
  pillOf(w).onclick()
  assert.doesNotMatch(w.root().text(), /去下载/, '装了就别劝人再下一遍')
})

/**
 * ⑮ 真机 2026-11-04 晚的最后一格：桌面端窗口是 `titleBarStyle:'hidden'` +
 * `titleBarOverlay{height:40}`，页面铺满整窗，**顶上 40px 被原生窗口按钮盖住**。
 * 挂件在 top:14px 时 DOM 里一切正常（自证 probe 命中自己），人眼却看不见。
 * 所以顶部两个角要自动让开 `env(titlebar-area-height)`；下边的角不吃这个偏移。
 */
test('⑮ 桌面端顶部安全区：右上角让开原生窗口按钮，下边的角不受影响', async () => {
  const dom = makeDom({ titlebar: 40 })
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  const root = w.root()
  assert.equal(root.style.top, '54px', '40 的安全区 + 14 的边距')
  assert.equal(root.style.right, '14px')

  pillOf(w).onclick()
  const btn = w.root().find((n) => /fc-posbtn/.test(n.className) && /左下/.test(n.textContent))[0]
  btn.onclick()
  const moved = w.root()
  assert.equal(moved.style.top, '', '下边的角不需要顶部安全区')
  assert.equal(moved.style.bottom, '14px')
  assert.equal(moved.style.left, '14px')
})

/**
 * ⑯ 真机 2026-11-04 晚的用户反馈："不能拖动，也不能右键，只能左键"。
 * 拖动默认锁着是**故意的**（防手抖），但"右键没反应"就是缺功能：
 * 右键要在原地把全部动作给出来（解锁 / 换角 / 刷新 / 收起 / 看板）。
 */
test('⑯ 右键出菜单：解锁拖动、换角、刷新、收起都在里面', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()

  const pill = pillOf(w)
  assert.equal(typeof pill.oncontextmenu, 'function', '角标要挂右键菜单')
  pill.oncontextmenu({ clientX: 100, clientY: 80, preventDefault() {} })

  const menu = dom.document.getElementById('fc-todo-widget-menu')
  assert.ok(menu, '右键要出菜单')
  const text = menu.text()
  assert.match(text, /拖动：已锁定/, '默认锁着要写清楚，并给解锁入口')
  assert.match(text, /位置：右上/)
  assert.match(text, /收起挂件/)
  assert.match(text, /刷新/)

  const unlock = menu.find((n) => /fc-row/.test(n.className) && /拖动：已锁定/.test(n.text()))[0]
  unlock.onclick()
  assert.equal(dom.storage.get('fc-todo-widget:locked'), '0', '菜单里解锁也要落盘')
  assert.equal(dom.document.getElementById('fc-todo-widget-menu'), null, '点完要收起来')
  assert.ok(w.root().find((n) => /可拖动/.test(n.text()))[0], '面板里应随之显示可拖动')
})

/** ⑰ 锁着的时候硬拖：位置不许动，但必须给一句解释（不然用户以为坏了） */
test('⑰ 锁着时硬拖：不动，但会说明"拖动已锁定"', async () => {
  const dom = makeDom()
  const w = runWidget(dom, { reply: TASKS })
  await w.flush()
  drag(w, dom, { x: 200, y: 150 }, { x: 1200, y: 760 })
  assert.equal(w.root().attrs['data-corner'], 'tr', '锁着就是不许动')
  assert.match(w.root().text(), /拖动已锁定/, '要解释为什么拖不动')
})
