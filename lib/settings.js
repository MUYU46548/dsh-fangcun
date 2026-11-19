/**
 * 插件设置（数据根 / 管道 / 项目范围）的**纯校验与归一**。
 *
 * 为什么不是 `Config`（schemastery）：本仓硬边界是**零依赖**（`layering ⑤` 连
 * `peerDependencies` 都禁止）。DSH 的内置 Settings 只会自动渲染 volatile 的 `Config`
 * 字段，而第三方插件（如 `dsh-keep-awake`）实际都是自带 client 半 + 设置页；
 * 配置本身走 Loader 行的原始 config（`configEditor.edit`），不需要 schemastery。
 *
 * 三条原则：
 *  ① **空字符串 = 清掉覆盖**（回到环境变量 / 自动探测），不是"设成空路径"；
 *  ② **脏值不写**：相对路径、换行、Windows 上不是 `\\.\pipe\` 的管道，一律拒绝并说人话；
 *  ③ 这个文件不认识 DSH、不认识方寸，只认"三个字符串字段"——可搬走。
 */
import path from 'node:path'

/** 设置的三个字段与长度上限（超长直接拒，不截断 —— 截断会把路径悄悄改错） */
export const SETTINGS_FIELDS = {
  dataDir: 2048,
  pipePath: 512,
  project: 200,
}

export const SETTINGS_KEYS = Object.keys(SETTINGS_FIELDS)

/** Windows 命名管道前缀（与 `lib/index.js` 的 `mcpPipePath()` 同一口径） */
const WIN_PIPE_PREFIX = '\\\\.\\pipe\\'

function asString(value) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return null
  return value.trim()
}

/**
 * 把 Loader 行里的原始 config 归一成三个字符串。
 * 认不出的键直接忽略 —— 这里只负责"读的时候别炸"，严格校验在 `validateSettingsPatch`。
 */
export function normalizeSettings(raw) {
  const out = { dataDir: '', pipePath: '', project: '' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of SETTINGS_KEYS) {
    const v = asString(raw[key])
    if (v !== null) out[key] = v.slice(0, SETTINGS_FIELDS[key])
  }
  return out
}

/**
 * 校验一份**局部**设置（只含用户这次要改的键）。
 *
 * @param {unknown} input
 * @param {{platform?: string}} [options] 平台可注入，测试用
 * @returns {{ok: true, patch: Record<string, string>} | {ok: false, error: string}}
 */
export function validateSettingsPatch(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '设置必须是一个 JSON 对象' }
  }
  const keys = Object.keys(input)
  if (keys.length === 0) return { ok: false, error: '没有要保存的设置' }

  const platform = String(options.platform || process.platform)
  const patch = {}
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_FIELDS, key)) {
      return { ok: false, error: '不认识的设置项：' + key }
    }
    const raw = input[key]
    const value = asString(raw)
    if (value === null) {
      return { ok: false, error: '设置项 ' + key + ' 必须是字符串（留空表示清除）' }
    }
    if (value.length > SETTINGS_FIELDS[key]) {
      return { ok: false, error: '设置项 ' + key + ' 太长（上限 ' + SETTINGS_FIELDS[key] + ' 字符）' }
    }
    if (/[\u0000\r\n]/.test(value)) {
      return { ok: false, error: '设置项 ' + key + ' 不能包含换行或空字符' }
    }
    if (key === 'dataDir' && value !== '' && !path.isAbsolute(value)) {
      return { ok: false, error: '方寸数据根必须是绝对路径（本地磁盘上的目录），留空表示自动探测' }
    }
    if (key === 'pipePath' && value !== '' && platform === 'win32'
      && !value.toLowerCase().startsWith(WIN_PIPE_PREFIX.toLowerCase())) {
      return { ok: false, error: 'Windows 上的管道必须写成 \\\\.\\pipe\\<名字>，留空表示默认 tegula-mcp' }
    }
    patch[key] = value
  }
  return { ok: true, patch }
}

/**
 * 把一份局部 patch 合进现有 config：空值 = **删掉这个键**，让下层（环境变量 / 默认）
 * 重新生效；不能写成 `dataDir: ""` —— 那会把"没设置"变成一个显式的空覆盖。
 */
export function mergeSettings(current, patch) {
  const next = { ...(current && typeof current === 'object' ? current : {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === '') delete next[key]
    else next[key] = value
  }
  return next
}

/** 设置页展示用：哪些字段有覆盖、来源是 config 还是默认 */
export function describeSettings(settings) {
  const s = normalizeSettings(settings)
  const overridden = {}
  for (const key of SETTINGS_KEYS) overridden[key] = Boolean(s[key])
  return { values: s, overridden }
}
