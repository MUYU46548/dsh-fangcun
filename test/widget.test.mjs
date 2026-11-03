/**
 * 待办挂件的契约测试（无 DSH、无浏览器）
 *
 * 钉住三件事：
 *  ① 注入行走 `webserver/index-inject`、类型必须是内联 `script`（**不许 `script-src`**，
 *     那个加载失败会把整个应用带下水），且重复调用不重复推；
 *  ② 挂件脚本与只读接口都是同源 GET；非本机来源一律 403；
 *  ③ 接口的数据来自方寸 MCP `list_tasks`，且**空状态算未完成**（没填 ≠ 做完）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import * as mod from '../lib/index.js'

function fakeRoot() {
  const listeners = []
  const root = {
    on(name, fn) { listeners.push([name, fn]); return () => {} },
    effect(fn) { fn() },
    inject(_list, cb) {
      cb({
        webServer: { register: () => () => {} },
        effect: (fn) => { fn() },
      })
    },
  }
  return { root, listeners }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(s) { this.body = String(s) },
  }
  return res
}

const uniquePipe = () => `\\\\.\\pipe\\dsh-fangcun-widget-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`

test('① 注入行：内联 script、指向自己的脚本、重复推只留一行', () => {
  const { root, listeners } = fakeRoot()
  mod.default.apply(root)
  const entry = listeners.find(([name]) => name === 'webserver/index-inject')
  assert.ok(entry, '必须订阅 webserver/index-inject')

  const table = []
  entry[1](table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.match(table[0].text, /\/fangcun\/widget\.js/)
  assert.doesNotMatch(table[0].text, /script-src/, '绝不能用 script-src（加载失败会带走整个应用）')

  entry[1](table) // 宿主可能多次收集
  assert.equal(table.length, 1, '重复推会重复加载脚本')
})

test('② 挂件脚本：GET 返回 JS，非 GET 405', async () => {
  const route = mod.ROUTES.find((r) => r.path === '/fangcun/widget.js')
  assert.ok(route, '必须注册 /fangcun/widget.js')

  const res = fakeRes()
  route.handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /javascript/)
  assert.match(res.body, /fc-todo-widget/)
  assert.match(res.body, /\/fangcun\/api\/tasks/)

  const bad = fakeRes()
  route.handler({ method: 'POST' }, bad)
  assert.equal(bad.statusCode, 405)
})

/**
 * ②b 真机验收 ② 的证据：health 要能分开"行没进表"和"进了表但页面没跑"。
 * 这两个故障在真机上长得一模一样（都是"页面没角标"），分诊表里最难分的一格。
 * 判别方法是请求头：浏览器从页面加载脚本会带 sec-fetch-dest / referer，curl 不会。
 */
test('②b health 暴露注入证据链，且 curl 不会被误算成页面加载', () => {
  const { root, listeners } = fakeRoot()
  mod.default.apply(root)

  const entry = listeners.find(([name]) => name === 'webserver/index-inject')
  entry[1]([]) // 宿主来收集一次

  const route = mod.ROUTES.find((r) => r.path === '/fangcun/widget.js')
  // 探针 / curl：没有 sec-fetch-* 与 referer
  route.handler({ method: 'GET', headers: {} }, fakeRes())
  const before = mod.collectHealth().widget
  assert.ok(before.pushed >= 1, '行必须进过表')
  assert.equal(before.servedByPage, 0, 'curl 不算页面加载')

  // 真浏览器从页面里加载：带 sec-fetch-dest=script
  const res = fakeRes()
  route.handler({ method: 'GET', headers: { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' } }, res)
  assert.equal(res.statusCode, 200)
  const after = mod.collectHealth().widget
  assert.equal(after.servedByPage, 1, '带 sec-fetch-dest 的才算页面真的执行了')
  assert.ok(after.lastServedAt, '要记下最后一次时间')
})

test('③ 只读接口：非本机来源 403', async () => {
  const route = mod.ROUTES.find((r) => r.path === '/fangcun/api/tasks')
  const res = fakeRes()
  await route.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.8' } }, res)
  assert.equal(res.statusCode, 403)
  assert.match(res.body, /本机/)
})

test('④ 只读接口：经 MCP list_tasks 取数；完成/驳回不算未完成，空状态算', async () => {
  const pipePath = uniquePipe()
  const server = net.createServer((socket) => {
    let buf = ''
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const req = JSON.parse(line)
        if (req.id === undefined) continue
        const reply = (result) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
        if (req.method === 'initialize') {
          reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fangcun', version: 'test' } })
        } else if (req.method === 'tools/call') {
          const tasks = [
            { id: 't1', title: '要做的', status: '待办', project: ['fangcun-base'] },
            { id: 't2', title: '在做', status: '进行中', project: 'fangcun-base' },
            { id: 't3', title: '做完了', status: '完成', project: [] },
            { id: 't4', title: '被打回', status: '驳回', project: [] },
            { id: 't5', title: '没填状态', status: '', project: [] },
          ]
          reply({ content: [{ type: 'text', text: JSON.stringify(tasks) }] })
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(pipePath, resolve))

  const prev = process.env.FANGCUN_MCP_PIPE
  process.env.FANGCUN_MCP_PIPE = pipePath
  try {
    const route = mod.ROUTES.find((r) => r.path === '/fangcun/api/tasks')
    const res = fakeRes()
    await route.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.total, 3, '待办/进行中/空状态 = 3，完成与驳回不算')
    const ids = body.items.map((i) => i.id).sort()
    assert.deepEqual(ids, ['t1', 't2', 't5'])
    assert.equal(body.items.find((i) => i.id === 't1').project, 'fangcun-base')
  } finally {
    if (prev === undefined) delete process.env.FANGCUN_MCP_PIPE
    else process.env.FANGCUN_MCP_PIPE = prev
    server.close()
  }
})
