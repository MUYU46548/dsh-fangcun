# AGENTS.md —— 在这个仓库开工前先读这一页

> 面向：接手本仓库的 agent（也包括未来的我）。
> 这里只放**已核实的事实**和**不容越界的规则**；写给用户看的东西在 `README.md`，
> 方向与需求在 `立项契约.md`。三者分工不要混。
>
> 本文件取代了旧的 `HANDOFF.md` 与 `PLAN.md`：那两份是施工期的临时单，
> 一份名字对公开仓库不合适，一份每次做完就过期（它曾经同时含两条错前提）。
> 内容已并入本文件，历史仍可用 `git log` 取回。

## 0. 一句话

把方寸（tegula）接进 DSH：**每轮把本会话 token 用量报回方寸账本**，**在 DSH 里看得到方寸待办**。
零依赖、只读、只走方寸的命名管道 MCP —— 不 import 方寸代码、不 import electron。

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

## 3. 两条链路（改之前先看懂数据怎么走）

**用量上报**：`session/event` → `UsageLedger.onSessionEvent`（按 `(sessionId, turn)` 聚合
`assistant/message`）→ `turn/end` 结算 → 本地 `outbox.jsonl` → 管道 MCP `usage_report` →
已发键落 `sent.jsonl`。方寸没开就攒在 outbox，60 秒重试。会话销毁时补结算半轮。

**待办挂件**：`apply()` 最前面订阅 `webserver/index-inject` → 推一行内联 script →
浏览器加载 `/fangcun/widget.js` → 拉 `/fangcun/api/tasks` → 经同一根管道 `list_tasks`（10 秒缓存）。

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
| 注入行是内联 script、无 `script-src`、不重复推 | `widget ①` |
| 只读路由：非本机 403、完成/驳回不算未完成 | `widget ③④` |
| health 只报能自证的事实、不泄凭据 | `plugin ⑤` |

## 5. 本地怎么跑

```powershell
npm test        # 32 条，不需要 DSH、不需要真方寸（真起假管道）
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
- `widget.pushed > 0 && widget.servedByPage == 0` → 行进了表但页面没执行；
- `fangcun.dataDir` 为空串 → 没找到方寸数据根，设 `FANGCUN_DATA_DIR`。

环境变量：`FANGCUN_DATA_DIR`（数据根）、`FANGCUN_MCP_PIPE`（管道）、`DSH_HOME`（默认 `~/.dsh`）。

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

## 9. 文档地图

| 文件 | 给谁 | 管什么 |
|---|---|---|
| `README.md` | 用户 | 怎么装、装完看到什么、隐私边界 |
| `立项契约.md` | 决策 | 终态 / 验收线 / 不要什么 / 选型（变更走 REV） |
| `AGENTS.md` | agent（本文件） | 已核实事实、硬边界、不变量、怎么测怎么发 |
| `CHANGELOG.md` | 用户 | 每个版本改了什么 |
