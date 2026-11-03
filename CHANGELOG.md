# 变更记录

## 0.1.0（2026-11-03）

首个版本，只做「能装 + 能自报状态」，不假装功能齐了。

- `GET /fangcun/health.json`：报方寸数据根来源、`registry.yaml` / `task-data` / `policies` 是否存在、MCP 管道路径、契约版本，以及还没做的两件事
- 路由按 DSH 真实形态注册：`{ kind: 'exact', path, handler }`（修正骨架期写的 `{ method, … }`）
- 数据根认不出时返回空串，不猜路径
- 零依赖（只用 Node 内置模块）；不 import 方寸代码、不 import electron
- CI：tag 触发 → 校验版本一致 → 测试 → `npm pack` → 发 GitHub Release（附 SHA256SUMS）
