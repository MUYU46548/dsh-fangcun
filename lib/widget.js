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
  var POLL_MS = 60000
  var state = { items: [], total: 0, error: '', open: false }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = String(text)
    return n
  }

  function css() {
    if (document.getElementById(ROOT_ID + '-style')) return
    var s = document.createElement('style')
    s.id = ROOT_ID + '-style'
    s.textContent = ''
      + '#' + ROOT_ID + '{position:fixed;right:14px;bottom:14px;z-index:2147483000;'
      + 'font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111}'
      + '#' + ROOT_ID + ' .fc-pill{display:flex;align-items:center;gap:6px;cursor:pointer;'
      + 'background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:999px;padding:6px 10px;'
      + 'box-shadow:0 2px 10px rgba(0,0,0,.12)}'
      + '#' + ROOT_ID + ' .fc-dot{width:8px;height:8px;border-radius:50%;background:#34c759}'
      + '#' + ROOT_ID + ' .fc-dot.off{background:#c7c7cc}'
      + '#' + ROOT_ID + ' .fc-panel{display:none;margin-top:8px;width:260px;max-height:320px;overflow:auto;'
      + 'background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:8px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.16)}'
      + '#' + ROOT_ID + '.fc-open .fc-panel{display:block}'
      + '#' + ROOT_ID + ' .fc-row{padding:6px 4px;border-bottom:1px solid rgba(0,0,0,.06);'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '#' + ROOT_ID + ' .fc-row:last-child{border-bottom:0}'
      + '#' + ROOT_ID + ' .fc-meta{color:#8e8e93;margin-left:6px}'
      + '#' + ROOT_ID + ' .fc-empty{color:#8e8e93;padding:6px 4px}'
  }

  function render() {
    var root = document.getElementById(ROOT_ID)
    if (!root) return
    root.className = state.open ? 'fc-open' : ''
    root.innerHTML = ''

    var pill = el('div', 'fc-pill')
    var dot = el('span', 'fc-dot' + (state.error ? ' off' : ''))
    var label = el('span', '', state.error ? '方寸未连接' : ('方寸 · ' + state.total))
    pill.appendChild(dot)
    pill.appendChild(label)
    pill.onclick = function () { state.open = !state.open; render() }
    root.appendChild(pill)

    var panel = el('div', 'fc-panel')
    if (state.error) {
      panel.appendChild(el('div', 'fc-empty', state.error))
    } else if (!state.items.length) {
      panel.appendChild(el('div', 'fc-empty', '没有未完成的卡'))
    } else {
      state.items.forEach(function (it) {
        var row = el('div', 'fc-row', it.title || it.id)
        row.title = (it.project || '') + ' · ' + (it.status || '')
        var meta = el('span', 'fc-meta', it.status || '')
        row.appendChild(meta)
        panel.appendChild(row)
      })
    }
    root.appendChild(panel)
  }

  function load() {
    fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error((data && data.error) || '方寸没有回数据')
        state.items = Array.isArray(data.items) ? data.items : []
        state.total = Number(data.total) || state.items.length
        state.error = ''
        render()
      })
      .catch(function (e) {
        state.error = '方寸未连接（' + ((e && e.message) || '未知原因') + '）'
        render()
      })
  }

  function mount() {
    if (document.getElementById(ROOT_ID)) return
    css()
    document.body.appendChild(el('div', '', null))
    var root = document.body.lastChild
    root.id = ROOT_ID
    render()
    load()
    setInterval(load, POLL_MS)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()`
