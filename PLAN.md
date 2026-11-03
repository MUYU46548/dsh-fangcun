# 施工单 —— 下一轮（创造模式）照着跑

> 写给接手的 agent：这是 **dsh-fangcun 仓库**，你现在就在它根目录。
> 先读完这一页，再读 `HANDOFF.md`（已核实的 DSH 宿主事实与坑），然后从 **P0** 开始。
> 不要重新发明方案：版本、边界、验收判据都已经定过，改之前先说明为什么。

## 0. 现状（2026-11-03，事实）

| 项 | 状态 |
|---|---|
| 仓库 | https://github.com/MUYU46548/dsh-fangcun （`main`，独立仓，非 monorepo） |
| 版本 | `0.2.0`（已 push，**未打 tag、未发 Release**） |
| 已实现 | 用量上报（`lib/usage.js` + `lib/mcp-pipe.js`）、待办挂件（`lib/widget.js`）、只读路由 `/fangcun/health.json` `/fangcun/api/tasks` `/fangcun/widget.js` |
| 测试 | `npm test` → **17/0**（3 个文件：plugin / usage / widget，含真管道端到端） |
| CI | `.github/workflows/release.yml`（tag 触发；npm 那步用 `NPM_TOKEN` 门控，**目前没有 npm 账号，跳过**） |
| 本机安装 | 已 `dsh plugin --profile desktop add link:E:\CODE\CangKu\dsh-fangcun`，profile 的 `dependencies` 与 `dsh.profile.bundles` 都写好了；**还没重启过 DSH，所以还没真加载过** |
| 方寸侧契约 | MCP 工具 `usage_report` / `list_tasks`，命名管道 `\\.\pipe\tegula-mcp`，换行分隔 JSON-RPC |

**没验过的三件事**（这是 P0 的全部内容）：

1. 桌面端是否真的派发 `session/event`（代码按 `dsh-whale-widget` 的用法写，没在真宿主跑过）；
2. `webserver/index-inject` 推的行是否真的进页面（桌面端只在启动时收集一次表）；
3. 方寸月报是否把 `origin=external` 单列。

## 1. 硬边界（越界即错，测试里钉着）

- **不 import 方寸代码、不 import electron** —— 只走 MCP / CLI / 数据文件；
- **只读方寸数据**：写方寸必须走 MCP 工具，不直接改 `task-data/`；
- **不改 DSH 自己的配置**：只声明自己的路由；
- **绝不推 `script-src` 行**：加载失败会 reject 掉 `__DSH_BOOT_READY__`，整个应用起不来；
- **`webserver/index-inject` 必须在 `apply()` 最前面注册**：宿主启动时只收集一次；
- 零依赖（只用 Node 内置模块）；
- 不改 `dsh/`（那是方寸仓里的旧路径，已删，别在那边重建）。

## 2. P0 · 真机验收（第一优先级，先做这个）

**前置**：暮雨已经把插件装进 profile（`link:`），只需要他**含托盘完全退出再开**。他会做。

重启后按顺序验，全部用命令，不靠眼睛：

```powershell
# ① 插件真的被加载了（端口从 DSH 窗口地址里取，或用 netstat 找）
curl.exe -s http://127.0.0.1:<端口>/fangcun/health.json
# 期望：200，plugin.version=0.2.0，usage.outboxPending=0

# ② 方寸在不在（插件依赖它拿数据）
Test-Path '\\.\pipe\tegula-mcp'     # 期望 True

# ③ 聊两轮后，用量有没有报出去
Get-Content $env:USERPROFILE\.dsh\dsh-fangcun\sent.jsonl -Tail 3   # 期望有行，key 形如 <session>#<turn>
Get-Content $env:USERPROFILE\.dsh\dsh-fangcun\outbox.jsonl         # 期望空文件（有行 = 没发出去）

# ④ 方寸月报（人工看一眼）：问答页应出现 1 笔 origin=external，token 与 sent 里的一致
```

**失败分诊表**（照着查，别乱改）：

| 症状 | 大概率原因 | 先查 | 改哪 |
|---|---|---|---|
| health 404 | 插件没被加载 | profile `package.json` 的 `dsh.profile.bundles` 有没有 `dsh-fangcun`；DSH 启动日志 | `cordis.patch.yml` 的 id/name 是否等于包名 |
| health 200，但页面没角标 | `index-inject` 行没进页面 | 确认 `injectRow` 在 `apply()` 最前面（先于 `root.inject`）；宿主是否在启动时收集 | 若确认行进了表仍不显示，评估改用 client 插件（见 P4） |
| 角标显示"方寸未连接" | 管道名不对 / 方寸没开 | `Test-Path \\.\pipe\tegula-mcp`；`health.fangcun.mcpPipe` | 设 `FANGCUN_MCP_PIPE`（代码已支持） |
| `sent.jsonl` 没出现 | `session/event` 没派发（事件名/参数形状不对） | 在 `apply()` 里临时加 `root.logger.info` 打事件名（改完跑 `npm test`，提交前删） | 按实测事件名调整；仍不行就换 `agent/turn-stopping` 等钩子 |
| `sent` 有行但方寸没账 | `usage_report` 参数不合契约 | 用 MCP 手工调一次同参数（`mcp__fangcun__usage_report`） | 改 payload 映射；方寸侧改动要走 REV |

**P0 完成判据**：①②③ 全绿 + ④ 亲眼确认；把结果（含失败与修法）写回 `HANDOFF.md` 的"还没验证的"一节。

## 3. P1 · 发 0.2.0（P0 通过后再做）

1. `git tag v0.2.0 && git push origin v0.2.0`；
2. 等 CI，然后**复核资产**（不许只看"工作流是绿的"）：
   ```powershell
   gh release view v0.2.0 --json tagName,isDraft,assets
   # 期望：非草稿；有 dsh-fangcun-0.2.0.tgz 与 SHA256SUMS.txt；size 合理（约 11KB）
   ```
3. 把桌面端的 `link:` 换成 Release 包，验证"用户视角的安装"：
   ```powershell
   dsh plugin --profile desktop remove dsh-fangcun
   dsh plugin --profile desktop add https://github.com/MUYU46548/dsh-fangcun/releases/download/v0.2.0/dsh-fangcun-0.2.0.tgz
   ```
4. 重启后 `plugin_updates_check` 应能认出这个插件（source = package-repository）。

**判据**：Release 资产可下、装得上、health 正常；`tag == package.json.version`。

## 4. P2 · 用量上报的健壮性（P0 暴露的问题 + 已知缺口）

按价值排序，逐条做，每条配测试：

1. **子代理会话标记**：`subagent/start|end` 记录 sessionId，上报时 `note` 加 `subagent=1`（鲸鱼插件用法，`HANDOFF.md` 事实 9/10 附近）。判据：主/子会话各一轮，note 可区分。
2. **压缩/恢复后的 turn 重号**：DSH 压缩或会话恢复可能让 `turn` 从 1 重来 → 现有幂等键会把新轮误判成旧的。修法：键里带会话内的"纪元"（例如第一次见到的 session 起始时间），或改用 `(turn, 首个消息 id)`。**先写一条会红的测试复现，再改。**
3. **outbox 上限**：超过 N 条（建议 500）时丢最旧并 `onError` 一次，避免无限涨。
4. **失败可见**：health 增加 `usage: { pending, lastSentAt, lastError }`（现在只有 pending）。
5. **金额口径**：不动（继续只报 token）；若方寸将来加 `cost_estimated` 字段，走方寸 REV 后再接。

## 5. P3 · 挂件体验（有 P0 的结论再做）

- 深色主题：用 `prefers-color-scheme` 或站点 CSS 变量，别写死白底；
- 离线/空态文案已经区分（"方寸未连接" vs "没有未完成的卡"），补"点一下重试"；
- 展开状态记忆（`localStorage`），默认收起；
- 点条目：只做"复制 id / 打开方寸看板 `http://127.0.0.1:8753`"这类只读动作，**不写方寸**；
- 别让它挡住 DSH 自己的控件：位置可配置（右下/左下），或允许关闭（存 localStorage）。

## 6. P4 · 分发与长期维护

- **npm**：暮雨目前没有账号（注册被网络限制）。有号后：加 `NPM_TOKEN` secret → CI 自动双发；版本仍与 tag 同源。**不要**自己猜 token 或让用户贴凭据进仓库。
- **市场索引**（可选）：format 1 的自定义 index，固定到发布提交 SHA；不必须。
- **DSH 升级检查表**（每次 DSH minor）：
  1. `npm test`；
  2. 装一次、跑一轮、看 health / sent / 角标；
  3. 更新 `package.json` 的 `engines.dsh` 与 `dsh.compatibility.dshReleases`；
  4. 失败就 +1 patch 发版，**不要**跳过版本号。
- **方寸契约变更**：`CONTRACT_VERSION` +1，改 payload 映射，补一条契约测试；不要靠"应该兼容"。

## 7. 创造模式开场白（直接粘）

> 读仓库根目录的 `PLAN.md` 和 `HANDOFF.md`。先做 P0：确认 dsh-fangcun 0.2.0 已在 desktop profile 里（`link:` 安装），
> 让用户重启 DSH 后，按 P0 的命令验收三项（health / index-inject 角标 / sent.jsonl→方寸月报）。
> 任何一项失败，按失败分诊表查，修完补测试再报告。P0 全绿之前不要打 tag。
> 全程遵守 PLAN.md 第 1 节的硬边界。

## 8. 已完成、别再做的

- ~~拆仓~~（已 `git subtree split`，方寸仓已删 `dsh/`）；
- ~~改名~~（`fangcun-dsh` → `dsh-fangcun`，含 `cordis.patch.yml` 与测试）；
- ~~修路由形状~~（`{ kind: 'exact', path, handler }`，不是 `{ method, … }`）；
- ~~自建更新检查~~（交给 `dsh-plugin-updates`，只需发 Release）。
