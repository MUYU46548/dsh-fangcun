/**
 * 待办挂件的两段前端代码。
 *
 * 为什么是"推一行内联 script，再由它去加载自己的脚本"：
 *  · DSH 桌面端的 index.html 是安装包里的静态文件，`tapIndex` 改不了它，
 *    **唯一**能进页面的通道是 `webserver/index-inject` 推的结构化行；
 *  · 行类型只用 `kind: 'script'`（内联）。**绝不用 `script-src`** ——
 *    那个走 `await loadScript(src)`，加载失败会 reject 掉 `__DSH_BOOT_READY__`，
 *    整个应用起不来。我们自己建 `<script>` 并吞掉 onerror，路由不在就静默失败。
 *
 * 脚本本身只读：拉 `/fangcun/api/tasks`，渲染一个角标 + 可展开面板。
 * 不写方寸任何数据，不改 DSH 的 DOM 结构（只往 body 追加一个 fixed 容器）。
 *
 * ⚠ 这一整段是**浏览器里跑的字符串**，不是本文件的模块代码：
 *   · 不要用反引号 / `${}`，会把外层 template literal 提前截断；
 *   · 改完跑 `test/widget-dom.test.mjs` —— 那个测试用替身 DOM 真执行这段脚本，
 *     能抓到"语法对但运行就抛"这类只在浏览器里出现的错。
 */

export const WIDGET_ROUTE = '/fangcun/widget.js'

/**
 * 页面自证：注入的脚本 / 挂件自己把"我跑到哪一步"报回宿主。
 *
 * 为什么非要有这个：桌面端（Electron）的页面是 `dsh-app://app/`，注入行由页面侧
 * 解释执行（`UZ()`），中间任何一环静默失败，用户看到的都只是"挂件不见了"——
 * 而 `health` 里 `servedByPage` 只能证明"脚本被取走了"，证明不了"它跑起来了"。
 * 这里用 `new Image()` 发 GET（fire-and-forget，不读响应、不跨域、不写任何数据）。
 */
export const REPORT_ROUTE = '/fangcun/api/widget-report'

/**
 * 由宿主注入到页面里的那一行（很短，只负责加载下面的真脚本）。
 *
 * `?from=page` 是**自己加的标记**，不是拿来区分缓存：桌面端（Electron）发出的请求
 * 既没有 `sec-fetch-*`、也没有 `referer`，只靠请求头判断会把"页面真的加载了"
 * 读成"没人来取"（2026-11-03 真机 `servedByPage` 一直是 0，但页面上明明有挂件）。
 * 只有我们推的这一行会带这个查询参数 —— 探针和 curl 不会。
 *
 * 顺带挂一个**全局 error 监听**：脚本语法错、404、被 CSP 挡、`mount()` 抛异常，
 * 全都只会安静地失败；没有这条，就只能靠人眼和猜。
 */
export const BOOTSTRAP_JS =
  '(function(){'
  + 'var R="' + REPORT_ROUTE + '";'
  + 'function rep(e,x){try{var i=new Image();i.src=R+"?e="+encodeURIComponent(e)+"&t="+Date.now()+(x?"&"+x:"")}catch(_){}}'
  + 'try{'
  + 'rep("boot","href="+encodeURIComponent(location.href)+"&rs="+encodeURIComponent(document.readyState)+"&body="+(document.body?1:0));'
  + 'window.addEventListener("error",function(ev){try{'
  + 'var el=ev&&ev.target||null;'
  + 'if(el&&el.tagName==="SCRIPT"){rep("script-error","src="+encodeURIComponent(el.src||""));return}'
  + 'rep("error","m="+encodeURIComponent((ev&&ev.message)||"")+"&f="+encodeURIComponent((ev&&ev.filename)||"")+"&l="+((ev&&ev.lineno)||0)+"&c="+((ev&&ev.colno)||0))'
  + '}catch(_){}},true);'
  + 'var d=document.body||document.head||document.documentElement;'
  + 'if(!d){rep("no-host");return}'
  + 'var s=document.createElement("script");s.src="' + WIDGET_ROUTE + '?from=page";s.async=true;'
  + 's.onerror=function(){rep("script-missing","src="+encodeURIComponent(s.src||""))};'
  + 'd.appendChild(s)'
  + '}catch(e){rep("boot-error","m="+encodeURIComponent((e&&e.message)||e))}})()'

/** 真正的挂件脚本（浏览器端，无依赖） */
export const WIDGET_JS = String.raw`(function () {
  'use strict'
  var ROUTE = '/fangcun/api/tasks'
  var ROOT_ID = 'fc-todo-widget'
  var LS_OPEN = 'fc-todo-widget:open'
  var LS_HIDDEN = 'fc-todo-widget:hidden'
  var LS_CORNER = 'fc-todo-widget:corner'
  var LS_POS = 'fc-todo-widget:pos'
  var LS_LOCK = 'fc-todo-widget:locked'
  // 四角，按顺时针排（面板里就按这个顺序摆按钮）
  var CORNERS = ['tr', 'br', 'bl', 'tl']
  // 默认右上：右下已经被 dsh-whale-widget 占了（见 applyCorner 注释）
  var DEFAULT_CORNER = 'tr'
  // 拖动**默认上锁**：圆点是用来点开面板的，手一抖就被挪走比"拖不动"更烦。
  // 想拖就点面板里的「已锁定」解锁（或右键角标），解锁后按住圆点**拖到哪就停哪**。
  var DRAG_THRESHOLD = 6
  var CORNER_LABELS = { tr: '右上', br: '右下', bl: '左下', tl: '左上' }
  var POLL_MS = 60000
  // pos = 自由摆放的坐标（角标左上角，视口 px）；null 表示还挂在某个角上
  // counts/scope/focus 来自 /fangcun/api/tasks：都是方寸自己的口吻，不是插件另算的量
  var state = { items: [], total: 0, error: '', boardUrl: '', open: false, hidden: false, corner: DEFAULT_CORNER, pos: null, locked: true, suppressUntil: 0, installed: true, downloadUrl: '', titlebar: 0, hintAt: 0, counts: { doing: 0, waiting: 0 }, scope: '全部项目', focus: null }
  var REPORT_ROUTE = '/fangcun/api/widget-report'
  var polling = false
  var watching = false
  var resizing = false
  var menuOff = null
  var panelEl = null
  // 用户按住拖的那颗（角标 / 收起后的小胶囊）：自由坐标量的就是它
  var handleEl = null

  /**
   * 把"我跑到哪一步"报回宿主（GET + Image 信标，不读响应）。任何异常都吞掉：
   * 诊断坏了不能连累挂件。
   */
  function report(event, extra) {
    try {
      var q = REPORT_ROUTE + '?e=' + encodeURIComponent(event) + '&t=' + Date.now()
        + '&hidden=' + (state.hidden ? 1 : 0) + '&open=' + (state.open ? 1 : 0)
        + '&corner=' + encodeURIComponent(state.corner || '')
      if (extra) q += '&' + extra
      var img = new Image()
      img.src = q
    } catch (e) { /* ignore */ }
  }

  function readLS(key) {
    try { return window.localStorage.getItem(key) } catch (e) { return null }
  }
  function writeLS(key, value) {
    try { window.localStorage.setItem(key, value) } catch (e) { /* 隐私模式：记不住就记不住 */ }
  }
  function removeLS(key) {
    try { window.localStorage.removeItem(key) } catch (e) { /* ignore */ }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = String(text)
    return n
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  /**
   * 位置：四角之一，**默认右上**。
   *
   * 为什么不是右下：dsh-whale-widget 的根节点钉在 right:0 / bottom:0（z-index 9999），
   * 谁占右下谁就压在鲸鱼脸上 —— 2026-11-03 真机截图实测，插件之间不该抢同一块地方。
   *
   * 偏移**同时写内联**：样式表没生效时位置也得是对的（0.2.0 的教训：只靠 CSS 就是裸奔）。
   * 代码含义：第一位 t/b = 上下，第二位 r/l = 左右。
   */
  /**
   * 顶部安全区：DSH 桌面窗口在 Windows 上用 titleBarStyle:'hidden' +
   * titleBarOverlay{height:40}，页面铺满整个窗口，**顶上 40px 被原生窗口按钮盖住**。
   * 挂件放在 top:14px 时 DOM 里一切正常（elementFromPoint 都命中它自己），
   * 人眼就是看不见 —— 2026-11-04 真机复查到的正是这一格。
   * 开了 overlay 的窗口里 Chromium 提供 env(titlebar-area-height)，用一个 1px 探针量出来；
   * 量不到（浏览器页 / 老宿主）就当 0，回到原来的 14px。
   */
  function titlebarInset() {
    try {
      if (!document.body) return 0
      var probe = document.createElement('div')
      probe.style.position = 'fixed'
      probe.style.top = '0'
      probe.style.left = '0'
      probe.style.width = '1px'
      probe.style.height = 'env(titlebar-area-height, 0px)'
      probe.style.pointerEvents = 'none'
      probe.style.visibility = 'hidden'
      document.body.appendChild(probe)
      var h = 0
      if (typeof probe.getBoundingClientRect === 'function') h = Number(probe.getBoundingClientRect().height) || 0
      if (probe.parentNode) probe.parentNode.removeChild(probe)
      // 离谱值不采信：宁可放低一点，也别把挂件甩到看不见的地方
      return h > 0 && h < 200 ? h : 0
    } catch (e) { return 0 }
  }

  function applyCorner(root) {
    var c = CORNERS.indexOf(state.corner) >= 0 ? state.corner : DEFAULT_CORNER
    root.setAttribute('data-corner', c)
    if (typeof root.removeAttribute === 'function') root.removeAttribute('data-free')
    root.style.position = 'fixed'
    root.style.zIndex = '2147483000'
    root.style.top = c.charAt(0) === 't' ? ((14 + (Number(state.titlebar) || 0)) + 'px') : ''
    root.style.bottom = c.charAt(0) === 'b' ? '14px' : ''
    root.style.left = c.charAt(1) === 'l' ? '14px' : ''
    root.style.right = c.charAt(1) === 'r' ? '14px' : ''
    root.style.transform = ''
  }

  function vpSize() {
    return { w: Number(window.innerWidth) || 0, h: Number(window.innerHeight) || 0 }
  }

  function clampNum(v, lo, hi) {
    var n = Number(v)
    if (hi < lo) hi = lo
    if (!isFinite(n)) n = lo
    return n < lo ? lo : (n > hi ? hi : n)
  }

  /**
   * 量一个节点的盒（宽高 + 视口坐标）。量不到（没有布局 / 老宿主）返回 null ——
   * 调用方按兜底值算，绝不把 0 当成"尺寸为零"去夹位置。
   */
  function rectOf(node) {
    var w = 0
    var h = 0
    var x = 0
    var y = 0
    try {
      if (node && typeof node.getBoundingClientRect === 'function') {
        var r = node.getBoundingClientRect()
        if (r) {
          w = Math.round(Number(r.width) || 0)
          h = Math.round(Number(r.height) || 0)
          x = Math.round(Number(r.left) || 0)
          y = Math.round(Number(r.top) || 0)
        }
      }
      if ((!w || !h) && node) {
        w = w || Math.round(Number(node.offsetWidth) || 0)
        h = h || Math.round(Number(node.offsetHeight) || 0)
      }
    } catch (e) { /* ignore */ }
    if (!w && !h) return null
    return { w: w, h: h, x: x, y: y }
  }

  /**
   * 自由坐标量的是**角标的左上角**（用户按住的那颗），不是根节点：
   * 面板开合时根节点会变大变小，坐标要是跟着根走，角标就会被面板顶走。
   * 量不到就给保守兜底：宁可夹得紧一点，也不要把挂件拖到屏幕外。
   */
  function sizeOf(root) {
    var b = rectOf(handleEl)
    if (!b || !b.w || !b.h) b = rectOf(root)
    if (!b || !b.w || !b.h) return { w: 96, h: 28, x: 0, y: 0 }
    return b
  }

  /** "x,y" → { x, y }；认不出来就 null（不拿脏值去摆位置） */
  function parsePos(raw) {
    if (typeof raw !== 'string' || !raw) return null
    var parts = raw.split(',')
    if (parts.length !== 2) return null
    var x = Number(parts[0])
    var y = Number(parts[1])
    if (!isFinite(x) || !isFinite(y) || x < 0 || y < 0) return null
    return { x: Math.round(x), y: Math.round(y) }
  }

  /**
   * 自由摆放：**拖到哪就停哪**。
   *
   * 为什么不再吸角（2026-11-05 真机反馈）：同一台机器上的鲸鱼挂件是真拖动，方寸却一松手
   * 就弹到最近的角，用户只会觉得"它不听我的"。四角保留成**快捷键**（面板/右键菜单里点），
   * 但拖动本身不再改角落盘。
   *
   * 只写 left/top；面板由 placePanel 改成绝对定位挂在角标上/下，开合面板不会再顶走角标。
   * 夹进视口：水平 0..(宽-自身宽)，垂直至少让开顶部原生窗口按钮区（事实 21）。
   */
  function applyPos(root) {
    if (!state.pos) return
    var vp = vpSize()
    var box = sizeOf(root)
    var minY = Number(state.titlebar) || 0
    state.pos = {
      x: Math.round(clampNum(state.pos.x, 0, Math.max(0, vp.w - box.w))),
      y: Math.round(clampNum(state.pos.y, minY, Math.max(minY, vp.h - box.h))),
    }
    var up = vp.h > 0 && state.pos.y + box.h / 2 >= vp.h / 2
    var rgt = vp.w > 0 && state.pos.x + box.w / 2 >= vp.w / 2
    root.setAttribute('data-free', '1')
    root.setAttribute('data-corner', (up ? 'b' : 't') + (rgt ? 'r' : 'l'))
    root.style.position = 'fixed'
    root.style.zIndex = '2147483000'
    root.style.left = state.pos.x + 'px'
    root.style.top = state.pos.y + 'px'
    root.style.right = ''
    root.style.bottom = ''
    root.style.transform = ''
  }

  /**
   * 自由摆放时的面板：绝对定位挂在角标下方或上方，横向贴左或贴右。
   * 这样面板开合只影响它自己，角标（也就是用户拖的那颗）原地不动。
   */
  function placePanel(root, panel) {
    if (!state.pos || !panel || !panel.style) return
    var vp = vpSize()
    var box = sizeOf(root)
    var up = vp.h > 0 && state.pos.y + box.h / 2 >= vp.h / 2
    var rgt = vp.w > 0 && state.pos.x + box.w / 2 >= vp.w / 2
    panel.style.position = 'absolute'
    panel.style.margin = '0'
    panel.style.top = up ? 'auto' : 'calc(100% + 8px)'
    panel.style.bottom = up ? 'calc(100% + 8px)' : 'auto'
    panel.style.left = rgt ? 'auto' : '0'
    panel.style.right = rgt ? '0' : 'auto'
    return panel
  }

  /** 摆位置：有保存的自由坐标就用它，否则回四角锚定 */
  function place(root) {
    if (!root) return
    if (state.pos) { applyPos(root); return }
    applyCorner(root)
  }

  /**
   * 四角一键摆位。会**清掉自由坐标**：之后窗口缩放还是贴那一角，直到用户再拖一次。
   */
  function setCorner(c) {
    if (CORNERS.indexOf(c) < 0) return
    state.corner = c
    state.pos = null
    writeLS(LS_CORNER, c)
    removeLS(LS_POS)
    var root = document.getElementById(ROOT_ID)
    if (root) applyCorner(root)
    render()
  }

  /**
   * 起手的基准坐标：按下那一刻，角标在视口的哪儿（按下瞬间不许跳）。
   * 优先量真实位置；量不到才按"当前角"推算（无布局的老宿主走这条）。
   */
  function startPos(root) {
    if (state.pos) return { x: state.pos.x, y: state.pos.y }
    var b = rectOf(handleEl)
    if (!b || (!b.w && !b.h)) b = rectOf(root)
    if (b && (b.w || b.h)) return { x: b.x, y: b.y }
    var vp = vpSize()
    var box = sizeOf(root)
    var c = CORNERS.indexOf(state.corner) >= 0 ? state.corner : DEFAULT_CORNER
    return {
      x: c.charAt(1) === 'l' ? 14 : Math.max(0, vp.w - box.w - 14),
      y: c.charAt(0) === 't' ? ((Number(state.titlebar) || 0) + 14) : Math.max(0, vp.h - box.h - 14),
    }
  }

  /**
   * 拖动：**拖到哪就停哪**（不吸角、不弹回），松手才落盘。
   *
   * **默认上锁**（state.locked）：圆点的主要用途是点开面板，手一抖就被挪走比"拖不动"更烦，
   * 所以先解锁（面板里的「拖动」或右键菜单）才拖得动；锁着硬拖会解释一句。
   * 位移不到 DRAG_THRESHOLD 当点击；真拖过之后 300ms 内的 click 要吞掉，
   * 否则松手会顺手把面板也开了。
   */
  function attachDrag(node) {
    if (!node || typeof node.addEventListener !== 'function') return
    node.addEventListener('pointerdown', function (e) {
      // 右键交给 contextmenu，不参与拖动
      if (e && e.button != null && e.button !== 0) return
      var root = document.getElementById(ROOT_ID)
      if (!root) return
      var sx = Number(e && e.clientX) || 0
      var sy = Number(e && e.clientY) || 0
      var lx = sx
      var ly = sy
      var moved = false
      // 起手就定下基准坐标：之后全程 = 基准 + 指针位移，跟手，不会越拖越偏
      var base = startPos(root)
      function onMove(ev) {
        lx = Number(ev && ev.clientX) || 0
        ly = Number(ev && ev.clientY) || 0
        if (!moved && Math.abs(lx - sx) + Math.abs(ly - sy) < DRAG_THRESHOLD) return
        moved = true
        // 锁着的时候不让它跟着走 —— 那会变成"能拖但松手弹回"，更 confusing。只解释一句。
        if (state.locked) { hintLocked(); return }
        state.pos = { x: base.x + (lx - sx), y: base.y + (ly - sy) }
        // 先让面板脱出布局（绝对定位），再摆位置 —— 否则"角标盒子"被面板撑大，夹不准
        if (state.open) placePanel(root, panelEl)
        applyPos(root)
        if (ev && ev.preventDefault) ev.preventDefault()
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', onUp, true)
        document.removeEventListener('pointercancel', onUp, true)
        if (state.locked) { if (moved) hintLocked(); return }
        if (!moved || !state.pos) return
        state.suppressUntil = Date.now() + 300
        // 松手即定住：只夹进视口，不换角、不吸边
        var vp = vpSize()
        var box = sizeOf(root)
        var minY = Number(state.titlebar) || 0
        state.pos = {
          x: Math.round(clampNum(state.pos.x, 0, Math.max(0, vp.w - box.w))),
          y: Math.round(clampNum(state.pos.y, minY, Math.max(minY, vp.h - box.h))),
        }
        writeLS(LS_POS, state.pos.x + ',' + state.pos.y)
        render() // 面板朝向、位置那一行按新坐标重算
        report('drag', 'x=' + state.pos.x + '&y=' + state.pos.y)
      }
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', onUp, true)
      document.addEventListener('pointercancel', onUp, true)
    })
  }

  /** 拖动被吞掉的那一次点击（松手后浏览器还会补发一个 click） */
  function clickingNow() {
    return Date.now() < state.suppressUntil
  }

  /** 右键 = 菜单。左键开面板、右键给全部动作，别让用户觉得"只有左键能用" */
  function attachMenu(node) {
    if (!node) return
    node.oncontextmenu = function (e) {
      if (e && e.preventDefault) e.preventDefault()
      showMenu(e && e.clientX, e && e.clientY)
      return false
    }
  }

  /**
   * 深色主题：不写死白底，跟着系统/站点走。
   * 用 prefers-color-scheme 而不是读站点变量 —— 读别人的变量就是在赌它不改名。
   */
  function css() {
    if (document.getElementById(ROOT_ID + '-style')) return
    var s = document.createElement('style')
    s.id = ROOT_ID + '-style'
    s.textContent = ''
      + '#' + ROOT_ID + '{position:fixed;z-index:2147483000;'
      + 'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;'
      + '--fc-bg:#fff;--fc-fg:#111;--fc-muted:#8e8e93;--fc-line:rgba(0,0,0,.12);--fc-soft:rgba(0,0,0,.06)}'
      + '@media (prefers-color-scheme: dark){'
      + '#' + ROOT_ID + '{--fc-bg:#1f2023;--fc-fg:#e8e8ea;--fc-muted:#9a9aa0;'
      + '--fc-line:rgba(255,255,255,.14);--fc-soft:rgba(255,255,255,.08)}}'
      + '#' + ROOT_ID + ' .fc-pill{display:flex;align-items:center;gap:6px;cursor:pointer;align-self:flex-end;'
      + 'background:var(--fc-bg);color:var(--fc-fg);border:1px solid var(--fc-line);'
      + 'border-radius:999px;padding:6px 10px;box-shadow:0 2px 10px rgba(0,0,0,.18)}'
      // 贴左的角：角标也要贴左，别让 280px 宽的面板把它顶到中间去
      + '#' + ROOT_ID + '[data-corner$="l"] .fc-pill{align-self:flex-start}'
      + '#' + ROOT_ID + ' .fc-dot{width:8px;height:8px;border-radius:50%;background:#34c759;flex:none}'
      + '#' + ROOT_ID + ' .fc-dot.off{background:#c7c7cc}'
      + '#' + ROOT_ID + ' .fc-mini{padding:4px 6px;opacity:.5}'
      + '#' + ROOT_ID + ' .fc-mini:hover{opacity:1}'
      + '#' + ROOT_ID + ' .fc-panel{display:none;margin-top:8px;width:280px;max-height:340px;overflow:auto;'
      + 'background:var(--fc-bg);color:var(--fc-fg);border:1px solid var(--fc-line);'
      + 'border-radius:12px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,.24)}'
      + '#' + ROOT_ID + '.fc-open .fc-panel{display:block}'
      // 贴下的角（bl/br）：面板翻到角标上面，别顶出屏幕
      + '#' + ROOT_ID + '[data-corner^="b"]{display:flex;flex-direction:column-reverse}'
      + '#' + ROOT_ID + '[data-corner^="b"] .fc-panel{margin-top:0;margin-bottom:8px}'
      + '#' + ROOT_ID + ' .fc-row{padding:6px 4px;border-bottom:1px solid var(--fc-soft);cursor:pointer;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '#' + ROOT_ID + ' .fc-row:hover{background:var(--fc-soft)}'
      + '#' + ROOT_ID + ' .fc-row:last-child{border-bottom:0}'
      + '#' + ROOT_ID + ' .fc-meta{color:var(--fc-muted);margin-left:6px}'
      + '#' + ROOT_ID + ' .fc-empty{color:var(--fc-muted);padding:6px 4px;cursor:pointer}'
      // 本次在办：这是"我手上那张"，给个底色，别和下面一长串待办混在一起
      + '#' + ROOT_ID + ' .fc-focus{background:var(--fc-soft);border-radius:8px}'
      + '#' + ROOT_ID + ' .fc-foot{display:flex;justify-content:space-between;gap:8px;'
      + 'padding:6px 4px 2px;color:var(--fc-muted)}'
      + '#' + ROOT_ID + ' .fc-link{cursor:pointer;text-decoration:underline}'
      // 位置选择：四个角一键换，存 localStorage，不用改配置也不用重启
      + '#' + ROOT_ID + ' .fc-pos{display:flex;flex-wrap:wrap;align-items:center;gap:6px;'
      + 'margin-top:4px;padding:6px 4px 2px;border-top:1px solid var(--fc-soft);color:var(--fc-muted)}'
      + '#' + ROOT_ID + ' .fc-posbtn{cursor:pointer;padding:1px 6px;border:1px solid var(--fc-line);border-radius:6px}'
      + '#' + ROOT_ID + ' .fc-posbtn:hover{background:var(--fc-soft)}'
      + '#' + ROOT_ID + ' .fc-posbtn.on{background:var(--fc-soft);color:var(--fc-fg);border-color:var(--fc-muted)}'
      // 右键菜单：默认锁着拖动时，右键是最自然的那一下（2026-11-04 真机反馈）
      + '#' + ROOT_ID + ' .fc-menu{position:fixed;z-index:2147483600;min-width:164px;padding:4px;'
      + 'background:var(--fc-bg);color:var(--fc-fg);border:1px solid var(--fc-line);border-radius:10px;'
      + 'box-shadow:0 8px 28px rgba(0,0,0,.28)}'
      + '#' + ROOT_ID + ' .fc-menu .fc-row{padding:5px 8px;border-radius:6px}'
      + '#' + ROOT_ID + ' .fc-menu .fc-row:hover{background:var(--fc-soft)}'
      + '#' + ROOT_ID + ' .fc-mark{opacity:.5;margin-left:8px}'
    // ⚠ 建完**必须挂进文档**。v0.2.0 这里只 createElement 没 append，
    //   元素不在文档里 ⇒ 一条规则都不生效 ⇒ 挂件以纯文本排在页面末尾（真机 2026-11-03 见到的那坨）。
    //   测试抓不到，因为替身 DOM 不做样式计算，只能靠这条断言钉住"挂进去了"。
    var host = document.head || document.body || document.documentElement
    if (host && typeof host.appendChild === 'function') host.appendChild(s)
  }

  function toast(text) {
    var root = document.getElementById(ROOT_ID)
    if (!root) return
    var old = document.getElementById(ROOT_ID + '-toast')
    if (old && old.parentNode) old.parentNode.removeChild(old)
    var t = el('div', 'fc-empty', text)
    t.id = ROOT_ID + '-toast'
    // 自由摆放时提示条绝对定位：别把根节点撑大（位置夹算的是角标的盒子）
    if (state.pos) {
      t.style.position = 'absolute'
      t.style.left = '0'
      t.style.top = 'calc(100% + 6px)'
      t.style.width = 'max-content'
      t.style.maxWidth = '240px'
    }
    root.appendChild(t)
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t) }, 1800)
  }

  /** 复制一段文本：只读动作，不改方寸任何东西 */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { showCopied('已复制 ', text) },
          function () { showCopied('复制失败，内容：', text) })
        return
      }
    } catch (e) { /* 掉到下面的兜底 */ }
    showCopied('内容：', text)
  }

  /** 提示条里别贴一整段长文本：卡号+标题可能几十个字，截断显示 */
  function showCopied(prefix, text) {
    var s = String(text == null ? '' : text)
    if (s.length > 64) s = s.slice(0, 64) + '…'
    toast(prefix + s)
  }

  /**
   * 角标文案：总数之外补两个"现在要不要动手"的数 ——
   * 在办（status=进行中）、待拍板（status=待验收/待审批）。
   * 两个数都是方寸自己写进卡里的 status 数出来的（见 lib/index.js 的 countStatuses），
   * 不是插件另立的分组，也不是优先级判断。
   */
  function pillText(notInstalled) {
    if (notInstalled) return '方寸未安装 · 去下载'
    if (state.error) return '方寸未连接'
    var t = '方寸 · ' + state.total
    var doing = Number(state.counts && state.counts.doing) || 0
    var waiting = Number(state.counts && state.counts.waiting) || 0
    if (doing > 0) t += ' · 在办 ' + doing
    if (waiting > 0) t += ' · 待拍板 ' + waiting
    return t
  }

  /**
   * 右键菜单。为什么要有：拖动**默认锁着**（防手抖），可用户的第一反应是"按住拖"
   * 或"右键看看"；两下都没反应就只会说"挂件坏了"（2026-11-04 真机反馈：
   * "不能拖动，也不能右键，只能左键"）。右键在这里给全：位置、拖动开关、刷新、收起、看板。
   */
  function closeMenu() {
    var m = document.getElementById(ROOT_ID + '-menu')
    if (m && m.parentNode) m.parentNode.removeChild(m)
    if (menuOff) {
      try { document.removeEventListener('pointerdown', menuOff, true) } catch (e) { /* ignore */ }
      menuOff = null
    }
  }

  function menuItem(menu, text, onClick, mark) {
    var it = el('div', 'fc-row', text)
    if (mark) it.appendChild(el('span', 'fc-mark', mark))
    it.onclick = function () { closeMenu(); try { onClick() } catch (e) { /* ignore */ } }
    menu.appendChild(it)
    return it
  }

  function showMenu(x, y) {
    closeMenu()
    var root = document.getElementById(ROOT_ID)
    if (!root) return
    var menu = el('div', 'fc-menu')
    menu.id = ROOT_ID + '-menu'
    var vw = Number(window.innerWidth) || 800
    var vh = Number(window.innerHeight) || 600
    menu.style.left = Math.round(Math.min(Math.max(8, Number(x) || 0), Math.max(8, vw - 190))) + 'px'
    menu.style.top = Math.round(Math.min(Math.max(8, Number(y) || 0), Math.max(8, vh - 260))) + 'px'

    menuItem(menu, '刷新', function () { load() })
    menuItem(menu, state.locked ? '拖动：已锁定（点这里解锁）' : '拖动：可拖动（点这里锁定）', function () {
      state.locked = !state.locked
      writeLS(LS_LOCK, state.locked ? '1' : '0')
      render()
      toast(state.locked ? '已锁定：按住拖不动了' : '已解锁：按住圆点拖到哪就停哪')
    })
    CORNERS.forEach(function (c) {
      menuItem(menu, '位置：' + CORNER_LABELS[c], function () { setCorner(c) },
        (!state.pos && c === state.corner) ? '●' : '')
    })
    if (state.boardUrl) {
      menuItem(menu, '打开看板', function () {
        try { window.open(state.boardUrl, '_blank', 'noopener') } catch (e) { /* 被拦截就算了 */ }
      })
    }
    menuItem(menu, '收起挂件', function () {
      state.hidden = true
      writeLS(LS_HIDDEN, '1')
      render()
    })

    root.appendChild(menu)
    // 点菜单外面就收起来（菜单自己的点击先冒到 item 上，已经 close 了）
    menuOff = function (ev) {
      var node = ev && ev.target
      while (node) {
        if (node === menu) return
        node = node.parentNode
      }
      closeMenu()
    }
    setTimeout(function () {
      try { if (menuOff) document.addEventListener('pointerdown', menuOff, true) } catch (e) { /* ignore */ }
    }, 0)
    report('menu', 'corner=' + encodeURIComponent(state.corner || '') + '&locked=' + (state.locked ? 1 : 0))
  }

  /** 锁定态下被拖动：不跟着走，但要说一句"为什么拖不动"（3 秒最多一次） */
  function hintLocked() {
    var now = Date.now()
    if (now - (state.hintAt || 0) < 3000) return
    state.hintAt = now
    toast('拖动已锁定：右键菜单里解锁')
  }

  function render() {
    var root = document.getElementById(ROOT_ID)
    if (!root) return
    place(root)
    root.className = (state.open ? 'fc-open' : '') + (state.hidden ? ' fc-hidden' : '')
    clear(root)
    panelEl = null
    handleEl = null

    if (state.hidden) {
      // 关掉之后要留一个能捞回来的入口，否则只能去清 localStorage。
      // 这里写「方寸」两个字而不是只留一个点：8px 的绿点贴在右上角，
      // 用户只会说"挂件没了"（2026-11-04 真机就是这个反馈）。
      var mini = el('div', 'fc-pill fc-mini')
      mini.title = '方寸待办（点击展开）'
      mini.appendChild(el('span', 'fc-dot' + (state.error ? ' off' : '')))
      mini.appendChild(el('span', '', '方寸'))
      mini.onclick = function () {
        if (clickingNow()) return
        state.hidden = false
        writeLS(LS_HIDDEN, '0')
        render()
      }
      attachDrag(mini)
      attachMenu(mini)
      handleEl = mini
      root.appendChild(mini)
      return
    }

    var notInstalled = state.installed === false
    var pill = el('div', 'fc-pill')
    var dot = el('span', 'fc-dot' + ((state.error || notInstalled) ? ' off' : ''))
    var label = el('span', '', pillText(notInstalled))
    pill.appendChild(dot)
    pill.appendChild(label)
    pill.title = notInstalled
      ? '没检测到方寸桌面版（点开有下载地址）'
      : (state.locked ? '方寸待办（左键面板 / 右键菜单）' : '方寸待办（按住拖到任意位置）')
    pill.style.cursor = state.locked ? 'pointer' : 'grab'
    // 解锁后把拖动的默认手势关掉，触屏上才不会变成滚页面
    if (!state.locked) pill.style.touchAction = 'none'
    pill.onclick = function () {
      if (clickingNow()) return // 刚拖完，别再顺手把面板开了
      state.open = !state.open
      writeLS(LS_OPEN, state.open ? '1' : '0')
      render()
    }
    attachDrag(pill)
    attachMenu(pill)
    handleEl = pill
    root.appendChild(pill)

    var panel = el('div', 'fc-panel')
    // 折叠态**不依赖 CSS**：样式表没生效时最坏是丑一点，不能把 20 条待办摊在页面上。
    panel.style.display = state.open ? 'block' : 'none'
    // 自由摆放时面板改成绝对定位挂在角标上/下：开合面板不再把角标顶走
    panelEl = panel
    placePanel(root, panel)
    // 顶部两行信息（没装/没连时不显示，免得把故障页搅乱）：
    //  ① 本次在办 —— DSH 侧最近一次工具调用动过的卡（卡号来自 lib/cards.js，只取 id）
    //  ② 口径 + 在办/待拍板的数（都是方寸自己的 status）
    if (!notInstalled && !state.error) {
      if (state.focus && state.focus.id) {
        var fr = el('div', 'fc-row fc-focus', '本次在办：' + (state.focus.title || state.focus.id))
        fr.title = state.focus.id + (state.focus.status ? ' · ' + state.focus.status : '')
          + '　点击复制卡号+标题'
        fr.appendChild(el('span', 'fc-meta', state.focus.status || ''))
        fr.onclick = function () {
          copyText(state.focus.id + (state.focus.title ? ' ' + state.focus.title : ''))
        }
        panel.appendChild(fr)
      }
      var doing = Number(state.counts && state.counts.doing) || 0
      var waiting = Number(state.counts && state.counts.waiting) || 0
      var summary = el('div', 'fc-empty', state.scope + ' · 未完成 ' + state.total
        + (doing > 0 ? ' · 在办 ' + doing : '')
        + (waiting > 0 ? ' · 待拍板 ' + waiting : ''))
      summary.onclick = function () { load() }
      panel.appendChild(summary)
    }

    if (notInstalled) {
      // 装了没开 / 没装，是两种下一步。这里只处理"没装"：给下载地址，不给假数字。
      panel.appendChild(el('div', 'fc-empty', '没检测到方寸桌面版（本机没有任何装机痕迹）。'))
      if (state.downloadUrl) {
        var dl = el('div', 'fc-link', '去下载：' + state.downloadUrl)
        dl.onclick = function () {
          try { window.open(state.downloadUrl, '_blank', 'noopener') } catch (e) { /* 被拦截就算了 */ }
        }
        panel.appendChild(dl)
      }
      panel.appendChild(el('div', 'fc-empty', '装好后重启 DSH 就能看到待办。'))
      var retryInstall = el('div', 'fc-empty', '已经装了？点这里重试')
      retryInstall.onclick = function () { load() }
      panel.appendChild(retryInstall)
    } else if (state.error) {
      var retry = el('div', 'fc-empty', state.error + '（点一下重试）')
      retry.onclick = function () { load() }
      panel.appendChild(retry)
    } else if (!state.items.length) {
      var empty = el('div', 'fc-empty', '没有未完成的卡（点一下刷新）')
      empty.onclick = function () { load() }
      panel.appendChild(empty)
    } else {
      state.items.forEach(function (it) {
        var row = el('div', 'fc-row', it.title || it.id)
        // 点一下复制「卡号 + 标题」：直接粘进对话就能开工，不用自己再去补标题
        row.title = (it.project || '') + ' · ' + (it.status || '') + ' · 点击复制卡号+标题'
        row.appendChild(el('span', 'fc-meta', it.status || ''))
        row.onclick = function () { copyText(it.id + (it.title ? ' ' + it.title : '')) }
        panel.appendChild(row)
      })
    }

    var foot = el('div', 'fc-foot')
    if (state.boardUrl) {
      var link = el('span', 'fc-link', '打开看板')
      link.onclick = function () {
        try { window.open(state.boardUrl, '_blank', 'noopener') } catch (e) { /* 被拦截就算了 */ }
      }
      foot.appendChild(link)
    } else {
      foot.appendChild(el('span', '', ''))
    }
    var close = el('span', 'fc-link', '收起挂件')
    close.onclick = function () { state.hidden = true; writeLS(LS_HIDDEN, '1'); render() }
    foot.appendChild(close)
    panel.appendChild(foot)

    // 位置：四个角只是**快捷键**（一键摆过去）。拖动之后是自由摆放，
    // 那时候不再有"当前角"，标一个「自由摆放」，免得用户以为四角按钮失灵。
    var pos = el('div', 'fc-pos')
    pos.appendChild(el('span', '', '位置'))
    if (state.pos) pos.appendChild(el('span', 'fc-meta', '自由摆放'))
    CORNERS.forEach(function (c) {
      var btn = el('span', 'fc-posbtn' + ((!state.pos && state.corner === c) ? ' on' : ''), CORNER_LABELS[c])
      btn.title = '把挂件放到' + CORNER_LABELS[c] + '（拖动可以停在任意位置）'
      btn.onclick = function () { setCorner(c) }
      pos.appendChild(btn)
    })
    panel.appendChild(pos)

    // 拖动开关：默认锁着。锁着的时候按住圆点只会点开面板，不会被手抖带着跑。
    var dragRow = el('div', 'fc-pos')
    dragRow.appendChild(el('span', '', '拖动'))
    var lockBtn = el('span', 'fc-posbtn' + (state.locked ? ' on' : ''), state.locked ? '已锁定' : '可拖动')
    lockBtn.title = state.locked
      ? '点一下解锁（也可以直接右键角标）：解锁后按住圆点拖到哪就停哪'
      : '点一下重新锁定：锁定后按住圆点不会再被拖走'
    lockBtn.onclick = function () {
      state.locked = !state.locked
      writeLS(LS_LOCK, state.locked ? '1' : '0')
      render()
    }
    dragRow.appendChild(lockBtn)
    panel.appendChild(dragRow)

    root.appendChild(panel)
  }

  function load() {
    try {
      fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (data) {
          // 装机判定要**先于** ok 判断读出来：503 的响应体里也带着它，
          // 不然"没装"和"装了没开"会被同一条错误吞掉。
          if (data && typeof data.installed === 'boolean') state.installed = data.installed
          if (data && typeof data.downloadUrl === 'string') state.downloadUrl = data.downloadUrl
          if (!data || data.ok !== true) throw new Error((data && data.error) || '方寸没有回数据')
          state.items = Array.isArray(data.items) ? data.items : []
          state.total = Number(data.total) || state.items.length
          // 下面三样是"让挂件说人话"的部分：都是宿主按方寸口径给的，页面不再自己算
          state.counts = (data && data.counts && typeof data.counts === 'object')
            ? { doing: Number(data.counts.doing) || 0, waiting: Number(data.counts.waiting) || 0 }
            : { doing: 0, waiting: 0 }
          state.scope = (typeof data.scope === 'string' && data.scope) ? data.scope : '全部项目'
          state.focus = (data && data.focus && typeof data.focus === 'object' && data.focus.id) ? data.focus : null
          state.boardUrl = typeof data.boardUrl === 'string' ? data.boardUrl : ''
          state.error = ''
          render()
        })
        .catch(function (e) {
          state.error = '方寸未连接（' + ((e && e.message) || '未知原因') + '）'
          render()
        })
    } catch (e) {
      // 有些环境的 fetch 是同步抛的（不是返回 rejected promise），一起兜住
      state.error = '方寸未连接（' + ((e && e.message) || '未知原因') + '）'
      render()
    }
  }

  /** 挂上之后量一次真实位置：有没有尺寸、在不在视口里、命中的是不是自己 */
  function probe() {
    try {
      var root = document.getElementById(ROOT_ID)
      if (!root) { report('probe-missing'); return }
      var r = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null
      var hit = null
      if (r && typeof document.elementFromPoint === 'function') hit = document.elementFromPoint(r.left + 3, r.top + 3)
      var inBody = -1
      if (document.body && typeof document.body.contains === 'function') inBody = document.body.contains(root) ? 1 : 0
      report('probe',
        'w=' + (r ? Math.round(r.width) : -1) + '&h=' + (r ? Math.round(r.height) : -1)
        + '&x=' + (r ? Math.round(r.left) : -1) + '&y=' + (r ? Math.round(r.top) : -1)
        + '&in=' + inBody + '&tb=' + (Number(state.titlebar) || 0)
        + '&hit=' + encodeURIComponent(hit ? (hit.id || hit.className || hit.tagName || '') : ''))
    } catch (e) { /* ignore */ }
  }

  function startPolling() {
    if (polling) return
    polling = true
    load()
    setInterval(load, POLL_MS)
  }

  /**
   * 根节点被人从 body 移走时**立刻补挂**，并报一条 removed。
   * 没有这条，挂件会安静失踪、定时器还在跑 —— 现象正好是"看不见，但 health 一切正常"。
   */
  function watch() {
    if (watching) return
    if (typeof MutationObserver !== 'function' || !document.body) return
    watching = true
    try {
      var mo = new MutationObserver(function () {
        if (document.getElementById(ROOT_ID)) return
        report('removed')
        setTimeout(function () { try { mount('remount') } catch (e) { /* ignore */ } }, 60)
      })
      mo.observe(document.body, { childList: true })
    } catch (e) { watching = false }
  }

  /**
   * 窗口尺寸变了：自由坐标要夹回可见区（不然缩小窗口后挂件就留在屏幕外，
   * 用户只会说"拖丢了"）。四角锚定由 CSS 自己贴角，不用管。
   */
  function watchResize() {
    if (resizing) return
    if (typeof window.addEventListener !== 'function') return
    resizing = true
    try {
      window.addEventListener('resize', function () {
        var root = document.getElementById(ROOT_ID)
        if (!root) return
        place(root)
        if (state.open) placePanel(root, panelEl)
      })
    } catch (e) { resizing = false }
  }

  function mount(why) {
    if (document.getElementById(ROOT_ID)) return
    css()
    state.open = readLS(LS_OPEN) === '1'
    state.hidden = readLS(LS_HIDDEN) === '1'
    var savedCorner = readLS(LS_CORNER)
    state.corner = CORNERS.indexOf(savedCorner) >= 0 ? savedCorner : DEFAULT_CORNER // 认不出来就回默认，不拿脏值去算位置
    state.pos = parsePos(readLS(LS_POS)) // 拖动过就按保存的坐标停在那儿（脏值当没存）
    state.locked = readLS(LS_LOCK) !== '0' // 只有明确存过 '0' 才是解锁，默认锁着
    state.titlebar = titlebarInset() // 顶部被原生窗口按钮占了多高（0 = 普通浏览器页）
    if (!document.body) { report('no-body'); return }
    var root = document.createElement('div')
    root.id = ROOT_ID
    document.body.appendChild(root)
    render() // 定位在 place 里写内联：样式表万一没生效，最坏是丑，不许排进正文
    watch()
    watchResize()
    startPolling()
    var href = (typeof location !== 'undefined' && location && location.href) ? String(location.href) : ''
    report('mount',
      'why=' + encodeURIComponent(why || 'first')
      + '&href=' + encodeURIComponent(href)
      + '&rs=' + encodeURIComponent(String(document.readyState || ''))
      + '&kids=' + (document.body && document.body.childNodes ? document.body.childNodes.length : -1))
    // 量尺寸要有布局才有意义（替身 DOM 没有 getBoundingClientRect，就别排这个定时器）
    if (typeof root.getBoundingClientRect === 'function') setTimeout(probe, 800)
  }

  function boot() {
    try { mount('boot') } catch (e) { report('mount-error', 'm=' + encodeURIComponent((e && e.message) || e)) }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()`
