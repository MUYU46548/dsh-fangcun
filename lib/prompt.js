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
 *
 * ⚠ 2026-11-17 改：原来只写 `mcp__fangcun__*`。那批属于方寸 MCP 客户端，
 *   它断开时（卡 140864fa）这些名字**在工具表里不存在**，于是这段指引变成死指令 ——
 *   模型照着调会报"没有这个工具"。现在两条路径都写，并说明掉线时用哪个。
 */
export const RULES_TEXT = [
  '## 方寸（tegula）任务看板',
  '',
  '方寸是本机正在运行的任务看板。**两条访问路径，任取其一**：',
  '',
  '| 用法 | 工具名 | 什么时候有 |',
  '|---|---|---|',
  '| 插件工具（推荐） | `fangcun_context` / `fangcun_tasks` / `fangcun_search` / `fangcun_card` / `fangcun_write` / `fangcun_logs` / `fangcun_log` / `fangcun_log_write` | 插件装了就有，**不依赖 MCP 客户端** |',
  '| MCP 工具 | `mcp__fangcun__list_tasks` / `get_task` / `create_task` / `update_task` / `move_status` | 只在 DSH 的方寸 MCP 客户端连上时才有 |',
  '',
  '先看工具表里有哪个就用哪个；**两个都有时优先插件工具**（少一跳、掉线也不受影响）。',
  '它只在**动手改某个东西**的时候有用；闲聊、问答、纯只读查看不必调用。',
  '',
  '- **开工第一件事：`fangcun_context`**（不是 `list_tasks`）。接过"改 / 修 / 做某个东西"的活，',
  '  第一个工具调用就该是它 —— 一次给出四样：章程四节 + 最近有效决策 + 手上还有的活 + **上次做到哪**',
  '  （最新执行日志的标题与它留下的下一步）。MCP 那条路要 `project_charter` + `decision_list` +',
  '  `list_tasks` + `list_logs` + `get_log` **五次**才凑齐同样的东西 —— 别把一次调用拆成五次。',
  '  章程缺哪节会明说「真没写」：那时不要替项目编目标，按现有卡和决策办事。',
  '- **接手别人没做完的活，从日志走**：`fangcun_logs` 列日志 → `fangcun_log` 读正文 + 接力链。',
  '  日志是**交接记录**（上一棒做了什么、留下什么下一步），比卡正文更接近"现在该干什么"。',
  '  ⚠ 日志**不是汇报工作的地方**，是用户的私人笔记本：`fangcun_log_write` 只在用户**明确要求**写日志时用，',
  '  收工不是理由 —— 收工要把结果写回**卡**。日志也没有 `完成`/`驳回`，只有进行中 / 取消进行中。',
  '- **先查再改，中间别插别的**：查完就动手。别"先看两眼代码、回头再查方寸"——那一步经常就回不来了。',
  '- **读具体卡**：需要正文时用 `fangcun_card`（或 `get_task`），按 id 取，别一次拉一堆。',
  '- **不知道卡在哪，先用 `fangcun_search`**：按关键词搜**全部项目、全部状态**（含已完成/驳回）。',
  '  `fangcun_tasks` 只能列"某个项目 + 未结卡"，没有关键词能力 —— 拿它去找"我记得有张讲 XX 的卡"',
  '  只会烧掉上下文还找不到。搜索带空串会被拒（那等于把整张看板拉进来）。',
  '- **`delete_task` 永不使用**：删卡不是 agent 的动作，卡的去留是人的签字。插件也没有这条路。',
  '- **收工回写**：做完把结果写回卡 —— 补正文 / 结论，改状态；',
  '  状态与正文都走工具，**不要手改 `task-data/` 里的文件**。',
  '- **只到「待验收」**：把卡移到 `待验收` 就停手。`完成` / `驳回` 是用户的验收签字，',
  '  方寸会直接拒绝 agent 这么做 —— 不要试图绕过，也不要替用户宣布"已验收"。',
  '- **`待验收` 的意思是"验收项全部验过"，不是"差不多了"**（用户 2026-11-17 明确过：',
  '  "没做完的东西就不该这样放，我除了签完成只有驳回"）。所以：',
  '  · 只要卡上还留着"待复核 / 待真机 / 待重启 / TODO / 之一未验"这类字样，**就不许进 `待验收`**；',
  '  · 该去哪：**留在 `进行中`**，把"还差什么"写进正文，或拆一张小卡单独追；',
  '  · 没验完就送签 = 逼用户在「完成」和「驳回」里二选一，而两个都不对 —— 那是**我的错，不是他的**。',
  '- **新问题建卡**：干活中冒出的新问题建卡（选对 project），不要只留在对话里。',
  '- **失败要说**：工具报错、方寸没开、写不进去，就在回复里说明"没写进去"，**不要声称已经改好**。',
  '- **工具回「方寸未连接」时**：那是**没连上**，不是"没有卡" —— 不要据此建重复的卡。',
  '  直接把 `hint` 那句话告诉用户（开方寸 / 去下载），然后等。',
  '- **缺什么说什么**（三件套各报自己那一环，别混说）：',
  '  · 方寸没装 → 给下载页 https://github.com/MUYU46548/fangcun/releases/latest',
  '  · 方寸装了没跑 → 让用户打开方寸，**不用重启 DSH**（打开就通）',
  '  · 方寸的 DSH 面板说"没装方寸插件" → 那要在方寸里装插件（方寸侧报的，别在这里替它装）',
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
