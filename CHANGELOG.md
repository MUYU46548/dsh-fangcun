# 变更记录

## 0.2.1（未发版）

修挂件的"裸奔"：右下角本该是一个小圆点，实际是**一整段纯文本摊在页面末尾**。

- **根因**：`css()` 里 `document.createElement('style')` 之后**没有 append 进文档**。
  元素不在文档里 ⇒ 一条规则都不生效 ⇒ 根节点退回普通流、面板的 `display:none` 也没了，
  于是 20 条待办连同「方寸 · 114」以纯文本形式排在 `<body>` 末尾。
  这个错从挂件第一版（`87a1f8e`）就在，`5e6434d` 重写 CSS 时原样带了过来。
- **补的兜底**（不只修那一行）：
  - 根节点自带内联 `position:fixed;right:14px;bottom:14px` —— 样式再丢一次，最坏是丑，不许排进正文；
  - 面板折叠态改成内联 `display:none/block`，不依赖 CSS。
- **测试**：`test/widget-dom.test.mjs` 新增 ⑨。原来 8 条全绿也没抓到，因为替身 DOM 不做样式计算，
  "元素在不在文档里"是唯一能断言的事实。做了变异验证：去掉 `appendChild` 后只有 ⑨ 红。

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
