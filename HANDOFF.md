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
| 10 | `event.type === 'assistant/message'` 时 `event.data.usage` = `{ inputTokens, cacheReadTokens, outputTokens }`，`event.data.turn` 是轮次，`event.data.message.source.model` 是模型；`turn/end` 是结算点 | whale `:944-989` |
| 11 | 可选服务用 `ctx.get('x')` 读，**绝不能写进 inject**（老宿主没有那个服务，整插件会永远不 apply） | whale 注释 `:1181` |
| 12 | `dsh plugin` 只是 pnpm 的转发壳；装/更新都靠版本号 | `dsh plugin --help` 原话 |
| 13 | 更新器按 `package.json.repository` 找上游 Release / Tag | `dsh-plugin-updates` README |

**没验证过的一条**：`webserver/index-inject` 在**桌面端**是不是唯一注入通道（whale 注释说是，因为它读的是安装包里的静态 `index.html`，`tapIndex` 过不去）。真装一次就能确认。

## 待做：① 用量上报（最值钱）

**输入**：`session/event`（见事实 10）。按 `(sessionId, turn)` 聚合，`turn/end` 结算。

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
initialize   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dsh-fangcun","version":"0.1.0"}}}
tools/call   → {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"usage_report","arguments":{...}}}
```

- Windows 管道：`\\.\pipe\tegula-mcp`（方寸侧 `pipe.ts`）
- **不要**退回"读 `task-data/*.md`"：那会把方寸的数据格式演进变成插件的发版理由
- **不要** import 方寸的 TS

### 可靠性要求（都要有测试）

1. **方寸没开**（管道不存在 / 连接失败）→ 事件进本地 outbox（`$DSH_HOME/dsh-fangcun/outbox.jsonl`），下次启动或下一轮重试；**绝不丢、绝不抛**。
2. **幂等**：键 = `sessionId + turn`。重复结算（重试、压缩、崩溃恢复）只能记一次。
3. **进程不背锅**：所有 I/O 失败只写 `ctx.logger.warn`，不能让 DSH 主流程感知到插件出错。
4. **非 GET 之外不暴露写接口**；插件自己不发任何网络请求。

**验收**：跑一轮 DSH 会话 → 方寸问答页月报出现 1 笔 `origin=external`，合计 token 与 DSH 侧一致。

## 待做：② 待办挂件

- `apply()` **最前面**注册 `root.on('webserver/index-inject', …)`（事实 7：晚注册就没了），
  push 一行**内联** `{ kind: 'script', placement: 'body', text: '<我们自己建 <script src=…> 并吞掉 onerror>' }`。
  **绝不用 `script-src`**（事实 8：加载失败会带走整个应用）。
- 脚本从插件自己的只读路由取数据（`list_tasks`，经同一根管道），**只读**，不改方寸任何数据。
- 路由要套回环/同源校验（照 keep-awake 的写法），别把"看板"变成任何网页都能读的接口。

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
git tag v0.1.0 && git push origin v0.1.0
```

CI（`.github/workflows/release.yml`）会：校验 tag 与 `package.json.version` 一致 → `npm test` → `npm pack` → 出 `SHA256SUMS.txt` → 建 Release 挂上资产。

- 本地兜底：`gh release create v0.1.0 *.tgz SHA256SUMS.txt`
- tag 与版本不一致是最常见的翻车点：更新器会认为"没更新"
- npm 那一路（`NPM_TOKEN` secret）已经写进工作流但默认跳过，等有账号再开
