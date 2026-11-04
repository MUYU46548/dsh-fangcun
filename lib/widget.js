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
  var LS_LOCK = 'fc-todo-widget:locked'
  // 四角，按顺时针排（面板里就按这个顺序摆按钮）
  var CORNERS = ['tr', 'br', 'bl', 'tl']
  // 默认右上：右下已经被 dsh-whale-widget 占了（见 applyCorner 注释）
  var DEFAULT_CORNER = 'tr'
  // 拖动**默认上锁**：圆点是用来点开面板的，手一抖就换角比"拖不动"更烦。
  // 想拖就点面板里的「已锁定」解锁，解完再拖，松手自动吸到最近的那个角。
  var DRAG_THRESHOLD = 6
  var CORNER_LABELS = { tr: '右上', br: '右下', bl: '左下', tl: '左上' }
  var POLL_MS = 60000
  var state = { items: [], total: 0, error: '', boardUrl: '', open: false, hidden: false, corner: DEFAULT_CORNER, locked: true, suppressUntil: 0, installed: true, downloadUrl: '', titlebar: 0 }
  var REPORT_ROUTE = '/fangcun/api/widget-report'
  var polling = false
  var watching = false

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
    var c = state.corner
    root.setAttribute('data-corner', c)
    root.style.position = 'fixed'
    root.style.zIndex = '2147483000'
    root.style.top = c.charAt(0) === 't' ? ((14 + (Number(state.titlebar) || 0)) + 'px') : ''
    root.style.bottom = c.charAt(0) === 'b' ? '14px' : ''
    root.style.left = c.charAt(1) === 'l' ? '14px' : ''
    root.style.right = c.charAt(1) === 'r' ? '14px' : ''
  }

  /**
   * 松手时按**落点**算最近的那个角：拖到右半边就是 r，上半边就是 t。
   * 视口尺寸拿不到时保留当前那一维，不瞎猜（宁可不动，也不要把挂件甩到看不见的地方）。
   */
  function cornerAt(x, y) {
    var w = Number(window.innerWidth) || 0
    var h = Number(window.innerHeight) || 0
    var next = state.corner
    if (h > 0) next = (y >= h / 2 ? 'b' : 't') + next.charAt(1)
    if (w > 0) next = next.charAt(0) + (x >= w / 2 ? 'r' : 'l')
    return next
  }

  function setCorner(c) {
    if (CORNERS.indexOf(c) < 0 || c === state.corner) return
    state.corner = c
    writeLS(LS_CORNER, c)
    var root = document.getElementById(ROOT_ID)
    if (root) applyCorner(root)
    render()
  }

  /**
   * 拖拽换角。**默认上锁**（state.locked）：圆点的主要用途是点开面板，
   * 手一抖就换角比"拖不动"更烦，所以拖动要先在面板里解锁。
   *
   * 拖的过程只改 transform（跟手而已，不动布局），松手才吸角并落盘；
   * 位移不到 DRAG_THRESHOLD 就当成一次普通点击，面板照常开合。
   * 真拖过之后 300ms 内的 click 要吞掉，否则松手会顺手把面板也开了。
   */
  function attachDrag(node) {
    if (!node || typeof node.addEventListener !== 'function') return
    node.addEventListener('pointerdown', function (e) {
      if (state.locked) return
      if (e && e.button != null && e.button !== 0) return
      var root = document.getElementById(ROOT_ID)
      if (!root) return
      var sx = Number(e && e.clientX) || 0
      var sy = Number(e && e.clientY) || 0
      var lx = sx
      var ly = sy
      var moved = false
      function onMove(ev) {
        lx = Number(ev && ev.clientX) || 0
        ly = Number(ev && ev.clientY) || 0
        if (!moved && Math.abs(lx - sx) + Math.abs(ly - sy) < DRAG_THRESHOLD) return
        moved = true
        root.style.transform = 'translate(' + (lx - sx) + 'px,' + (ly - sy) + 'px)'
        if (ev && ev.preventDefault) ev.preventDefault()
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', onUp, true)
        document.removeEventListener('pointercancel', onUp, true)
        root.style.transform = ''
        if (!moved) return
        state.suppressUntil = Date.now() + 300
        setCorner(cornerAt(lx, ly))
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
      + '#' + ROOT_ID + ' .fc-foot{display:flex;justify-content:space-between;gap:8px;'
      + 'padding:6px 4px 2px;color:var(--fc-muted)}'
      + '#' + ROOT_ID + ' .fc-link{cursor:pointer;text-decoration:underline}'
      // 位置选择：四个角一键换，存 localStorage，不用改配置也不用重启
      + '#' + ROOT_ID + ' .fc-pos{display:flex;flex-wrap:wrap;align-items:center;gap:6px;'
      + 'margin-top:4px;padding:6px 4px 2px;border-top:1px solid var(--fc-soft);color:var(--fc-muted)}'
      + '#' + ROOT_ID + ' .fc-posbtn{cursor:pointer;padding:1px 6px;border:1px solid var(--fc-line);border-radius:6px}'
      + '#' + ROOT_ID + ' .fc-posbtn:hover{background:var(--fc-soft)}'
      + '#' + ROOT_ID + ' .fc-posbtn.on{background:var(--fc-soft);color:var(--fc-fg);border-color:var(--fc-muted)}'
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
    root.appendChild(t)
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t) }, 1800)
  }

  /** 复制 id：只读动作，不改方寸任何东西 */
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('已复制 ' + text) },
          function () { toast('复制失败，id：' + text) })
        return
      }
    } catch (e) { /* 掉到下面的兜底 */ }
    toast('id：' + text)
  }

  function render() {
    var root = document.getElementById(ROOT_ID)
    if (!root) return
    applyCorner(root)
    root.className = (state.open ? 'fc-open' : '') + (state.hidden ? ' fc-hidden' : '')
    clear(root)

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
      root.appendChild(mini)
      return
    }

    var notInstalled = state.installed === false
    var pill = el('div', 'fc-pill')
    var dot = el('span', 'fc-dot' + ((state.error || notInstalled) ? ' off' : ''))
    var label = el('span', '',
      notInstalled ? '方寸未安装 · 去下载' : (state.error ? '方寸未连接' : ('方寸 · ' + state.total)))
    pill.appendChild(dot)
    pill.appendChild(label)
    pill.title = notInstalled
      ? '没检测到方寸桌面版（点开有下载地址）'
      : (state.locked ? '方寸待办' : '方寸待办（拖到四个角之一可换位置）')
    pill.style.cursor = state.locked ? 'pointer' : 'grab'
    pill.onclick = function () {
      if (clickingNow()) return // 刚拖完，别再顺手把面板开了
      state.open = !state.open
      writeLS(LS_OPEN, state.open ? '1' : '0')
      render()
    }
    attachDrag(pill)
    root.appendChild(pill)

    var panel = el('div', 'fc-panel')
    // 折叠态**不依赖 CSS**：样式表没生效时最坏是丑一点，不能把 20 条待办摊在页面上。
    panel.style.display = state.open ? 'block' : 'none'
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
        row.title = (it.project || '') + ' · ' + (it.status || '') + ' · 点击复制 id'
        row.appendChild(el('span', 'fc-meta', it.status || ''))
        row.onclick = function () { copyText(it.id) }
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

    // 位置：四个角一键换。存 localStorage —— 不改插件配置、不用重启。
    var pos = el('div', 'fc-pos')
    pos.appendChild(el('span', '', '位置'))
    CORNERS.forEach(function (c) {
      var btn = el('span', 'fc-posbtn' + (state.corner === c ? ' on' : ''), CORNER_LABELS[c])
      btn.title = '把挂件放到' + CORNER_LABELS[c]
      btn.onclick = function () { setCorner(c) }
      pos.appendChild(btn)
    })
    panel.appendChild(pos)

    // 拖动开关：默认锁着。锁着的时候按住圆点只会点开面板，不会被手抖带着跑。
    var dragRow = el('div', 'fc-pos')
    dragRow.appendChild(el('span', '', '拖动'))
    var lockBtn = el('span', 'fc-posbtn' + (state.locked ? ' on' : ''), state.locked ? '已锁定' : '可拖动')
    lockBtn.title = state.locked
      ? '点一下解锁：解锁后按住圆点拖到四个角之一就能换位置'
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

  function mount(why) {
    if (document.getElementById(ROOT_ID)) return
    css()
    state.open = readLS(LS_OPEN) === '1'
    state.hidden = readLS(LS_HIDDEN) === '1'
    var savedCorner = readLS(LS_CORNER)
    state.corner = CORNERS.indexOf(savedCorner) >= 0 ? savedCorner : DEFAULT_CORNER // 认不出来就回默认，不拿脏值去算位置
    state.locked = readLS(LS_LOCK) !== '0' // 只有明确存过 '0' 才是解锁，默认锁着
    state.titlebar = titlebarInset() // 顶部被原生窗口按钮占了多高（0 = 普通浏览器页）
    if (!document.body) { report('no-body'); return }
    var root = document.createElement('div')
    root.id = ROOT_ID
    document.body.appendChild(root)
    render() // 定位在 applyCorner 里写内联：样式表万一没生效，最坏是丑，不许排进正文
    watch()
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
