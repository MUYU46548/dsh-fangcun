# 变更记录

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

## 0.1.0（2026-11-03）

首个版本，只做「能装 + 能自报状态」，不假装功能齐了。

- `GET /fangcun/health.json`：报方寸数据根来源、`registry.yaml` / `task-data` / `policies` 是否存在、MCP 管道路径、契约版本，以及还没做的两件事
- 路由按 DSH 真实形态注册：`{ kind: 'exact', path, handler }`（修正骨架期写的 `{ method, … }`）
- 数据根认不出时返回空串，不猜路径
- 零依赖（只用 Node 内置模块）；不 import 方寸代码、不 import electron
- CI：tag 触发 → 校验版本一致 → 测试 → `npm pack` → 发 GitHub Release（附 SHA256SUMS）
