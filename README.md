# fangcun-dsh —— 方寸 × DSH 插件

把方寸接进 DSH：在 DSH 里看方寸待办、把本会话的用量报回方寸账本。

> **现状：骨架阶段。** 现在能装、能自报状态（`/fangcun/health.json`），
> 但「用量上报」和「待办挂件」还没写 —— 见下面「还没做」。
> 装上去打开 `/fangcun/health.json` 就能看到它自己承认的待办清单。

## 安装

```bash
# npm 已发布版（推荐：能跟随版本更新）
dsh plugin --profile web add fangcun-dsh

# 从 GitHub
dsh plugin --profile web add github:MUYU46548/fangcun-dsh

# 本地开发（软链，改源文件立即生效；目录不能移动）
dsh plugin --profile web add link:<本目录的绝对路径>
```

装完重启 `dsh web`；桌面端要**含系统托盘完全退出**再开。

- ⚠ npm 名与 `github:` 是**同一个包名**，两个来源别混装；切换前先
  `dsh plugin --profile web remove fangcun-dsh`
- ⚠ 桌面端不能用 `--profile web`，要在桌面端会话里让 DSH 用内置 `plugin_manager` 装

## 更新

跟着**版本号**走，跟仓库数量无关：

| 安装方式 | 更新怎么来 |
|---|---|
| npm | DSH 插件管理页的更新入口 → 拉 npm 上的新版本 |
| `github:` | 拉 main 当前状态（不跟随已发布版本） |
| `link:` | 改源目录立即生效 |

所以「能让全体 DSH 用户及时拿到新版」靠的是**发到 npm 并递增 version**，
不是「有没有独立仓库」。独立仓库的价值在别处（见根目录记忆里的判断）。

## 接口

`GET /fangcun/health.json`

```json
{
  "ok": true,
  "plugin": { "name": "fangcun-dsh", "version": "0.1.0" },
  "fangcun": {
    "dataDir": "E:/CODE/CangKu/fangcun",
    "source": "env",                       // env / appdata:方寸 / none
    "found": { "registry": true, "taskData": true, "policies": true },
    "mcpPipe": "\\\\.\\pipe\\tegula-mcp"
  },
  "todo": ["会话结束把用量报回方寸（需要 DSH 会话事件钩子）", "..."]
}
```

数据根的三处来源：环境变量 `FANGCUN_DATA_DIR` → `%APPDATA%/方寸/data-dir.json` →
`%APPDATA%/Fangcun/data-dir.json`。**认不出来就返回空串**，不猜路径 ——
猜错会让插件对着空目录报"一切正常"。

## 三条边界

1. **不许 import 方寸的代码。** 只走对外接口：命名管道 MCP、`tegula` CLI、数据目录文件。
   这条是"能独立拆仓"的前提；一旦 import 了方寸 TS，两个仓就锁死了。
2. **只读方寸数据。** 要写就走 MCP 工具（后面有人在把关），不直接改 `task-data`。
3. **不改 DSH 自己的配置。** 只声明自己的路由，不 patch 别人的 bundle。

## 还没做

| 件 | 依赖什么 | 说明 |
|---|---|---|
| 会话结束把用量报回方寸 | DSH 的会话事件钩子（现有插件是靠监听本机会话事件拿 usage 的） | 方寸侧已经备好 MCP 工具 `usage_report`（只收人民币、空账不写、标 `origin=external` 单独计数） |
| 待办速览挂件 | `root.on('webserver/index-inject', …)` 注入前端脚本 | 数据只读，不写方寸 |
| 装/更新自检 | npm latest 对比 | 照 DSH 现有插件的 `/update-check.json` 形态：点了才联网 |

## 已知未验证

- 路由对象的字段名按 DSH 现有插件的写法取 `{ method, path, handler }`。
  **还没在真 DSH 上跑过**；若宿主认 `route` 而不是 `path`，改 `lib/index.js` 的 `ROUTES` 一处即可。
- 图标还没做（做一张 PNG，在 `package.json` 加 `icon` 字段，并加入 `files`）。
