/**
 * dsh-fangcun —— client half（DSH 设置里的「方寸」一节）。
 *
 * 为什么需要它：DSH 0.2 线的内置 Settings 只自动渲染插件 `Config` 里的 volatile 字段，
 * 而 `Config` 要 `@deepseek-ai/schemastery`；本仓零依赖，不能引。第三方插件的实际做法
 * （已装的 `dsh-keep-awake` 就是这样）是自带一个 client 模块，注册 `settings.section`。
 *
 * 这一节做三件事：
 *  ① 把方寸当前状态说人话（装没装 / 连没连 / 数据根从哪来 / 管道 / 在办与待拍板）；
 *  ② 编辑三项宿主设置：数据根、管道、项目范围（走 `/fangcun/api/settings`，
 *     宿主用 `configEditor` 写 profile patch，保存后插件重启一次生效）；
 *  ③ 挂件开关 / 四角摆位（写 localStorage + 调挂件暴露的 `window.__fcTodoWidget`），
 *     点完立刻作用到页面上的挂件，不用刷新。
 *
 * ⚠ 这是浏览器侧代码：不 import、不使用 Node API；React 从模块加载器的 require 取。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fangcun',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const HEALTH = '/fangcun/health.json'
    const SETTINGS = '/fangcun/api/settings'
    const TASKS = '/fangcun/api/tasks'
    const REFRESH_MS = 10_000
    const LS = {
      hidden: 'fc-todo-widget:hidden',
      corner: 'fc-todo-widget:corner',
      pos: 'fc-todo-widget:pos',
    }
    const CORNERS = [
      { id: 'tr', label: '右上' },
      { id: 'br', label: '右下' },
      { id: 'bl', label: '左下' },
      { id: 'tl', label: '左上' },
    ]

    const styles = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      heading: { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.7 },
      row: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 },
      label: { flex: '0 0 84px', color: 'var(--dsw-alias-label-secondary)' },
      value: { flex: 1, wordBreak: 'break-all' },
      dim: { opacity: 0.65, fontSize: 12 },
      error: { color: 'var(--dsw-state-error-primary)', fontSize: 12, whiteSpace: 'pre-wrap' },
      ok: { color: 'var(--dsw-state-success-primary)', fontSize: 12 },
      input: {
        flex: 1,
        minWidth: 0,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        padding: '4px 8px',
        font: 'inherit',
      },
      button: {
        minHeight: 30,
        padding: '0 12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 15,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
      },
      buttonOn: {
        borderColor: 'var(--dsw-alias-label-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
      },
      badge: {
        display: 'inline-block',
        padding: '1px 9px',
        borderRadius: 999,
        fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        whiteSpace: 'nowrap',
      },
      badgeOn: { color: 'var(--dsw-state-success-primary)' },
      badgeOff: { color: 'var(--dsw-state-warn-label)' },
      badgeErr: { color: 'var(--dsw-state-error-primary)' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 },
    }

    function readLS(key) {
      try { return window.localStorage.getItem(key) } catch { return null }
    }
    function writeLS(key, value) {
      try { window.localStorage.setItem(key, value) } catch { /* 隐私模式：记不住就记不住 */ }
    }
    function removeLS(key) {
      try { window.localStorage.removeItem(key) } catch { /* ignore */ }
    }

    function readWidgetState() {
      const api = typeof window !== 'undefined' ? window.__fcTodoWidget : null
      let snapshot = null
      try { snapshot = api && typeof api.snapshot === 'function' ? api.snapshot() : null } catch { snapshot = null }
      return {
        hidden: snapshot ? Boolean(snapshot.hidden) : readLS(LS.hidden) === '1',
        corner: (snapshot && snapshot.corner) || readLS(LS.corner) || 'tr',
        pos: (snapshot && snapshot.pos) || null,
        locked: snapshot ? Boolean(snapshot.locked) : readLS(LS.corner) !== null,
        available: Boolean(api),
      }
    }

    async function getJson(url) {
      const response = await fetch(url, { cache: 'no-store' })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body || body.ok !== true) {
        throw new Error((body && body.error) || ('HTTP ' + response.status))
      }
      return body
    }

    async function putSettings(patch) {
      const response = await fetch(SETTINGS, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body || body.ok !== true) {
        throw new Error((body && body.error) || ('HTTP ' + response.status))
      }
      return body
    }

    function sourceLabel(source) {
      if (source === 'config') return '设置页'
      if (source === 'env') return '环境变量'
      if (source && source.startsWith('appdata:')) return '方寸自动探测'
      return '没找到'
    }

    function dispatchReasonLabel(reason) {
      if (reason === 'cooldown') return '冷却中（10 分钟内不重复）'
      if (reason === 'daily-cap') return '今日已达上限（2 次）'
      if (reason === 'unsigned') return '文件没有 GUI 签名（agent 手写，已拒）'
      if (reason === 'bad-signature') return '签名不对（文件被改过，已拒）'
      if (reason === 'no-secret') return '插件找不到方寸签名密钥'
      if (reason === 'bad-format') return '派单格式不对'
      if (reason === 'open-failed') return '会话没建起来'
      return String(reason || '')
    }

    function Section() {
      const [health, setHealth] = useState(null)
      const [settings, setSettings] = useState(null)
      const [tasks, setTasks] = useState(null)
      const [draft, setDraft] = useState({
        dataDir: '', pipePath: '', project: '', dispatchDailyCap: '', dispatchCooldownMin: '', dispatchConcurrency: '',
      })
      const [widget, setWidget] = useState(readWidgetState)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const dirty = useRef(false)

      const applySettingsBody = (body) => {
        setSettings(body)
        if (body && body.values && !dirty.current) {
          setDraft({
            dataDir: body.values.dataDir || '',
            pipePath: body.values.pipePath || '',
            project: body.values.project || '',
            dispatchDailyCap: body.values.dispatchDailyCap || '',
            dispatchCooldownMin: body.values.dispatchCooldownMin || '',
            dispatchConcurrency: body.values.dispatchConcurrency || '',
          })
        }
        if (body && body.boardUrl) {
          setHealth((prev) => ({ ...(prev || {}), boardUrl: body.boardUrl }))
        }
      }

      const refresh = async () => {
        const next = {}
        try { next.health = await getJson(HEALTH) } catch (e) { next.healthError = String(e.message || e) }
        try { next.settings = await getJson(SETTINGS) } catch (e) { next.settingsError = String(e.message || e) }
        try { next.tasks = await getJson(TASKS) } catch (e) { next.tasksError = String(e.message || e) }
        if (next.health) setHealth((prev) => ({ ...next.health, boardUrl: (prev && prev.boardUrl) || next.health.boardUrl || '' }))
        if (next.settings) applySettingsBody(next.settings)
        if (next.tasks) setTasks(next.tasks)
        const firstError = next.healthError || next.settingsError || ''
        if (firstError) setError(firstError)
        else setError('')
      }

      useEffect(() => {
        let alive = true
        const tick = async () => {
          await refresh()
          if (!alive) return
        }
        void tick()
        const timer = setInterval(() => { void tick() }, REFRESH_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const setField = (key, value) => {
        dirty.current = true
        setDraft((prev) => ({ ...prev, [key]: value }))
        setNotice('')
      }

      const save = async (patch) => {
        setBusy(true)
        setNotice('')
        setError('')
        try {
          const body = await putSettings(patch)
          dirty.current = false
          setDraft({
            dataDir: body.values.dataDir || '',
            pipePath: body.values.pipePath || '',
            project: body.values.project || '',
            dispatchDailyCap: body.values.dispatchDailyCap || '',
            dispatchCooldownMin: body.values.dispatchCooldownMin || '',
            dispatchConcurrency: body.values.dispatchConcurrency || '',
          })
          setNotice(body.message || '已保存')
          applySettingsBody({ ...body, boardUrl: settings && settings.boardUrl })
          setTimeout(() => { void refresh() }, 1200)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const setWidgetHidden = (hidden) => {
        writeLS(LS.hidden, hidden ? '1' : '0')
        const api = window.__fcTodoWidget
        if (api && typeof api.setHidden === 'function') {
          try { api.setHidden(hidden) } catch { /* 挂件不在也把设置记住 */ }
        } else if (api && typeof api.applySettings === 'function') {
          try { api.applySettings() } catch { /* ignore */ }
        }
        setWidget((prev) => ({ ...prev, hidden }))
      }

      const setWidgetCorner = (corner) => {
        writeLS(LS.corner, corner)
        removeLS(LS.pos)
        const api = window.__fcTodoWidget
        if (api && typeof api.setCorner === 'function') {
          try { api.setCorner(corner) } catch { /* ignore */ }
        } else if (api && typeof api.applySettings === 'function') {
          try { api.applySettings() } catch { /* ignore */ }
        }
        setWidget((prev) => ({ ...prev, corner, pos: null }))
      }

      const link = health && health.link ? health.link : null
      const installed = Boolean(link && link.installed)
      const ready = Boolean(link && link.ready)
      const badgeText = !health
        ? '读取中'
        : installed === false
          ? '方寸未安装'
          : ready ? '已连接' : '未连接'
      const badgeStyle = !health
        ? styles.badge
        : installed === false
          ? { ...styles.badge, ...styles.badgeErr }
          : ready ? { ...styles.badge, ...styles.badgeOn } : { ...styles.badge, ...styles.badgeOff }
      const dataDir = settings && settings.effective ? settings.effective.dataDir : ''
      const dataDirSource = settings && settings.effective ? settings.effective.dataDirSource : ''
      const pipePath = settings && settings.effective ? settings.effective.pipePath : ''
      const project = settings && settings.effective ? settings.effective.project : ''
      const counts = tasks && tasks.counts ? tasks.counts : { doing: 0, waiting: 0 }
      const boardUrl = (settings && settings.boardUrl) || (health && health.boardUrl) || ''
      const writable = Boolean(settings && settings.writable)

      return h(
        'div',
        { style: styles.panel },
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('strong', null, '方寸'),
            h('span', { style: badgeStyle }, badgeText),
            h('span', { style: { ...styles.dim, marginLeft: 'auto' } },
              health && health.plugin ? 'v' + health.plugin.version : ''),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '数据根'),
            h('span', { style: styles.value },
              dataDir || '（自动探测）',
              dataDirSource ? h('span', { style: styles.dim }, '  · ' + sourceLabel(dataDirSource)) : null),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '管道'),
            h('span', { style: styles.value }, pipePath || '（默认）'),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '项目范围'),
            h('span', { style: styles.value }, project || '全部项目'),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '未完成'),
            h('span', { style: styles.value },
              tasks ? `${tasks.total} 张 · 在办 ${counts.doing} · 待拍板 ${counts.waiting}` : '读取中'),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '模型工具'),
            h('span', { style: styles.value },
              health && health.tools && health.tools.registered
                ? (health.tools.names || []).length + ' 个已注册'
                : '未注册'),
          ),
          // 2026-11-20：派单自证 —— 为什么没开会话（冷却/日上限/没签名）要看得见
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '派单'),
            h('span', { style: styles.value },
              health && health.dispatch
                ? (health.dispatch.secretFound === false ? '签名密钥未找到 · ' : '')
                  + '今日 ' + (health.dispatch.todayCount || 0) + '/' + (health.dispatch.dailyCap || 2)
                  + (health.dispatch.lastReject ? ' · 最近拒绝：' + dispatchReasonLabel(health.dispatch.lastReject) : '')
                : '未知'),
          ),
          link && link.hint ? h('div', { style: styles.dim }, link.hint) : null,
          boardUrl
            ? h(
              'div',
              { style: styles.actions },
              h('button', {
                style: styles.button,
                onClick: () => { try { window.open(boardUrl, '_blank', 'noopener') } catch { /* ignore */ } },
              }, '打开看板'),
            )
            : null,
        ),

        h('div', { style: styles.heading }, '连接设置'),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '数据根'),
            h('input', {
              style: styles.input,
              value: draft.dataDir,
              placeholder: '留空 = 自动探测（推荐）',
              onChange: (e) => setField('dataDir', e.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '管道'),
            h('input', {
              style: styles.input,
              value: draft.pipePath,
              placeholder: '留空 = \\\\.\\pipe\\tegula-mcp',
              onChange: (e) => setField('pipePath', e.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '项目范围'),
            h('input', {
              style: styles.input,
              value: draft.project,
              placeholder: '留空 = 全部项目',
              onChange: (e) => setField('project', e.target.value),
            }),
          ),
          h('div', { style: styles.dim }, writable
            ? '保存后写进 DSH profile，插件会重启一次让新配置生效。'
            : (settings && settings.error) || '设置不可写（宿主没有 configEditor 服务）。'),
          h(
            'div',
            { style: styles.actions },
            h('button', {
              style: styles.button,
              disabled: busy || !writable,
              onClick: () => { void save({
                dataDir: draft.dataDir, pipePath: draft.pipePath, project: draft.project,
                dispatchDailyCap: draft.dispatchDailyCap, dispatchCooldownMin: draft.dispatchCooldownMin,
                dispatchConcurrency: draft.dispatchConcurrency,
              }) },
            }, busy ? '保存中…' : '保存'),
            h('button', {
              style: styles.button,
              disabled: busy || !writable,
              onClick: () => { void save({
                dataDir: '', pipePath: '', project: '',
                dispatchDailyCap: '', dispatchCooldownMin: '', dispatchConcurrency: '',
              }) },
            }, '恢复默认'),
            h('button', {
              style: styles.button,
              disabled: busy,
              onClick: () => { void refresh() },
            }, '刷新'),
          ),
          notice ? h('div', { style: styles.ok }, notice) : null,
          error ? h('div', { style: styles.error }, error) : null,
        ),

        h('div', { style: styles.heading }, '派单限流'),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '同时最多'),
            h('input', {
              style: styles.input,
              value: draft.dispatchConcurrency,
              placeholder: '默认 10（1–100）',
              onChange: (e) => setField('dispatchConcurrency', e.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '每天最多'),
            h('input', {
              style: styles.input,
              value: draft.dispatchDailyCap,
              placeholder: '默认 0 = 不限',
              onChange: (e) => setField('dispatchDailyCap', e.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '冷却（分钟）'),
            h('input', {
              style: styles.input,
              value: draft.dispatchCooldownMin,
              placeholder: '默认 0 = 不冷却',
              onChange: (e) => setField('dispatchCooldownMin', e.target.value),
            }),
          ),
          h('div', { style: styles.dim }, '默认同一时间 10 个、不冷却、每日不限；改完点上面的「保存」，插件重启后生效。'),
        ),

        h('div', { style: styles.heading }, '挂件'),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '显示挂件'),
            h('input', {
              type: 'checkbox',
              checked: !widget.hidden,
              onChange: (e) => setWidgetHidden(!e.target.checked),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '位置'),
            h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              ...CORNERS.map((c) => h('button', {
                key: c.id,
                style: !widget.pos && widget.corner === c.id ? { ...styles.button, ...styles.buttonOn } : styles.button,
                onClick: () => setWidgetCorner(c.id),
              }, c.label)),
            ),
          ),
          widget.pos
            ? h('div', { style: styles.dim }, `当前是自由摆放（${widget.pos.x}, ${widget.pos.y}）—— 点任一四角即可回到角上。`)
            : null,
          h('div', { style: styles.dim }, widget.available
            ? '挂件在页面上，改动立刻生效。'
            : '挂件还没挂上（或这一页不是 DSH 页面）；改动已记下，挂件下次出现时生效。'),
        ),
      )
    }

    function report(event) {
      // 页面侧自证：和挂件共用同一个只读信标入口。客户端半到底有没有在这个页面里跑起来，
      // health.widget.page.events 里会出现 client-apply / client-section 两行 —— 不靠人眼猜。
      try {
        const url = '/fangcun/api/widget-report?e=' + encodeURIComponent(event) + '&t=' + Date.now()
        void fetch(url, { cache: 'no-store' }).catch(() => {})
      } catch { /* 自证坏了不能连累设置页 */ }
    }

    function apply(ctx) {
      report('client-apply')
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => {
        const off = slots.register({
          name: 'settings.section',
          id: 'dsh-fangcun',
          order: 170,
          label: () => '方寸',
        }, Section)
        report('client-section')
        return off
      })
    }

    return { inject: ['slots'], apply }
  },
})
