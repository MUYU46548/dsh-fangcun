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
      if (reason === 'disabled') return '派单总闸未启用（默认关）'
      if (reason === 'cooldown') return '冷却中'
      if (reason === 'daily-cap') return '今日已达上限'
      if (reason === 'unsigned') return '文件没有 GUI 签名（agent 手写，已拒）'
      if (reason === 'bad-signature') return '签名不对（文件被改过，已拒）'
      if (reason === 'no-secret') return '插件找不到方寸签名密钥'
      if (reason === 'bad-format') return '派单格式不对'
      if (reason === 'concurrency') return '在途会话已满'
      if (reason === 'open-failed') return '会话没建起来'
      return String(reason || '')
    }

    /**
     * 「上一单实际挂到哪个工具档」的人话（2026-11-25）。
     *
     * 为什么必须显示：`presetResolved` 从 2026-11-24 起就写进 health 了，
     * 但界面一次都没渲染过它 —— 于是"派单成功"在界面上看起来永远一模一样，
     * 而那一单可能只有插件工具、连 read/write/pwsh 都没有。
     * 卡 `948feaa9` 正文点名要治的就是这个：「界面永远显示派单成功」。
     *
     * 三种状态分开说，**不合并、不美化**：
     *   · true  → 说清挂到了哪一档（note 里有 agentPreset=xxx 与来源）
     *   · false → **明说这单没有文件/终端工具**，别让用户以为能干活
     *   · 没这个字段（老插件 / 还没派过单）→ 返回空串，不猜
     */
    function presetLabel(dispatch) {
      if (!dispatch) return ''
      const note = String(dispatch.presetNote || '')
      if (dispatch.presetResolved === true) return note || '已挂上默认工具档'
      if (dispatch.presetResolved === false) {
        return (note ? note + ' —— ' : '') + '⚠ 这一单没有文件/终端工具，只会拿到插件工具'
      }
      return ''
    }

    function Section() {
      const [health, setHealth] = useState(null)
      const [settings, setSettings] = useState(null)
      const [tasks, setTasks] = useState(null)
      const [draft, setDraft] = useState({
        dataDir: '', pipePath: '', project: '',
        dispatchPreset: '',
        dispatchEnabled: false, dispatchCooldownSec: '', dispatchDailyCap: '', dispatchConcurrency: '',
      })
      const [widget, setWidget] = useState(readWidgetState)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const dirty = useRef(false)

      const applySettingsBody = (body) => {
        setSettings(body)
        if (body && body.values && !dirty.current) {
          const d = body.dispatch && body.dispatch.settings ? body.dispatch.settings : null
          setDraft({
            dataDir: body.values.dataDir || '',
            pipePath: body.values.pipePath || '',
            project: body.values.project || '',
            // 2026-11-24（暮雨第 3 条）：派单会话的权限档
            dispatchPreset: (body.dispatchPreset && body.dispatchPreset.configured) || '',
            // 派单四项的真身在 body.dispatch（与方寸设置页同一个文件）
            dispatchEnabled: d ? d.enabled === true : false,
            dispatchCooldownSec: d ? String(d.cooldownSec === undefined ? '' : d.cooldownSec) : '',
            dispatchDailyCap: d ? String(d.dailyCap === undefined ? '' : d.dailyCap) : '',
            dispatchConcurrency: d ? String(d.concurrency === undefined ? '' : d.concurrency) : '',
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
          const d = body.dispatch && body.dispatch.settings ? body.dispatch.settings : null
          setDraft({
            dataDir: body.values.dataDir || '',
            pipePath: body.values.pipePath || '',
            project: body.values.project || '',
            dispatchPreset: (body.dispatchPreset && body.dispatchPreset.configured) || '',
            dispatchEnabled: d ? d.enabled === true : false,
            dispatchCooldownSec: d ? String(d.cooldownSec === undefined ? '' : d.cooldownSec) : '',
            dispatchDailyCap: d ? String(d.dailyCap === undefined ? '' : d.dailyCap) : '',
            dispatchConcurrency: d ? String(d.concurrency === undefined ? '' : d.concurrency) : '',
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
                ? (health.dispatch.settings && health.dispatch.settings.enabled === false ? '未启用 · ' : '')
                  + '今日 ' + (health.dispatch.todayCount || 0) + '/'
                  + (Number(health.dispatch.dailyCap) > 0 ? health.dispatch.dailyCap : '不限')
                  + (health.dispatch.lastReject ? ' · 最近拒绝：' + dispatchReasonLabel(health.dispatch.lastReject) : '')
                : '未知'),
          ),
          // 2026-11-25：**这一单实际挂到哪个工具档** —— 没有这一行，
          // 界面上「派单成功」和「派单成功但空手」长得一模一样。空串 = 不渲染整行（宁缺勿滥）。
          presetLabel(health && health.dispatch)
            ? h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, '工具档'),
              h('span', { style: styles.value }, presetLabel(health.dispatch)),
            )
            : null,
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
          // 2026-11-24（暮雨第 3 条）：「能不能增加一个设置选项，可以让用户更改
          // 派单任务的默认权限（当前默认为工作区内修改）？」
          //
          // 能 —— 权限档就是 Agent 预设档（agentPreset）。所以这里让用户填档名，
          // 而不是去改 DSH 的 Agent 预设本体（暮雨：「DSH的Agent预设太复杂，别去碰它」）。
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '派单权限'),
            h('input', {
              style: styles.input,
              value: draft.dispatchPreset,
              placeholder: '留空 = 跟 DSH 当前默认档（推荐）',
              onChange: (e) => setField('dispatchPreset', e.target.value),
            }),
          ),
          h('div', { style: styles.dim },
            '派单会话用哪个 Agent 预设档 —— 这决定它挂哪些工具（含文件/终端写权限）。'
            + '留空 = 跟 DSH 当前默认档一致；填了就用那一档。'
            + '⚠ DSH 的 Agent 预设本体不会被改动，这里只决定"派单开出来的会话用哪一档"。'),
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
                dispatchPreset: draft.dispatchPreset,
                dispatchEnabled: draft.dispatchEnabled, dispatchCooldownSec: draft.dispatchCooldownSec,
                dispatchDailyCap: draft.dispatchDailyCap, dispatchConcurrency: draft.dispatchConcurrency,
              }) },
            }, busy ? '保存中…' : '保存'),
            h('button', {
              style: styles.button,
              disabled: busy || !writable,
              onClick: () => { void save({
                dataDir: '', pipePath: '', project: '',
                // 派单四项「恢复默认」= 出厂值（关 / 30 秒 / 3 / 1）
                dispatchEnabled: false, dispatchCooldownSec: '30',
                dispatchDailyCap: '3', dispatchConcurrency: '1',
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

        h('div', { style: styles.heading }, '派单'),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '启用派单'),
            h('input', {
              type: 'checkbox',
              checked: draft.dispatchEnabled,
              onChange: (e) => setField('dispatchEnabled', !!e.target.checked),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '冷却（秒）'),
            h('input', {
              style: styles.input,
              value: draft.dispatchCooldownSec,
              placeholder: '默认 30（0 = 不冷却）',
              onChange: (e) => setField('dispatchCooldownSec', e.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '每天最多'),
            h('input', {
              style: styles.input,
              value: draft.dispatchDailyCap,
              placeholder: '默认 3（0 = 不限）',
              onChange: (e) => setField('dispatchDailyCap', e.target.value),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, '同时最多'),
            h('input', {
              style: styles.input,
              value: draft.dispatchConcurrency,
              placeholder: '默认 1（1–100）',
              onChange: (e) => setField('dispatchConcurrency', e.target.value),
            }),
          ),
          h('div', { style: styles.dim },
            '默认关闭：没打开之前，插件拒绝消费任何派单（手写文件也一样）。'
            + '这四项与方寸「设置 → 通用 → DSH 派单」是同一个文件，改完立即生效，不需要重启插件。'),
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

    // `presetLabel` 与 `dispatchReasonLabel` 一起导出，纯粹是为了**能被真跑断言**：
    // 它们决定「这一单到底能不能干活」这句话怎么给人看，
    // 而之前 `presetResolved` 写进 health 却零渲染，正是"写了没接线"。
    // 导出不影响 `inject/apply` 契约（宿主只读这两个键）。
    return { inject: ['slots'], apply, presetLabel, dispatchReasonLabel }
  },
})
