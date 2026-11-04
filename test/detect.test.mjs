/**
 * 「这台机器装没装方寸本体」的判定。
 *
 * 为什么要测：这句话会直接变成给用户的提示 —— 说错了要么让人白重装，
 * 要么让人以为只是"没开"。所以每条装机痕迹**单独**验一遍，且必须能说清是拿什么认出来的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DOWNLOAD_URL, describeInstall, detectInstall } from '../lib/detect.js'

/** 一个 Windows 形状的假环境 */
const ENV = {
  APPDATA: 'C:\\Users\\t\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  USERPROFILE: 'C:\\Users\\t',
}

/** 只让列出来的路径"存在"，其它一律不存在 */
const only = (paths) => (p) => paths.includes(p)

test('① 干净机器：判定未安装，并列出查过哪些地方（不猜路径）', () => {
  const info = detectInstall(ENV, { exists: () => false })
  assert.equal(info.installed, false)
  assert.equal(info.evidence, '')
  assert.equal(info.downloadUrl, DOWNLOAD_URL, '未安装时必须给下载地址')
  assert.match(info.downloadUrl, /^https:\/\/github\.com\/MUYU46548\/fangcun\/releases/)
  assert.ok(info.checked.length >= 5, '要说清楚查了哪几处，不能只报一个 false')
  assert.ok(info.checked.every((p) => p.includes('C:\\')), '只查绝对路径，不许拼出相对路径')
})

test('② 跑过方寸（data-dir.json）→ data-dir；数据根优先于其它证据', () => {
  const p = 'C:\\Users\\t\\AppData\\Roaming\\fangcun-desktop\\data-dir.json'
  const info = detectInstall(ENV, { exists: only([p]) })
  assert.equal(info.installed, true)
  assert.equal(info.evidence, 'data-dir')
})

test('③ 装了但没跑：开始菜单快捷方式也算数', () => {
  const lnk = 'C:\\Users\\t\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\方寸.lnk'
  const info = detectInstall(ENV, { exists: only([lnk]) })
  assert.equal(info.installed, true)
  assert.equal(info.evidence, 'shortcut', 'NSIS 安装器建的快捷方式：装了没跑也认得出')
})

test('④ userData / 更新器 / 安装目录三种痕迹各自都能认出来', () => {
  const cases = [
    ['C:\\Users\\t\\AppData\\Roaming\\fangcun-desktop', 'user-data'],
    ['C:\\Users\\t\\AppData\\Local\\fangcun-desktop-updater', 'updater'],
    ['C:\\Program Files\\fangcun', 'install-dir'],
  ]
  for (const [p, evidence] of cases) {
    const info = detectInstall(ENV, { exists: only([p]) })
    assert.equal(info.installed, true, p)
    assert.equal(info.evidence, evidence, p)
  }
})

test('⑤ 环境变量缺一半也不许查相对路径（本地目录不能被当成"装了"）', () => {
  const info = detectInstall({}, { exists: (p) => !p.includes(':') })
  assert.equal(info.installed, false)
  assert.deepEqual(info.checked, [], '没有基底就不查，别拼出相对路径')
})

test('⑥ 诊断文本要人话：未安装给"查了哪几处"，已安装给证据', () => {
  const no = describeInstall(detectInstall(ENV, { exists: () => false }))
  assert.match(no, /未检测到/)
  assert.match(no, /查了 \d+ 处/)

  const yes = describeInstall(detectInstall(ENV, { exists: (p) => p.endsWith('fangcun-desktop') }))
  assert.match(yes, /已安装/)
  assert.match(yes, /user-data/)
})
