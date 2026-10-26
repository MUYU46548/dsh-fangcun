# HANDOFF —— 把这个插件交给 DSH 自己写

> 写给接手的人/agent：这是 `fangcun-dsh` 的交接单。**先读这份，再读代码。**
> 2026-10-26，暮雨决定：骨架已经够用，剩下的交给 DSH 自己研究（它比我更清楚宿主的 API）。

## 一句话目标

把方寸接进 DSH：① 会话结束时把本会话的 token/金额报回方寸账本；② 在 DSH 里看方寸待办。

## 现状（已落地、已验证的部分）

| 文件 | 内容 | 谁验证过 |
|---|---|---|
| `package.json` | name `fangcun-dsh` / `type: module` / `dsh.bundle.patch` / `files` 白名单 | `scripts/test/e2e-dsh-plugin.cjs` |
| `cordis.patch.yml` | `- insert: [{ id: fangcun-dsh, name: fangcun-dsh }]` | 同上（id/name 必须等于包名） |
| `lib/index.js` | `export default { name, apply(root) }`；注册 `GET /fangcun/health.json` | 同上（假 root 真调 apply） |
| `README.md` | 安装/更新来源对照、接口示例、边界、已知未验证 | — |

`health` 只报**能自证的事实**：数据根从哪读到（env / appdata）、`registry.yaml` `task-data` `policies` 在不在、MCP 命名管道路径；**认不出数据根就返回空串，不猜路径**；并带 `todo` 字段列出还没做的三件。

## 已查实的 DSH 接口事实（这些就是目前全部的"文档"）

DSH 没有公开的插件 API 文档，下面几条是从一个真实插件（`MeteorNOX/DeepSeek-Balance-Whale-Widget`）的**实文件**里读出来的，可当事实用：

1. **安装源**：`dsh plugin --profile web add <npm 名 | github:owner/repo | link:<绝对路径> | file:<绝对路径>>`
2. **更新**：走 DSH 插件管理页拉新版本。**npm 源跟版本号；`github:` 源跟 main 当前状态**。
3. **DSH 不认子目录**：`link:.` 的前提是"仓库根目录本身就是插件包"。所以本插件必须**独立成仓**（或至少独立成 npm 包）。
4. **挂载声明**：`package.json` 的 `dsh.bundle.patch` 指向一个 YAML，内容是
   ```yaml
   - insert:
       - id: <包名>
         name: <包名>
   ```
   `id`/`name` 与包名不一致的症状是**装了但插件不出现**（宿主按名找模块）。
5. **插件导出形态**：`export default { name, apply(root) }`（不是 `export const name` + `export function apply`）。
6. **注册路由**：`root.inject(['webServer'], (ctx) => ctx.webServer.register(route))`。
   ⚠ 路由对象字段名按 `{ method, path, handler }` 写的，**未在真 DSH 上验证**；若宿主认 `route`，改 `ROUTES` 一处。
7. **桌面端注入前端脚本**：`root.on('webserver/index-inject', (table) => ...)`（参考实现用它推内联 script）。
8. **桌面端不能用 `--profile web`**：要在桌面端会话里让 DSH 用内置 `plugin_manager` 装。

参考实现（可直接读源码学形态）：`https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget`
—— 它的 `lib/index.js` 是宿主侧插件本体，`lib/accounting.mjs` 是记账内核，`cordis.patch.yml` 只有 2 行。

## 三条硬边界（越界就不许合）

1. **不许 import 方寸的代码**，也不许 import `electron`。只能走方寸的对外接口：
   命名管道 MCP（Windows `\\.\pipe\tegula-mcp`）、`tegula` CLI、数据目录里的文件。
   —— 这条是"两个仓互不锁死"的前提，`e2e-dsh-plugin.cjs` 里钉着，加一行 import 就红。
2. **只读方寸数据**。要写方寸必须走 MCP 工具（后面有人在把关），不直接改 `task-data/`。
3. **不改 DSH 自己的配置**。只声明自己的路由，不 patch 别人的 bundle。

## 待做三件（按价值排序）

### ① 会话结束把用量报回方寸（第一优先）

方寸侧**已经备好**接口：MCP 工具 `usage_report`，参数：

```jsonc
{
  "client": "dsh",              // 谁报的
  "model": "deepseek-chat",
  "prompt_tokens": 1200,
  "completion_tokens": 300,
  "cost": "0.0173",             // 可选；**只收人民币**，USD 会被拒（方寸不做汇率）
  "at": "2026-10-26T08:00:00Z", // 可选；默认服务端时间
  "note": "…"                   // 可选，120 字截断
}
```

服务端会：非负整数校验、空账拒绝、写进 `ai-trace.jsonl` 并标 `origin: 'external'`，
月报表里**单独计数**（不与方寸自己的调用混算）。

要做的事：找到 DSH 的会话结束/每轮结束事件，把该轮的 usage 取出来，经 MCP 调 `usage_report`。
**验收**：跑一轮 DSH 会话 → 方寸问答页月报表出现「其中 1 笔是外部上报」，金额与 token 对得上。

### ② 待办速览（次优先）

用 `root.on('webserver/index-inject', …)` 注入一小段前端脚本，显示"方寸待办 N 张 / 最近一条"。
数据只读。**验收**：DSH 界面上看得到数字，且点开能列出标题（不改方寸任何数据）。

### ③ 装/更新自检

照参考实现的 `/update-check.json` 形态：`{ ok, current, latest, hasUpdate, source }`，**点了才联网**。
**验收**：装旧版时自检提示有新版。

## 怎么自测（不需要先发 npm）

```bash
cd <本目录>
dsh plugin --profile web add link:$PWD      # 软链安装，改代码立即生效
dsh --profile web --dump-config | Select-String fangcun   # 确认已进 profile
# 重启 dsh web，然后
curl http://127.0.0.1:<端口>/fangcun/health.json
```

`health` 的 `dataDir` 为空串 = 没找到方寸数据根 → 设 `FANGCUN_DATA_DIR` 环境变量再试。

## 发到 npm（让全体 DSH 用户能更新）

```bash
npm version patch && npm publish        # version 必须递增，否则管理页认为没更新
```
包名 `fangcun-dsh` 目前**未占用**，第一次发布前先 `npm view fangcun-dsh` 确认。

## 从方寸仓拆成独立仓（保留历史）

仓库里这份代码在 `dsh/` 子目录，是**独立仓的种子**：

```bash
git subtree split -P dsh -b plugin-split
git push git@github.com:MUYU46548/fangcun-dsh.git plugin-split:main
```

拆完之后：本仓删掉 `dsh/`，插件自己的测试与发版都搬过去。**边界①守住的情况下，这一步没有耦合风险。**
