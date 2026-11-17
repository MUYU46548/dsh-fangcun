#!/usr/bin/env node
/**
 * 把 `lib/tool.js` 里**非标准**的 JSON Schema 写法转成宿主认的标准写法。
 *
 * ## 病（2026-11-17 真机抓到）
 *
 * 0.6.0 装上后 `health.tools.registered = false`，错误原文：
 *
 *   unsupported JSON schema: schema.properties.connected.required is not supported
 *   on type "boolean"; …items.items.properties.id.required is not supported on type "string"
 *
 * 因为 `lib/tool.js` 把必填写成了 **属性上的布尔值**：
 *   `connected: { type: 'boolean', required: true }`
 * 而宿主认的是**标准 JSON Schema**：`required` 是父对象上的**字符串数组**：
 *   `{ type: 'object', properties: {...}, required: ['connected', ...] }`
 *
 * 这是两种不同方言（前者是某些校验库的形状），宿主直接拒 —— 于是**四个模型工具全部没注册上**。
 *
 * ⚠ 为什么单测全绿也没抓到：单测只断"定义了 output.schema"，没有把 schema 喂给宿主的校验器。
 *   真正的判据是 `health.tools.registered === true`。
 *
 * ## 做法
 *
 * 用 `node:vm` 真执行一遍源文件里每个 `output.schema` 对象字面量？——不行，那需要整个模块可求值。
 * 所以这里用**文本级、但结构感知**的转换：
 *   ① 找到每个 `required: true`，记住它所在属性的名字；
 *   ② 把它删掉；
 *   ③ 在它所属的 `properties: {` 的**兄弟位置**插入 `required: ['a','b']`。
 *
 * 只处理 `output.schema`（以及它嵌套的 items）—— 那是校验器真正检查的地方。
 * `parameters`（inputSchema）本来就没写 `required: true`，不动。
 *
 * 用法：node scripts/fix-tool-schema.mjs [--dry]
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(import.meta.dirname, '..', 'lib', 'tool.js')
const dry = process.argv.includes('--dry')

let src = fs.readFileSync(FILE, 'utf-8')
const before = src

/**
 * 在一个已知的文本区间里，把 `required: true` 提升为父级数组。
 *
 * 做法：逐行扫，维护属性栈。遇到 `xxx: {` 就压栈；遇到 `}` 就弹栈。
 * 每一层记录：它是不是 `properties:` 的子层、这一层的属性名、以及本层哪些属性是必填。
 */
function hoist(text) {
  const lines = text.split('\n')
  const out = []
  // 栈元素：{ key, isProperties, pending: [必填属性名], indent }
  const stack = []

  const indentOf = (s) => (s.match(/^\s*/) || [''])[0].length

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const trimmed = line.trim()

    // ── 属性声明：`key: {` 或 `key: value,` ──
    const mObj = /^([A-Za-z_$][\w$]*)\s*:\s*\{$/.exec(trimmed)
    const mPropLine = /^properties\s*:\s*\{$/.test(trimmed)
    const mItemInline = /^([A-Za-z_$][\w$]*)\s*:\s*\{\s*(.*?)\s*\},?$/.exec(trimmed)

    if (mPropLine) {
      // properties 块开始：记录它属于哪个对象（把 key 记进父层）
      stack.push({ key: 'properties', isProperties: true, pending: [], indent: indentOf(line) })
      out.push(line)
      continue
    }

    if (mObj) {
      // 新对象开始。它的 key 是父层的一个属性名
      const key = mObj[1]
      const parent = stack[stack.length - 1]
      if (parent && parent.isProperties) {
        // 这个对象是某个 schema 的属性；先记下它的名字（等它闭括号时看它有没有 required:true）
        parent.currentChild = key
      }
      stack.push({ key, isProperties: false, pending: [], indent: indentOf(line), hasRequiredTrue: false })
      out.push(line)
      continue
    }

    // ── 行内属性：`id: { type: 'string', required: true },` ──
    if (mItemInline) {
      const key = mItemInline[1]
      const body = mItemInline[2]
      const parent = stack[stack.length - 1]
      if (/required\s*:\s*true/.test(body)) {
        // 去掉 required: true，把属性名记到父层的 pending
        let cleaned = body
          .replace(/,\s*required\s*:\s*true/, '')
          .replace(/required\s*:\s*true\s*,\s*/, '')
        if (parent && parent.isProperties) parent.pending.push(key)
        const comma = /,\s*$/.test(trimmed) ? ',' : ''
        out.push(line.replace(/^(\s*[A-Za-z_$][\w$]*\s*:\s*\{)\s*.*?(\},?\s*)$/, `$1 ${cleaned} $2`))
        void comma
        continue
      }
      out.push(line)
      continue
    }

    // ── 多行属性里的 `required: true,` 单独一行 ──
    if (/^required\s*:\s*true,?$/.test(trimmed)) {
      const parent = stack[stack.length - 1]
      if (parent) {
        if (parent.isProperties && parent.currentChild) parent.pending.push(parent.currentChild)
        else parent.hasRequiredTrue = true
      }
      continue // 直接吞掉这一行
    }

    // ── 闭括号：`},` 或 `}` ──
    if (/^\},?$/.test(trimmed)) {
      const closing = stack.pop()
      // ⚠ 多行对象（如 `items: { … }`）的必填标记在**它自己里面**（`required: true,` 单独一行），
      //   所以闭括号时要把"我这一层是必填的"回报给**父层**的 pending。
      //   第一版漏了这一步：`items` / `decisions` / `cards` 三个数组型必填项全丢了，
      //   而产物照样成型、照样"转换成功 0 残留" —— 与本次 bug 同一个形态（静默少字段）。
      if (closing && closing.hasRequiredTrue) {
        const parent = stack[stack.length - 1]
        if (parent && parent.isProperties && parent.currentChild) {
          parent.pending.push(parent.currentChild)
        }
      }
      // 如果这一层是 properties 块，并且攒了必填项 → 在闭括号前插入 required 数组
      if (closing && closing.isProperties && closing.pending.length) {
        const ind = ' '.repeat(closing.indent)
        out.push(`${ind}required: ${JSON.stringify(closing.pending)},`)
      }
      out.push(line)
      continue
    }

    out.push(line)
  }
  return out.join('\n')
}

// 只处理 output.schema 区域：从 `output: {` 到它闭合。为简单可靠，
// 这里对**整个文件**做一次提升 —— `parameters` 里没有 `required: true`（已核），
// 所以不会误伤；而如果以后有人写了，那也是该修的同类问题。
src = hoist(src)

if (src === before) {
  console.log('没找到需要转换的 `required: true`（可能已经修过了）')
  process.exit(0)
}

if (dry) {
  const a = before.split('\n'), b = src.split('\n')
  console.log(`--dry：将改动 ${Math.abs(a.length - b.length)} 行的增删（原 ${a.length} 行 → 新 ${b.length} 行）`)
  process.exit(0)
}

fs.writeFileSync(FILE, src, 'utf-8')
const left = (src.match(/required\s*:\s*true/g) || []).length
console.log(`已写入 ${path.relative(process.cwd(), FILE)}；剩余 required: true = ${left}`)
if (left) {
  console.error('⚠ 还有残留 —— 转换器没覆盖到，需要人工看')
  process.exit(1)
}
