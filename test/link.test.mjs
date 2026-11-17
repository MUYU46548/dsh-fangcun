/**
 * 三件套连通状态（方寸 / DSH / 插件）的测试。
 *
 * 用户 2026-11-17 原话：
 * 「后续方寸内部界面也要调整，加强插件支持（**缺插件提示下插件，缺DSH提示下DSH，
 *   插件本身也能提醒下方寸**）」
 *
 * 这里钉的是**插件看得见的那半边**：方寸装没装、跑没跑。
 * 「DSH 那一环」在插件里没有意义（插件就活在 DSH 进程里），由方寸侧 `dshPlugin.ts` 报 ——
 * 所以合成一句话时必须能指出"这一环是谁报的"，不许混说。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeFangcunLink } from '../lib/index.js'

/** 不存在的用户目录：保证不会被本机真实的方寸安装"污染" */
const BARE_ENV = {
  USERPROFILE: 'C:\\nobody',
  APPDATA: 'C:\\nobody\\AppData',
  LOCALAPPDATA: 'C:\\nobody\\Local',
  ProgramData: 'C:\\nobody\\ProgramData',
  ProgramFiles: 'C:\\nobody\\PF',
  FANGCUN_MCP_PIPE: '\\\\.\\pipe\\fc-absent-zzz',
}

test('① 没装：要给下载页，而不是只说"失败"', () => {
  const r = probeFangcunLink(BARE_ENV, { installed: false })
  assert.equal(r.installed, false)
  assert.equal(r.running, false)
  assert.equal(r.ready, false)
  assert.match(r.hint, /没装方寸/)
  assert.match(r.hint, /github\.com/, '没装必须给下载地址')
})

test('② 装了没跑：要让人"打开方寸"，且明说不用重启 DSH', () => {
  const r = probeFangcunLink(BARE_ENV, { installed: true })
  assert.equal(r.installed, true)
  assert.equal(r.running, false, '管道不存在 = 没在跑')
  assert.equal(r.ready, false)
  assert.match(r.hint, /打开方寸/)
  // 这句是用户最容易被误导的地方：以为要重启 DSH。实际打开方寸就通。
  assert.match(r.hint, /不用重启/)
})

test('③ 装了也在跑：ready=true 且没有多余提示', () => {
  // 用真实存在的路径当"管道"（文件系统层面存在即可，不需要真是管道）
  const r = probeFangcunLink({ ...BARE_ENV, FANGCUN_MCP_PIPE: process.execPath }, { installed: true })
  assert.equal(r.installed, true)
  assert.equal(r.running, true)
  assert.equal(r.ready, true)
  assert.equal(r.hint, '')
})

test('④ 环境变量坏掉也不许抛（只读探测，不能影响主流程）', () => {
  const r = probeFangcunLink({ FANGCUN_MCP_PIPE: '\u0000bad' }, { installed: true })
  assert.equal(typeof r.running, 'boolean')
  assert.equal(typeof r.ready, 'boolean')
  assert.equal(typeof r.hint, 'string')
})

test('⑤ 三件套分工不许混说：插件侧只报方寸那一环', () => {
  // 「缺 DSH 提示装 DSH」是方寸侧的事（services/dshPlugin.ts 里 summary 已覆盖三种状态）。
  // 插件侧若也去判定 DSH 状态，就会出现两处各说各的 —— 那正是"同一个数字三个地方各写各的"。
  const r = probeFangcunLink(BARE_ENV, { installed: true })
  assert.deepEqual(Object.keys(r).sort(), ['hint', 'installed', 'pipePath', 'ready', 'running'])
  // 不许有 dsh 这个"状态字段"（可以提到 DSH，但那只是"不用重启它"的指引）
  assert.equal(r.dsh, undefined, '插件侧不该有 dsh 状态字段')
  assert.equal(r.dshInstalled, undefined)
  // hint 里若提到 DSH，只允许是"不用重启 DSH"这一种指引，不许是"DSH 装没装"的判断
  if (/DSH/i.test(r.hint)) {
    assert.match(r.hint, /不用重启/, 'DSH 只允许以"不用重启"的形式出现')
    assert.ok(!/装没装|未安装/.test(r.hint), '不许在插件侧判 DSH 装没装')
  }
})
