# 变更记录

## 0.7.8（2026-11-24）· 四个提议口 + 派单权限可配

> 对应方寸 `6dc0dc1`（0.7.9）、2026-11-23 问卷《方寸-决策机制三岔路》的 K1 / K3。

- **`fangcun_write` 从 3 个 action 扩到 7 个**（K3 答案 A：四个口一起补）。
  这是「AI 从不拿决策问我」的**机器真因**：技能卡 `fangcun-bridge` ①.9 早就写着
  「有 ≥2 件要拍板 → 用 qn_propose 出卷」，而工具表里没有这个口。
  实测插件日志 500 条 / 14 个会话，问卷类调用 **0 次** —— 技能教了，工具没有。
  - `qn_propose` → 落一份待答的卷（每题 id / ≥2 选项 / 每选项写代价 / 每题写验收线）
  - `decision_propose` → 只落「待审批」（**不是** `decision_record`：名字要说出它只能提议）
  - `stage_plan_propose` → 落「待裁决」阶段卡（三块缺一不可，判据必须带 `cmd:`/`str:`/`num:`/`file:`）
  - `smap_propose` → 落「待审批」卡，不碰 `policies/`，mapText 必须带 `最后核实：YYYY-MM-DD`
  - 四个口**参数在插件侧先校验一遍**：让模型一次写对，而不是撞墙后拿报错返工。
  - ⚠ 四个口**都只能落草稿态**，谁都不能自批 —— 这是它们存在的正当性前提。
- **新增设置项 `dispatchPreset`**（方寸第 3 条：「能不能让用户改派单任务的默认权限？」）。
  答案：**权限档就是 Agent 预设档**，所以只需要决定"这一单用哪一档"，
  **不用碰 DSH 的 Agent 预设本体**（原话「DSH的Agent预设太复杂，别去碰它」）。
  留空 = 跟宿主当前默认档走（推荐，也是出厂行为）；填了就用那一档。
  优先级：设置页显式指定 > 宿主默认档 > 不传。

### 0.7.8 补丁（2026-11-25）· 派单退化成空手的根因 + 「算了却不显示」

> 暮雨 2026-11-24：「A 居然还没修好，我快吐了。」

- **真 bug：派单会静默退化成"只有插件工具"**（容器 `948feaa9`）。两个都读了宿主
  `@deepseek-ai/dsh-agent-preset-registry` 的实现才查出来：
  - ① 用**空串**调 `presets.resolve(wanted)`，而宿主是 `id ?? this.defaultId` ——
    `'' ?? x` 等于 `''`，于是 `Unknown agent preset:` 异常被外层 `catch` 静默吞掉，
    `agentPreset` 留空 → 不传 `meta.agentPreset`、不传 `setup` → 空手；
  - ② `list()` 的返回项**根本没有 `isDefault` 字段**，`find(x => x.isDefault) || rows[0]`
    永远退化成 `rows[0]`，而 rows 按 order 排，第一个不是默认档。
  - 修法按权威程度来：`defaultId` → `resolve()` 不带参 → `list()` 只认 `isDefault === true`，
    查不到就**不猜**。抽成纯函数 `resolveDispatchPreset()` 便于真跑断言。
- **每次派单成功落一行 `dispatch-capability`**（`audit.jsonl`），写明本单实际挂到哪个档；
  解析不到时 `presetResolved: false` 并说明「只有插件工具」，**不冒充成功**。
- **界面补上「工具档」那一行**（2026-11-25）：`presetResolved` 早就写进 health 了，
  但 `client.js` **一次都没渲染过** —— 界面上「派单成功」和「派单成功但空手」长得一模一样。
  现在三种状态分开说：挂上了哪一档 / ⚠ 这单没有文件/终端工具 / 老插件不猜。
- **治理「判据不可复跑」这个病本身**（本轮顺手抓到的）：
  - `npm test` 点名了 16 个文件（此前只点 14 个，`dispatch-preset` / `dispatch-capability`
    **压根没跑**，而卡上写着"全量 182/0"）；现在全量 **184/0**。
  - `test/layering.test.mjs` 新增守卫 ⑥：扫 `test/*.test.mjs`，任何文件没被 `npm test`
    点名就红（反例：抹掉那两个 → 精确红并指名道姓）。
  - `test/client.test.mjs` 新增 ⑤：真调用 `presetLabel`，钉住"空手必须明说"。
    ⚠ 这一条的第一版**是假绿**：它只匹配到三元条件那一处，把渲染值换成写死的
    `'派单成功'` 照样绿 —— 反例自证当场抓出，已改成钉 `styles.value` 后面那个位置。

## 0.7.7（2026-11-22）· 运行时上下文不再每分钟重发

- **agent 那一行不带时间戳**：`systemPrompt.context` 原来是
  `全部项目 · 未完成 N 张 · 截至 HH:MM`，而快照每 60 秒刷新一次 →
  DSH（`dsh-agent-loop` 的运行时上下文）逐字比较 section 文本，**每分钟都判定“变了”** →
  每分钟往会话里追加一条 `<system-reminder>`，把 DSH 自带时钟的 10 分钟节流完全绕过。
  现在注册给 agent 的是 `全部项目 · 未完成 N 张`（数字 / 连接状态 / 项目变了才变）；
  给人看的 health 那一行仍保留 `截至 HH:MM`（“最后一次成功是什么时候”只在那边有用）。
- **修 `PLUGIN_VERSION` 漂移**：`lib/index.js` 还写着 `0.7.5` 而 package.json 已是 `0.7.6`
  （health 会自报错版本）→ 统一到 `0.7.7`；既有测试当场抓到。

## 0.7.6（2026-11-21）· 派单会话真的挂上工具档

- `openSession()` 除了把 `agentPreset` 写进会话头，还传
  `setup: (agentCtx) => presets.mount(agentCtx, preset)` —— 只写头不 mount 的会话会落到空壳档：
  会话头写着 `standard`，实际只有板子工具。
- 真机验收：派一单三件事（读文件 / 写卡 / 跑脚本）**3/3**。

## 0.7.5（2026-11-21）· 派单会话带默认工具档

- 建会话前用 `agentPresets.resolve()` 取宿主当前默认档写进 `meta.agentPreset`；
  解析失败不传（退回宿主默认，不丢单）。

## 0.7.4（2026-11-21）· 兼容表补 0.2.2-rc.5

- `dsh.compatibility.dshReleases` 补登记 `0.2.2-rc.5: compatible`（本机实测：插件加载、MCP 管道读写、
  设置页/客户端半都在；派单尚未实跑，所以标 `compatible` 而不是 `verified`）。
- 目的：方寸插件页不再把当前 DSH 基座标成 `unknown`（那是“没登记”，不是读取失败）。
- 功能代码未改；仅包版本与兼容声明。

## 0.7.3（2026-11-20）· 派单签名 + 可调限流

- **只消费方寸 GUI 签名的派单**：`source=gui` + `nonce` + HMAC；未签名/篡改 → `rejected/` + 审计，
  不再见文件就开会话。
- **默认限流**：同一时间 10 个、冷却 0、每日不限（0 = 不限）；DSH 设置页「派单限流」可调。
- **审计**：`.dispatch-dsh/audit.jsonl` 记 source(gui/agent)/kind/project/sessionId/at/reason；
  health 暴露 `lastReject/todayCount/dailyCap/cooldownMs/concurrency/secretFound`。
- **签名密钥**：`%APPDATA%/方寸/dispatch-secret`（userData，不在数据根）；插件找不到就拒绝，不退回无签名直开。
- 保留 0.7.2 的记忆开关 / 核心预算行为；MCP 工具与路由不变。

## 0.7.2（2026-11-20）· 记忆开关 + 核心预算 2000→800

方寸 v2 把记忆改成 `claim + evidence` 两层，并加了默认开启的记忆开关。插件这一版只跟着改两处：

- **认 `memory_core.enabled`**：方寸关掉记忆时，`fangcun_context` 说
  「记忆核心（已关闭）—— 在方寸 → 设置 → 通用 → 记忆 里开启」；
  **不再**把「关掉」渲染成「core.md 还没写」。
- **核心预算 2000→800**：方寸 v2 的 `core.md` 由钉住的 claim 生成（≤800 字），
  插件 schema / 渲染 / 测试同步。
- `shapeContext` 新增 `memoryEnabled`；`output.schema.required` 同步；
  `tool ⑦/⑦b/⑦d` 覆盖开 / 拉失败 / 关三种状态。

## 0.7.1（2026-11-19）· `fangcun_context` 注入固定记忆核心（不是动态 top-N）

用户 2026-11-17：「方寸要管记忆，**当 DSH 的记忆层**」「你做之前真的有看过其他家的记忆是怎么实现的吗？」
用户 2026-11-19 追问：「后期等几十万字每次注入上下文？记忆做的时候就没规划好。」

### 一、context 第五处：`memory_core`（固定核心，≤2000 字）

`fangcun_context` 原来并行拉四处（章程 / 决策 / 未结卡 / 最新日志）。第五处只拉
**固定核心** `memory/core.md`：人工维护、硬上限 2000 字、只放编号与一句话；
归档（事故/教训全文）**不自动注入**，只报「另有 N 条」，要细节模型自己
`memory_search` / `memory_read`。

- 抄的是 **Letta core memory**（核心块小、常驻、字符受限、少而精）+ **Claude memory tool** 的
  just-in-time（完整归档按需取）；不再把动态 top-5 当"核心"塞进每次开工。
- **拉失败 ≠ 没有记忆**：老版方寸没有 `memory_core` 时，`memoryUnavailable=true`，
  渲染成「没拉到记忆核心，这不等于没踩过坑」，不许说成"这个项目很干净"。
- 待审批 / 已撤销不进核心（它们不算数）。
- `memory_briefing` 保留为**按需检索**工具，不再由 context 自动调用。

### 二、逐轮度量补 `editFirst`（与记忆层同一版发出）

- `lib/proof.js` 的 `verdictOf` 新增 `editFirst = editAt === 1 && 首工具∈EDIT_TOOLS`，
  `health.proof.turns` 单列；`cards ③f` 钉住。真机 309 轮：`editFirst 18 / 5.9%`。
- 为什么：`readBeforeEdit` 29.5% 看着像规则失效，拆开看"上来就改"的只有 7.6%；
  其余多是"上一轮已经查过"的续作轮次。指标改成可行动的那个，**不据此改提示词**。

### 三、验证

- `npm test`：**152/152**（`tool ⑦` 并行名单五处 + 固定核心渲染 / `memoryUnavailable`；`cards ③f`）；
- 真机（DSH 2026-11-19 重启后 0.7.1）：`health.proof.turns.editFirst=18`；
- 桌面端 `e2e-memory`：**76/0**（固定核心 ≤2000 字、core.md 不进归档、检索默认 20 条、
  简报 5 条、摘要跳过标题、memory_read 截断、待审批/驳回）。

### 四、review 时修的两处口径

1. **初版把动态 `memory_briefing` top-5 当"核心"自动注入**——用户指出"后期几十万字
   每次注入？没规划好"。已改成固定 `memory/core.md`（≤2000 字）+ 归档按需，
   动态 top-5 只保留为检索工具，不再自动注入。`tool ⑦` 钉住"core 有 chars/budget，
   归档只报数、标题不进 context"。
2. **设置页「保存」没有变化却谎报重启**（用户 2026-11-19 点完保存原话"感觉没什么用"）：
   三项都空时 PUT 仍把 profile 重写一遍（内容不变），回包却写 `restarting:true` +
   "插件会重启一次"。现在先比对归一后的配置：**没变化就不碰 profile、不重启**，
   回「已保存：没有变化」；`settings ④` 钉住。

## 0.7.0（2026-11-18）· DSH 设置页：数据根 / 管道 / 项目范围 / 挂件都能在 DSH 里改

用户原话：「别人的插件都支持直接在 DSH 里设置，方寸可以吗？目前好像没看到，只有个小挂件右键菜单。」

### 一、新增 client 半（`client.js`）

DSH 0.2 线不会给第三方插件自动生成设置表单 —— `dsh-settings` 只自动渲染 `Config` 的
volatile 字段，而且 README 明说"no shipped client does so yet"。所以照已装插件的实际做法：

- `package.json` 加 `dsh.client.platform='web'` + `exports['./client']`；
- 根目录 `client.js` 用 `window.__ModuleLoader__.load({ id: 'dsh-fangcun', factory })`；
- `apply(ctx)` 里 `ctx.slots.inject('settings.section', …)` 注册一节「方寸」。

设置页有三块：**状态**（连接 / 版本 / 数据根来源 / 管道 / 项目 / 未完成与在办）、
**连接设置**（数据根、管道、项目范围，保存与恢复默认）、**挂件**（显示/隐藏、四角摆位）。
挂件改动直接写 `localStorage` 并调 `window.__fcTodoWidget`，点完立刻生效，不用刷新。

### 二、宿主侧：三项覆盖 + 设置路由

- `apply(root, config)` 读 Loader 行 config；`resolveDataDir` / `resolvePipePath` /
  `resolveProjectScope` 的优先级变成 **设置 > 环境变量 > 自动探测**；`health.fangcun.source`
  会如实写 `config`。
- 新路由 `GET/PUT /fangcun/api/settings`：只收本机 + 同源；PUT 校验（绝对数据根、
  Windows 管道前缀、未知键、非字符串）后走 `configEditor.edit(entry, …)` 写 profile patch，
  保存后 Loader 重启本插件。**没有 `configEditor` 时回 501 + 原因，不假装保存。**
- `health` 新增 `settings`（三项值 / 是否可写 / 错误）与 `client`（客户端半是否进模块表、路径）。

### 三、挂件新增只读 API

`window.__fcTodoWidget = { snapshot, applySettings, setCorner, setHidden, refresh }`，
给设置页联动用；挂件自己的右键菜单、拖动、四角逻辑不变。

### 四、验证

- `npm test`：**151/151**（新增 `settings ①–⑥`、`client ①–④`、`widget-dom ⑲`）；
- 真机：`plugin_manager set_plugin(include:dsh-fangcun)` 后 `health.plugin.version` 变 0.7.0，
  `health.client.available=true`、`settings.writable=true`，**没重启 DSH**；
- **真机 PUT 真写过一次**（2026-11-19）：`dataDir` 写成当时生效的同一个值 → profile patch 出现
  `- id: dsh-fangcun … config: dataDir: …`、插件重启后 `health.fangcun.source=config`；
  再清空 → 该行整条移除、patch 哈希回到原值（前后 `3E5295…7589` 一致），没留野行；
- 页面自证：刷新后 `health.widget.page.events` 出现 `client-apply` / `client-section`，
  同时 `boot/mount/probe` 恢复、`probe.tb=40/hit=fc-pill`；
- 桌面端刷新后 `injected/pushed` 仍为 0（窗口缓存，见 AGENTS 事实 54），判据改用 page 事件。
- ⚠ 修一个自查发现的小 bug：`health.settings` 原先照抄 apply 那一拍，而 `configEditor` 比本插件
  晚就绪 → 页面能保存、health 却一直写 `writable:false`（同一个页面两个答案）。现在 health 与
  GET 路由一样**当场问宿主**（`settings ⑥` 钉着）。

**未发版**（用户此前说过「暂不发版，全世界装的人不会超过三个」）；本机 `link:` 已生效。
设置页的**人眼视觉确认**还没做：用户打开设置面板看到「方寸」一节才算数。

## 0.6.7（2026-11-17）· `fangcun_search`：关键词全文搜索（跨全部项目与状态）

用户拍板：「**`search_tasks` 必须补，`delete_task` 永不做**」。两句话，两个动作。

### 一、补 `fangcun_search` → `search_tasks`

**它解决的是插件此前完全做不到的一件事**：模型遇到「我记得有一张讲 XX 的卡，但不知道 id、
也不知道在哪个项目」。旧工具箱里只有"列某个项目的未结卡"，**没有任何关键词能力** ——
模型只能逐个项目去猜，把整表塞进上下文，然后还是找不到。

真机实测同一个词两种路径的差距：

```
fangcun_search("派单")                   => 10 条，跨 dsh-fangcun / fangcun-base / project-2
fangcun_tasks(project=dsh-fangcun)       => 21 张，其中含"派单"字样的只有 2 张
```

**口径必须与 `list_tasks` 不同**：搜索**含已完成 / 驳回**。要是也跟着过滤未结卡，
模型就永远搜不到"上次这个问题是怎么解决的" —— 那正是搜索存在的理由。

### 二、`delete_task` 永不进白名单（用户：「永不做」）

写成了**显式名单** `NEVER_ROUTED`，而不是"没写就是不做"—— 白名单的默认行为是
"不在里面就转发不了"，但**没人会去数漏了哪些**。写成显式的，`tool ⑨b` 就能钉住它，
将来谁想加必须先回来读理由：

1. **补了模型也会被拒**：方寸 `writeGate.ts` 的 `DESTRUCTIVE_TOOLS` 含 `delete_task`，
   本机档位是「读写」（不含破坏性）→ 真机原话"已被拒绝"。
   发一把永远打不开的钥匙，模型只会把失败当成"方寸坏了"，白花一次调用。
2. **删卡不是 agent 该做的决定**：卡的去留是人的签字（与 `SIGNOFF_STATUSES` 同一条治理口径）。
3. **真实需求为零**：P0 里唯一那次 `delete_task` 是模型想删自己造的探针卡，最后改用「驳回」收的。

### 三、真机探针又抓到一个会烧上下文的坑

`search_tasks('')` 在真管道上回 **396 条**。第一版没拦，等于允许模型用一个空字符串
把整张看板拉进上下文 —— 正是用户说过的「每次一共就那么多上下文空间，占满对话就死了」。
已修：空 query（含纯空白）**直接抛**，不算搜索。`tool ⑨` 钉死。

### 四、验证

- `npm test`：**139/139**（新增 `tool ⑨/⑨b`；`⑨b` 就是那条"永不"的守卫）
- `scripts/check-packed-schema.mjs`：**8/8 过宿主真校验器**
- `plugin_manager` 一次 → `health.plugin.version` **0.6.6 → 0.6.7**，`tools.names` 变 8 个，**没重启 DSH**
- 真管道真调：`搜"派单"` 10 条跨三项目 / 空串与纯空白都被拒 / 搜了没中回"没有匹配"（与"没连上"文案不同）

**未发版**（用户 2026-11-17：「暂不发版，全世界装的人不会超过三个」）—— npm 上仍是 0.6.5，本机 `link:` 已生效。

## 0.6.6（2026-11-17）· 日志三件套：`fangcun_logs` / `fangcun_log` / `fangcun_log_write`

用户 2026-11-17：「**真正派活最常用的是从日志走**，之前因为不透明等原因砍掉了。既然直连 DSH 有希望做好。」

所以日志不是附属品，是**派活的正路** —— 而插件此前对它完全失明：`list_logs` / `get_log` /
`create_log` / `update_log` / `set_log_status` 五个工具一个都没有。模型想翻第二条日志就得回 MCP。
`fangcun_context` 那个「上次做到哪」只能看见**最新一条**。

### 〇、先说 P0 的结论：**"模型不选插件"这个前提是错的**

上一版当时的判断是「工具确实通了，但模型还是主要走 MCP（30% 先查后改率）」，据此列了
"拆 `fangcun_write`"和"改提示词"两条假设。按 `tools.jsonl` 500 行 + 会话原文重算，**两条都不成立**：

| 窗口 | 插件工具 | MCP | 说明 |
|---|---:|---:|---|
| 今天全天 | 64 | 206 | 混了 18:11 之前的时段，那时插件工具**还没真通** |
| 18:11 之后（工具真通） | 64 | 15 | 其中 10 次还落在**工具真通之前就建好的两个老会话**里 |
| **之后新建的会话** | **63** | **6** | 真正的对比 |

那 6 次 MCP 调用逐个看：`search_tasks` ×2（插件没有）、`delete_task` ×1（插件没有），
剩下 3 次 `list_tasks` 里 **2 次是同一段的重复调用、1 次直接报 `unknown tool`（掉线了）**。

**结论：有能力时模型就走插件。剩下的 MCP 流量几乎全是能力缺口，不是认知问题。**
所以「拆 `fangcun_write`」和「改提示词」都不该做 —— 补缺口才是。

### 一、三个新工具

| 工具 | 转发 | 说明 |
|---|---|---|
| `fangcun_logs` | `list_logs` | 列日志（封顶 20 条，截断说出来） |
| `fangcun_log` | `get_log` | 读一条日志正文 + **接力链上下游**（派活时"上一棒怎么交给我的"比正文更值钱） |
| `fangcun_log_write` | `create_log` / `update_log` / `set_log_status`（按 `action`） | 日志写口 |

**为什么日志写口与 `fangcun_write` 分开，而不是塞进它的 action 枚举**：两者不是同一类东西。
卡有状态机（有闸、有签字），日志只有"在办 / 不在办"（无闸）。塞在一起会让模型以为
日志也能 move 成 `待验收` —— 那是不存在的语义。

### 二、三道硬约束（都抄自方寸原文，不是我自己加的）

1. **`create` 必须 `userAsked=true`** —— 方寸原话 "Requires userAsked: true, otherwise the call is rejected"。
   日志是**用户的私人上下文笔记本，不是 agent 汇报工作的地方**。插件**连"模型忘了带"都不替它补**：
   补了就等于替用户同意。收工请写卡，不写日志。
2. **日志没有终态**：`set_log_status` 只收 `running` / `idle`。没有 request_close / cancel_close。
   `完成`/`驳回` 是卡的签字，永远不在日志上 —— 所以这里**没有**状态闸，那里本来就没有终态。
3. **`update_log` 改不了 status**（方寸原文："Lifecycle fields (status) are NOT here"），插件不替它拼。
   反过来说：`taskIds: []` 是**合法的清空**，不能当空字符串丢掉。

### 三、真管道探针当场抓到一个我刚写出来的 bug

方寸对**不存在的日志号**回 `{ok:false, error:'Log not found: …'}` 且 `isError:true`，
第一版 `shapeLog` 只判"是不是对象"，于是 `{ok:false,…}` 被当成正常日志 →
模型看到 `ok:true` + 一片空白正文。**读失败伪装成"这条日志是空的"，是这次最坏的错。**
已修：如实标 `ok:false`，并把原因写进 `body`。`tool ⑧b` 钉死。

### 四、验证

- `npm test` **137/137**（新增 `tool ⑧/⑧b/⑧c/⑧d` 四组）；
- `scripts/check-packed-schema.mjs`：**7/7 过宿主真校验器**（自造校验器不算数，见 AGENTS 事实 37）；
- 真管道逐个真调：`list_logs` → 3 条；`get_log` → 1052 字正文 + `nextSteps` + 接力链上游；
  七个写口闸逐个试过（`userAsked` 缺/假、`state=完成`、空 update、未知 action 全部被拒）。

## 0.6.5（2026-11-17）· 管子真的通了一次；压缩用量进账；`fangcun_context` 长出「上次做到哪」

三件事：**派单那条管子此前一次都没跑过**（不是界面没入口——本机安装包里那个按钮一直在）；
**压缩那次调用的 token 一直没进账**；以及 `fangcun_*` 那四个工具**没有存在的理由**
（模型有 46 个同名 MCP 工具可用）。

### 〇、压缩用量现在记账（用户 2026-11-17："压缩用量该接（也算损耗）"）

**为什么不会重复记账**（这是接它的唯一依据，不是"应该没问题"）：压缩走的是
`ctx.llm.stream(...)`（`dsh-compaction-basic` 直接调），**不经过 agent loop**，所以它不产生
`assistant/message`；反过来 agent loop 的 `assistant/message` 也从不带 `compactionId` —— **两条来源互斥**。

**为什么不并进某一轮**：`compaction/summary` **没有 `turn` 字段**（手动压缩时
`compaction/start.turn` 甚至为 null），并进去等于把压缩的钱记到那轮头上。
所以用独立幂等键 `sessionId#compact-<compactionId>`，`note` 带 `compaction=1`。

口径与轮次一致：`prompt_tokens = input + cacheRead`。`usage` 缺失 / 零 token / 没有 `compactionId`
→ **一律不记**（宁可少报也不记假的）。真账本实收一条：`prompt=48000`（input 8000 + cacheRead 40000）。

**顺手修掉一个真 bug**：幂等以前只查 `sent.jsonl`（**已发**），而 `sent` 是发出去之后才落盘的 ——
同一事件**在一个 flush 周期内来两次**就会入队两遍。现在**同时查 `queue`（已入队未发）**。
⚠ 轮次路径中了同样一枪，一起修了（由新测试 `usage ⑩c` 抓到）。

### 一、派单管子：现在点一下，开出来的是**会干活**的会话

真机探针（往 `.dispatch-dsh/` 放一份派单、等 8 秒）证明消费端**看起来很成功**：
`health.dispatch.lastOk = true`、会话 id 也有了。但磁盘上那个会话**只有一行头、零事件**：
模型永远不知道有这回事。四个错叠在一起：

| # | 错在哪 | 后果 |
|---|---|---|
| ① | `session.append('user/message')` 投递 | **不会叫醒 agent** —— 轮次由 Agent 的 inbox 驱动，往日志里补一句只是"历史里多了句话" |
| ② | 手写的消息没有 `id` / `source` | 宿主校验 `assertMessageEventShape` 要 `id` 非空、`source.kind` 非空；缺了就是坏事件 |
| ③ | `agents.create({ sessionId, title })` | `title` **不是** `CreateAgentOptions` 的字段（静默丢弃），`meta.cwd` 也没传 → 会话落在 `sessions/_no-cwd/` |
| ④ | 没传 `agentOptions` | 新 agent 没有 provider/model，第一轮就抛 "has no provider/model" —— 用户看到的是"开出来了，但说话不回" |

改法（与宿主自己的 `dsh-headless` / `dsh-schedule` 同一套）：

- `agents.create({ sessionId, meta: { cwd }, agentOptions })`：`cwd` 先认派单文件的 `cwd:`，
  再回退 `registry.yaml` 里该项目的 `repo:`（新增 `projectRepoOf`；相对路径一律不认）；
  `agentOptions` 取 `agentDefaultModel.currentSelection()`，与 GUI 新建会话同源；
- 投递走 **`agent.followup(message)`**，消息自己带 `id` + `source: { kind: 'user' }`；
- 名字走 `sessionTitle.rename`，落盘走 `sessions.flush` —— 不 flush 的话消息只活在内存里；
- 老宿主没有 `followup` 时退回 `session.append`（并明说它不会自己跑），不假装成功。

### 二、`fangcun_context` 现在是"开工一屏"，也是唯一有理由留着的那一个

它一次给四样：章程四节 + 最近有效决策 + 手上的活 + **上次做到哪**
（最新一条执行日志的标题与它留下的下一步）。MCP 那条路要
`project_charter` + `decision_list` + `list_tasks` + `list_logs` + `get_log` **五次**才凑齐。

规则段同时收紧：过去写"先用 `fangcun_context`（或 `list_tasks`）"——括号里那个"或"就是
模型走向 MCP 的门。现在写死"**开工第一件事：`fangcun_context`，不是 `list_tasks`**"，
并说明为什么不是 MCP 那条路（五次 vs 一次）。

顺带修掉一个真机读出来的显示 bug：卡没少也报"只列前 N 张"（截断口径拿全部卡数比，关掉的卡也被算成"还有更多"）。

测试 127 条全绿（新增：派单必须走 followup / 消息形状合法 / 带模型路由 / 落对目录 / registry 认仓库 / `cwd` 字段可缺省）。

## 0.6.4（2026-11-17）· create 会静默吞掉 status

**真机验证 0.6.3 时抓到的**：我用 `fangcun_write` 建草稿卡（`status: '草稿'`），
落下来的却是 **`待办`**。

### 病

`writeCallOf()` 的 `create` 分支**根本没转发 `status`**：

```js
if (args.project) call.project = ...
if (args.body) call.body = ...
if (args.priority) call.priority = ...
if (Array.isArray(args.tags)) call.tags = ...
// ← status 没了
return { tool, args: call }
```

而 `parameters` 里**明明声明了 `status`** —— 所以模型看得到、会传，
插件收了却不发，方寸用默认值落卡。

**为什么这比报错更糟**：模型以为按计划建了草稿，人以为那张卡已经排进队列。
而「待办」在方寸里是**要过进队列闸**的正式状态（可能需要已批准的澄清问卷），「草稿」不是 ——
**静默换了一个语义不同的状态**。

### 为什么 123 条测试全绿也没抓到

`test/tool.test.mjs` 那条「全字段都带上」的断言**自己就漏了 status**：

```js
writeCallOf({ action: 'create', title: 'T', project: 'p', body: 'B', priority: '高', tags: ['a','b'] })
assert.deepEqual(..., { title, project, body, priority, tags })   // ← 断言里也没有 status
```

**代码和测试一起漏，所以测试是绿的。**
⭐ 教训：「全字段」这类断言必须**对着参数声明逐字段数**，不能凭记忆列。

### 修

- `create` 转发 `status`（空值不写，不凭空造）
- **创建时也不许直接落成「完成」/「驳回」** —— 与 `move` 同一道锁（那是用户的签字）
- `test ③` 补四条：转发 status / 空 status 不写 / 完成被拒 / 驳回被拒
- 反例自证：把 status 转发删回去 → 精确变红 1 条（17/1），恢复 18/0

### 真机验证

| 步 | 结果 |
|---|---|
| 修前建卡（`status:'草稿'`） | 落成 **`待办`** ❌ |
| 修后建卡（`status:'草稿'`） | 落成 **`草稿`** ✅ |
| 拒绝设「完成」 | `「完成」是用户的验收签字，agent 不能设…这是治理层的锁，不要绕` ✅ |

### 同批确认的里程碑

`0.6.3` 是本项目**第一次**让四个模型工具在真机上真正可用
（0.4.0 起一直零注册，0.6.2 还因 `parameters` 撞 `title` 保留字把整轮对话打挂）。
本次真调三个只读工具全部成功：`fangcun_tasks` 拿到 373 张卡、
`fangcun_context` 三处并行且如实报 `missing: ['目标','场景','边界']`、
`fangcun_card` 读到 2213 字正文。


## 0.6.3（2026-11-17）· 参数 schema 要为"参数名叫 title"负责

真机症状：DSH 发不出消息，provider 回 400 ——

```
Tool 9 function has invalid 'parameters' schema:
{'description': 'Card title. Required for create.', 'type': 'string'} is not of type 'string'
Failed validating 'type' in metaschema['properties']['title'] ... On schema['title']
```

### 根因

四个工具的 `parameters` 写的是「字段名 → 子 schema」的**扁平映射**（那是宿主
`harness.defineTool` 吃的 DSL 形状）。但本插件走 `ctx.tools.register` 直注册：
宿主只校验 `output.schema`，**不编译 parameters**，交什么就原样发给 provider。

于是扁平映射被当成 JSON Schema 本身 —— 属性名全摊在根部。`action` / `body` 这类
未知关键字 provider 直接忽略，只有 `title` 例外：它在 JSON Schema 里是**保留注解**，
必须是字符串，而这里给的是对象 → 整轮请求 400 打不出去，看起来就像"DSH 坏了"。

### 改法

`parameters` 一律交完整 JSON Schema：`{ type: 'object', properties: { … } }`（`objectParams()`）。

### 为什么之前的守卫没抓到

`scripts/check-packed-schema.mjs` 验的是**自己包了一层**的 schema
（`{ type:'object', properties: d.parameters }`）—— 又是"自己当裁判"：验的形状与
真机发出去的形状不是一个东西。现在原样验 `d.parameters`；`test/tool.test.mjs`
新增 ⑦c：根上出现属性名、或 `title` 不是字符串，直接红。

双向验证：改前源码 4/4 FAIL，改后 4/0 PASS（宿主真校验器）。

## 0.6.2（2026-11-17）· 0.6.1 发出去的那个"修复"其实是错的

**0.6.1 已经发到 npm 与 GitHub Release 了，而它带着同一个 bug。**
装 0.6.1 → `health.tools.registered` 仍然是 **false** → 四个工具照样一个都没有。

### 为什么 0.6.1 的修复没生效

它把 `required: true`（属性上的布尔值）改成了数组，但**数组写进了 `properties` 里面**：

```js
// 0.6.1 发出去的样子（错）：required 成了 properties 的一个"字段"，值是数组
properties: {
  id: { type: 'string' },
  required: ['id'],
},

// 0.6.2（对）：required 与 properties 同级
properties: { id: { type: 'string' } },
required: ['id'],
```

宿主的话是：`schema.properties.required must be a schema object`。

### 为什么 0.6.1 的守卫没抓到（这才是要记的）

0.6.1 新加的 ⑦ 只认 `required: true` 这一种**布尔**写法。
数组形式落在 properties 里，它**视而不见**。

> **一条只能抓一半的守卫，比没有更危险** —— 它让人以为验过了。

### 为什么发版流水线也没抓到

`release.yml` 里两步都绿：

- `npm test` —— 看的是**源码**，且 ⑦ 本身漏了一半；
- `smoke-packed` —— 只报 `tools=4`（**在不在**），不看 schema **合法不合法**。

**于是"单测绿 + 冒烟绿 + 发布成功"三绿，东西装上去照样不能用。**

### 修

| 处 | 做了什么 |
|---|---|
| `lib/tool.js` | 7 处 `required` 数组移到 `properties` **同级**（tasks 2 / card 1 / context 3 / write 1） |
| `test/tool.test.mjs` | 新增 **⑦a**：`required` **数组**落在 `properties` 里 → 红 |
| `scripts/check-packed-schema.mjs` | 新增：拿**宿主 app.asar 里的真实校验规则**验 schema（不是自己发明口径） |
| `.github/workflows/release.yml` | 新增一步：**对解包后的 tgz** 跑上面那个守卫 —— 堵住"源码绿、产物坏" |

### 反例自证（三条都要能精确变红）

1. 把 0.6.1 的 `lib/tool.js` 装回来 → `⑦a` 精确点出**全部 7 处**；
2. `check-packed-schema.mjs` 验**已发布的 0.6.1 包** → `0 / 4`，四个工具全红；
3. 验 0.6.2 的包 → `4 / 0` 全绿。

### 验证

- `npm test` **122 / 0**（0.6.1 是 121，+1 条 ⑦a）
- `npm pack` → 解包 → `check-packed-schema` **4 / 0**
- `SMOKE OK version=0.6.2 routes=4 tools=4`
- ⚠ **真机 `health.tools.registered === true` 仍未复验** —— 要装 0.6.2 并重启 DSH。
  在那之前这条**不算完成**，别再写"已修"。

## 0.6.1（2026-11-17）· 模型工具其实一次都没注册上

> ⚠ **本节在 16:33 被订正过。** 初版写着「四个 tool schema 逐个过宿主口径校验：全绿」——
> **那是假的**。当时代验器只抓 `required: true`（布尔值），漏掉了下面这个更隐蔽的写法，
> 于是 121 条全绿、真机上四个工具照样全灭。订正内容见本节末尾「订正 · 第一次修没修对」。

**这是 0.6.0 的真机验收结果：装上了，但四个模型工具一个都没有。**

### 病

0.6.0 装上并重启后，`health.json` 报：

```
tools.registered = false
tools.error: unsupported JSON schema: schema.properties.connected.required is not supported
             on type "boolean"; …items.items.properties.id.required is not supported on type "string"
```

根因：`lib/tool.js` 把必填写成了**属性上的布尔值**——

```js
connected: { type: 'boolean', required: true }     // ← 这种方言宿主不认
```

而宿主认的是**标准 JSON Schema**：`required` 是父对象上的**字符串数组**——

```js
{ type: 'object', properties: { connected: { type: 'boolean', … } }, required: ['connected', …] }
```

于是宿主拒掉整批注册：`fangcun_context / fangcun_tasks / fangcun_card / fangcun_write` **全部不可用**。

### 为什么 114 条单测全绿也没抓到

它们只断「定义了 `output.schema`」，**从没把 schema 喂给宿主的校验规则**。
真正的判据是 `health.tools.registered === true` —— 而那一步只有真机能验。

**这是 0.6.0 最贵的教训**：单测绿 ≠ 工具能用。

### 修

- `lib/tool.js`：47 处属性级 `required: true` 全部提升成**父级 `required: [...]` 数组**
  （含 `items` / `decisions` / `cards` 三个数组型字段——它们是多行对象，
  第一版转换器漏了它们，是「转换成功 0 残留」却少字段的同一个形态）
- 新增 `scripts/fix-tool-schema.mjs`：可重跑的转换器（`--dry` 先看）
- 新增两条测试 `⑦ / ⑦b`：
  - 属性级 `required` 布尔值 → 红
  - `required` 数组里的名字不在同层 `properties` 里 → 红
  - **反例自证过**：把 0.6.0 的旧文件放回去，新断言精确变红 1 条

### 订正 · 第一次修没修对（2026-11-17 16:33）

真机 `health.tools.registered` **仍然是 false**。第一次修把 `required` 从
「属性上的布尔值」改成了「数组」，但**数组写在了 `properties` 里面**：

```js
// 错（第一次修的结果）：required 成了 properties 的一个"字段"，值是数组
properties: {
  id: { type: 'string' },
  required: ['id'],          // ← 位置错了
},

// 对：required 与 properties 同级
properties: { id: { type: 'string' } },
required: ['id'],
```

宿主对这种写法的话是：`schema.properties.required must be a schema object`。

**为什么这次仍然没被抓到**：新加的 ⑦ 只认 `required: true` 这一种**布尔**写法，
数组形式落在 properties 里它视而不见 —— **一条只能抓一半的守卫，比没有更危险**，
它让我以为验过了。7 处（`fangcun_tasks` 2 + `fangcun_card` 1 + `fangcun_context` 3 +
`fangcun_write` 1）全部踩中。

**这次的修法**：
- `lib/tool.js`：7 处 `required` 数组全部移到 `properties` **同级**
- 新增测试 `⑦a`：`required` **数组**落在 properties 里 → 红（专门补上那半个缺口）
- **反例自证**：把 0.6.1 初版文件放回去 → `⑦a` 精确变红，一次点出全部 7 处
- 方寸侧新增 `scripts/test/check-plugin-schema.cjs`：把**宿主 app.asar 里的真实校验规则**
  抄成守卫（不是自己发明口径），四个工具逐个过；自带 5 条反例自证
  （含"属性级布尔"与"数组塞进 properties"两种病，都必须被抓）

### 验证

- `npm test` **122 / 0**（0.6.0 是 119；初版 121，本次 +1 条 ⑦a）
- 四个 tool schema 过**从宿主抄出来的**校验规则：全绿（`check-plugin-schema.cjs` 4/0）
- ⚠ **真机 `health.tools.registered === true` 尚未复验** —— 要重启 DSH 才加载新代码。
  在那之前，本条的验收**不能算通过**。


## 0.6.0（2026-11-17）· 那根管子

暮雨拍板：「**管子现在就做，它是其他一切的前提**」，形态选「开新会话（方寸发，DSH 里冒出）」。

### 管子两端

| 端 | 做什么 |
|---|---|
| **方寸** | 项目页多一个「🧠 派给 DSH」按钮 → 落一份派单文件到 `<数据根>/.dispatch-dsh/` |
| **插件（本仓）** | 每 8 秒看一眼派单目录，看见就 `ctx.agents.create()` 开新会话，把上下文包作为**第一条用户消息**塞进去，**建成后才删派单** |

### 为什么经文件，而不是两边直连

三方各有硬边界，只有文件能同时满足：

1. **方寸不 import DSH 的任何东西**（它连"DSH 装没装"都只是只读探测）；
2. **插件不 import 方寸代码**（`plugin ③` 钉着，`layering ①` 也钉着）；
3. 上下文包上万字，**塞不进命令行参数**。

所以：方寸写文件，插件读文件。跨进程只经文件，谁也不用知道对方的内部。

### 三条纪律（`test/dispatch.test.mjs` 7 条钉着）

1. **建成会话才删派单** —— 建失败留着，下次还能试。否则"用户点了没反应，派单也没了"是最坏的静默失败；
2. **坏派单立即丢弃** —— 不许每一拍都去读一个永远解不开的文件；
3. **坏文件/没目录/宿主炸了都不抛** —— 派单是锦上添花，不该拖垮记账与挂件。

### 为什么塞 `user/message` 而不是 `systemPrompt`

`systemPrompt` 每次装配都重算；而这个包是**"这一次派单的快照"**，属于这一轮历史。
塞成 `user/message`，模型看得到，也能在后续轮次里被引用，且不会跟着每一轮变形。

### 不开第二个 agent 循环

REV-014 定案：**借 DSH，不自研**。这里只调宿主的 `agents.create`，循环归宿主。
宿主没有 `agents` 服务（老宿主/形状变了）时**明说派不出去**，不假装。

### `health.dispatch` 让这件事可自证

用户点了「派给 DSH」，真正想知道的是**DSH 那边到底开没开**：

```json
"dispatch": { "lastAt": "...", "lastProject": "sitian", "lastOk": true,
              "lastSessionId": "fangcun-dispatch-...", "lastError": "" }
```

只报"成没成 + 会话 id"，**不把上下文正文写进 health**（那可能是私事）。

**114/114 全绿。** 方寸侧 `tsc -p tsconfig.main.json` 退出 0、`vite build` 退出 0。

## 0.5.0（2026-11-17）

这一版让「**方寸的记忆**真的能用上」—— 而不只是存着。

### 来由

用户当天两句原话：

> 「会话迟早会消失，方寸要不要**直接把记忆层一步到位**算了。**不是记忆插件，但比记忆插件更强，是项目的灵魂。**」

> 「**方寸插件本身还可以做什么，好让 DSH 和方寸的组合更顺一点。**」

核实到的事实：方寸的 `contextPack`（章程+登记表+方针+决策+卡+日志六处）
**只生成文件，界面上没有「派给 agent」的口子** —— 所以模型开工前根本不知道项目要变成什么。

### 新增 `fangcun_context`：一屏说完项目背景

模型一次调用拿到三样，全是**作数的**、不是"相似片段"：

| 拿到什么 | 来自方寸 | 为什么它比记忆插件强 |
|---|---|---|
| 章程四节（使命/目标/场景/边界） | `project_charter` | 这是**价值观锚**，检索不出来（它不是"说过的话"）。缺哪节会明说「真没写」，不许替项目编 |
| 最近有效决策 | `decision_list` | 带**状态**（有效/已撤销/已合并）—— 知道哪条已被推翻，片段相似度不知道 |
| 手上还有的活 | `list_tasks` | 只列未结（完成/驳回不进背景），带状态机 |

三处**并行**拉（串行慢三倍且互不依赖）；**全部都失败才算"没连上"**，只缺一处仍算连上并单独标注。
输出有界：决策 8 条、卡 12 张，超了明说。

### 规则段改成"先看项目要变成什么"

原来写的是"开工先查 → 列卡"。现在改成：

> 先用 `fangcun_context` 看清**这个项目要变成什么**（使命/目标/边界）再动手 ——
> 别凭记忆猜进度，也别照通用常识来。

这一句就是"AI 写代码没全局意识、天天乱改、忘记东西"的对策：**先给它项目的灵魂，再让它动手。**

### 同时修掉 0.4.1 的撒谎（详见 0.4.2，此处合并说明）

方寸没开时返回 `total: 0` 会被读成「方寸里没有卡」→ 去建重复卡。
现在 `connected` 与 `total` 分开，文案明写「不是"没有卡"」。

### health 增加 `link` 与三件套分工

- 插件只报「方寸」这一环（装没装 / 跑没跑），**不报 DSH**（插件就活在 DSH 里，报它没意义）
- 「装了没跑」的提示必须写**「不用重启 DSH」**（方寸打开就自动通）

### 测试

`tool ⑦/⑦b/⑦c` 三条钉住：缺节要说「真没写」、三处并行、**有一处通就算连上**、
缺 `project` 不许默认成"全部项目"。

**107/107 全绿。**

## 0.4.2（2026-11-17）

用户拍板：「方寸插件本身还可以做什么，好让 DSH 和方寸的组合更顺一点。
后续方寸内部界面也要调整，加强插件支持（**缺插件提示下插件，缺DSH提示下DSH，
插件本身也能提醒下方寸**）。」

### 修一个 0.4.1 我自己挖的坑：方寸没开时**撒了谎**

0.4.1 为了让「方寸没开是常态」不报错，`fangcun_tasks` 在管道失败时返回 `total: 0`。
**模型会读成「方寸里没有卡」—— 那是撒谎**，后果是它去建重复的卡。

现在 `connected` 与 `total` 分开：

| 情形 | connected | total | hint |
|---|---|---|---|
| 方寸跑着、真没卡 | `true` | `0` | 空 |
| 方寸没开 | `false` | `0` | 「方寸桌面版没有在运行，请打开后重试；没装就去下载」 |

渲染文案也改了：连不上时输出「**方寸未连接 —— 查不到待办（不是"没有卡"）**」，
而不是「0 张未结」。写工具的失败也带上同一句 `hint`。

### 新增 `health.link`：三件套里「插件看得见的那两环」

```json
"link": {
  "installed": true,     // 方寸装没装（只读文件痕迹）
  "running": false,      // 方寸跑没跑（命名管道在不在）
  "ready": false,
  "pipePath": "\\\\.\\pipe\\tegula-mcp",
  "hint": "方寸装了但没在运行 —— 打开方寸即可（打开后自动通，不用重启 DSH）"
}
```

**分工不许混说**：插件只报「方寸」这一环。「DSH 装没装」在插件里没有意义（插件就活在 DSH 进程里），
由方寸侧 `services/dshPlugin.ts` 报。两边各报自己看得见的，合起来才是完整三件套
（`test/link.test.mjs` ⑤ 钉着：插件侧不许有 `dsh` 状态字段）。

### 规则段：缺什么说什么，且给下一步

新增三条，对应三件套各自的缺口：
- 方寸没装 → 给下载页
- 方寸装了没跑 → 让用户打开方寸，**明确说不用重启 DSH**
- 方寸说「没装方寸插件」→ 那是方寸侧报的，在方寸里装

### 测试

`test/link.test.mjs` 新增 5 条（没装 / 装了没跑 / 都通 / 环境变量坏掉 / 分工不混说）；
`tool.test.mjs` ④ 改写成「连不上必须 `connected:false` 且文案说"不是没有卡"」，
并新增 ④b 钉住「连上但没卡」与「没连上」必须能区分。

**104/104 全绿。**

## 0.4.1（2026-11-17）

这一版四件事：**取消 DSH 版本上界**、**宿主兼容性只提醒不退出**、**修 0.4.0 的自证失明**、
**防腐层边界上测试 + 验收闸加锁**。

### 取消 `engines.dsh` 上界（用户拍板："能不能用随缘，插件永远只保适配版本"）

原来是 `>=0.2.1-rc.2 <0.3.0`。核实宿主代码（`@deepseek-ai/dsh-app-boot` 的 `loadProfileDirectory`）：

```js
const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
// ...
} catch (error) { skippedBundles.push({ packageName, reason: String(error) }); }
```

**不满足 `engines` 会被 throw，然后 catch 成 `skippedBundles` —— 整个插件静默消失**：
挂件、记账、工具全没了，界面上只显示"没装"，而且没有原因。
DSH 是 developer preview、升级频繁，于是 `<0.3.0` 就是一个定时炸弹。

现在只有下限 `>=0.2.1-rc.2`：**宁可能用 + 提醒，也不要静默退出**。

### 宿主兼容性自检（`lib/compat.js`）—— 只提醒，不退出

六个关键宿主能力各给三态：`ok` / `degraded`（存在但形状不像预期）/ `missing`。
结论进 `health.compat`：

```json
"compat": {
  "checkedAt": "2026-11-17T...",
  "capabilities": { "webServer": "ok", "systemPrompt": "ok", "tools": "ok", ... },
  "warnings": [],
  "summary": "全部 6 项宿主能力正常"
}
```

判据是**运行时真实形状**，不是版本号比较 —— 版本号相等不代表 API 没变（preview 期尤其）。
探测**绝不抛**：出错记成缺口并继续，插件照常干它能干的。

⚠ 一个真 bug（测试 ⑤ 抓出来的）：最初只判 `typeof root.on === 'function'`，于是"宿主有 `on` 但一订阅就抛"
被当成健康 —— 记账与自证实际全哑却报绿。现在**真调一次**再判。

### 修 0.4.0 引入的自证失明（我自己挖的坑）

`proof.js` / `cards.js` 只认 `mcp__fangcun__*`（DSH 给 MCP 工具生成的名字）。
0.4.0 新增的 `fangcun_tasks` / `fangcun_card` / `fangcun_write` **不带这个前缀**，于是：

- `proof.rows` 不涨、`readBeforeEdit` / `wroteBack` 不涨
- `cards.lastCardId` 永远空 → 挂件「本次在办」消失、`usage` 的 note 不带 `card=`

等于把"接线坏了"的病（卡 140864fa）搬成"口径没跟上"。现在**两个前缀都认**，
并区分只读/写入：`fangcun_tasks` / `fangcun_card` 算查，`fangcun_write` 算回写
（只读工具算回写会把"只查不干"的病掩盖掉）。

### 验收闸加锁（两道）

用户/梅林的硬规则："DSH 也得过闸……智能层不豁免治理层。"

- **第二道（原本就有，在方寸本体）**：`desktop/src/main/mcp/tools.ts` 的 `move_status` 对
  `完成` / `驳回` 直接 `isError` 拒绝。**这道锁位置正确** —— 在方寸核心层，不在插件、不在 DSH。
- **第一道（新增，在插件）**：`SIGNOFF_STATUSES`。理由不是"不信任方寸"，而是：
  不该先撞墙才知道；且不许赌锁的位置（方寸哪天重构挪走了硬拒，插件这道还在）。
  `move` 与 `update` 两条路径都过闸，不留后门。

### 防腐层边界上测试（`test/layering.test.mjs`）

用户拍板："方寸↔DSH 之间收窄成一个适配模块，翻译只发生在这一处。"
核实结果：**已经基本是这样了**——所有 `root.get/inject/on/effect`、`webServer.register`、
`systemPrompt`、`tools.register` 全部集中在 `lib/index.js` 一个文件。

所以这版不重写，只**把它变成 CI 能守的规则**：除 `index.js` / `compat.js` 外，
任何 lib 文件出现 DSH 概念就红。做了反例验证（故意在 `cards.js` 塞 `root.get('webServer')`
→ 2 例失败），确认检测器真的有效，不是空跑。

### 规则段改写（`lib/prompt.js`）

原来只写 `mcp__fangcun__*` —— MCP 掉线时那些名字**在工具表里不存在**，这段变成死指令。
现在两条路径都写，并明确"两个都有时优先插件工具"。另加一条纪律：
**只到「待验收」，完成/驳回是用户签字，方寸会拒绝**。

## 0.4.0（2026-11-17）

**插件第一次真的让模型能调方寸做事。** 0.3.0 的全部对外出口是 4 条 HTTP 路由 ——
那是给浏览器/挂件看的，模型一个工具都没有。这一版补上那一层。

### 模型工具（REV-014 ②）

三个工具，注册在 `ctx.tools`（`lib/tool.js`）：

| 工具 | 做什么 | 转发的方寸 MCP |
|---|---|---|
| `fangcun_tasks` | 列卡（只读） | `list_tasks` |
| `fangcun_card` | 读一张卡的正文（只读） | `get_task` |
| `fangcun_write` | `action: create / update / move` | `create_task` / `update_task` / `move_status` |

四条边界钉在测试里（`test/tool.test.mjs`，8 条）：

- **只白名单转发**：`action` 不在三个里就抛，绝不转发任意工具名（那是提权）。
- **参数不全就抛，绝不猜**：`create` 没 `title`、`update`/`move` 没 `id`、`move` 没 `status` 都直接报错。
- **输出有界**：列表封顶 30 条、单卡正文封顶 4000 字，截断必须说出来
  （用户原话："每次一共就那么多上下文空间，占满对话就死了"）。
- **不假装成功**：方寸没开时读工具回空列表、写工具回 `ok:false` + 原因，不抛堆栈也不谎报已写入。

### 为什么不叫 `mcp__fangcun__*`

宿主的方寸 MCP 客户端断开时（卡 `dsh-里的-fangcun-mcp-客-140864fa`），`mcp__fangcun__*` 全部消失。
这三个工具走**插件自己的命名管道**，不依赖那个 MCP 客户端 —— 所以 MCP 断开时它们仍在。

### 零依赖不变

不 import `@deepseek-ai/dsh-tools`（`defineTool` 只是类型标注 + 校验，返回的就是原对象），
形状按 `dsh-tools/src/contracts.ts` 的 `ToolDefinition` 对齐。

### health 新增 `tools`

`health.tools = { registered, names, error }`。拿不到 `tools` 服务（老宿主）时 `registered:false`
且 `error` 写明原因 —— 与 `prompt` 同一个口径：**不假装注册上**。

### 两处顺手修正

- `shapeCard` 的每个分支都填满 `output.schema` 的 required 字段：少一个字段，
  宿主在 output 校验那步会拒掉整次调用，那会让"没连上方寸"以"工具坏了"的样子出现。
- `fangcun_tasks` / `fangcun_card` 的管道异常就地兜住：方寸没开是常态，不是异常。

## 0.3.0（2026-11-07）

这一版把契约 ⑥ 剩下的三件事做完：**规则段**、**一行现状**、**自证 sidecar**；
外加一轮真机修复（挂件"裸奔"、位置、拖拽、`servedByPage` 误判）。

### 分发：npm + GitHub Release 双通道（REV-006）

- npm 公开包 `dsh-fangcun@0.3.0` 与 GitHub Release（`.tgz` + `SHA256SUMS.txt`）同时发布，
  CI 由 tag 触发，两处是**同一份代码**；安装可写 `dsh-fangcun@0.3.0`，离线仍可用 Release 包。
- 推翻 REV-004 的"npm 不做"：用户已注册 npm 账号（`muyu46548`），token 存在系统环境变量，
  仓库 secret `NPM_TOKEN` 已配置。
- CI runner 改成 `windows-latest`：插件只支持 Windows，`detect` 测试断言 `C:\...` 路径，
  在 ubuntu 上会假红（2026-11-07 首跑就踩到）。

### 看板链接与挂件诊断（2026-11-07 真机）

- **8791 是死链**：`.tegula-port` 停在 2026-10-22，写它的进程早退出。看板地址现在先验 PID，
  PID 不在就不返回链接，挂件不显示「打开看板」——宁可不给，也不给打不开的地址。
- 挂件点击角标开合面板、点「打开看板」会写 `health.widget.page` 的 `panel` / `board` 事件；
  面板渲染异常写 `panel-error`。以后"点了没反应"能直接分辨是点击没进来还是链接打不开。

### 让 agent 真的用上方寸（契约 ①②⑦–⑩）

- **规则段**（`systemPrompt.section`）：开工先查 / 收工回写 / 新问题建卡 / 失败要说；
  另加一条反例条款——闲聊、问答、只读查看**不要**调方寸工具（对应验收 ⑩"不过度触发"）。
  段是**静态文本**，不掺动态数据，提示词缓存不会被它打破。见 `lib/prompt.js`。
- **一行现状**（`systemPrompt.context`）：`<项目> · 未完成 <N> 张 · 截至 <时间>`，
  provider 只读内存快照，**绝不在装配时走管道**（方寸没开也不会卡每一轮）。
  快照每 60 秒由后台刷新，方寸没开就明说「方寸 · 未连接」，不拿旧数字装新鲜。
  `FANGCUN_PROJECT` 可把统计限定到单个项目。见 `lib/status.js`。
- **自证 sidecar**：`session/event` 里的 `tool/call` → `$DSH_HOME/dsh-fangcun/tools.jsonl`，
  **只记 `mcp__fangcun__*` 工具的「时间 / 会话 / 轮次 / 名字」**，不记参数（参数里可能有私事）。
  上限 500 行，超了丢最旧。这是验收 ⑦–⑩ 的判据来源，不靠模型自述、不靠人看界面。见 `lib/proof.js`。
- **health 新增 `prompt` / `proof`**：规则段到底注册上没有、一行现状现在长什么样、
  自证日志有几条。这三样都属于"装上了但没生效完全看不出来"的盲区。
- 宿主没有 `systemPrompt` 服务时**不假装成功**：`get()` 拿不到就 3 秒后再看一次，
  仍没有就在 health 里写明原因，挂件与记账照常工作（不写进 inject，见 AGENTS 事实 11）。

### 真机修复

- **挂件"裸奔"**：`css()` 建了 `<style>` 却**没 append 进文档** ⇒ 一条规则都不生效，
  右下角本该是小圆点，实际是「方寸 · N」+ 20 条待办以纯文本排在 `<body>` 末尾
  （从挂件第一版就在）。现在把 style 挂进 `<head>`，并且根节点自带内联定位、
  折叠态用内联 `display` —— 样式再丢一次，最坏是丑，不许排进正文。
- **位置可选，默认右上角**：面板底部四选一，存 `localStorage`。
  默认不占右下：`dsh-whale-widget` 的根节点钉在 `right:0;bottom:0`（z-index 9999），
  第一次真机验证时挂件正压在鲸鱼脸上。
- **拖拽换角（默认上锁）**：面板里「拖动：已锁定 / 可拖动」，解锁后按住圆点拖，松手吸到最近的角；
  位移 <6px 当点击，真拖过后 300ms 内的 click 吞掉（免得顺手开面板）。
- **`servedByPage` 误判**：桌面端 Electron 的请求既没有 `sec-fetch-*` 也没有 `referer`，
  旧判据在真机上恒为 0 —— 「页面在跑」被读成「没人来取」。
  现在主判据换成注入行自己加的 `?from=page`，请求头只当辅助。

### 桌面端挂件消失（2026-11-04 真机回归）

重启之后桌面端**看不见挂件**，但证据不是"没装上"：脚本被页面取走过（`servedByPage=1`），
之后 `/fangcun/api/tasks` 每 60 秒仍被调用 —— 说明脚本确实跑起来过、定时器还活着，
只是页面上没有那个角标。桌面端页面是 `dsh-app://app/`，注入行由页面侧解释执行，
中间任何一环静默失败都只看得到"挂件没了"。

- **页面自证**：注入行一执行就报 `boot`（页面地址 / readyState），挂上时报 `mount`，
  800ms 后报 `probe`（量到的位置、命中元素是不是自己），根节点被摘掉报 `removed`，
  脚本语法错 / 404 / 被 CSP 挡 / `mount()` 抛异常都由**注入行挂的全局 error 监听**报上来。
  落在 `/fangcun/api/widget-report`（只收本机），`health.widget.page` 留最近 12 条。
- **被摘掉自动补挂**：`MutationObserver` 盯 `body.childList`，根节点不在就重建（不重复起轮询）。
- **收起态改成带字的胶囊**：以前收起只留 8px 绿点，用户只会说"挂件没了"；现在写「方寸」。
- `health.widget` 的口径补清楚：`injected/pushed` 是**注入表被收集的次数**（桌面 boot 一次 +
  每次 index 渲染一次），不是插件被 apply 了几次。

### 没装方寸本体：直接给下载入口（2026-11-04）

以前只有两句「未连接」，可"压根没装"和"装了没开"要人做的事完全不同。现在分开：

- **只读文件判定装机痕迹**（`lib/detect.js`）：`data-dir.json` → Electron userData →
  electron-updater 目录 → 开始菜单/桌面快捷方式 → Program Files / Programs 下的同名字目录。
  不跑进程、不发网络请求；装了没跑也认得出（安装器建的快捷方式）；
- **挂件角标**：「方寸未安装 · 去下载」，面板里给 `releases/latest` 地址，装好后点「重试」；
- **一行现状**：「方寸 · 未安装」（不再混成「未连接」），规则段同时教 agent 把下载地址说出来；
- **health**：`fangcun.installed / installedEvidence / downloadUrl`；`/fangcun/api/tasks` 的
  200 与 503 都带上这两个字段，挂件据此选界面。

- **真因（2026-11-04 晚，重启后的自证链给出来的）**：桌面窗口在 Windows 上是
  `titleBarStyle:'hidden'` + `titleBarOverlay{height:40}` —— 页面铺满整窗，**顶上 40px 被原生窗口按钮盖住**。
  挂件挂在 `top:14px`，DOM 里完全正常（`probe` 显示 `in=1`、`hit=fc-pill`），人眼就是看不见。
  现在顶部两个角会量 `env(titlebar-area-height)` 让开（浏览器页量到 0，行为不变）。

- **右键菜单**（2026-11-04 用户反馈"不能拖、不能右键，只能左键"）：右键角标就地给出
  解锁拖动 / 四角位置 / 刷新 / 打开看板 / 收起；锁着时硬拖会提示「拖动已锁定：右键菜单里解锁」，
  不再一声不响。拖动**默认锁着**是故意的（防手抖），但"为什么拖不动"必须说得出。

- **拖动改成自由摆放**（2026-11-05 用户反馈："可以拖了，但拖完自动吸附，不能放在想要的位置；
  同一台机器上的鲸鱼余额挂件却是真拖动，随便拖哪里都行"）：解锁后拖到哪就停哪，松手不吸角、
  不弹回，位置存 `localStorage`（`fc-todo-widget:pos`，形如 `"x,y"`），刷新与重启都还在。
  拖到窗口边会被夹进可见区（顶部让开原生窗口按钮区），窗口缩小后也会自动夹回来。
  四角按钮保留成**快捷键**：点一下仍然一键摆到那一角。
  配套改动：自由模式下待办面板改成 `position:absolute` 挂在角标上/下（下半屏自动往上翻），
  开合面板不会再把这个角标顶走；坐标量的是**角标**本身，不是会随面板变大的根节点。

### 真联动：能度量、能归因、挂件说人话（2026-11-05）

用户反馈："还有没有其他要改的东西？比如让DSH真正和方寸联动起来，而不是摆设？
目前挂件本身展示的信息倒是没多大意义。"（契约 REV-005）

- **逐轮度量**（`lib/proof.js` + `turns.jsonl`）：每轮收尾记一行，存的是**顺序** ——
  第一次工具是谁、方寸读在第几位、改文件在第几位、回写在第几位。`health.proof.turns` 直接出
  `turns / withEdit / readBeforeEdit / wroteBack / readOnly`，契约 ②7「开工先查」、
  ②8「收工回写」、②10「闲聊别查」不再靠人翻日志。判定对"读回来的历史"与"刚收尾的这一轮"
  用同一套口径，重启不漂；`turn/end` 没带轮次时收最新一轮；半轮在会话销毁时补结算。
- **卡号追踪**（`lib/cards.js`）：只从 `tool/call` 的 `arguments.id` 里、只对五个带卡号的工具取，
  **参数里其余字段一个都不读**。用在两处：`usage_report` 的 `note` 带 `card=<卡号>`
  （方寸可按卡归因 token；放不进 120 字就不带，绝不写半截 id）；挂件的「本次在办」。
- **挂件说人话**：角标从 `方寸 · 130` 变成 `方寸 · 130 · 在办 3 · 待拍板 2`
  （在办 = status「进行中」，待拍板 = 「待验收/待审批」，都是方寸自己的标签，不另判优先级）；
  面板顶部多一行「本次在办」（最近一次动过的那张卡，点它复制卡号+标题）；
  点条目复制的是「卡号 + 标题」，粘进对话就能开工。
- **口径对齐**：`/fangcun/api/tasks` 现在也跟 `FANGCUN_PROJECT` 走，与上下文里那一行同一个项目范围
  （以前挂件永远报全部项目，设了这个变量两边会各说各的）。

### 测试

70 条（`npm test`）：

- 新增 `test/cards.test.mjs`：卡号只从白名单取（日志 id 不算卡号、脏值不取）、
  一轮去重/焦点 TTL/会话销毁即忘/轮次上限、逐轮判定（先查后改、改了没回写、只查不干）、
  半轮在会话销毁时结算、`turn/end` 不带轮次也能收尾、`note` 带 `card=` 且不超 120 字、
  挂件计数与 `focus` 照方寸口径；
- 新增 `test/prompt.test.mjs`：规则段四个触发点、注册与撤销、provider 抛错兜底、
  一行现状格式（全部项目 / 指定项目 / 未连接 / 未知）、未完成口径、BoardStatus 真起假管道、
  自证过滤与上限；
- 新增 `test/detect.test.mjs`：干净机器判未安装并列出查过哪几处、五种装机痕迹各自认得出来、
  环境变量缺失时**不许拼相对路径**、诊断文本是人话；
- `test/widget-dom.test.mjs` 新增 ⑬⑭（没装给下载入口 / 装了没开仍说未连接）、
  ⑮（桌面端顶部安全区：右上角让开原生窗口按钮，下边的角不受影响）、
  ⑯⑰（右键菜单解锁拖动 / 锁着硬拖给提示）；
- `test/widget.test.mjs` 新增 ⑥（装机判定进 health 与 tasks 响应，没装才给下载地址）；
- `test/widget-dom.test.mjs` 新增 ⑨⑩⑪（样式表挂进文档 / 位置四角 / 拖动=自由摆放与锁定，
  含"松手落盘坐标""拖出屏幕被夹回""面板绝对定位""点四角清掉自由坐标""脏坐标回默认"）与
  ⑫（根节点被摘掉时自动补挂、不重复起轮询）；
- `test/widget.test.mjs` 新增 ⑤（页面自证上报：本机记账、非本机 403、非 GET 405）；
- `test/plugin.test.mjs` 新增 ⑧⑨（apply 真的注册了提示词、方寸工具真的落了自证日志、没服务时不假装）；
- `test/widget.test.mjs` ②b 改写为"带标记算、curl 不算、没头的浏览器也算"；
- 变异验证：去掉 `appendChild` 只有挂件 ⑨ 红；默认角改回右下 ⑨⑩ 红；
  去掉锁定判断 / 拖后吞点击 只有 ⑪ 红；自证不过滤工具 只有 ⑧ 红；规则段不注册 只有 ② 红；
  `note` 里无条件塞卡号 只有 `cards ④` 红；判定只看当前轮不看历史 `cards ③` 红。

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
- **真机验收修掉两处**（2026-11-03，都是"测试绿、真机不对"的契约错位）：

  - **`session/event` 的第一个参数是 Session 对象，不是字符串**。旧实现 `String(sessionId)`
    把每个会话都拍成 `"[object Object]"`，幂等键退化成 `[object Object]#<turn>` ——
    不同会话的同一 turn 互相顶掉，真机表现为**静默漏报**（方寸账本里 note 写着 `session=[object`）。
    现在 `sessionIdOf()` 归一化（认 `id` / `sessionId` / `header.id`），
    并**显式拒绝 `"[object Object]"`**；取不出 id 时报一次错并跳过，不编假 id。
    补测试 ⑥/⑥b：两条不同会话的第 1 轮都必须报出去。
  - `note` 里的会话短名：`id.slice(0,8)` 对 `session-<uuid>` 只会得到 `session-`
    （八个字符一点区分度都没有），改成去掉前缀再取 8 位。
  - `health` 新增 `usage.{lastSentAt,lastError}`（失败要看得见）与
    `widget.{injected,pushed,servedByPage,lastServedAt}`（真机验收 ② 的证据链：
    靠 `sec-fetch-dest` / `referer` 区分"页面真的加载了脚本"和"有人 curl 了一下"）。

- 用量健壮性（P2）：

  - **子代理会话**：宿主没有 `subagent/start|end` 事件，判据在 `SessionHeader`
    （`origin === 'subagent'` / `parentSession` / `delegationDepth > 0`）。子代理的 token 照报，
    `note` 加 `subagent=1` 以便与主会话区分。
  - 订阅改用 `{ global: true }`（`EventOptions` 原文："regardless of context filter checks"），
    否则子代理会话的事件收不到；带参调用抛异常时退回两参形式，**绝不两次都注册**（那会每轮记两遍）。
  - **outbox 上限 500 条**：超了丢最旧的并报错。它每轮整份重写，无上限会把磁盘和 CPU 一起拖死。
  - **轮次回绕的防守**：`turn` 其实来自持久投影、不会回绕（详见 AGENTS.md 事实 10e），
    但万一回绕且撞上已发键，原本会**静默丢掉一整轮**；现在会报错说明丢的是哪一轮。
  - `test/usage.test.mjs` 新增 ⑦（子代理标记）、⑧（outbox 上限）、⑨（回绕不静默）；
    `test/plugin.test.mjs` 新增 ⑦（从 `apply()` 一路验到 outbox 的接线）。
  - **已知缺口（未接）**：`compaction/summary` 自带 `usage`，压缩消耗的 token 现在没进账；
    但尚不确定它是否同时体现为 `assistant/message`，**先真机对比再决定**（多报账比少报更糟）。

- 挂件体验（P3）：

  - **深色主题**：颜色走 CSS 变量 + `@media (prefers-color-scheme: dark)`，不写死白底，
    也不去读站点自己的 CSS 变量（读别人的变量等于赌它不改名）。
  - **展开状态记忆**：`localStorage` 记住展开/收起，默认收起，别挡 DSH 自己的控件。
  - **可以关掉**：关掉后留一个小圆点能点回来（直接消失的话，用户只能去清 localStorage）。
  - **点条目 = 复制 id**（只读）；空态与错误态都能"点一下重试"，并区分
    "方寸未连接" 与 "没有未完成的卡"。
  - **看板入口用真实端口**：读数据根下 `.tegula-port` 第一行（实测是 8791，不是文档里的 8753），
    读不到就不显示入口 —— 不给用户一个打不开的链接。
  - 新增 `test/widget-dom.test.mjs`：用替身 DOM **真执行** `WIDGET_JS`（8 条）。
    原来只断言"字符串里有没有某个词"，那样"语法对但一执行就抛"照样绿 ——
    而它在真机上的表现是"装上了但页面没角标"，得看宿主日志才查得动。

## 0.1.0（2026-11-03）

首个版本，只做「能装 + 能自报状态」，不假装功能齐了。

- `GET /fangcun/health.json`：报方寸数据根来源、`registry.yaml` / `task-data` / `policies` 是否存在、MCP 管道路径、契约版本，以及还没做的两件事
- 路由按 DSH 真实形态注册：`{ kind: 'exact', path, handler }`（修正骨架期写的 `{ method, … }`）
- 数据根认不出时返回空串，不猜路径
- 零依赖（只用 Node 内置模块）；不 import 方寸代码、不 import electron
- CI：tag 触发 → 校验版本一致 → 测试 → `npm pack` → 发 GitHub Release（附 SHA256SUMS）
