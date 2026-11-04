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

## 3. 四条链路（改之前先看懂数据怎么走）

**用量上报**：`session/event` → `UsageLedger.onSessionEvent`（按 `(sessionId, turn)` 聚合
`assistant/message`）→ `turn/end` 结算 → 本地 `outbox.jsonl` → 管道 MCP `usage_report` →
已发键落 `sent.jsonl`。方寸没开就攒在 outbox，60 秒重试。会话销毁时补结算半轮。

**待办挂件**：`apply()` 最前面订阅 `webserver/index-inject` → 推一行内联 script →
浏览器加载 `/fangcun/widget.js` → 拉 `/fangcun/api/tasks` → 经同一根管道 `list_tasks`（10 秒缓存）。
**位置**是客户端自己的事：四角之一存 `localStorage`（`fc-todo-widget:corner`），默认右上，
不占右下 —— 那一角是 `dsh-whale-widget` 的（事实 14）。
**拖动**默认上锁（`fc-todo-widget:locked`，只有存过 `'0'` 才是解锁）：解锁后按住圆点拖，
松手按落点吸到最近的角；位移 <6px 当点击。锁着的理由是圆点主要用来点开面板。收起后是带「方寸」
字样的小胶囊（只留一个 8px 的绿点，用户只会说"挂件没了"）。

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

**自证**：同一条 `session/event` 订阅里，`tool/call` 且名字以 `mcp__fangcun__` 开头 →
追加 `$DSH_HOME/dsh-fangcun/tools.jsonl`（只记时间/会话/轮次/工具名，不记参数；上限 500）。
契约 ②⑦–⑩ 的判据从这里读，不靠模型自述。

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
| 拖动**默认上锁**（解锁才拖得动）、手抖 <6px 算点击、拖完吞掉那一下 click | `widget-dom ⑪` |
| 挂件不安静消失：根节点被摘掉会**自动补挂**且不重复起轮询 | `widget-dom ⑫` |
| 页面自证：`boot/mount/probe/removed/error` 进 `health.widget.page`，只收本机 | `widget ⑤` |
| **没装本体 ≠ 没连上**：装机判定只看文件痕迹、结论进 health、挂件给下载入口 | `detect ①–⑥`、`widget ⑥`、`widget-dom ⑬⑭`、`prompt ④` |
| 注入行是内联 script、无 `script-src`、不重复推 | `widget ①` |
| 只读路由：非本机 403、完成/驳回不算未完成 | `widget ③④` |
| 规则段含四个触发点 + 「闲聊不查」；注册与撤销成对 | `prompt ①②` |
| 一行现状：格式对、未完成口径对、读快照不碰管道、方寸没开=未连接、provider 不抛 | `prompt ④⑤⑥⑦③` |
| 自证只记方寸工具、不记参数、脏 id 不记、有上限 | `prompt ⑧⑨` |
| apply 真的注册了提示词；没有 `systemPrompt` 服务时不假装成功、其它功能照旧；方寸工具调用落 `tools.jsonl` | `plugin ⑧⑨` |
| health 只报能自证的事实、不泄凭据 | `plugin ⑤` |

## 5. 本地怎么跑

```powershell
npm test        # 57 条，不需要 DSH、不需要真方寸（真起假管道）
npm pack        # 验发布包；CI 会把 tgz 解出来真 apply 一次
```

装进 DSH（开发态用 `link:`，改完**重启**才生效 —— 插件不进热更）：

```powershell
dsh plugin --profile desktop add link:<本目录绝对路径>
# 桌面端要含托盘完全退出再开
curl.exe http://127.0.0.1:<端口>/fangcun/health.json
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

环境变量：`FANGCUN_DATA_DIR`（数据根）、`FANGCUN_MCP_PIPE`（管道）、
`FANGCUN_PROJECT`（提示词那行只统计某个项目）、`DSH_HOME`（默认 `~/.dsh`）。

## 6. 发版

```powershell
git tag v<version> && git push origin v<version>
```

CI 会：校验 tag 与 `package.json.version` 一致 → `npm test` → `npm pack` →
验清单 → **解包真 apply 一次**（`test/smoke-packed.mjs`）→ 出 `SHA256SUMS.txt` → 建 Release。

- tag 与版本不一致是最常见的翻车点：更新器会认为"没更新"；
- 发完要**复核资产**，不许只看"工作流是绿的"：
  `gh release view v<version> --json tagName,isDraft,assets`；
- **分发只走 GitHub Release**（`.tgz` + `SHA256SUMS.txt`）。npm 不做了 ——
  账号注册这条路走不通，代价与收益不成比例（契约 REV-004）。
  CI 里那步 npm 用 `NPM_TOKEN` 门控，没有 secret 就自动跳过，**不要**去补这个 secret。
  README 里的安装地址必须是 Release 的 `.tgz`，不要写成 `包名@版本`（那需要 npm）。

## 7. 维护检查表

**每次 DSH 升级（minor）**：`npm test` → 装一次跑一轮看 health / sent / 挂件 →
更新 `package.json` 的 `engines.dsh` 与 `dsh.compatibility.dshReleases` →
失败就 +1 patch 发版，**不要**跳过版本号。

**方寸契约变更**：`CONTRACT_VERSION` +1，改 payload 映射，补契约测试；不要靠"应该兼容"。

## 8. 还没解决的

1. `compaction/summary.usage` 该不该接（事实 10g）—— 缺一次真机压缩的对照。
2. 方寸月报界面还没人工确认过（文件层已确认 `origin=external`、`reported_by=dsh`）。
3. 会话压缩/恢复期之外的 turn 语义没再验过（现存结论：不回绕，见事实 10e）。
4. **0.3.0 的三件事只在单测里绿过**（规则段 / 一行现状 / 自证），真机要重启后按
   `health.prompt.rules`、上下文里那一行、`tools.jsonl` 三项复核；②⑦–⑩ 的验收也依赖它。
5. **2026-11-04 真机回归：重启后桌面端挂件不见了**。已有的事实：脚本被取走过一次
   （`servedByPage=1`）、`/fangcun/api/tasks` 其后每 60 秒被调一次（说明脚本确实跑起来过、
   定时器还活着）、页面里却没有挂件 —— 指向"挂上去之后被摘掉 / 被盖住"。
   现在已加页面自证 + 自动补挂；**下次重启先看 `health.widget.page.events`**：
   有 `mount` 有 `probe` 且 `in=1` 就该能看见；有 `removed` 说明补挂逻辑要再看；
   有 `boot` 没 `mount` 就看 `error`。**拿到这段证据之前不要打 `v0.3.0` tag**。

## 9. 文档地图

| 文件 | 给谁 | 管什么 |
|---|---|---|
| `README.md` | 用户 | 怎么装、装完看到什么、隐私边界 |
| `立项契约.md` | 决策 | 终态 / 验收线 / 不要什么 / 选型（变更走 REV） |
| `AGENTS.md` | agent（本文件） | 已核实事实、硬边界、不变量、怎么测怎么发 |
| `CHANGELOG.md` | 用户 | 每个版本改了什么 |
