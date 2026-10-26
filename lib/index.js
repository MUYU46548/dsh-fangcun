/**
 * fangcun-dsh —— 方寸 × DSH 插件（宿主侧）
 *
 * ⚠ 现状（2026-10-26）：**只做了"能装、能自报状态"这一步**。
 *   真正值钱的那两件（会话结束把用量报回方寸、待办速览挂件）还没写，
 *   因为它们的钩子依赖 DSH 的会话事件与注入 API —— 见 README「还没做」。
 *   这个文件刻意**不假装已经做完**：`/fangcun/health.json` 里有一栏 `todo`
 *   直接写着哪些还没实现，装上去就能看见。
 *
 * 三条边界（越界即错，和方寸本体的契约一致）：
 *  ① **不许 import 方寸的代码**。插件与方寸之间只走对外接口：
 *     命名管道 MCP（Windows `\\.\pipe\tegula-mcp`）、`tegula` CLI、数据目录里的文件。
 *     这条是"能独立拆仓"的前提 —— 一旦 import 了方寸的 TS，两个仓就锁死了。
 *  ② **只读方寸数据**。写方寸要走 MCP 工具（有人在后面把关），不直接改 task-data。
 *  ③ **不改 DSH 自己的配置**。插件只声明自己的路由，不去 patch 别人的 bundle。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 package.json 的 version 必须一致（`e2e-dsh-plugin.cjs` 会比，防漂移） */
export const PLUGIN_NAME = 'fangcun-dsh'
export const PLUGIN_VERSION = '0.1.0'

/** 方寸 MCP 的命名管道名（与方寸 `main/mcp/pipe.ts` 同一口径） */
const MCP_PIPE_BASENAME = 'tegula-mcp'

/**
 * 找方寸数据根。三处来源，按可靠度排：
 *  ① 环境变量 `FANGCUN_DATA_DIR`（多机/便携部署时唯一可靠的方式）
 *  ② `%APPDATA%/方寸/data-dir.json`（方寸桌面版自己记的，产品名是中文）
 *  ③ `%APPDATA%/Fangcun/data-dir.json`（旧名字，留着兼容）
 * ⚠ 认不出来就返回 null —— **不猜一个路径**。猜错会让插件对着空目录报"一切正常"。
 */
export function resolveDataDir(env = process.env) {
  const fromEnv = String(env.FANGCUN_DATA_DIR || '').trim()
  if (fromEnv) return { dir: fromEnv, source: 'env' }

  const appData = String(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  for (const appName of ['方寸', 'Fangcun', 'fangcun-desktop']) {
    const p = path.join(appData, appName, 'data-dir.json')
    try {
      if (!fs.existsSync(p)) continue
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const dir = String(raw?.dir || '').trim()
      if (dir) return { dir, source: 'appdata:' + appName }
    } catch { /* 坏文件当没有，继续找下一处 */ }
  }
  return { dir: null, source: 'none' }
}

/** 只看"文件在不在"，不解析内容 —— 判数字要留给方寸自己（插件不重复实现解析） */
export function collectHealth(env = process.env) {
  const { dir, source } = resolveDataDir(env)
  const has = (rel) => {
    if (!dir) return false
    try { return fs.existsSync(path.join(dir, rel)) } catch { return false }
  }
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${MCP_PIPE_BASENAME}`
    : path.join(os.tmpdir(), MCP_PIPE_BASENAME + '.sock')

  return {
    ok: true,
    plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    fangcun: {
      dataDir: dir || '',
      // 这个来源字段很重要：远程/多机排查时，"从哪读到的"比"读到了什么"更关键
      source,
      found: {
        registry: has('registry.yaml'),
        taskData: has('task-data'),
        policies: has('policies'),
      },
      mcpPipe: pipePath,
      mcpPipeNote: '管道存在与否要在运行时探活；这里只给出路径（探活属于 MCP 客户端的事）',
    },
    // 诚实清单：装上去就能看见"哪些还没做"，而不是让用户以为功能都齐了
    todo: [
      '会话结束把本次 token/金额经 MCP usage_report 报回方寸（需要 DSH 会话事件钩子）',
      '待办速览挂件（需要 webserver/index-inject 注入一段前端脚本）',
      '装/更新自检（npm latest 对比，照 DSH 现有插件的 /update-check.json 形态）',
    ],
  }
}

function healthHandler(_req, res) {
  try {
    const body = JSON.stringify(collectHealth(), null, 2)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    // 本机插件，不对外；仍然只给只读事实
    res.end(body)
  } catch (e) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
  }
}

/**
 * 路由清单单独提出来，既方便宿主注册，也方便测试直接调 handler 验返回。
 *
 * ⚠ 路由对象的字段名是按 DSH 现有插件的用法写的（`{ path, handler }`）。
 *   如果宿主的 schema 认 `route` 而不是 `path`，改这一处即可 ——
 *   这一条**还没有在真 DSH 上跑过**，第一次装的时候要现场确认（README 里也写了）。
 */
export const ROUTES = [
  { method: 'GET', path: '/fangcun/health.json', handler: healthHandler },
]

export default {
  name: PLUGIN_NAME,
  apply(root) {
    // 等宿主把 webServer 备好再注册；不写对象级 inject，避免"整插件被挡住"
    root.inject(['webServer'], (ctx) => {
      for (const r of ROUTES) {
        ctx.webServer.register(r)
      }
    })
  },
}
