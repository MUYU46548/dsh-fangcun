/**
 * 发布包里的工具 schema 过**宿主门禁**（2026-11-17）
 *
 * ## 为什么单测不够，非要再验一遍"解包后的东西"
 *
 * 0.6.1 发版时 `npm test` 是绿的、`smoke-packed` 也报了 `tools=4`，
 * 但真正装到 DSH 里，`health.tools.registered` 仍然是 **false** ——
 * 因为漏掉的是**位置**：`required` 数组被写进了 `properties` 里面。
 *
 * 单测看的是源码，冒烟看的是"有没有四个工具"，**两者都不看 schema 合法不合法**。
 * 而用户装的是 tgz，不是源码 —— 所以这里对**解出来的包**再验一次。
 *
 * ## 判据从哪来（关键：跑宿主的真代码，不是照规则重写一遍）
 *
 * 早期版本是"从 app.asar 里把规则抄成一段代码"。**那等于我自己当裁判** ——
 * 抄漏一条就是一次假绿（0.6.1 就是这么过去的）。
 *
 * 现在改成：从已安装 DSH 的 `app.asar` 里把 `@deepseek-ai/*` 整个解到临时目录，
 * 直接 `import` 宿主的 `@deepseek-ai/dsh-tools/lib/types/json-schema.js`，
 * 调它的 **`assertSupportedJsonSchema`**。
 * 宿主怎么判，这里就怎么判 —— 连报错文案都是宿主自己吐的
 * （`schema.properties.required must be a schema object` 与真机 health 逐字一致）。
 *
 * ## 找不到宿主时怎么办
 *
 * 明写 `SKIP` 并**不算通过**。别的机器上没装 DSH 就没法验，这必须说出来，
 * 不能静默变绿 —— 那正是这次踩过的坑。
 *
 * 用法：
 *   node scripts/check-packed-schema.mjs <解包目录>    例：.pkg/package
 *   node scripts/check-packed-schema.mjs              # 默认验工作区 ./lib
 *   FC_HOST_ASAR=<path> node scripts/check-packed-schema.mjs   # 指定 app.asar
 *
 * ⚠ asar 头（实测四组数字推出来的，别再猜）：
 *   u32@0=4  u32@4=头部 pickle 长度  u32@8=含 padding 的 JSON 长度  u32@12=JSON 本身长度
 *   · header JSON 在 16，长度取 u32@12
 *   · 数据区基址 = 8 + u32@4   ← 用 16+u32@12 会差几字节，解出来的文件带别人尾巴
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST_ASAR_CANDIDATES = [
  process.env.FC_HOST_ASAR,
  'C:/Users/muyu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar',
  path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app.asar'),
].filter(Boolean)

function findHostAsar() {
  for (const p of HOST_ASAR_CANDIDATES) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* 下一个 */ }
  }
  return ''
}

/** 从 app.asar 里把 @deepseek-ai/* 解到临时目录，返回 { tmp, jsonSchema } */
function unpackHost(asar) {
  const buf = fs.readFileSync(asar)
  const headerSize = buf.readUInt32LE(12)
  const hdr = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))
  const base = 8 + buf.readUInt32LE(4)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostschema-'))
  const PREFIX = '/dsh/node_modules/@deepseek-ai/'
  let count = 0
  const walk = (node, prefix) => {
    if (node.files) { for (const [k, v] of Object.entries(node.files)) walk(v, prefix + '/' + k); return }
    if (!prefix.startsWith(PREFIX)) return
    const rel = prefix.slice('/dsh/node_modules/'.length)
    const dest = path.join(tmp, 'node_modules', rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const off = base + Number(node.offset)
    fs.writeFileSync(dest, buf.slice(off, off + node.size).toString('utf8'), 'utf8')
    count++
  }
  walk(hdr, '')

  return {
    tmp,
    count,
    jsonSchema: path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js'),
  }
}

const target = process.argv[2] || '.'
const toolPath = path.resolve(target, 'lib', 'tool.js')
if (!fs.existsSync(toolPath)) {
  console.log(`FAIL 找不到 ${toolPath}`)
  process.exit(1)
}

const hostAsar = findHostAsar()
if (!hostAsar) {
  console.log('SKIP 这台机器找不到 DSH 的 app.asar —— 没法用宿主真校验器验。')
  console.log('     SKIP 不算通过：装 DSH 的机器上必须真跑一次。')
  console.log('     指定位置：FC_HOST_ASAR=<...>/app.asar')
  console.log('RESULT SKIP（未验，不是通过）')
  process.exit(0)
}

const { tmp, count, jsonSchema } = unpackHost(hostAsar)
if (!fs.existsSync(jsonSchema)) {
  console.log(`FAIL 宿主包里没有 json-schema.js（解出 ${count} 个文件）`)
  process.exit(1)
}

let failed = false
try {
  const host = await import(pathToFileURL(jsonSchema).href)
  const assertFn = host.assertSupportedJsonSchema
  if (typeof assertFn !== 'function') {
    console.log('FAIL 宿主模块没导出 assertSupportedJsonSchema')
    process.exit(1)
  }

  const { buildTools } = await import(pathToFileURL(toolPath).href)
  const tools = buildTools({ callTool: async () => ({ ok: true }) })
  const defs = Array.isArray(tools) ? tools : Object.values(tools)

  console.log(`== 发布包 schema 过宿主真校验器（${defs.length} 个工具）==`)
  console.log(`   宿主：${hostAsar}`)
  console.log(`   包：  ${toolPath}`)

  for (const d of defs) {
    let ok = true
    const cases = [
      // parameters 原样交给宿主验：宿主 tools.register 不编译它，是直接发给 provider 的
      ['parameters', d.parameters ? d.parameters : null],
      ['output.schema', d.output && d.output.schema],
    ]
    for (const [label, schema] of cases) {
      if (!schema) { console.log(`FAIL  ${d.name}.${label} 缺失`); ok = false; continue }
      try {
        assertFn(schema)
      } catch (e) {
        ok = false
        console.log(`FAIL  ${d.name}.${label}`)
        const v = e && e.violations
        if (Array.isArray(v)) v.slice(0, 6).forEach((x) => console.log(`        · ${x}`))
        else console.log(`        · ${(e && e.message) || e}`)
      }
    }
    if (ok) console.log(`PASS  ${d.name}`)
    else failed = true
  }

  if (failed) {
    console.log('')
    console.log('⚠ 宿主会整批拒注册 → 装上去后模型侧一个方寸工具都没有（health.tools.registered=false）')
    console.log('RESULT 有工具没通过')
  } else {
    console.log('')
    console.log(`RESULT ${defs.length} / 0 —— 宿主全部接受`)
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}

process.exit(failed ? 1 : 0)
