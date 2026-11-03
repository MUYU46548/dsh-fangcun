# HANDOFF —— 下一轮要做什么，以及**已经核实过的事实**

> 写给接手的 agent：先读这份，再读代码。事实部分都标了证据，**别再自己猜一遍**；
> 猜错的代价是"装了但插件不出现"这种要看宿主日志才能查的故障。

## 一句话目标

把方寸接进 DSH：① 每轮把本会话 token 用量报回方寸账本；② 在 DSH 里看方寸待办。

## 已核实的宿主事实（2026-11-03，从真插件源码读出）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 插件导出 `export default { name, apply(root) }` | `dsh-whale-widget/lib/index.js:723` |
| 2 | 局部等待服务：`root.inject(['webServer'], (ctx) => …)` | 同上 `:749` |
| 3 | 注册路由：`ctx.webServer.register({ kind: 'exact', path, handler })` | `dsh-keep-awake/lib/index.js:628`、whale `:3549+` |
| 4 | **路由没有 `method` 字段**，方法在 handler 里判 | 同上（两处 20 余条路由都是这个形状） |
| 5 | 往页面推行：`root.on('webserver/index-inject', (table) => table.push(row))` | whale `:735` |
| 6 | 行形状：`{ kind: 'script', placement: 'body', text }`（**内联**，不是 `script-src`） | whale `:744`、注释 `:706-717` |
| 7 | ⚠ **那张表是宿主启动时收集一次的**：订阅晚于收集，行永远进不去 | whale 注释 `:726-730`（#152/#153 的根因） |
| 8 | ⚠ **`script-src` 行加载失败会让整个应用起不来**（reject 掉 `__DSH_BOOT_READY__`） | whale 注释 `:709-716` |
| 9 | 用量钩子：`ctx.on('session/event', (sessionId, event) => …)` | whale `:1128` |
| 10 | ⚠ **签名是 `ctx.on('session/event', (session, event) => …)`：第一个参数是 Session 对象，不是 id 字符串**。id 在 `session.id`（= `session.header.id`） | ①应用内真实源码：`file-upload` 服务写的是 `ctx.on("session/event", (session, event) => this.observeSessionEvent(session, event))`，`session/disposed` 同形；`acp` 用 `sessions.get(session.header.id)`；`productAnalytics` 用 `session.id`。②反证：v0.2.0 把它当字符串用，真机 `sent.jsonl` 里 key 全是 `[object Object]#<turn>`，方寸账本 note 写着 `session=[object` |
| 10b | `event.data.usage` = `{ inputTokens, cacheReadTokens, outputTokens }`，`event.data.turn` 是轮次，`event.data.message.source.model` 是模型；`turn/end` 是结算点 | 同 10（whale `:944-989`） |
| 10c | 还有 `compaction/start`（`event.data.turn === null` 表示手动触发），可用来识别"压缩/恢复"这个 turn 可能回绕的时机 | `productAnalytics` 的 `context_compression` 上报 |
| 10d | 想收**所有** agent 的会话（含子代理）要传 `{ global: true }`：`ctx.on('session/event', fn, { global: true })`。`EventOptions.global` 原文是 "Receive the event regardless of context filter checks" —— 只是**放宽过滤**，不会重复投递 | `history follow` 里的 `disposeEvent` / `disposeCreated`；`Context.on` 的类型声明 |
| 10e | **`turn` 不会回绕**：它是 `const turn = phase.turn + 1`，而 `phase.turn` 在构造时由持久投影恢复 —— `const lastTurn = sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0`。压缩不动它，重启也不动它。**只有投影彻底缺失时才会从 0 开始**，而那基本等于新会话（新 sessionId） | `AgentLoop` 构造函数；`turnBoundary` 投影的 `apply`（`case 'turn/start': {...lastTurn: event.data.turn}`） |
| 10f | **宿主里没有 `subagent/start` / `subagent/end` 事件**。判子代理看 `SessionHeader`：`origin?: 'subagent'` / `parentSession?: SessionId` / `delegationDepth?: number`。事件表里只有 `subagent/descriptor` 与 `subagent/catalog` | 宿主 `SessionHeader` 类型声明原文；`SessionEventMap` 全表 |
| 10g | ⚠ **未解**：`compaction/summary` 自带 `usage?: TokenUsage`（压缩那次 LLM 调用的真实用量），我们现在**只收 `assistant/message`**，所以压缩花的 token 没进账。**但还不确定**它是否同时也体现为一条 `assistant/message` —— 生产端是用 spread 拼的对象，静态追不到。要判定只需真机跑出一次压缩，对比两边；**在那之前不要接**（接错就是多报账，比少报更糟） | `compaction/summary` 的类型声明；`compaction/start`/`end` 也带 `turn`（手动压缩时 `turn: null`） |
| 11 | 可选服务用 `ctx.get('x')` 读，**绝不能写进 inject**（老宿主没有那个服务，整插件会永远不 apply） | whale 注释 `:1181` |
| 12 | `dsh plugin` 只是 pnpm 的转发壳；装/更新都靠版本号 | `dsh plugin --help` 原话 |
| 13 | 更新器按 `package.json.repository` 找上游 Release / Tag | `dsh-plugin-updates` README |

**没验证过的一条**：`webserver/index-inject` 在**桌面端**是不是唯一注入通道（whale 注释说是，因为它读的是安装包里的静态 `index.html`，`tapIndex` 过不去）。真装一次就能确认。

## ① 用量上报（v0.2.0 已实现）

代码：`lib/usage.js`（聚合 + outbox + 幂等）、`lib/mcp-pipe.js`（管道客户端）、
`lib/index.js` 的 `apply()` 里订阅 `session/event` / `session/disposed`。
测试：`test/usage.test.mjs`（真起一个假方寸管道，5 组，13 条断言）。

**输入**：`session/event`（见事实 10）。按 `(sessionId, turn)` 聚合，`turn/end` 结算；会话销毁时补结算半轮。
**`session` 是对象**（事实 10）—— 取 id 走 `sessionIdOf()`，判子代理走 `isSubagentSession()`（事实 10f），
两者都认 `header`，测试里钉着。

**输出**：方寸 MCP 工具 `usage_report`（`desktop/src/main/mcp/tools.ts:159`）：

```jsonc
{
  "client": "dsh",
  "model": "deepseek/deepseek-v4.1-flash",
  "prompt_tokens": 1200,        // = inputTokens + cacheReadTokens（note 里写明拆分）
  "completion_tokens": 300,     // = outputTokens（DSH 保证 reasoning ⊆ output，不重复计）
  "note": "session=<id> turn=<n> cache_read=...",
  "at": "2026-11-03T05:00:00Z"
}
```

**不发 `cost`。** 方寸那个字段的语义是 "Provider-reported cost"（供应商报价），DSH 只给 token、没有 cost；自己按价目表算是**估算**，塞进去就是让账本说假话（方寸决策 D-054 同口径：token 是硬数据，元是推算）。

### 传输：直连命名管道，别绕

方寸的 MCP 是**换行分隔的 JSON-RPC 2.0 over named pipe**（`desktop/src/main/mcp/socket-server.ts:41-88`），最小客户端只需两步：

```
initialize   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dsh-fangcun","version":"0.2.0"}}}
tools/call   → {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"usage_report","arguments":{...}}}
```

- Windows 管道：`\\.\pipe\tegula-mcp`（方寸侧 `pipe.ts`）
- **不要**退回"读 `task-data/*.md`"：那会把方寸的数据格式演进变成插件的发版理由
- **不要** import 方寸的 TS

### 可靠性要求（都要有测试）

1. **方寸没开**（管道不存在 / 连接失败）→ 事件进本地 outbox（`$DSH_HOME/dsh-fangcun/outbox.jsonl`），下次启动或下一轮重试；**绝不丢、绝不抛**。
2. **幂等**：键 = `sessionId + turn`。重复结算（重试、压缩、崩溃恢复）只能记一次。
   - turn 是持久的（事实 10e），所以这个键成立；但如果真出现回绕，撞键会让整轮**静默消失**，
     所以 `finalize()` 在"回绕且撞上已发键"时**报错**（`⑨` 测试钉着：宁可吵，不可静默）。
3. **进程不背锅**：所有 I/O 失败只写 `ctx.logger.warn`，不能让 DSH 主流程感知到插件出错。
4. **outbox 有上限**（500 条）：超了丢最旧的并报错 —— 它每轮整份重写，无上限会拖死磁盘。
5. **非 GET 之外不暴露写接口**；插件自己不发任何网络请求。

**验收**：跑一轮 DSH 会话 → 方寸问答页月报出现 1 笔 `origin=external`，合计 token 与 DSH 侧一致。

## ② 待办挂件（v0.2.0 已实现）

代码：`lib/widget.js`（注入行 + 浏览器脚本）、`lib/index.js` 的路由与 `injectRow`。
测试：`test/widget.test.mjs`（4 组，路由与注入行形状）、
`test/widget-dom.test.mjs`（8 组，替身 DOM **真执行**脚本 —— 改挂件后必须跑这个）。

- `apply()` **最前面**注册 `root.on('webserver/index-inject', …)`（事实 7：晚注册就没了），
  push 一行**内联** `{ kind: 'script', placement: 'body', text: '<我们自己建 <script src=…> 并吞掉 onerror>' }`。
  **绝不用 `script-src`**（事实 8：加载失败会带走整个应用）。
- 脚本从插件自己的只读路由取数据（`list_tasks`，经同一根管道），**只读**，不改方寸任何数据。
- 路由套回环校验（非本机 403），10 秒缓存；`完成/驳回` 不算未完成，**空状态算未完成**。
- 看板地址来自数据根下 `.tegula-port` 的**第一行**（实测 8791；PLAN 里写的 8753 是旧值）。
  读不到就返回空串，挂件不显示入口。
- 深色主题走 `prefers-color-scheme`；展开/关闭状态存 `localStorage`；关掉后留小圆点可点回。
- 点条目只做**只读**动作（复制 id），不写方寸。

**验收**：DSH 界面看得到数字、点开能列标题；跑前跑后方寸 `task-data/` 逐字节不变。

## 本地怎么测（不需要先发版）

```powershell
# 1) 契约测试（不需要 DSH）
npm test

# 2) 装进 profile（软链）
dsh plugin --profile desktop add link:E:\path\to\dsh-fangcun
# 3) 完全退出 DSH（含托盘）再开
# 4) 打开 http://127.0.0.1:<端口>/fangcun/health.json
```

`dataDir` 为空串 = 没找到方寸数据根 → 设 `FANGCUN_DATA_DIR` 再试。

## 发版

```powershell
git tag v0.2.0 && git push origin v0.2.0
```

CI（`.github/workflows/release.yml`）会：校验 tag 与 `package.json.version` 一致 → `npm test` → `npm pack` → 出 `SHA256SUMS.txt` → 建 Release 挂上资产。

- 本地兜底：`gh release create v0.2.0 *.tgz SHA256SUMS.txt`
- tag 与版本不一致是最常见的翻车点：更新器会认为"没更新"
- npm 那一路（`NPM_TOKEN` secret）已经写进工作流但默认跳过，等有账号再开

## 还没验证的（真装一次才知道）

> **2026-11-03 首次真机验收结果**（重启后新会话，DSH web 端口 64528）：
>
> | 项 | 结果 | 证据 |
> |---|---|---|
> | 插件是否真加载 | ✅ | `GET /fangcun/health.json` → 200，`plugin.version=0.2.0` |
> | `session/event` 是否真派发 | ✅ | `~/.dsh/dsh-fangcun/sent.jsonl` 有 16 行，时间戳与真实对话轮次对得上 |
> | 方寸是否真收下 | ✅ | 方寸 `ai-trace.jsonl` 出现 `origin=external`、`reported_by=dsh`，token 与 sent 一致 |
> | 管道 | ✅ | `Test-Path \\.\pipe\tegula-mcp` → True |
> | 只读路由 | ✅ | `/fangcun/api/tasks` → `total=114`；`/fangcun/widget.js` → 200 JS |
> | 挂件是否进页面 | ✅ | **不需要眼睛**：`/fangcun/api/tasks` 返回的缓存戳在 07:38:13 刷新，而我的下一次请求是 07:38:18 —— 中间我没有发过请求，说明**页面里的挂件自己在按 60 秒轮询**。注入行确实进了 Desktop 的页面并执行了（`webserver/index-inject` 在桌面端可用，这条疑问结案） |
> | 方寸月报界面 | ⬜ 待看一眼 | 文件层已确认 `origin=external`，界面没截过图 |
>
> **本轮修掉的真 bug**：`session/event` 的 `(session, event)` 被当成 `(sessionId, event)`，
> 于是所有会话共用 `"[object Object]"`、幂等键互相顶掉 → 静默漏报。见 CHANGELOG。
> 教训：**照别人的用法抄，抄到的是用法不是签名** —— 事实要回到源码逐字看。

1. ~~桌面端是否真的收到 `session/event`~~ —— **已验：收到**（2026-11-03，`sent.jsonl` 有行）。
   同时发现签名是 Session 对象，已修。
2. ~~方寸月报是否把外部记录单列~~ —— **文件层已确认** `origin=external`、`reported_by=dsh`；
   问答页界面还没人工看过一眼（不影响账本正确性）。
3. ~~**`webserver/index-inject` 在桌面端的行为**~~ —— **已验：可用**（2026-11-03）。
   判法（不靠眼睛、也不靠 curl 说谎）：挂件每 60 秒自己来取一次
   `/fangcun/api/tasks`，所以只读接口的**缓存戳会在没人调用时自己往前跳**。
   观测到 `07:38:13` 的戳出现在我两次请求（`07:37:03` / `07:38:18`）之间 —— 页面确实在执行脚本。
   > 下一轮起可以直接读 `health.widget`：`pushed>0 && servedByPage>0` 就是同一条结论的机读版。
