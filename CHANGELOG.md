# 变更记录

## 0.6.1（2026-11-17）· 模型工具其实一次都没注册上

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

### 验证

- `npm test` **121 / 0**（0.6.0 是 119）
- `npm pack` + 解包真 apply：`SMOKE OK version=0.6.1 routes=4 tools=4`
- 四个 tool schema 逐个过宿主口径校验：全绿


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
