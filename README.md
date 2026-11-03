<div align="center">

<h1>dsh-fangcun</h1>
<p><strong>让 DSH 里的 AI 真的围着方寸干活</strong></p>
<p>每轮把 token 用量记回方寸账本 · 在 DSH 里一眼看到还有多少卡没做完</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a085" alt="MIT 许可证"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-Windows%20桌面版-2F6FED" alt="DSH Windows 桌面版插件"></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-cb3837" alt="当前版本"></a>
</p>

</div>

**跑完一整晚，想知道这些会话到底烧了多少 token，还得自己开方寸一个月一个项目去核对。**

dsh-fangcun 是 [方寸（tegula）](https://github.com/MUYU46548/fangcun) 任务看板的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件。它做两件事：把 DSH 每一轮的 token 用量自动记回方寸账本，以及把方寸里没做完的卡显示在 DSH 界面右上角（位置可改）。不需要复制粘贴，不需要手记。

本项目是方寸的**附属项目**，需要先装好方寸才能用；它是 DSH 插件，不能单独运行。本项目使用 AI 辅助开发。

## 装进 DSH

**前提**：Windows 上的 DSH 桌面版（0.2.0-rc.2 或更新），并且方寸正在运行（插件靠它的命名管道取数据）。

1. 打开 DSH 的「插件 → 添加插件」。
2. 在「包名或地址」里填入下方地址，「安装源」保持默认。
3. 安装完成后**含托盘完全退出 DSH 再打开** —— 插件不进热更，不重启就不会加载。

```text
https://github.com/MUYU46548/dsh-fangcun/releases/download/v0.2.0/dsh-fangcun-0.2.0.tgz
```

也可以下载 [同目录的发布包](https://github.com/MUYU46548/dsh-fangcun/releases) 后用本地路径安装，或用命令行：

```powershell
dsh plugin --profile desktop add https://github.com/MUYU46548/dsh-fangcun/releases/download/v0.2.0/dsh-fangcun-0.2.0.tgz
```

> 建议把安装和更新都交给 DSH 里的 Agent 处理：它自己能装、能查 health、能判断装没装好。
> 插件更新由 `dsh-plugin-updates` 负责 —— 只要本仓库发了新的 Release，它就能认出来，不需要你再手工下载。

**装完怎么确认？** 浏览器打开 `http://127.0.0.1:<DSH 端口>/fangcun/health.json`，应当看到 `"ok": true` 与 `"version": "0.2.0"`。端口从 DSH 窗口地址里取。

## 装完你会看到

### 右上角多了一个小圆点（四个角随便挑）

点开就是方寸里**没做完**的卡（完成和驳回的不算，状态空着算没做完）。点条目复制卡号，点「打开看板」直接去方寸本体看。

- 跟着系统深浅色走，深色模式下不是白底；
- 默认收起，不挡 DSH 自己的控件；展开状态会记住；
- **位置自己挑**：面板底部有「位置：右上 右下 左下 左上」，点一下就地挪过去，选择会记住。
  默认**右上角** —— 右下角留给别的挂件（比如那只鲸鱼），插件之间不抢同一块地方；
- 嫌它碍事就点「收起挂件」—— 会缩成一个小圆点，点一下还能回来。

### 账本自己长出来

每轮对话结束，这一轮用掉的 token 自动记进方寸账本，带 `origin=external` 标记，和方寸自己花的钱分开。方寸没开着也不丢：记录先攒在本地，60 秒后重试。

**只报 token，不报金额。** DSH 只给 token 数，没有供应商报价；自己按价目表算出来的是估算，塞进标着"供应商报价"的字段里就是让账本说假话。要折算成钱，请在方寸侧按自己的口径做。

## 它不做什么

| 不做 | 为什么 |
|---|---|
| 不读方寸的 `task-data/*.md` | 只走方寸对外的 MCP 接口，方寸改数据格式不用重发插件 |
| 不改方寸的任何数据 | 全程只读；要看要改，去方寸本体 |
| 不发任何网络请求 | 只连本机的命名管道 |
| 不碰 DSH 的配置 | 只声明自己的三个只读路由 |
| 不让局域网访问 | 路由只回本机请求，其他来源一律 403 |

插件本身零依赖，只用 Node 内置模块。

## 配置

一般不用配。下面两个环境变量是给多机部署或非默认路径用的：

| 变量 | 作用 | 默认 |
|---|---|---|
| `FANGCUN_DATA_DIR` | 方寸数据根（认不出时 health 里 `dataDir` 会是空串） | 读 `%APPDATA%\方寸\data-dir.json` |
| `FANGCUN_MCP_PIPE` | 方寸 MCP 管道路径 | Windows `\\.\pipe\tegula-mcp` |

## 出问题了

| 症状 | 先看 | 怎么办 |
|---|---|---|
| 装完界面没变化 | `health.json` 是否 200 | 没重启，或插件没进 profile；**含托盘完全退出**再开 |
| 圆点上写着「方寸未连接」 | 方寸是否在跑 | 启动方寸；点一下圆点可重试 |
| 账本里没有记录 | `health.usage` 的 `outboxPending` / `lastError` | 有积压 = 方寸没开或管道名不对；`lastError` 会写明原因 |
| 看板入口不见了 | 方寸看板启动过没有 | 插件按方寸自己记的端口给链接，没记过就不显示，不会给你一个打不开的地址 |
| 界面底部出现**一大段纯文本**（「方寸 · N」跟一串待办） | 0.2.0 的样式 bug | 升级到 0.2.1：样式表没挂进页面，挂件退化成正文。修完是右上角一个小圆点 |
| 小圆点挡住了别的东西 | 挂件位置 | 点开面板，底部「位置」四选一，点完立刻挪走并记住 |

排查都以 `health.json` 为准 —— 它报的是插件能自证的事实，不猜。

## 交流与支持

- **[提交问题或建议](https://github.com/MUYU46548/dsh-fangcun/issues)**：带上 DSH 与插件版本、`health.json` 内容、复现步骤。
- **如果喜欢本项目，欢迎到[爱发电](https://afdian.com/a/muyu46548B?utm_source=copylink&utm_medium=link)支持作者！**

## 文档与开源

[更新记录](CHANGELOG.md) · [MIT 许可证](LICENSE) · [方寸本体](https://github.com/MUYU46548/fangcun)

本插件的本地数据都在 `%USERPROFILE%\.dsh\dsh-fangcun\`：`sent.jsonl` 是已上报的记录，`outbox.jsonl` 是还没发出去的积压。删掉它们不会影响方寸里的任何数据。

随着 DSH Windows 桌面版的版本变化，本插件可能不再适用。作者会尽快跟进新版 DSH，但不为可用性提供担保。
