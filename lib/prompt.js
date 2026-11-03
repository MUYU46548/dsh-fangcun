/**
 * 提示词：**规则段**（稳定）+ **一行现状**（动态）。
 *
 * 为什么规则放段、状态放 context（契约 ④）：
 *  · 段是静态文本，稳定 ⇒ 不破坏提示词缓存；
 *  · context 是每轮重算的动态事实，有快照语义，变了才重记 ⇒ 只放"现在有几张卡"这种一行事实。
 *
 * 为什么只要一行（契约 ③#4）：把 13 个项目的待办全塞进上下文是噪音，不是引导。
 * 段里负责"什么时候该去查"，行里只负责"现在有多少张"。
 *
 * 宿主侧用法（index.js）：`ctx.get('systemPrompt')` 拿到服务后 `registerPrompt(sp, { line })`。
 * 服务不存在（老宿主）就跳过 —— 提示词是锦上添花，不能因为它把插件整体拖死。
 */

export const RULES_SECTION_NAME = 'dsh-fangcun:rules'
export const STATUS_CONTEXT_NAME = 'dsh-fangcun:status'

/** 放在核心段之后：规则是"附加纪律"，不该抢在系统核心指令前面 */
export const RULES_ORDER = 850
export const STATUS_ORDER = 900

/**
 * 规则段正文。四条触发点对应验收 ②⑦–⑩：
 * 开工先查（⑦）/ 收工回写（⑧）/ 新问题建卡（⑨）/ 不过度触发（⑩，写进"什么时候不查"）。
 * 「失败要说」是第 5 条，防的是"模型自称写成功"——那会让账本比没写更糟。
 */
export const RULES_TEXT = [
  '## 方寸（tegula）任务看板',
  '',
  '方寸是本机正在运行的任务看板，通过 MCP 工具访问：',
  '`mcp__fangcun__list_tasks` / `get_task` / `create_task` / `update_task` / `move_status`。',
  '它只在**动手改某个东西**的时候有用；闲聊、问答、纯只读查看不必调用。',
  '',
  '- **开工先查**：接过"改 / 修 / 做某个东西"的活，先用 `list_tasks`（必要时 `get_task`）',
  '  看清相关卡再动手，别凭记忆猜进度。',
  '- **收工回写**：做完把结果写回卡 —— `update_task` 补正文 / 结论，`move_status` 改状态；',
  '  状态与正文都走工具，**不要手改 `task-data/` 里的文件**。',
  '- **新问题建卡**：干活中冒出的新问题用 `create_task` 建卡（选对 project），不要只留在对话里。',
  '- **失败要说**：工具报错、方寸没开、写不进去，就在回复里说明"没写进去"，**不要声称已经改好**。',
].join('\n')

/**
 * 把段与 context 注册进宿主。返回一次性 disposer。
 *
 * `line()` 必须是同步、纯内存、不抛的（见 lib/status.js）；
 * 这里再包一层 try —— provider 抛错会影响整轮提示词装配，代价太大。
 *
 * @param {object} systemPrompt 宿主 `ctx.systemPrompt`（只用到 section / context）
 * @param {{ line?: () => string, sectionOrder?: number, contextOrder?: number }} [options]
 */
export function registerPrompt(systemPrompt, options = {}) {
  const sp = systemPrompt || {}
  const disposers = []
  const line = typeof options.line === 'function' ? options.line : () => ''
  const sectionOrder = Number.isFinite(options.sectionOrder) ? options.sectionOrder : RULES_ORDER
  const contextOrder = Number.isFinite(options.contextOrder) ? options.contextOrder : STATUS_ORDER

  if (typeof sp.section === 'function') {
    disposers.push(sp.section({ name: RULES_SECTION_NAME, order: sectionOrder, text: RULES_TEXT }))
  }
  if (typeof sp.context === 'function') {
    disposers.push(sp.context({
      name: STATUS_CONTEXT_NAME,
      order: contextOrder,
      text: () => { try { return String(line() || '') } catch { return '' } },
    }))
  }
  return () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch { /* 已注销 */ }
    }
  }
}
