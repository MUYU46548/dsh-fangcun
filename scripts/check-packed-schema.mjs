/**
 * 发布包里的工具 schema 过宿主门禁（2026-11-17）
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
 * ## 判据从哪来
 *
 * 抄的是**宿主 app.asar 里 `checkSchemaNode` 的真实规则**，不是自己发明一套：
 *   · 节点只许 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解；
 *   · properties / required / additionalProperties 只许挂 `type:'object'`；
 *   · items 只许挂 `type:'array'`；
 *   · **properties 的每个值必须本身是 schema 对象** —— 塞数组进去就是这条会红。
 *
 * 用法：
 *   node scripts/check-packed-schema.mjs <解包目录>   例：.pkg/package
 *   node scripts/check-packed-schema.mjs             # 默认验工作区 ./lib
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['title', 'description', '$comment', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'])
const ALLOWED_FOR = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}

const isPlainRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function validateSchema(root, rootPath = 'schema') {
  const violations = []
  const stack = [{ node: root, path: rootPath }]
  const seen = new Set()
  while (stack.length) {
    const { node, path: p } = stack.pop()
    if (!isPlainRecord(node)) { violations.push(`${p} must be a schema object`); continue }
    if (seen.has(node)) { violations.push(`${p} is circular`); continue }
    seen.add(node)
    for (const key of Object.keys(node)) {
      if (!CONSTRAINT.has(key) && !ANNOTATION.has(key)) violations.push(`${p}.${key} is not a supported keyword`)
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) { violations.push(`${p} cannot declare both type and oneOf`); continue }
    if (!hasType) { violations.push(`${p} requires type`); continue }
    if (hasOneOf) continue
    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(`${p}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      continue
    }
    for (const [key, types] of Object.entries(ALLOWED_FOR)) {
      if (Object.hasOwn(node, key) && !types.includes(type)) {
        violations.push(`${p}.${key} is not supported on type "${type}"`)
      }
    }
    if (type === 'object') {
      if (Object.hasOwn(node, 'required')) {
        const req = node.required
        if (!Array.isArray(req) || !req.every((x) => typeof x === 'string')) {
          violations.push(`${p}.required must be an array of strings`)
        } else if (Object.hasOwn(node, 'properties') && isPlainRecord(node.properties)) {
          for (const name of req) {
            if (!Object.hasOwn(node.properties, name)) violations.push(`${p}.required 要求了不存在的字段 "${name}"`)
          }
        }
      }
      if (Object.hasOwn(node, 'properties')) {
        if (!isPlainRecord(node.properties)) {
          violations.push(`${p}.properties must be an object of schemas`)
        } else {
          for (const [name, child] of Object.entries(node.properties)) {
            if (!isPlainRecord(child)) {
              violations.push(`${p}.properties.${name} must be a schema object（实际是 ${Array.isArray(child) ? 'array' : typeof child}）`)
            } else {
              stack.push({ node: child, path: `${p}.properties.${name}` })
            }
          }
        }
      }
    } else if (type === 'array' && Object.hasOwn(node, 'items')) {
      stack.push({ node: node.items, path: `${p}.items` })
    }
  }
  return violations
}

const target = process.argv[2] || '.'
const toolPath = path.resolve(target, 'lib', 'tool.js')
if (!fs.existsSync(toolPath)) {
  console.log(`FAIL 找不到 ${toolPath}`)
  process.exit(1)
}

const { buildTools } = await import(pathToFileURL(toolPath).href)
const tools = buildTools({ callTool: async () => ({ ok: true }) })
const defs = Array.isArray(tools) ? tools : Object.values(tools)

console.log(`== 发布包 schema 过宿主门禁（${toolPath}）==`)
let bad = 0
for (const d of defs) {
  const vs = []
  // parameters 是"字段名→schema"的记录，不是完整 schema，包一层再验
  if (d.parameters) vs.push(...validateSchema({ type: 'object', properties: d.parameters, required: [] }, `${d.name}.parameters`))
  if (d.output && d.output.schema) vs.push(...validateSchema(d.output.schema, `${d.name}.output.schema`))
  else vs.push(`${d.name}.output.schema 缺失`)
  if (vs.length === 0) console.log(`PASS  ${d.name}`)
  else { bad++; console.log(`FAIL  ${d.name}`); vs.forEach((v) => console.log(`        · ${v}`)) }
}

if (bad) {
  console.log('')
  console.log('⚠ 宿主会整批拒注册 → 装上去后模型侧一个方寸工具都没有（health.tools.registered=false）')
  console.log(`RESULT ${defs.length - bad} / ${bad}`)
  process.exit(1)
}
console.log('')
console.log(`RESULT ${defs.length} / 0 —— 全部能过宿主门禁`)
