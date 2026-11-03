# dsh-fangcun —— 方寸 × DSH 插件

把 [方寸（tegula）](https://github.com/MUYU46548/fangcun) 任务看板接进 DSH：在 DSH 里看方寸待办，把本会话的 token 用量报回方寸账本。

> **现状 v0.2.0：用量上报 + 待办挂件都已实现，但还没在真 DSH 上跑过一轮。**
> 装上去打开 health 就能看到它自己承认的待办清单（`todo` 字段）—— 里面写着"哪些还没真机验证"。

**零依赖**：只用 Node 内置模块。不 import 方寸代码、不 import electron —— 这是两个仓互不锁死的前提。

## 安装

发版后（GitHub Release 的 `.tgz`）：

```powershell
dsh plugin --profile desktop add https://github.com/MUYU46548/dsh-fangcun/releases/download/v0.2.0/dsh-fangcun-0.2.0.tgz
```

本地开发（软链，改源文件立即生效，目录不能移动）：

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-fangcun
```

装完**重启 DSH**（桌面端要含托盘完全退出再开）—— 插件不进热更。

## 更新

跟**版本号**走，与仓库数量无关。装了 [dsh-plugin-updates](https://github.com/InariNGT-Ofiicial/dsh-plugin-updates) 的话，它每 24 小时从本仓的 GitHub Release 检查一次并自动安装；没装就手动重跑上面的安装命令。

两条硬规则：

1. **git tag 必须等于 `package.json.version`**（`v0.1.0` ↔ `0.1.0`）。更新器是拿上游 `package.json` 的包名/版本去核对 Release 的，差一个字符就认为"没更新"。
2. **Release 必须带 `.tgz` 资产**（可另附 `SHA256SUMS.txt`；有 SHA-256 digest 时更新器会校验）。

## 接口

`GET /fangcun/health.json`

```json
{
  "ok": true,
  "plugin": { "name": "dsh-fangcun", "version": "0.2.0" },
  "contract": { "version": 1, "usageTool": "usage_report", "tasksTool": "list_tasks" },
  "fangcun": {
    "dataDir": "E:/CODE/CangKu/fangcun",
    "source": "env",
    "found": { "registry": true, "taskData": true, "policies": true },
    "mcpPipe": "\\\\.\\pipe\\tegula-mcp"
  },
  "usage": { "outboxPending": 0 },
  "todo": ["桌面端真机验证：session/event 是否真收到、index-inject 行是否真进页面"]
}
```

数据根三处来源：环境变量 `FANGCUN_DATA_DIR` → `%APPDATA%/方寸/data-dir.json` → `%APPDATA%/Fangcun/data-dir.json`。**认不出来就返回空串**，不猜路径 —— 猜错会让插件对着空目录报"一切正常"。

## 用量上报（v0.2.0）

每轮结束（`turn/end`）把该轮的 token 经方寸的 MCP 工具 `usage_report` 报回账本：

| 字段 | 口径 |
|---|---|
| `prompt_tokens` | `inputTokens + cacheReadTokens`（缓存读也是输入侧 token；拆分写进 `note`） |
| `completion_tokens` | `outputTokens`（DSH 保证 reasoning ⊆ output，不重复计） |
| `cost` | **不发** —— DSH 只有 token、没有供应商报价；自己按价目表算是估算，不该塞进标着 "provider-reported" 的字段 |
| `client` | `dsh` |

三条保证：

1. **不丢**：方寸没开 / 管道断 → 记录落 `$DSH_HOME/dsh-fangcun/outbox.jsonl`，60 秒后与下次启动重试；
2. **不重**：幂等键 `sessionId#turn`，重复结算与进程重启后重放都只记一次（已发键落 `sent.jsonl`）；
3. **不吵**：任何失败只写 DSH 日志，绝不影响会话。

`health.usage.outboxPending` 是当前积压条数 —— 它长期为 0 才说明真的报上去了。

## 待办挂件（v0.2.0）

- **注入**：`webserver/index-inject` 推**一行内联 script**（绝不用 `script-src` —— 那个加载失败会让整个应用起不来），由它去加载 `/fangcun/widget.js` 并吞掉 `onerror`；
- **数据**：`/fangcun/api/tasks` 经方寸 MCP `list_tasks` 取，**只读**、10 秒缓存、**只给本机**（非回环 403）；
- **口径**：`完成 / 驳回` 不算未完成；**空状态算未完成**（没填 ≠ 做完）；
- **界面**：右下角一个角标「方寸 · N」，点开设面板列标题，60 秒刷新一次。

## 三条边界（越界即错）

1. **不 import 方寸的代码，也不 import electron。** 只走方寸的对外接口：命名管道 MCP（`\\.\pipe\tegula-mcp`）、`tegula` CLI、数据目录里的文件。测试里钉着，加一行 import 就红。
2. **只读方寸数据。** 要写方寸必须走 MCP 工具（方寸侧把关），不直接改 `task-data/`。
3. **不改 DSH 自己的配置。** 只声明自己的路由，不 patch 别人的 bundle。

## 怎么维护（写给未来的自己）

| 轴 | 谁在变 | 插件要动吗 | 判据 |
|---|---|---|---|
| **方寸契约** | `usage_report` / `list_tasks` 的字段 | 基本不用；改了才 +1 minor | 改 `CONTRACT_VERSION` + 补一条契约测试 |
| **DSH 宿主** | 0.2.1-rc 线还在动 | **要，这是主要成本** | 每升一个 DSH minor 跑一轮 `npm test` + 装一次实测，更新 `engines.dsh` 与 `dsh.compatibility.dshReleases` |
| **分发** | 你发版 | 不用 | 打 tag → CI 发 Release → 用户 24 小时内自动更新 |

一句话：**方寸改版不带动插件发版**，前提是插件只走 MCP、不读 `task-data/*.md`。反过来说，一旦有人图省事去直接读数据文件，这条就失效了。

## 路线

- **v0.1.0** ✅ 能装、能自报状态、CI 发版
- **v0.2.0** ✅ 用量上报：`session/event` 聚合每轮 token → 命名管道 MCP `usage_report`；本地 outbox + 幂等键
- **v0.2.0** ✅ 待办挂件：`webserver/index-inject` 内联 script + 只读路由 `list_tasks`
- **下一步** 真 DSH 跑一轮 → 打 tag 发 0.2.0
- **以后** npm 发布（需账号），与 Release 版本同源

## 开发

```powershell
npm test        # 契约测试（node --test）
npm pack        # 看发布包里到底装了什么
```

交接细节（已核实的 DSH 宿主形态、坑、验收判据）在 [HANDOFF.md](HANDOFF.md)。

## License

MIT
