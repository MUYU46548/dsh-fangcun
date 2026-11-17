/**
 * 派单消费：「方寸点一下 → DSH 里冒出一个新会话」（2026-11-17·那根管子）。
 *
 * 暮雨原话：「管子现在就做，它是其他一切的前提。」
 *
 * ## 两端各做什么
 *
 * | 端 | 做什么 | 为什么 |
 * |---|---|---|
 * | 方寸 | 写一份派单文件到 `<数据根>/.dispatch-dsh/` | 方寸不 import DSH，也不 spawn 它 |
 * | 插件（本文件） | 看见派单 → 在 DSH 里开新会话 → 带上上下文包 → **删掉派单** | 插件就在 DSH 里跑，天然知道 profile 与怎么收结果 |
 *
 * ## 为什么经文件，而不是两边直连
 *
 * 三方各有硬边界，只有文件能同时满足：
 *   ① 方寸**不 import DSH 的任何东西**；
 *   ② 插件**不 import 方寸代码**（`test/plugin.test.mjs ③` 钉着，`layering` 也钉着）；
 *   ③ 上下文包上万字，塞不进命令行参数。
 *
 * ## 两个必须守住的纪律
 *
 * ① **绝不双开**：同一个派单只消费一次（消费后立即删）。
 *    重复建会话会让用户看到"我明明只点了一次，冒出三个窗口"。
 * ② **绝不假装**：DSH 没有 `agents` 服务（老宿主/形状变了）时，
 *    **明说派不出去**并留下派单文件（下次还能试），不许默默吞掉。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 派单目录（与方寸 `contextPack.dispatchDir()` 同一口径：数据根下的 `.dispatch-dsh/`） */
export function dispatchDirOf(dataDir) {
  const dir = String(dataDir || '').trim()
  if (!dir) return ''
  return path.join(dir, '.dispatch-dsh')
}

/**
 * 派单**用途**（2026-11-17 暮雨定案：「以后可以直接在 DSH 里派活做规划」）。
 *
 * 为什么要有这个字段：同一根管子上现在跑两种完全不同的活 ——
 *   · `work`  开工：**改代码/改卡**，模型该动手；
 *   · `plan`  规划：**产出计划**，模型该先想清楚再动手，且产物是「可机检的判据」而非散文。
 * 两者对模型的指令不同（见 `dispatchPrompt`），不能共用一段话术。
 *
 * ⚠ 缺省是 `work`：老派单文件没有这个字段，行为必须与 0.6.0 完全相同（零破坏）。
 */
export const DISPATCH_KINDS = ['work', 'plan']

export function normalizeDispatchKind(raw) {
  const k = String(raw || '').trim().toLowerCase()
  return DISPATCH_KINDS.includes(k) ? k : 'work'
}

/**
 * 拆一份派单文件：头部是 `<!-- fangcun-dispatch v1 ... -->` 的 key: value 行，
 * 下面正文直接当上下文包用。
 *
 * 解析失败**返回 null 而不是抛**：坏文件不该卡住整个消费循环（`usage ④` 同一条纪律）。
 */
export function parseDispatch(raw) {
  const text = String(raw || '')
  const head = /<!--\s*fangcun-dispatch v1([\s\S]*?)-->/.exec(text)
  if (!head) return null
  const meta = {}
  for (const line of head[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.project) return null
  // 正文 = 头部之后的部分。两个空行都可能出现（方寸写的时候加了一个，
  // 文件里也可能本来就有），这里**统一剥掉开头所有空行** —— 否则投给会话的第一条消息
  // 会在标题前空两行，看着像"内容没进去"。
  const body = text.slice(head.index + head[0].length).replace(/^(?:[ \t]*\r?\n)+/, '')
  return {
    project: meta.project,
    projectName: meta.projectName || '',
    at: meta.at || '',
    kind: normalizeDispatchKind(meta.kind),
    chars: Number(meta.chars) || body.length,
    missing: meta.missing ? meta.missing.split('|').filter(Boolean) : [],
    body,
  }
}

/**
 * 列出派单文件，**最新的在前**。
 *
 * 为什么按 mtime 而不是文件名里的时间戳：文件名是人可读的，mtime 才是文件系统的事实。
 * 两者不一致时（例如从别处拷进来的）以 mtime 为准 —— 那是它真正"什么时候到这里"。
 */
export function listDispatches(dataDir) {
  const dir = dispatchDirOf(dataDir)
  if (!dir) return []
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => /^dispatch-.*\.md$/.test(n))
  } catch {
    return []   // 目录不存在 = 没人派过单，这是常态不是错误
  }
  const rows = []
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      rows.push({ name, path: full, mtime: st.mtimeMs })
    } catch { /* 半路被删的忽略 */ }
  }
  return rows.sort((a, b) => b.mtime - a.mtime)
}

/**
 * 消费一份派单：读 → 解析 → 交给 `open` → **成功后删掉**。
 *
 * 删除时机很关键：**会话真的建起来了才删**。
 * 建失败就留着（下次启动还能重试），否则用户点了一次、什么也没发生、派单也没了 ——
 * 那是最坏的一种"静默失败"。
 *
 * @param {{path: string}} row - `listDispatches` 的一行
 * @param {(payload: object) => Promise<{ok: boolean, sessionId?: string, error?: string}>} open
 * @returns {Promise<{ok: boolean, project?: string, sessionId?: string, error?: string}>}
 */
export async function consumeDispatch(row, open) {
  if (!row || !row.path) return { ok: false, error: '没有派单文件' }
  let raw = ''
  try {
    raw = fs.readFileSync(row.path, 'utf-8')
  } catch (e) {
    return { ok: false, error: '读不到派单：' + String((e && e.message) || e) }
  }
  const payload = parseDispatch(raw)
  if (!payload) {
    // 坏派单：删掉它，别让每轮都去读一个永远解不开的文件
    try { fs.unlinkSync(row.path) } catch { /* ignore */ }
    return { ok: false, error: '派单文件格式不对（已丢弃）' }
  }
  let res
  try {
    res = await open(payload)
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) }
  }
  if (res && res.ok) {
    try { fs.unlinkSync(row.path) } catch { /* 删不掉也别让会话白建 */ }
    return { ok: true, project: payload.project, sessionId: res.sessionId || '' }
  }
  return { ok: false, project: payload.project, error: (res && res.error) || '会话没建起来' }
}

/**
 * 把上下文包塞进新会话的**第一条用户消息**。
 *
 * 为什么不是塞 systemPrompt：systemPrompt 是每次装配都重算的，
 * 而这个包是"这一次派单的快照"——它属于**这一轮的历史**，不该跟着每一轮变。
 * 塞成 user/message，模型看得到，也能在后面的轮次里被引用。
 *
 * ⚠ 两种用途的话术**必须不同**（2026-11-17 暮雨：「以后直接在 DSH 里派活做规划」）：
 *   · plan：产物是**可机检的判据**，不许写成散文。这是方寸唯一能自动验的东西 ——
 *     规划若落不成判据，它就退化成"感觉变好了"，那条路已经走过一遍且失败过。
 *   · work：产物是**改动的卡/代码**，强调先查后改、回写、别签字。
 */
export function dispatchPrompt(payload) {
  const p = payload || {}
  const kind = normalizeDispatchKind(p.kind)
  const miss = (p.missing && p.missing.length)
    ? `\n\n⚠ 这个包缺：${p.missing.join('、')} —— 那几处**真没写**，不要替项目编。`
    : ''
  const head = `【方寸派单 · ${kind === 'plan' ? '规划' : '开工'}】项目 ${p.project}${p.projectName ? '（' + p.projectName + '）' : ''}`

  const tail = kind === 'plan'
    ? [
      '',
      '---',
      '上面是方寸里这个项目的现状（契约/方针/决策/未完成卡/最近日志）。',
      '',
      '**这次是让你做规划，不是让你马上改代码。**',
      '',
      '方寸自己不再产计划了（它那套「宪法页 + 七道闸」已定案重做）——',
      '规划**在你这里做**，方寸只负责：把项目现实交给你（就是上面这段）、事后按判据机检、记账。',
      '',
      '## 要你产出的东西',
      '',
      '按「**下一步该干什么 + 按什么顺序 + 排除了什么**」给出 2–5 个阶段，每个阶段必须带：',
      '',
      '- **做什么**：一句话，不要背景铺垫',
      '- **判据**：每条前面必须打四类前缀之一 ——',
      '  `cmd:`（跑命令看退出码/输出）、`str:`（某原文必须出现）、`num:`（某个数 == N）、`file:`（某路径存在）。',
      '  ⚠ **写不出判据的条目不要写** —— 方寸验不了它，它就会变成一张永远验收不了的卡。',
      '- **依据**：指回上面材料里的具体一处（哪张卡 / 哪条决策 / 哪个文件）。引不出依据的条目**不许编**。',
      '',
      '## 三条硬约束',
      '',
      '① 方寸**不砍功能**（用户 11-08 已定：每个功能都有用，没有多余功能）——不许把"砍掉 X"当规划；',
      '② 有的事**只有用户能拍板**（方向/取舍/验收线），把它写进「需要问用户的问题」，别自己替他定；',
      '③ 做完把结果写回方寸：卡用 `fangcun_write`，`完成`/`驳回` 是用户的签字，不要设。',
    ]
    : [
      '',
      '---',
      '上面是方寸里这个项目的现状（契约/方针/决策/未完成卡/最近日志）。',
      '请据此判断**下一步该做什么**，给出顺序并说清排除了什么。',
      '动手改卡请用 fangcun_write；`完成` / `驳回` 是用户的签字，不要设。',
    ]

  return [head, '', String(p.body || ''), miss, ...tail].join('\n')
}
