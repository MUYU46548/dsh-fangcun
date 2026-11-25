/**
 * 防腐层边界测试（2026-11-17 用户与梅林、信息哨兵的共识）。
 *
 * ## 为什么要有这条测试
 *
 * 用户拍板："方寸↔DSH 之间收窄成一个适配模块（防腐层）—— 方寸本体不出现任何 DSH 概念和类型，
 * 翻译只发生在这一处。" 收益：
 *   · DSH 停更搬内核 = 换适配层，方寸本体一行不动
 *   · 其他平台支持 = 写第二个适配层，"弱支持"从死路变成明码标价
 *
 * ## 这条测试怎么保证它
 *
 * **不靠纪律，靠 CI**。纪律会忘，CI 不会。规则只有一条：
 *
 *   除 `lib/index.js`（宿主入口，就是适配层本身）与 `lib/compat.js`（体检要读宿主能力）
 *   之外，**任何 lib 文件都不许出现 DSH 概念**。
 *
 * 允许出现的是**方寸协议**：MCP 工具名（`list_tasks` / `move_status`…）、命名管道、
 * JSONL 文件、HTTP 路由 —— 这些换成任何宿主都不变。
 *
 * ⚠ 已知的两个"跨界但合理"的例外，各自在源码里写明理由：
 *   ① `lib/proof.js` 的 `mcp__fangcun__` 前缀 —— **是 DSH 生成的 MCP 工具命名**，
 *      但自证要按名字认工具，绕不开。它被单独隔离成一个常量，且加了插件前缀的并行路径。
 *   ② `lib/prompt.js` / `lib/status.js` 里提到 `systemPrompt` 只在注释/形参名里，
 *      不是真的调宿主 API（本身只收一个 `sp` 对象）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(here, '..', 'lib')

/** 适配层本身 + 体检模块（它就是要读宿主能力，否则没法报缺口） */
const ADAPTER_FILES = new Set(['index.js', 'compat.js'])

/**
 * DSH 概念的**调用形态**（不是提词）。
 * 只匹配真正会绑定到宿主 API 的写法，避免把注释里的说明判成违规。
 */
const DSH_CALL_PATTERNS = [
  // 宿主根上下文 API
  /\broot\s*\.\s*(get|inject|on|effect|logger)\s*\(/,
  /\bctx\s*\.\s*(webServer|systemPrompt|tools|effect|on|get)\b/,
  // 宿主服务名（只在真的当字符串用时才算：get('x') / 已经被上面覆盖）
  /\bwebServer\s*\.\s*register\s*\(/,
  /\bsystemPrompt\s*\.\s*(section|context)\s*\(/,
  /\btools\s*\.\s*register\s*\(/,
  // 宿主事件名
  /['"]webserver\/index-inject['"]/,
  /['"]session\/event['"]/,
  /['"]session\/disposed['"]/,
  // 宿主包
  /from\s+['"]@deepseek-ai\//,
  /require\(\s*['"]@deepseek-ai\//,
]

function libFiles() {
  return fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
}

/** 去掉注释，避免把说明文字误判成真实调用 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '')
  // 行注释：只剥独占一行的与行尾的 //（够用，且不会吃掉 http:// 里的）
  out = out.split('\n').map((line) => {
    const i = line.indexOf('//')
    if (i < 0) return line
    // 不剥字符串里的 //（例如 'https://…'）—— 简单判断：引号数量为偶数才剥
    const before = line.slice(0, i)
    const quotes = (before.match(/['"`]/g) || []).length
    return quotes % 2 === 0 ? before : line
  }).join('\n')
  return out
}

test('① lib/ 里的 DSH 概念只出现在适配层（index.js / compat.js）', () => {
  const offenders = []
  for (const file of libFiles()) {
    if (ADAPTER_FILES.has(file)) continue
    const src = stripComments(fs.readFileSync(path.join(libDir, file), 'utf-8'))
    for (const re of DSH_CALL_PATTERNS) {
      const m = src.match(re)
      if (m) offenders.push(`${file}: 匹配 ${re} → ${JSON.stringify(m[0])}`)
    }
  }
  assert.deepEqual(
    offenders, [],
    '这些文件出现了 DSH 概念，应当收进 lib/index.js（适配层）\n' + offenders.join('\n'),
  )
})

test('② 适配层自己确实存在且是唯一入口', () => {
  // 反向验证：适配层**必须**真有这些调用，否则说明①是"没东西可查"的假绿
  const idx = fs.readFileSync(path.join(libDir, 'index.js'), 'utf-8')
  assert.match(idx, /root\.inject\s*\(/, 'index.js 应当等 webServer')
  assert.match(idx, /root\.on\s*\(/, 'index.js 应当订事件')
  assert.match(idx, /root\.effect\s*\(/, 'index.js 应当用 effect 管生命周期')
  assert.match(idx, /webserver\/index-inject/, '挂件注入行必须在适配层')
  assert.match(idx, /'systemPrompt'/, '提示词服务必须在适配层拿')
  assert.match(idx, /'tools'/, '工具服务必须在适配层拿')
})

test('③ 插件对外只暴露一个 apply（换宿主时改这里，不改业务模块）', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(typeof mod.default.apply, 'function')
  assert.equal(mod.default.name, 'dsh-fangcun')
  // 业务模块不该被宿主直接依赖：它们的导出都是方寸协议侧的纯函数/类
  const tool = await import('../lib/tool.js')
  for (const k of ['buildTools', 'makePipeCallTool', 'shapeTasks', 'shapeCard', 'writeCallOf']) {
    assert.equal(typeof tool[k], 'function', 'tool.js 应当导出 ' + k)
  }
  // tool.js 不许自己碰宿主 tools 服务 —— 它只造定义，注册由适配层做
  const toolSrc = stripComments(fs.readFileSync(path.join(libDir, 'tool.js'), 'utf-8'))
  assert.ok(!/tools\s*\.\s*register\s*\(/.test(toolSrc), 'tool.js 不许自己注册（注册是适配层的事）')
  assert.ok(!/from\s+['"]@deepseek-ai\//.test(toolSrc), 'tool.js 不许 import DSH 包（零依赖）')
})

test('④ 方寸协议侧的模块不认识 DSH（它们是可搬走的部分）', () => {
  // 这些文件是"搬内核时不用动的"：只认 MCP 工具名、管道、JSONL、HTTP。
  const pure = ['mcp-pipe.js', 'usage.js', 'cards.js', 'proof.js', 'tool.js', 'widget.js', 'dispatch.js']
  for (const file of pure) {
    const src = stripComments(fs.readFileSync(path.join(libDir, file), 'utf-8'))
    assert.ok(!/from\s+['"]@deepseek-ai\//.test(src), file + ' 不许 import DSH 包')
    assert.ok(!/\broot\.(get|inject|on|effect)\s*\(/.test(src), file + ' 不许碰宿主根上下文')
  }
})

test('⑤ 零依赖：package.json 没有任何 dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'))
  assert.equal(pkg.dependencies, undefined, '插件必须零依赖（硬边界）')
  assert.equal(pkg.peerDependencies, undefined, '也不许有 peerDependencies —— 那会绑死宿主包版本')
})

/**
 * ⑥ `npm test` 必须点名**每一个** `test/*.test.mjs`。
 *
 * ## 这条为什么必须存在（不是洁癖）
 *
 * 2026-11-24 卡 `948feaa9` 正文写着「插件全量测试 **182 / 0**」。
 * 但 `npm test` 的脚本里只有 14 个文件、实际跑出来是 **170** —— 差的 12 条
 * 就是 `dispatch-preset`（7）与 `dispatch-capability`（5）这两个新文件，
 * 它们**压根没进 npm test**，只有在人工点名时才跑过。
 *
 * 于是「全量绿」和「我手工跑过那两个文件」被写成了同一句话。
 * 这正是这张卡自己要治的病：**判据不可复跑，卡就会撒谎**。
 * 谁下次再加一个测试文件忘了登记，这条当场红 —— 而不是等 20 个会话后靠人发现。
 */
test('⑥ npm test 点名了每一个 test/*.test.mjs（新的测试文件不许漏登记）', () => {
  const root = path.join(here, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
  const cmd = String((pkg.scripts && pkg.scripts.test) || '')
  assert.ok(cmd.includes('--test'), 'npm test 必须走 node --test')

  const listed = new Set(
    (cmd.match(/test\/[\w.-]+\.mjs/g) || []).map((p) => path.basename(p)),
  )
  const onDisk = fs.readdirSync(path.join(root, 'test'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
  const missing = onDisk.filter((f) => !listed.has(f))

  assert.deepEqual(
    missing, [],
    '这些测试文件没被 npm test 点名（`npm test` 不会跑它们，但卡上会写已跑过）：' + missing.join(', '),
  )
  // 反向也钉：点了名却不存在 = 脚本里挂着死路径
  const ghost = [...listed].filter((f) => !onDisk.includes(f)).sort()
  assert.deepEqual(ghost, [], 'npm test 点了不存在的文件：' + ghost.join(', '))
})
