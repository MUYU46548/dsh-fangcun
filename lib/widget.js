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

/** 由宿主注入到页面里的那一行（很短，只负责加载下面的真脚本） */
export const BOOTSTRAP_JS =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + WIDGET_ROUTE + '";s.async=true;'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** 真正的挂件脚本（浏览器端，无依赖） */
export const WIDGET_JS = String.raw`(function () {
  'use strict'
  var ROUTE = '/fangcun/api/tasks'
  var ROOT_ID = 'fc-todo-widget'
  var LS_OPEN = 'fc-todo-widget:open'
  var LS_HIDDEN = 'fc-todo-widget:hidden'
  var POLL_MS = 60000
  var state = { items: [], total: 0, error: '', boardUrl: '', open: false, hidden: false }

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
   * 深色主题：不写死白底，跟着系统/站点走。
   * 用 prefers-color-scheme 而不是读站点变量 —— 读别人的变量就是在赌它不改名。
   */
  function css() {
    if (document.getElementById(ROOT_ID + '-style')) return
    var s = document.createElement('style')
    s.id = ROOT_ID + '-style'
    s.textContent = ''
      + '#' + ROOT_ID + '{position:fixed;right:14px;bottom:14px;z-index:2147483000;'
      + 'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;'
      + '--fc-bg:#fff;--fc-fg:#111;--fc-muted:#8e8e93;--fc-line:rgba(0,0,0,.12);--fc-soft:rgba(0,0,0,.06)}'
      + '@media (prefers-color-scheme: dark){'
      + '#' + ROOT_ID + '{--fc-bg:#1f2023;--fc-fg:#e8e8ea;--fc-muted:#9a9aa0;'
      + '--fc-line:rgba(255,255,255,.14);--fc-soft:rgba(255,255,255,.08)}}'
      + '#' + ROOT_ID + ' .fc-pill{display:flex;align-items:center;gap:6px;cursor:pointer;'
      + 'background:var(--fc-bg);color:var(--fc-fg);border:1px solid var(--fc-line);'
      + 'border-radius:999px;padding:6px 10px;box-shadow:0 2px 10px rgba(0,0,0,.18)}'
      + '#' + ROOT_ID + ' .fc-dot{width:8px;height:8px;border-radius:50%;background:#34c759;flex:none}'
      + '#' + ROOT_ID + ' .fc-dot.off{background:#c7c7cc}'
      + '#' + ROOT_ID + ' .fc-mini{padding:4px 6px;opacity:.5}'
      + '#' + ROOT_ID + ' .fc-mini:hover{opacity:1}'
      + '#' + ROOT_ID + ' .fc-panel{display:none;margin-top:8px;width:280px;max-height:340px;overflow:auto;'
      + 'background:var(--fc-bg);color:var(--fc-fg);border:1px solid var(--fc-line);'
      + 'border-radius:12px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,.24)}'
      + '#' + ROOT_ID + '.fc-open .fc-panel{display:block}'
      + '#' + ROOT_ID + ' .fc-row{padding:6px 4px;border-bottom:1px solid var(--fc-soft);cursor:pointer;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '#' + ROOT_ID + ' .fc-row:hover{background:var(--fc-soft)}'
      + '#' + ROOT_ID + ' .fc-row:last-child{border-bottom:0}'
      + '#' + ROOT_ID + ' .fc-meta{color:var(--fc-muted);margin-left:6px}'
      + '#' + ROOT_ID + ' .fc-empty{color:var(--fc-muted);padding:6px 4px;cursor:pointer}'
      + '#' + ROOT_ID + ' .fc-foot{display:flex;justify-content:space-between;gap:8px;'
      + 'padding:6px 4px 2px;color:var(--fc-muted)}'
      + '#' + ROOT_ID + ' .fc-link{cursor:pointer;text-decoration:underline}'
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
    root.className = (state.open ? 'fc-open' : '') + (state.hidden ? ' fc-hidden' : '')
    clear(root)

    if (state.hidden) {
      // 关掉之后要留一个能捞回来的入口，否则只能去清 localStorage
      var mini = el('div', 'fc-pill fc-mini')
      mini.title = '方寸待办（点击展开）'
      mini.appendChild(el('span', 'fc-dot' + (state.error ? ' off' : '')))
      mini.onclick = function () { state.hidden = false; writeLS(LS_HIDDEN, '0'); render() }
      root.appendChild(mini)
      return
    }

    var pill = el('div', 'fc-pill')
    var dot = el('span', 'fc-dot' + (state.error ? ' off' : ''))
    var label = el('span', '', state.error ? '方寸未连接' : ('方寸 · ' + state.total))
    pill.appendChild(dot)
    pill.appendChild(label)
    pill.title = '方寸待办'
    pill.onclick = function () {
      state.open = !state.open
      writeLS(LS_OPEN, state.open ? '1' : '0')
      render()
    }
    root.appendChild(pill)

    var panel = el('div', 'fc-panel')
    if (state.error) {
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

    root.appendChild(panel)
  }

  function load() {
    try {
      fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (data) {
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

  function mount() {
    if (document.getElementById(ROOT_ID)) return
    css()
    state.open = readLS(LS_OPEN) === '1'
    state.hidden = readLS(LS_HIDDEN) === '1'
    var root = document.createElement('div')
    root.id = ROOT_ID
    document.body.appendChild(root)
    render()
    load()
    setInterval(load, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()`
