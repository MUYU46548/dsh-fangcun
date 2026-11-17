# AGENTS.md —— 在这个仓库开工前先读这一页

> 面向：接手本仓库的 agent（也包括未来的我）。
> 这里只放**已核实的事实**和**不容越界的规则**；写给用户看的东西在 `README.md`，
> 方向与需求在 `立项契约.md`。三者分工不要混。
>
> 本文件取代了旧的 `HANDOFF.md` 与 `PLAN.md`：那两份是施工期的临时单，
> 一份名字对公开仓库不合适，一份每次做完就过期（它曾经同时含两条错前提）。
> 内容已并入本文件，历史仍可用 `git log` 取回。

## 0. 一句话

把方寸（tegula）接进 DSH：**每轮把本会话 token 用量报回方寸账本**，**让 agent 开工先查、收工回写方寸**，
**在 DSH 里看得到方寸待办**。零依赖、只读、只走方寸的命名管道 MCP —— 不 import 方寸代码、不 import electron。

## 1. 硬边界（越界即错，测试里钉着）

- **不 import 方寸代码、不 import electron** —— 只走 MCP / CLI / 数据文件（`test/plugin.test.mjs` ③）；
- **只读方寸数据**：写方寸必须走 MCP 工具，不直接改 `task-data/`；
- **不改 DSH 自己的配置**：只声明自己的路由；
- **绝不推 `script-src` 行**：加载失败会 reject 掉 `__DSH_BOOT_READY__`，整个应用起不来；
- **`webserver/index-inject` 必须在 `apply()` 最前面注册**：宿主启动时只收集一次；
- **零依赖**：只用 Node 内置模块；
- **不报金额**：只报 token（DSH 没有供应商报价，自己算是估算）；
- **插件自己不发任何网络请求**；路由只读、非本机 403。

## 2. 已核实的宿主事实（每条都有出处，别再自己猜一遍）

猜错的代价是"装了但插件不出现"、"账目静默漏报"这类要看宿主日志才查得动的故障。

| # | 事实 | 证据 |
|---|---|---|
| 1 | 插件导出 `export default { name, apply(root) }` | 已装插件的真实源码 |
| 2 | 局部等待服务：`root.inject(['webServer'], (ctx) => …)` | 同上 |
| 3 | 注册路由：`ctx.webServer.register({ kind: 'exact', path, handler })` | `dsh-keep-awake`、`dsh-whale-widget` 两处 20 余条路由 |
| 4 | **路由没有 `method` 字段**，方法在 handler 里判 | 同上 |
| 5 | 往页面推行：`root.on('webserver/index-inject', (table) => table.push(row))` | same |
| 6 | 行形状：`{ kind: 'script', placement: 'body', text }`（**内联**） | 同上 |
| 7 | ⚠ **那张表是宿主启动时收集一次的**：订阅晚于收集，行永远进不去 | whale 注释（#152/#153 的根因） |
| 8 | ⚠ **`script-src` 行加载失败会让整个应用起不来** | whale 注释 |
| 9 | 用量钩子：`ctx.on('session/event', …)` | — |
| 10 | ⚠ **签名是 `(session, event)`：第一个参数是 Session 对象，不是 id 字符串**。id 在 `session.id`（= `session.header.id`） | ①`file-upload` 服务原文 `(session, event) => this.observeSessionEvent(session, event)`；`acp` 用 `session.header.id`；`productAnalytics` 用 `session.id`。②反证：0.2.0 早先把它当字符串，真机 `sent.jsonl` 里 key 全是 `[object Object]#<turn>` |
| 10b | `event.data.usage` = `{ inputTokens, cacheReadTokens, outputTokens }`；`event.data.turn` 是轮次；`event.data.message.source.model` 是模型；`turn/end` 是结算点 | whale + 宿主事件表 |
| 10c | 还有 `compaction/start`（`turn === null` 表示手动触发）、`compaction/end` | 宿主 `SessionEventMap` |
| 10d | 想收**所有** agent 的会话（含子代理）要传 `{ global: true }`：`EventOptions.global` 原文 "Receive the event regardless of context filter checks" —— 只放宽过滤，**不会重复投递** | `Context.on` 类型声明 + `history follow` 用法 |
| 10e | **`turn` 不会回绕**：`const turn = phase.turn + 1`，`phase.turn` 由持久投影恢复（`stateOf(session,'turnBoundary')?.lastTurn ?? 0`）。压缩与重启都不动它；只有投影彻底缺失才从 0 开始，而那基本等于新会话 | `AgentLoop` 构造函数 + `turnBoundary` 投影 |
| 10f | **宿主里没有 `subagent/start\|end` 事件**。判子代理看 `SessionHeader`：`origin:'subagent'` / `parentSession` / `delegationDepth` | `SessionHeader` 类型声明原文 |
| 10g | ⚠ **未解**：`compaction/summary` 自带 `usage`，压缩那次调用的 token 现在**没进账**。但它是否同时也体现为一条 `assistant/message` 还没证实（生产端用 spread 拼对象，静态追不到）。**先真机跑出一次压缩、对比两边，再决定接不接** —— 接错就是多报账，比少报更糟 | `compaction/summary` 类型声明 |
| 11 | 可选服务用 `ctx.get('x')` 读，**绝不能写进 inject**（老宿主没那服务 → 插件永不 apply） | whale 注释 |
| 12 | `dsh plugin` 只是 pnpm 的转发壳；装/更新都靠版本号 | `dsh plugin --help` 原话 |
| 13 | 更新器按 `package.json.repository` 找上游 Release / Tag | `dsh-plugin-updates` README |
| 14 | **右下角是 `dsh-whale-widget` 的**：根节点 `.dshwv-root` 钉在 `right:0;bottom:0`（z-index 9999，`pointer-events:none`），宽高 122px 起 —— 挂件别往那儿放 | 已装插件 `assets/whale-widget.js` 的 CSS 原文；真机截图里挂件正压在鲸鱼脸上 |
| 15 | 提示词注册：`ctx.systemPrompt.section({ name, order, text })` 与 `.context({ name, order, text })`；`text` 可以是**同步函数**（装配时调用，**不能 await**）；服务用 `ctx.get('systemPrompt')` 读 | 本机 `cordis_inspect_query` 的 `Service.listService` 原文：`PromptSection` / `PromptContext` 声明 |
| 16 | `tool/call` 事件数据 = `{ turn, step, callId, name, arguments }`；方寸工具在会话里叫 `mcp__fangcun__<tool>` | `session/event` 的 `SessionEventMap` 声明 + 本会话工具表 |
| 17 | **桌面端 Electron 的请求不带 `sec-fetch-*`，也不带 `referer`**（挂件脚本那次实测 `servedByPage` 恒为 0）。判"页面真的来取"要靠自己加的标记，别靠头 | 2026-11-03 真机：页面有挂件、health 却是 0 |
| 18 | **桌面端页面不是 http，是 `dsh-app://app/`**：主窗口加载它，页面侧靠 IPC `dshDesktopBoot` 拿注入表并**自己执行**；`/fangcun/*` 这类不是 dist 文件的路径由主进程 `forwardWebRequest` 带上 host cookie 转发到 Host —— 所以挂件在桌面端照样拉得到脚本和接口 | `app.asar` 的 `/lib/main.js`：`protocol.handle(SCHEME, …)` + `forwardWebRequest()`；`dsh-web-frontend` 的 `UZ()` |
| 19 | **`collectIndexInjections()` 每次调用都新发一张表**（"Fresh per call"）。`widget.injected/pushed` 是**收集次数**（桌面 boot 一次 + 每次 index 渲染一次），**不是插件 apply 次数**，别当重复安装的证据 | `webServer` 服务原文：`collectIndexInjections()` 描述 + 2026-11-04 实测 2/2 而 `package.json` 只有一处安装 |
| 20 | 桌面端 `kind:'script'` 行 = 页面侧建内联 `<script>` **append 到 `body`**（`placement` 决定 head/body）。`script-src` 走 `await` 加载、失败会 reject 启动 —— 别用 | 同上 `UZ()` 实现 |
| 21 | ⚠ **桌面窗口顶上 40px 是原生窗口按钮区**：Windows 上用 `titleBarStyle:'hidden'` + `titleBarOverlay{height:40}`，页面铺满整窗、**被原生层盖住**。DOM 里放在 `top:14px` 的东西 `elementFromPoint` 仍命中它自己，但人眼看不见（2026-11-04 真机：挂件"消失"的真因）。让开用 `env(titlebar-area-height)`（Chromium 在开了 overlay 的窗口里提供） | `app.asar /lib/main.js` 的 `new BrowserWindow({ titleBarStyle: 'hidden', titleBarOverlay: { height: 40 } })`（0.2.2-rc.1）+ 真机 probe |
| 22 | **注册模型工具**：`root.get('tools').register(definition)`。`ToolDefinition` = `name` + `description` + `parameters` + **`output`（必须）** + `execute(args, exec)`；可选 `presentCall` / `presentResult` / `timeoutMs` / `isConcurrencySafe`。`output` 形状 = `{ schema, render(args, value) }` | `dsh-tools/src/contracts.ts` 的 `ToolDefinition` 与 `ToolOutputDefinition`（0.2.2-rc.3） |
| 23 | ⚠ **`defineTool` 会改写对象**（旧说法"不改变对象"是错的）：库里的 `defineTool` 会用 `parameterSchemaSpecToJsonSchema()` / `valueSchemaSpecToJsonSchema()` 把作者写的 DSL **编译成真的 JSON Schema** 再返回。所以「裸对象直接交给 `register`」只有在**你自己已经交完整 JSON Schema**时才成立 | `dsh-tools/lib/types/schema.js` 的 `defineTool`（0.21.x 实读）；`dsh-tool-todo` 交的本来就是完整 schema，才看不出差别 |
| 23b | ⚠ **`tools.register` 只校验 `output.schema`，不校验也不编译 `parameters`** —— 交什么就原样发给 provider。`parameters` 必须是完整 JSON Schema `{type:'object',properties:{…}}`；写成「字段名→子 schema」的扁平映射＝把属性名摊到 schema 根部，其中 `title` 是 JSON Schema **保留注解**（必须字符串），撞上就是 provider 400、整轮对话发不出去 | `dsh-tools/lib/index.js` `ToolsService.register`（只看 `assertSupportedJsonSchema(output.schema)`）；2026-11-17 真机 400 原文；`tool ⑦c` + `check-packed-schema.mjs` 原样验 `d.parameters` |
| 24 | **`output.schema` 的 required 字段必须每个分支都填满**：少一个字段，宿主在 output 校验那步会拒掉**整次**调用 —— "没连上后端"会以"工具坏了"的样子出现 | `ToolOutputDefinition`：`schema` 是 `JsonSchemaNode`，`render` 是其纯投影；`tool.test.mjs ③b③c` 钉着 |
| 25 | 本机 `HKCU\Console\%%Startup` **键存在但零值** → Windows 11 默认把控制台**委托给 Windows Terminal**。于是任何进程只要创建控制台，就会弹 `WindowsTerminal.exe -Embedding` 的可见窗口（`CASCADIA_HOSTING_WINDOW_CLASS`）。真正的 `PseudoConsoleWindow` 归属 cmd 自己、`rect=0x0` **不可见** —— 判断"谁闪的窗口"要看 `CASCADIA_*` 那一行 | 2026-11-17 实测：`MainWindowHandle` 对控制台窗口恒为 0（不可用作判据），必须枚举 `ConsoleWindowClass`/`PseudoConsoleWindow`/`CASCADIA_*` |
| 26 | ⚠ **`engines.dsh` 写上界 = 给升级埋炸弹**：不满足时宿主会 `throw`，然后被 catch 成 `skippedBundles` —— **整个插件静默消失**（挂件/记账/工具全没，界面只显示"没装"，无原因）。⚠ 注意 `skippedBundles` 的注释写的是 "skipped without changing the manifest and listed in `skippedBundles`; nothing is printed" | `dsh-app-boot/lib/index.js` 的 `loadProfileDirectory`：`if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))` 在 `try` 里，`catch` 只 push 到 `skippedBundles` |
| 27 | **所以 `engines.dsh` 只写下限、不写上界**（用户 2026-11-17："能不能用随缘，插件永远只保适配版本"）。代价是宿主 API 变了插件会"加载上但少干活"，所以**必须配运行期自检**（`lib/compat.js`）把缺口写进 `health.compat` | `compat ①` 钉住"不许有上界"；`compat ②–⑥` 钉住体检三态 |
| 28 | **`root.on` 只判 `typeof === 'function'` 会漏掉"能调用但会抛"的宿主** —— 那与"没有"对插件是同一件事（订阅不上 = 收不到事件 = 记账与自证全哑），但报告要区分 missing/degraded | `compat ⑤⑤b`（2026-11-17 这个 bug 就是测试抓出来的） |
| 29 | **`exempted` 机制**：宿主支持按"包名@精确版本 + DSH 精确版本"给豁免（`--accept-risk`），但那是给**用户**用的逃生口，不是插件该依赖的东西 | `dsh-app-boot` 的 `setProfileVersionExemption` / `validatePluginVersionExemption` |
| 30 | **自证必须认两条命名路径**：`mcp__fangcun__<tool>`（DSH 生成的 MCP 工具名）与 `fangcun_<x>`（插件自己注册的）。只认前者会让 0.4.0 的插件工具**全部不被计入** —— `proof` 与 `cards` 双双失明。⚠ 两条路径的短名形状不同：MCP 那条要去前缀（`mcp__fangcun__update_task`→`update_task`），插件那条**不能去**（`fangcun_write` 去前缀会变成 `write`，撞上宿主的写文件工具） | `cards ①b`、`cards ③d③e`（2026-11-17 这个坑是自己挖的） |
| 31 | **`完成` / `驳回` 的硬拒在方寸本体，不在插件**：`desktop/src/main/mcp/tools.ts` 的 `move_status` 直接回 `isError` + `suggested: '待验收'`。插件侧另有一道 `SIGNOFF_STATUSES`（第一道锁），理由是"不该先撞墙才知道"+"不许赌锁的位置" | `tool ③b③c`、方寸 `tools.ts:1203` |
| 32 | **防腐层现状**：所有 DSH 概念（`root.get/inject/on/effect`、`webServer.register`、`systemPrompt`、`tools.register`）**已集中在 `lib/index.js`**；`mcp-pipe/usage/cards/proof/tool/status/widget` 全是方寸协议侧（换宿主不用动）。用 `test/layering.test.mjs` 把它钉成 CI 规则，不靠纪律 | `layering ①–⑤`（做过反例验证：往 `cards.js` 塞 `root.get('webServer')` → 2 例失败） |
| 33 | ⚠ **`connected` 与 `total` 必须分开报**：方寸没开时若只回 `total: 0`，模型会读成「方寸里没有卡」并去建重复卡（0.4.1 的真实缺陷）。所以读工具回 `connected:false` + `hint`，渲染文案明写「不是"没有卡"」 | `tool ④④b`（2026-11-17 修自己挖的坑） |
| 34 | **三件套分工**：插件只报「方寸」这一环（装没装 / 跑没跑）；「DSH 装没装」在插件里没有意义（插件就活在 DSH 进程里），由方寸侧 `services/dshPlugin.ts` 报。两边各报自己看得见的 —— 否则就是「同一个数字三个地方各写各的」 | `link ⑤`：插件侧不许有 `dsh` 状态字段 |
| 35 | **装了没跑 ≠ 要重启 DSH**：方寸打开就自动通（命名管道按需连接，插件 60 秒重试）。提示语必须写「不用重启 DSH」，否则用户会去重启整个应用 | `link ②` |
| 36 | ✅ **0.6.3 起模型工具真机可用**（0.4.0 起一直零注册）。2026-11-17 18:11 逐个真调验证：`fangcun_tasks` → `connected:true / total:373`；`fangcun_context` → 三处并行、`missing:['目标','场景','边界']`（**没替项目编**）；`fangcun_card` → 2213 字正文、`truncated:false`。真走 `\\.\pipe\tegula-mcp`，不是单测替身 | 2026-11-17 真机实测 |
| 37 | ⚠ **`tools.register` 的 `parameters` 必须交完整 JSON Schema**，且**属性名不许叫 `title` 之外还得看 `required`**——见事实 23/23b。0.6.0→0.6.3 四版才通，中间 **0.6.2 把整轮对话打挂过**（provider 400）。**自造校验器 = 自己当裁判，连错两次**；`scripts/check-packed-schema.mjs` 是拿宿主真校验器判的，打包后必跑 | 2026-11-17 事故 |
| 38 | ⚠ **写工具的参数转发靠手写，容易漏**：0.6.4 修的是 `create` 分支**根本没转发 `status`** —— 模型传 `'草稿'`，落成默认的 `'待办'`（后者在方寸里要过进队列闸，语义不同）。**「全字段」断言如果不逐字段对着 `parameters` 声明数，会跟着一起漏，测试全绿也抓不到** | `tool ③`、0.6.4 CHANGELOG |
| 39 | ⚠ **往会话日志 `session.append('user/message')` 不会叫醒 agent**：轮次由 Agent 的 inbox 驱动（`agent.followup(message)`）；只 append 的结果是"历史里多了一句话"，模型永远不跑。而且手写的 user 消息**必须有 `id`（非空）与 `source.kind`（非空）**，否则 `assertMessageEventShape` 判它是坏事件。派单那条管子此前就是踩这个，会话建出来是空的 | `plugin ⑩`（2026-11-17 真机探针 + agent-loop `followup` 原文） |
| 40 | ⚠ **`agents.create` 的三个坑**：① **没有 `title` 字段**（`CreateAgentOptions` 只有 `sessionId/meta/agentOptions/setup/signal` 等，传了静默丢弃）；② **不传 `meta.cwd` 就落在 `sessions/_no-cwd/`**（真机实证），等于派进真空；③ **不传 `agentOptions` 就没有 provider/model**，第一轮抛 `agent "…" has no provider/model` —— 用户看到的是"会话开出来了，但说话不回"。正解：`cwd` 用绝对路径 + `agentOptions` 取 `agentDefaultModel.currentSelection()`（与 GUI 新建会话同源） | 2026-11-17 真机：探针会话落在 `_no-cwd` 且零事件；`agent-loop:686` 原文 |
| 41 | **会话要"落盘"得自己 `sessions.flush(session)`**：`session.append`/`followup` 只进内存，落盘是 `session/flush` 的活（`dsh-schedule` 每发一条都 await 一次）。探针会话在磁盘上只有一行头、零事件就是这个原因 | `plugin ⑩`、`dsh-schedule` `send()` 原文 |
| 42 | ✅ **改完不必重启 DSH**：本机 `dsh-hmr` 是 active，**Plugin Manager 的一次操作会触发重组**，而重组"也替换**加载文件在磁盘上变过的插件**——包含 `node_modules` 下装的和 **`link:` 包的目标**"。所以 `plugin_manager set_plugin(enabled:true)` 一次（`target=include:dsh-fangcun`）就能让 0.6.4→0.6.5 在**运行中的进程里**生效（`health.plugin.version` 当场变 0.6.5，`compat.checkedAt` 刷新）。⚠ 前提是新代码**能被干净 import**（先 `node -e "import('./lib/index.js')"` 验一遍）：加载失败会把旧实例停掉并标 `failed`，那才是真的坏 | `dsh-hmr` README 第 50 行原文 + 2026-11-17 18:58 实测 |
| 43 | ⚠ **`待验收` = 验收项全部验过，不是"差不多了"**（用户 2026-11-17 原话："没做完的东西就不该这样放，我除了签完成只有驳回"）。用户那一栏只有「完成 / 驳回」两个按钮，**没有"再等等"** —— 所以送一张自己心里知道还差东西的卡进去，等于逼他在两个都不对的选项里选。判据：卡上只要还留着「待复核 / 待真机 / 待重启 / TODO / 之一未验」这类字样，**就不许 move 到 `待验收`**；该留在 `进行中`，或拆小卡单独追。这是 agent 的错，不是用户的负担 | `prompt ①d` 钉着；2026-11-17 我把「派单管子」那张标着"待重启复核"的卡送审，用户当场指出 |
| 44 | ✅ **`fangcun_write` 三条 action + 三道闸真机全通**（2026-11-17 19:50，此前只验过 `create`）：`update` 改正文 → `get_task` 确认落盘；`move` 待办→草稿 → `get_task` 报 `status=草稿`；`move`→`完成` **被拒**；`update`→`驳回` **被拒**；`create` 带 `status:完成` **被拒**。五条全是真调真拿拒绝，没有一条是"我以为它该报错"。⚠ 写工具的三道锁**都在插件侧先挡**，方寸本体那道（`tools.ts` 的 `move_status` 硬拒）还没被撞到过 —— 因为撞不到，这也正是第一道锁存在的理由（事实 31） | 2026-11-17 真机；`tool ③/③b/③c` 在真管道上站得住 |
| 45 | ✅ **「不丢」真机补测通过**（2026-11-17 20:00，契约 ⑥ 第 6 条）：真 `UsageLedger` + 真管道，只换 `DSH_HOME`。管道不存在时 `outbox=1 / sent=0`；换成 `\\.\pipe\tegula-mcp` 后 `outbox=0 / sent=2`，**积压那轮跟着第 2 轮一起发出去**。⚠ 探针第一版写错过：`UsageLedger` 的选项是 **`home`**（不是 `dataDir`），传错了 outbox 恒为 0，看着像"丢了" —— **这类"自己的探针写错"要先怀疑探针再怀疑代码** | 2026-11-17 实测；`usage ①` 从假管道升到真账本 |
| 46 | ⚠ **查账别查错文件**：`fangcun/mcp-usage.jsonl` 是 **MCP 调用日志**（字段 `ts / via / ids`，**没有 `card`**）；真账本是 **`fangcun/ai-trace.jsonl`**（`origin=external` 才是 DSH 报的），`card` 字段在那里。2026-11-17 上次日志说"今天 103 条里 74 条没归因（72%）"，按账本重算：**今天 127 条 external 全部带 `card`（100%）**，历史 570 条里 346 条（61%）—— 那个 72% 八成是读了调用日志 | `ai-trace.jsonl` 实读 + 2026-11-17 复核 |

## 3. 四条链路（改之前先看懂数据怎么走）

**用量上报**：`session/event` → `UsageLedger.onSessionEvent`（按 `(sessionId, turn)` 聚合
`assistant/message`）→ `turn/end` 结算 → 本地 `outbox.jsonl` → 管道 MCP `usage_report` →
已发键落 `sent.jsonl`。方寸没开就攒在 outbox，60 秒重试。会话销毁时补结算半轮。
结算时 `note` 会带**这一轮在办那张卡的卡号**（`card=<id>`，来自 `lib/cards.js`）——
方寸账本可按卡归因 token。卡号放不进 120 字上限就整段不带，**绝不写半截 id**。

**待办挂件**：`apply()` 最前面订阅 `webserver/index-inject` → 推一行内联 script →
浏览器加载 `/fangcun/widget.js` → 拉 `/fangcun/api/tasks` → 经同一根管道 `list_tasks`（10 秒缓存）。
**位置**是客户端自己的事，两种模式：
① **四角锚定**（默认右上，不占右下 —— 那一角是 `dsh-whale-widget` 的，事实 14），存
`fc-todo-widget:corner`，用 CSS 的 left/right/bottom 贴角；
② **自由摆放**，存 `fc-todo-widget:pos` = `"x,y"`（**角标左上角**的视口 px，不是根节点的），
用 inline `left/top`，夹在视口内（顶部下限 `env(titlebar-area-height)`），窗口缩放时重新夹。
**拖动**默认上锁（`fc-todo-widget:locked`，只有存过 `'0'` 才是解锁）：解锁后按住圆点拖，
**松手就停在原地**（不吸角、不弹回 —— 2026-11-05 真机反馈：鲸鱼挂件能随便拖，这个一松手就弹角）；
位移 <6px 当点击。自由模式下面板改成 `position:absolute` 挂在角标上/下（`placePanel`），
开合面板不会再把角标顶走；坐标量的是**角标**（`handleEl`），量根节点会被面板尺寸带偏。
锁着的理由是圆点主要用来点开面板。收起后是带「方寸」字样的小胶囊（只留一个 8px 的绿点，
用户只会说"挂件没了"）。
**右键**出菜单（解锁拖动 / 四角摆位 / 刷新 / 打开看板 / 收起），锁着时硬拖会 toast 一句
"拖动已锁定：右键菜单里解锁" —— 用户反馈过"只能左键"，不给解释就等于坏了。
**看板链接**读数据根的 `.tegula-port`，但**要先验 PID**：文件是「端口/PID/时间戳」三行，
PID 不在就返回空串，挂件不显示「打开看板」——2026-11-07 真机踩到 10 月 22 日的死端口 8791。

**挂件自证**：注入行一执行就报 `boot`（页面地址 / readyState），`mount()` 报 `mount`，
800ms 后报 `probe`（量出来的位置、命中的是不是自己），根节点被谁摘掉报 `removed` 并**自动补挂**；
注入行还挂了全局 `error` 监听（语法错 / 404 / CSP / mount 抛异常都会报）。全部落
`/fangcun/api/widget-report`，`health.widget.page.events` 留最近 12 条。桌面端
`servedByPage` 只能证明"脚本被取走"，证明不了"它跑起来且还在页面上"。

**装机提示**：`lib/detect.js` 判"这台机器装没装方寸本体"，**只读文件**（data-dir.json / Electron userData /
electron-updater 目录 / 开始菜单与桌面快捷方式 / Program Files 与 Programs 下的同名字目录），
不跑进程、不发请求。三种状态给三种话术：没装 → 挂件角标写「方寸未安装 · 去下载」并给 Releases 地址、
一行现状写「方寸 · 未安装」；装了没开 → 「未连接」；装了也在跑只是管道不对 → 查 `FANGCUN_MCP_PIPE`。
判定结论进 `health.fangcun.installed / installedEvidence / downloadUrl`，也随
`/fangcun/api/tasks` 的 200 与 503 一起回给挂件（挂件据此决定显示哪一个）。

**提示词**：`apply()` 里 `root.get('systemPrompt')`（拿不到就 3 秒后重试一次，仍没有就写进
`health.prompt.error`；**不写进 inject**，否则老宿主上插件永不 apply）→
`section()` 放**静态规则段**（`lib/prompt.js`，不掺动态数据，别破坏提示词缓存）+
`context()` 放**一行现状**（`lib/status.js` 的内存快照，60 秒后台刷新；provider **绝不碰管道**）。

**模型工具**（REV-014 ②，0.4.0 起；`fangcun_context` 0.5.0 起）：`apply()` 里 `root.get('tools')`
（同样是 `get` 不是 `inject`，理由见事实 11）→ `register()` **四个**定义（`lib/tool.js`）→
模型调到就开一条管道连接、用完即关。

| 工具 | 转发 | 说明 |
|---|---|---|
| `fangcun_context` | `project_charter` + `decision_list` + `list_tasks` + `list_logs`（**并行**）+ 最新一条 `get_log`（补下一步） | 开工一屏：章程四节 + 决策 + 未结卡 + **上次做到哪**。MCP 那条路要五跳才凑齐 |
| `fangcun_tasks` | `list_tasks` | 列未结卡（只读） |
| `fangcun_card` | `get_task` | 读一张卡正文（只读） |
| `fangcun_write` | `create_task` / `update_task` / `move_status`（按 `action`） | 唯一的写口 |

`fangcun_context` 的三条铁律（`tool ⑦/⑦b/⑦c` 钉着）：
①**缺节要说「真没写」**，不许替项目编目标；②四处**并行**拉，**有一处通就算连上**（只缺一处单独标）；
③缺 `project` 就抛，不许默认成"全部项目"去猜。
「上次做到哪」只取**最新一条**日志的标题 + 下一步（`MAX_LOG_BLURB` 600 字）：正文不塞 ——
那可能是几万字，而且它不是任务卡（渲染里明写这句，否则模型会照着抄）。

**只白名单转发**，不做任意工具名转发。
工具名是 `fangcun_*` 而**不是** `mcp__fangcun__*`：后者属于方寸 MCP 客户端，它断开时（卡 140864fa）
那批工具全会消失，而这四个走插件自己的管道，仍然可用。
输出一律**有界**（列表 30 条、正文 4000 字、决策 8 条、卡 12 张）并在超限时明说 —— 上下文是共用资源。
注册状态进 `health.tools = { registered, names, error }`。

**自证**：同一条 `session/event` 订阅里，`tool/call` 且名字**以 `mcp__fangcun__` 或 `fangcun_` 开头**
（两条路径都认，见事实 30）→ 追加 `$DSH_HOME/dsh-fangcun/tools.jsonl`
（只记时间/会话/轮次/工具名，不记参数；上限 500）。
另外 **每轮收尾一行** 进 `turns.jsonl`（上限 500），记的是**顺序**：第一次工具是谁、方寸读在第几位、
改文件在第几位、回写在第几位、shell 在第几位。`health.proof.turns` 直接给出
`turns / withEdit / readBeforeEdit / wroteBack / readOnly / withShell` ——
契约 ②⑦（先查后改）、②⑧（改了就回写）、②⑩（只查不干的可疑轮次）不用再人翻日志。
判定口径在 `lib/proof.js` 的 `verdictOf`，**历史行与刚收尾的一行走同一套**（重启后数字不漂）。

**卡号追踪**（`lib/cards.js`）：只从 `tool/call` 的 `arguments.id` 里、且只对
`get_task / update_task / move_status / delete_task / plan_get` 这五个工具取卡号
（`get_log/update_log` 的 `id` 是日志号，**不是卡号**，别混）。
用在两处：`usage_report` 的 `note` 里 `card=<id>`（按卡归因 token）；
`/fangcun/api/tasks` 的 `focus` 字段（挂件顶部「本次在办」，标题从这次 `list_tasks` 结果里匹配）。
**参数里其余字段一个都不读** —— 这是与 `proof.js` 同一条隐私边界（`cards ①` 钉着）。

**挂件的口径**（REV-005）：`/fangcun/api/tasks` 回 `total / counts / focus / scope / items`。
`counts.doing` = status「进行中」的条数，`counts.waiting` = 「待验收」+「待审批」；
`items` 仍是 `list_tasks` 的前 20 条、**不重排**（`list_tasks` 不返回时间戳，排序只能靠猜）。
`scope` 跟 `FANGCUN_PROJECT` 走，与一行现状同一个项目口径（以前挂件永远全部项目，两边会各说各的）。

## 4. 关键不变量 ↔ 测试

改动这些必须同时改测试，否则等于把保障拆了没人知道。

| 不变量 | 钉在哪 |
|---|---|
| 不丢：方寸没开也不丢，进 outbox | `usage ①` |
| 能发：握手 + `tools/call`，口径 `prompt = input + cacheRead` | `usage ②` |
| 不重：重放 / 重结算只记一次 | `usage ③`、`usage ⑨` |
| 毒记录不卡队列 | `usage ④` |
| 零 token 不落记录；半轮补结算 | `usage ⑤` |
| **对象形状取真 id，不同会话同一轮不互相顶掉** | `usage ⑥/⑥b`、`plugin ⑦` |
| 子代理照报但标 `subagent=1` | `usage ⑦` |
| outbox 上限 500，丢最旧 + 报错 | `usage ⑧` |
| 挂件脚本能跑（真执行，不只是字符串匹配） | `widget-dom ①–⑧` |
| **挂件只当浮层**：样式表真挂进 `<head>`、根节点按角写内联定位、折叠态内联 `display:none` | `widget-dom ⑨` |
| 位置默认右上（右下是鲸鱼的）、四角可换、选择存 `localStorage`、脏值回默认 | `widget-dom ⑩` |
| 拖动**默认上锁**（解锁才拖得动）、**松手停在原地**（自由坐标落盘、不吸角）、拖出屏幕会被夹回、手抖 <6px 算点击、拖完吞掉那一下 click、自由模式下面板绝对定位不顶走角标 | `widget-dom ⑪` |
| 挂件不安静消失：根节点被摘掉会**自动补挂**且不重复起轮询 | `widget-dom ⑫` |
| 页面自证：`boot/mount/probe/removed/error` 进 `health.widget.page`，只收本机 | `widget ⑤` |
| **没装本体 ≠ 没连上**：装机判定只看文件痕迹、结论进 health、挂件给下载入口 | `detect ①–⑥`、`widget ⑥`、`widget-dom ⑬⑭`、`prompt ④` |
| **顶部不吃原生窗口按钮区**：右上/左上让开 `env(titlebar-area-height)`，下边的角不受影响 | `widget-dom ⑮` |
| **右键有菜单**（解锁 / 四角 / 刷新 / 看板 / 收起）；锁着硬拖会解释一句 | `widget-dom ⑯⑰` |
| 注入行是内联 script、无 `script-src`、不重复推 | `widget ①` |
| 只读路由：非本机 403、完成/驳回不算未完成 | `widget ③④` |
| 规则段含四个触发点 + 「闲聊不查」；注册与撤销成对 | `prompt ①②` |
| 一行现状：格式对、未完成口径对、读快照不碰管道、方寸没开=未连接、provider 不抛 | `prompt ④⑤⑥⑦③` |
| 自证只记方寸工具、不记参数、脏 id 不记、有上限 | `prompt ⑧⑨` |
| **逐轮顺序可证**：先查后改 / 改了没回写 / 只查不干，各自数得出来；判定历史与新增同一口径（重启不漂）；`turn/end` 没带轮次时收最新一轮；半轮在会话销毁时补结算 | `cards ③③b③c` |
| **卡号只取 `arguments.id`**：日志 id 不算卡号、非白名单工具不取、脏值不取；一轮去重、焦点有 TTL、会话销毁即忘、轮次有上限 | `cards ①②②b` |
| **按卡记账**：note 放得下才带 `card=`，放不下整段不带（不写半截 id），原有 `cache_read` 口径不被挤掉，note ≤ 120 | `cards ④` |
| **挂件口径照方寸的 status 数**（在办/待拍板），`focus` 只配可见列表里的标题，没有就只给卡号 | `cards ⑤`、`widget-dom ⑱⑱b` |
| apply 真的注册了提示词；没有 `systemPrompt` 服务时不假装成功、其它功能照旧；方寸工具调用落 `tools.jsonl` | `plugin ⑧⑨` |
| **模型工具是真 ToolDefinition**（name/description/parameters/output/execute 齐全）；**只白名单转发**（不在 `create/update/move` 里的 action 就抛）；参数不全就抛不猜；输出有界且截断明说；**连不上时 `connected:false` + hint，不许回 `total:0` 冒充"没有卡"** | `tool ①②③④④b⑤` |
| 没有 `tools` 服务时 `health.tools.registered=false` + 写明原因，不假装注册 | `plugin ⑨` |
| **三件套只报自己那一环**：`health.link` 报方寸装没装/跑没跑 + hint；插件侧不许有 `dsh` 状态字段；没装给下载页、装了没跑说「打开方寸」且**明说不用重启 DSH** | `link ①②③④⑤` |
| **engines.dsh 不设上界**（写上界会让升级后插件静默消失）；`dsh.compatibility.dsh` 同样只有下限 | `compat ①` |
| **兼容性只提醒不退出**：六项宿主能力三态齐全；空宿主/抛异常的探测都不外泄；`on` 能调用但会抛要报 degraded 而不是 ok | `compat ②–⑥` |
| **自证认两条命名路径**：MCP 短名与插件工具名都计入；`fangcun_tasks`/`fangcun_card` 只算查、`fangcun_write` 算回写；只读工具不许算回写 | `cards ①b`、`cards ③d③e` |
| **验收闸第一道锁**：`完成`/`驳回` 在 move 与 update 两条路径上都被拒；正常状态（待办/进行中/待验收/待审批）不误伤 | `tool ③b③c` |
| **规则段两条路径都写**（MCP 掉线时不变成死指令）+ 钉住「只到待验收」 | `prompt ①b①c` |
| **防腐层边界**：DSH 概念只在 `index.js` / `compat.js`；业务模块零 DSH 依赖；零 dependencies | `layering ①–⑤`（做过反例验证） |
| **看板链接只指向活着的进程**：`.tegula-port` 有 PID 且 PID 已退出 → 不给链接；旧格式只有端口 → 保留旧行为 | `plugin ⑩` |
| health 只报能自证的事实、不泄凭据 | `plugin ⑤` |

## 5. 本地怎么跑

```powershell
npm test        # 107 条，不需要 DSH、不需要真方寸（真起假管道）
npm pack        # 验发布包；CI 会把 tgz 解出来真 apply 一次
```

装进 DSH（开发态用 `link:`）。**改完不一定要重启**（事实 42）：本机 `dsh-hmr` active 时，
一次 `plugin_manager set_plugin(enabled:true)`（`target=include:dsh-fangcun`）会触发重组，
把 `link:` 目标里**磁盘上变过的文件**换进来 —— 2026-11-17 实测 0.6.4→0.6.5 在运行中的进程里生效。
**先验 `node -e "import('./lib/index.js')"`**：import 不干净会被停掉并标 `failed`。
真正需要重启的只剩：改了 `package.json` 的 `dsh` 清单/`engines`、或者 HMR 被关掉时。

```powershell
dsh plugin --profile desktop add link:<本目录绝对路径>
curl.exe http://127.0.0.1:<端口>/fangcun/health.json   # 先看 version 是不是新的一版
```

排查用 `health`，别看界面：

- `usage.outboxPending > 0` → 方寸没开或管道名不对；
- `usage.lastError` → 最近一次为什么没发出去；
- `widget.pushed > 0 && widget.servedByPage == 0` → 行进了表但页面没执行。
  `servedByPage` 现在认注入行自己加的 `?from=page`（桌面端 Electron 不带 `sec-fetch-*`/`referer`，
  0.2.0 只靠请求头判断才恒为 0）；
- **`widget.page.events` 是"页面自己说跑到哪一步"**（2026-11-04 起）：`boot` = 注入行执行了，
  `mount` = 根节点挂上了（带页面地址与 readyState），`probe` = 量到位置、命中元素，
  `removed` = 被谁摘掉（已自动补挂），`error` / `script-missing` = 脚本没跑成。
  **有 boot 没 mount** = 挂件脚本执行失败，看紧跟着的 `error`；**servedByPage 涨但 page.count 不涨**
  = 请求根本没到页面（或被挡在脚本执行前）；
- `probe` 里的 `tb` 是量到的**顶部安全区**（桌面端应为 40，浏览器页为 0），`y` 应当 ≈ `tb + 14`。
  `tb=0` 而窗口明明有原生按钮 → overlay 的 `env(titlebar-area-height)` 没读到，
  右上角会被原生窗口按钮盖住（事实 21，2026-11-04 的"挂件消失"就是这个）；
- 界面底部出现**一整段纯文本**（「方寸 · N」+ 一堆待办）→ 样式没生效。先看 `<head>` 里
  有没有 `#fc-todo-widget-style`：没有 = `css()` 忘了 `appendChild`（0.2.0 的错）；
  有 = 被别的样式或 CSP 挡了。这一格 `health` 看不出来，只能看 DOM；
- `fangcun.dataDir` 为空串 → 没找到方寸数据根，设 `FANGCUN_DATA_DIR`。
- `fangcun.installed === false` → 本机没有方寸桌面版：`downloadUrl` 会给 Releases 地址，
  挂件角标是「方寸未安装 · 去下载」，提示词那行写「方寸 · 未安装」。**装了却报 false**：
  装到自定义目录、又没建开始菜单/桌面快捷方式 —— 设 `FANGCUN_DATA_DIR` 或补个快捷方式即可
  （判定只读文件，见 `lib/detect.js`）。
- `prompt.rules === false` → 规则段没注册：`prompt.error` 会写原因（宿主没有 `systemPrompt`
  服务 = 老宿主）。这时挂件与记账照常工作，只是模型收不到"要用方寸"的提示。
- `prompt.line` 一直是「方寸 · 未连接」→ 后台快照刷不到 `list_tasks`（方寸没开 / 管道名不对）；
  它每 60 秒自己重试，不会卡住模型调用。
- `proof.rows` 不涨 → 没有任何 `mcp__fangcun__*` 调用（真没调），或者 `session/event` 没收到
  （那就先看 `usage` 那一栏）。
- **`proof.turns`**（2026-11-05 起）是"联动到底发生了没有"的数字，几个数要一起看：
  `withEdit` = 真的改过文件的轮次；`readBeforeEdit` = 其中**先查了方寸**的（②7）；
  `wroteBack` = 动过方寸写工具的（②8）；`readOnly` = 只查了方寸、别的没动（②10 的可疑轮次）。
  `withEdit > 0 而 readBeforeEdit == 0` = 规则段没生效或模型没照做（先看 `prompt.rules`）。
  `open > 0` 且一直不降 = `turn/end` 没收到（事件链断了）。
- **`cards.lastCardId` 一直空** → 没有带 `id` 的方寸工具调用（`get_task/update_task/move_status/...`），
  或宿主把 `tool/call` 的 `arguments` 换成了别的形状（`cards ①` 会红）。
  它空着时挂件不会显示「本次在办」，`usage` 的 note 也不会带 `card=`。
- `usage` 里某轮的 note **没有** `card=`：要么那轮没动卡，要么卡号太长（note 上限 120 字）——
  `lib/usage.js` 的 `noteFor` 宁可整段不带，也不写半截 id。

环境变量：`FANGCUN_DATA_DIR`（数据根）、`FANGCUN_MCP_PIPE`（管道）、
`FANGCUN_PROJECT`（提示词那行只统计某个项目）、`DSH_HOME`（默认 `~/.dsh`）。

## 6. 发版

```powershell
git tag v<version> && git push origin v<version>
```

CI 会：校验 tag 与 `package.json.version` 一致 → `npm test` → `npm pack` →
验清单 → **解包真 apply 一次**（`test/smoke-packed.mjs`）→ 出 `SHA256SUMS.txt` → 建 Release。
runner 是 **`windows-latest` + Git Bash**：插件只支持 Windows，`detect` 测试按 Windows 路径断言；
换成 ubuntu 会在 3 条 detect 用例上假红（2026-11-07 首跑踩过）。

- tag 与版本不一致是最常见的翻车点：更新器会认为"没更新"；
- 发完要**复核资产**，不许只看"工作流是绿的"：
  `gh release view v<version> --json tagName,isDraft,assets`；
  同时 `npm view dsh-fangcun version` 核对 npm 那一路真的发布了；
- **双通道分发**（契约 REV-006）：npm 公开包 `dsh-fangcun` + GitHub Release
  （`.tgz` + `SHA256SUMS.txt`）。CI 由 tag 触发，两条通道发同一份代码；
- CI 的 npm 步骤由仓库 secret `NPM_TOKEN` 驱动（2026-11-07 已配好，token 来自用户的
  系统环境变量，npm 账号 `muyu46548`）。**secret 不落本地 `.npmrc`**；
  改了 token 就去 GitHub 仓库设置里替换，不要写进仓库或 README；
- README 的安装写法：`dsh-fangcun@<版本>`（npm），Release 的 `.tgz` 作为离线/兜底。
  不要再写"npm 不做"——那是 REV-004 的旧结论，已被 REV-006 推翻。
- **新包第一次发布有个"占位期"**（2026-11-07 实测）：registry 先出现
  `0.0.0-stage`（description 是 "Temporary package placeholder for staged publishing"），
  真正的 `0.3.0` 约 5 分钟后才可访问，`latest` 随后自动指过去。
  **不要因为 404 就重复 publish**，先轮询 `https://registry.npmjs.org/dsh-fangcun/<version>`；
  `0.0.0-stage` 是 npm 的名字预留，**不要 unpublish**。本机 npm 10.9.8 没有 `npm stage` 子命令，
  需要时用 `npx npm@latest stage ...`（12.x 才有）。

## 7. 维护检查表

**每次 DSH 升级**（用户 2026-11-17 拍板："能不能用随缘，插件永远只保适配版本"）：

1. **先看 `health.compat`**——它直接告诉你哪块 API 变了：
   `capabilities` 里哪项不是 `ok`，`warnings` 就是人话解释。
   这一步不需要重启插件（体检在 apply 时跑，重启后自动重算）。
2. `npm test` —— 单测不依赖宿主版本，主要防自己改坏。
3. 真机跑一轮，看 `health` 的 `usage` / `widget` / `prompt` / `tools` / `proof` 五栏。
4. **有缺口才修**，修完 +1 patch 发版。
5. ⚠ **不要为了"跟版本"去改 `engines.dsh` 的上界** —— 那会让升级后插件静默消失（事实 26）。
   `engines.dsh` 只有下限；`dsh.compatibility.dshReleases` 里可以加一行
   `"<新版本>": "verified"` 记录"我在这版验过"，但**它不参与加载判定**，纯记录。

**方寸契约变更**：`CONTRACT_VERSION` +1，改 payload 映射，补契约测试；不要靠"应该兼容"。

## 8. 还没解决的

1. `compaction/summary.usage` 该不该接（事实 10g）—— 缺一次真机压缩的对照。
2. 方寸月报界面还没人工确认过（文件层已确认 `origin=external`、`reported_by=dsh`）。
3. 会话压缩/恢复期之外的 turn 语义没再验过（现存结论：不回绕，见事实 10e）。
4. **0.3.0 的三件事只在单测里绿过**（规则段 / 一行现状 / 自证），真机要重启后按
   `health.prompt.rules`、上下文里那一行、`tools.jsonl` 三项复核；②⑦–⑩ 的验收也依赖它。
5. **2026-11-04 挂件"消失"已确认修好**（重启后 `probe.tb=40 / y=54`，右上角可见）。
   ⚠ **用户 2026-11-17 明确纠正过这条卡的前提**："桌面端挂件一直都在，都在了很多天了。哪有消失？"
   —— 那张卡后来还挂在"进行中"，标题本身在制造误判；真机 `health.widget.page` 2026-11-17 18:02 的证据是
   `mount` + `probe(in=1, hit=fc-todo-widget, tb=40)`，**没有 `removed`**。以后描述它要按证据说
   （"可见/被原生按钮区盖住/被摘掉"三种），不要再用"消失"这个词。剩下真正没确认的只有自由摆放那一条：
   **待真机确认**：解锁后拖到任意位置 → 松手就停在那、刷新还在、四角按钮仍能一键摆位。
6. **REV-005 的三件事（2026-11-05）只在单测里绿过**：逐轮度量（`health.proof.turns`）、
   卡号追踪（`cards.lastCardId`、`usage` note 里的 `card=`）、挂件「在办 / 待拍板 / 本次在办」。
   真机要重启后按三个点复核；`proof.turns` 从这一版装上才开始积累，头一天数字小是正常的。
7. **方寸侧还没确认 `usage_report` 的 `note` 会被落盘/可查**：`card=<卡号>` 已经发过去了，
   但"方寸账本能不能按卡汇总"要方寸那边给出结论（查不到就等于白带，不许在 README 里写成已实现）。
8. **看板死链（2026-11-07）**：本机 `.tegula-port` 是 2026-10-22 的 8791，PID 早退出；
   已改成"PID 不在就不给链接"（`plugin ⑩`）。真机重启后应看到：挂件面板不再出现「打开看板」，
   直到方寸的看板服务真的起来。挂件开合/点看板现在会写 `health.widget.page` 的
   `panel` / `board` 事件，用来分辨"点击没进来"和"链接打不开"。
9. ~~**0.4.0 的模型工具只在单测里绿过**~~ → ✅ **2026-11-17 18:11 真机验通**（事实 36）：
   四个工具全部注册上并真调成功。0.4.0 → 0.6.3 走了四版：
   0.6.0/0.6.1 零注册（`required` 写法错）、0.6.2 注册上但 `parameters` 撞 `title` 保留字
   把整轮对话打挂、**0.6.3 才真通**。
   **仍缺**：模型经宿主真调一次 `fangcun_*` → `tools.jsonl` 里出现记录（自证链最后一环）。
10. **`fangcun_write` 三条 action 现已在真机全通**（2026-11-17 19:50，事实 44）：
   `create`（18:13）、`update`（改正文后 `get_task` 确认）、`move`（待办↔草稿，`get_task` 报状态变）；
   三道验收闸也逐个真调过，**全部被拒**（`move→完成`、`update→驳回`、`create 带 status:完成`）。
   同一轮修过的 `create` 没转发 `status` 已由 0.6.4 修（事实 38）。

11. **自造校验器是这轮事故的病根**（`0.6.0`/`0.6.1` 两次都是"我自己写的校验器说通过了"）。
   现在 `scripts/check-packed-schema.mjs` 是**拿宿主 app.asar 里的真校验器**判的，
   而且**对打包产物判**（不是工作区）。发版前必跑；CI 里也已加一步。

12. ✅ **派单管子（0.6.5，2026-11-17 18:58 真机验通，没重启 DSH）**：消费端四个错已修（事实 39/40/41），
   用 `plugin_manager` 触发重组换上新代码后，放一份派单 → 12 秒内：
   `health.dispatch.lastOk=true`、会话落在 `sessions/--E-CODE-CangKu-dsh-fangcun--/fangcun-dispatch-…`
   （**项目仓库，不是 `_no-cwd`**，头里 `"cwd":"E:\\CODE\\CangKu\\dsh-fangcun"`）；
   会话事件序列 `agent/inbox/spliced → turn/start → step/start → system/message → user/message(上下文包,
   source.kind=user) → request/header → assistant/message → turn/end(completed)` —— **模型真的开口了**。
   ⚠ 那次自检会话（标题「方寸派单 · 开工 · dsh-fangcun」）是验证产物，可以在界面里删掉。
   另外**按钮本来就在**：本机安装包 `E:\Software\fangcun-desktop\resources\app.asar` 里
   `dist/main/ipc.js` / `dist/preload/index.js` / `dist/renderer/assets/index-*.js` 都含
   `context:dispatchDsh` 与「派给 DSH」——"界面入口还没有"这个旧判断是错的，别再按它排期。
   **仍没验过的**：真人在方寸界面上点那个按钮（这条只是用等价文件模拟的）、以及 `kind: plan` 的规划派单。

## 9. 文档地图

| 文件 | 给谁 | 管什么 |
|---|---|---|
| `README.md` | 用户 | 怎么装、装完看到什么、隐私边界 |
| `立项契约.md` | 决策 | 终态 / 验收线 / 不要什么 / 选型（变更走 REV） |
| `AGENTS.md` | agent（本文件） | 已核实事实、硬边界、不变量、怎么测怎么发 |
| `CHANGELOG.md` | 用户 | 每个版本改了什么 |
