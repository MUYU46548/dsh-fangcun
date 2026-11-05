# 变更记录

## 0.3.0（未发版）

这一版把契约 ⑥ 剩下的三件事做完：**规则段**、**一行现状**、**自证 sidecar**；
外加一轮真机修复（挂件"裸奔"、位置、拖拽、`servedByPage` 误判）。

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
