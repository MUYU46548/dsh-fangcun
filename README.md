# dsh-fangcun —— 方寸 × DSH 插件

把 [方寸（tegula）](https://github.com/MUYU46548/fangcun) 任务看板接进 DSH：在 DSH 里看方寸待办，把本会话的 token 用量报回方寸账本。

> **现状 v0.1.0：骨架。** 现在能装、能自报状态（`/fangcun/health.json`），
> 但「用量上报」与「待办挂件」还没写 —— 见 [路线](#路线)。
> 装上去打开 health 就能看到它自己承认的待办清单（`todo` 字段），不假装功能齐了。

**零依赖**：只用 Node 内置模块。不 import 方寸代码、不 import electron —— 这是两个仓互不锁死的前提。

## 安装

发版后（GitHub Release 的 `.tgz`）：

```powershell
dsh plugin --profile desktop add https://github.com/MUYU46548/dsh-fangcun/releases/download/v0.1.0/dsh-fangcun-0.1.0.tgz
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
  "plugin": { "name": "dsh-fangcun", "version": "0.1.0" },
  "contract": { "version": 1, "usageTool": "usage_report", "tasksTool": "list_tasks" },
  "fangcun": {
    "dataDir": "E:/CODE/CangKu/fangcun",
    "source": "env",
    "found": { "registry": true, "taskData": true, "policies": true },
    "mcpPipe": "\\\\.\\pipe\\tegula-mcp"
  },
  "todo": ["把本会话 token 用量经 MCP usage_report 报回方寸（v0.2.0）", "..."]
}
```

数据根三处来源：环境变量 `FANGCUN_DATA_DIR` → `%APPDATA%/方寸/data-dir.json` → `%APPDATA%/Fangcun/data-dir.json`。**认不出来就返回空串**，不猜路径 —— 猜错会让插件对着空目录报"一切正常"。

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
- **v0.2.0** 用量上报：`session/event` 聚合每轮 token → 经命名管道 MCP 调 `usage_report`；本地 outbox + 幂等键（方寸没开也不丢、不重记）
- **v0.2.0** 待办挂件：`webserver/index-inject` 推内联 script + 只读路由取 `list_tasks`
- **以后** npm 发布（需账号），与 Release 版本同源

## 开发

```powershell
npm test        # 契约测试（node --test）
npm pack        # 看发布包里到底装了什么
```

交接细节（已核实的 DSH 宿主形态、坑、验收判据）在 [HANDOFF.md](HANDOFF.md)。

## License

MIT
