/**
 * 方寸本体装没装 —— **只读本机文件，不跑进程、不发网络请求**。
 *
 * 为什么要单独判一次：`resolveDataDir()` 找不到数据根只能说明"没数据"，
 * 而这有三种情况，给的提示完全不同：
 *  · 机器上根本没装方寸桌面版 → 该请用户去下载；
 *  · 装了但从没启动过（还没选数据目录）→ 该请用户打开方寸；
 *  · 装了也在跑，只是管道名不对 → 该查 `FANGCUN_MCP_PIPE`。
 * 把前两种混成一句"未连接"，用户只会以为自己网络有问题。
 *
 * 判定只认**装机痕迹**，不猜路径：
 *  ① `data-dir.json`（跑过方寸才会写）→ 最硬的证据；
 *  ② `%APPDATA%\fangcun-desktop` / `%APPDATA%\Fangcun`（Electron userData）；
 *  ③ `%LOCALAPPDATA%\fangcun-desktop-updater`（electron-updater 的安装痕迹）；
 *  ④ 开始菜单 / 桌面的「方寸.lnk」「Fangcun.lnk」（NSIS 安装器建的，**装了没跑也认得出**）；
 *  ⑤ `Programs` / `Program Files` 下名字像 fangcun / 方寸 / tegula 的目录。
 *
 * 认不出的情况（自定义目录 + 没建快捷方式）宁可报 false：**提示下载**比
 * "明明装了却说你没装"更可接受 —— 后者会让用户去重装，代价更大。所以 evidence
 * 会一起报上去，`installed=false` 时你看得到"我查了哪些地方"。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 方寸桌面版的下载页（仓库 README 里的 Releases 页） */
export const DOWNLOAD_URL = 'https://github.com/MUYU46548/fangcun/releases/latest'

const INSTALL_DIR_NAMES = ['fangcun', '方寸', 'tegula', 'fangcun-desktop']
const SHORTCUT_NAMES = ['方寸.lnk', 'Fangcun.lnk', 'fangcun.lnk', 'Tegula.lnk']

function defaultExists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

/**
 * @param {object} [env] 环境变量（默认 process.env；测试传替身）
 * @param {{ exists?: (p: string) => boolean }} [options] 只为测试留的注入口
 * @returns {{installed: boolean, evidence: string, checked: string[], downloadUrl: string}}
 */
export function detectInstall(env = process.env, options = {}) {
  const exists = typeof options.exists === 'function' ? options.exists : defaultExists
  const appData = String(env.APPDATA || '')
  const localAppData = String(env.LOCALAPPDATA || '')
  const programData = String(env.ProgramData || env.PROGRAMDATA || '')
  const userProfile = String(env.USERPROFILE || '')
  const programFiles = [
    String(env.ProgramFiles || env.PROGRAMFILES || ''),
    String(env['ProgramFiles(x86)'] || ''),
  ].filter(Boolean)

  const checked = []
  const check = (p) => {
    if (!p) return false
    checked.push(p)
    return exists(p)
  }
  /** 基底为空就别拼路径：否则 `path.join('', 'x')` 会变成**相对当前目录**的检查 */
  const joinIf = (base, ...parts) => (base ? path.join(base, ...parts) : '')
  const done = (evidence) => ({ installed: Boolean(evidence), evidence, checked, downloadUrl: DOWNLOAD_URL })

  // ① 数据根：方寸跑过才会写 data-dir.json
  for (const folder of ['方寸', 'Fangcun', 'fangcun-desktop']) {
    if (check(joinIf(appData, folder, 'data-dir.json'))) return done('data-dir')
  }

  // ② Electron userData（装过、启动过）
  for (const folder of ['fangcun-desktop', 'Fangcun']) {
    if (check(joinIf(appData, folder))) return done('user-data')
  }

  // ③ 更新器留下的目录（安装器跑过）
  if (check(joinIf(localAppData, 'fangcun-desktop-updater'))) return done('updater')

  // ④ 快捷方式：装了没跑也认得出
  const shortcutDirs = [
    joinIf(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    joinIf(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    joinIf(userProfile, 'Desktop'),
  ]
  for (const dir of shortcutDirs) {
    for (const name of SHORTCUT_NAMES) {
      if (check(joinIf(dir, name))) return done('shortcut')
    }
  }

  // ⑤ 常见安装目录里名字像方寸的
  for (const root of [...programFiles, joinIf(localAppData, 'Programs')]) {
    for (const name of INSTALL_DIR_NAMES) {
      if (check(joinIf(root, name))) return done('install-dir')
    }
  }

  return done('')
}

/** 一行给人看的诊断（health / 日志用，不参与判定） */
export function describeInstall(info) {
  if (!info) return 'unknown'
  if (!info.installed) return '未检测到（查了 ' + info.checked.length + ' 处：' + info.checked.join(' / ') + '）'
  return '已安装（证据：' + info.evidence + '）'
}
