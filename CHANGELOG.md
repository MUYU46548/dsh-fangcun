# 变更记录

## 0.3.0（未发版）

这一版把契约 ⑥ 剩下的三件事做完：**规则段**、**一行现状**、**自证 sidecar**；
外加一轮真机修复（挂件"裸奔"、位置、拖拽、`servedByPage` 误判）。

### 让 agent 真的用上方寸（契约 ①②⑦–⑩）

- **规则段**（`systemPrompt.section`）：开工先查 / 收工回写 / 新问题建卡 / 失败要说；
  另加一条反例条款——闲聊、问答、只读查看**不要**调方寸工具（对应验收 ⑩"不过度触发"）。
  段是**静态文本**，不掺动态数据，提示词缓存不会被它打破。见 `lib/prompt.js`。
- **一行现状**（`systemPrompt.context`）：`<项目> · 未完成 <N> 张 · 截至 <时间>`，
  provider 只读内存快照，**绝不在装配时走管道**（方寸没开也不会卡每一轮）。
  快照每 60 秒由后台刷新，方寸没开就明说「方寸 · 未连接」，不拿旧数字装新鲜。
  `FANGCUN_PROJECT` 可把统计限定到单个项目。见 `lib/status.js`。
- **自证 sidecar**：`session/event` 里的 `tool/call` → `$DSH_HOME/dsh-fangcun/tools.jsonl`，
  **只记 `mcp__fangcun__*` 工具的「时间 / 会话 / 轮次 / 名字」**，不记参数（参数里可能有私事）。
  上限 500 行，超了丢最旧。这是验收 ⑦–⑩ 的判据来源，不靠模型自述、不靠人看界面。见 `lib/proof.js`。
- **health 新增 `prompt` / `proof`**：规则段到底注册上没有、一行现状现在长什么样、
  自证日志有几条。这三样都属于"装上了但没生效完全看不出来"的盲区。
- 宿主没有 `systemPrompt` 服务时**不假装成功**：`get()` 拿不到就 3 秒后再看一次，
  仍没有就在 health 里写明原因，挂件与记账照常工作（不写进 inject，见 AGENTS 事实 11）。

### 真机修复

- **挂件"裸奔"**：`css()` 建了 `<style>` 却**没 append 进文档** ⇒ 一条规则都不生效，
  右下角本该是小圆点，实际是「方寸 · N」+ 20 条待办以纯文本排在 `<body>` 末尾
  （从挂件第一版就在）。现在把 style 挂进 `<head>`，并且根节点自带内联定位、
  折叠态用内联 `display` —— 样式再丢一次，最坏是丑，不许排进正文。
- **位置可选，默认右上角**：面板底部四选一，存 `localStorage`。
  默认不占右下：`dsh-whale-widget` 的根节点钉在 `right:0;bottom:0`（z-index 9999），
  第一次真机验证时挂件正压在鲸鱼脸上。
- **拖拽换角（默认上锁）**：面板里「拖动：已锁定 / 可拖动」，解锁后按住圆点拖，松手吸到最近的角；
  位移 <6px 当点击，真拖过后 300ms 内的 click 吞掉（免得顺手开面板）。
- **`servedByPage` 误判**：桌面端 Electron 的请求既没有 `sec-fetch-*` 也没有 `referer`，
  旧判据在真机上恒为 0 —— 「页面在跑」被读成「没人来取」。
  现在主判据换成注入行自己加的 `?from=page`，请求头只当辅助。

### 测试

46 条（`npm test`）：

- 新增 `test/prompt.test.mjs`：规则段四个触发点、注册与撤销、provider 抛错兜底、
  一行现状格式（全部项目 / 指定项目 / 未连接 / 未知）、未完成口径、BoardStatus 真起假管道、
  自证过滤与上限；
- `test/widget-dom.test.mjs` 新增 ⑨⑩⑪（样式表挂进文档 / 位置四角 / 拖拽与锁定）；
- `test/plugin.test.mjs` 新增 ⑧⑨（apply 真的注册了提示词、方寸工具真的落了自证日志、没服务时不假装）；
- `test/widget.test.mjs` ②b 改写为"带标记算、curl 不算、没头的浏览器也算"；
- 变异验证：去掉 `appendChild` 只有挂件 ⑨ 红；默认角改回右下 ⑨⑩ 红；
  去掉锁定判断 / 拖后吞点击 只有 ⑪ 红；自证不过滤工具 只有 ⑧ 红；规则段不注册 只有 ② 红。

## 0.2.0（2026-11-03）

用量上报可用。

- 订阅 `session/event`：按 `(sessionId, turn)` 聚合 `assistant/message` 的 usage，`turn/end` 结算；会话销毁时补结算半轮
- 经命名管道 MCP 调方寸 `usage_report`：`prompt_tokens = inputTokens + cacheReadTokens`、`completion_tokens = outputTokens`、**不报金额**（DSH 没有供应商报价，自己算是估算）
- 本地 outbox（`$DSH_HOME/dsh-fangcun/outbox.jsonl`）：方寸没开也不丢，60 秒与下次启动重试
- 幂等键 `sessionId#turn`：重复结算 / 重启后重放都只记一次（已发键落 `sent.jsonl`）
- `health.usage.outboxPending`：当前积压条数
- 待办挂件：`webserver/index-inject` 推一行内联 script（不用 `script-src`）→ 加载 `/fangcun/widget.js`；
  数据走只读路由 `/fangcun/api/tasks`（MCP `list_tasks`，10 秒缓存，非本机 403）
- 测试：新增 `test/usage.test.mjs`（真起假方寸管道）与 `test/widget.test.mjs`（注入行 / 脚本 / 只读接口），
  覆盖"不丢 / 能发 / 不重 / 毒记录不卡队列 / 半轮补结算 / 空状态算未完成"
- **真机验收修掉两处**（2026-11-03，都是"测试绿、真机不对"的契约错位）：

  - **`session/event` 的第一个参数是 Session 对象，不是字符串**。旧实现 `String(sessionId)`
    把每个会话都拍成 `"[object Object]"`，幂等键退化成 `[object Object]#<turn>` ——
    不同会话的同一 turn 互相顶掉，真机表现为**静默漏报**（方寸账本里 note 写着 `session=[object`）。
    现在 `sessionIdOf()` 归一化（认 `id` / `sessionId` / `header.id`），
    并**显式拒绝 `"[object Object]"`**；取不出 id 时报一次错并跳过，不编假 id。
    补测试 ⑥/⑥b：两条不同会话的第 1 轮都必须报出去。
  - `note` 里的会话短名：`id.slice(0,8)` 对 `session-<uuid>` 只会得到 `session-`
    （八个字符一点区分度都没有），改成去掉前缀再取 8 位。
  - `health` 新增 `usage.{lastSentAt,lastError}`（失败要看得见）与
    `widget.{injected,pushed,servedByPage,lastServedAt}`（真机验收 ② 的证据链：
    靠 `sec-fetch-dest` / `referer` 区分"页面真的加载了脚本"和"有人 curl 了一下"）。

- 用量健壮性（P2）：

  - **子代理会话**：宿主没有 `subagent/start|end` 事件，判据在 `SessionHeader`
    （`origin === 'subagent'` / `parentSession` / `delegationDepth > 0`）。子代理的 token 照报，
    `note` 加 `subagent=1` 以便与主会话区分。
  - 订阅改用 `{ global: true }`（`EventOptions` 原文："regardless of context filter checks"），
    否则子代理会话的事件收不到；带参调用抛异常时退回两参形式，**绝不两次都注册**（那会每轮记两遍）。
  - **outbox 上限 500 条**：超了丢最旧的并报错。它每轮整份重写，无上限会把磁盘和 CPU 一起拖死。
  - **轮次回绕的防守**：`turn` 其实来自持久投影、不会回绕（详见 AGENTS.md 事实 10e），
    但万一回绕且撞上已发键，原本会**静默丢掉一整轮**；现在会报错说明丢的是哪一轮。
  - `test/usage.test.mjs` 新增 ⑦（子代理标记）、⑧（outbox 上限）、⑨（回绕不静默）；
    `test/plugin.test.mjs` 新增 ⑦（从 `apply()` 一路验到 outbox 的接线）。
  - **已知缺口（未接）**：`compaction/summary` 自带 `usage`，压缩消耗的 token 现在没进账；
    但尚不确定它是否同时体现为 `assistant/message`，**先真机对比再决定**（多报账比少报更糟）。

- 挂件体验（P3）：

  - **深色主题**：颜色走 CSS 变量 + `@media (prefers-color-scheme: dark)`，不写死白底，
    也不去读站点自己的 CSS 变量（读别人的变量等于赌它不改名）。
  - **展开状态记忆**：`localStorage` 记住展开/收起，默认收起，别挡 DSH 自己的控件。
  - **可以关掉**：关掉后留一个小圆点能点回来（直接消失的话，用户只能去清 localStorage）。
  - **点条目 = 复制 id**（只读）；空态与错误态都能"点一下重试"，并区分
    "方寸未连接" 与 "没有未完成的卡"。
  - **看板入口用真实端口**：读数据根下 `.tegula-port` 第一行（实测是 8791，不是文档里的 8753），
    读不到就不显示入口 —— 不给用户一个打不开的链接。
  - 新增 `test/widget-dom.test.mjs`：用替身 DOM **真执行** `WIDGET_JS`（8 条）。
    原来只断言"字符串里有没有某个词"，那样"语法对但一执行就抛"照样绿 ——
    而它在真机上的表现是"装上了但页面没角标"，得看宿主日志才查得动。

## 0.1.0（2026-11-03）

首个版本，只做「能装 + 能自报状态」，不假装功能齐了。

- `GET /fangcun/health.json`：报方寸数据根来源、`registry.yaml` / `task-data` / `policies` 是否存在、MCP 管道路径、契约版本，以及还没做的两件事
- 路由按 DSH 真实形态注册：`{ kind: 'exact', path, handler }`（修正骨架期写的 `{ method, … }`）
- 数据根认不出时返回空串，不猜路径
- 零依赖（只用 Node 内置模块）；不 import 方寸代码、不 import electron
- CI：tag 触发 → 校验版本一致 → 测试 → `npm pack` → 发 GitHub Release（附 SHA256SUMS）
