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
 */
export function dispatchPrompt(payload) {
  const p = payload || {}
  const miss = (p.missing && p.missing.length)
    ? `\n\n⚠ 这个包缺：${p.missing.join('、')} —— 那几处**真没写**，不要替项目编。`
    : ''
  return [
    `【方寸派单】项目 ${p.project}${p.projectName ? '（' + p.projectName + '）' : ''} 的上下文包`,
    '',
    String(p.body || ''),
    miss,
    '',
    '---',
    '上面是方寸里这个项目的现状（契约/方针/决策/未完成卡/最近日志）。',
    '请据此判断**下一步该做什么**，给出顺序并说清排除了什么。',
    '动手改卡请用 fangcun_write；`完成` / `驳回` 是用户的签字，不要设。',
  ].join('\n')
}
