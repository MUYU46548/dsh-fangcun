/**
 * 宿主兼容性自检（2026-11-17 用户拍板："DSH 升级是经常发生的事情，插件应该只提醒而不是退出服务，
 * 能不能用随缘，插件永远只保适配版本"）。
 *
 * ## 为什么要这个模块
 *
 * 核实过宿主的两段代码（`@deepseek-ai/dsh-app-boot` 与 `dsh-plugin-manager`）：
 *
 *   ① `engines.dsh` 写在 package.json 里时，宿主在**加载 bundle 那一步**判：
 *      `evaluatePluginCompatibility()` 不满足 → `throw` → **被 catch 成 `skippedBundles`**，
 *      于是整个插件静默消失（挂件/记账/工具全没了，界面上只有"插件没装"）。
 *      这一段**不是插件能控制的**，只能靠 `engines` 不写上界来避免（已改）。
 *
 *   ② 但"不写上界"不等于"永远能用"：新宿主可能把 `webServer.register` 的参数换了、
 *      把 `tools.register` 的 output 形状换了、把 `session/event` 的数据挪了。
 *      那时插件**加载上但少干活**，而 `health` 里不会自己说出来。
 *
 * ## 所以这一层做什么
 *
 * **只体检、只报告、绝不退出**。每个关键宿主能力给一个三态：
 *
 *   ok       —— 拿到了，而且形状对
 *   degraded —— 拿到了，但形状看着不对（可能部分功能会静默失效）
 *   missing  —— 根本没这个服务/事件（老宿主，或宿主改名了）
 *
 * 结论进 `health.compat`，并在**探测到不匹配时**往 `health.compat.warnings` 塞一句人话。
 * 插件照常工作 —— 能用的部分继续用，这是"随缘"的具体含义。
 *
 * ## 为什么不 import DSH 的包来比版本
 *
 * 插件是**零依赖**的（硬边界）。而且拿 `engines.dsh` 的版本号去比 "我测过哪些版本"
 * 本来就是错的口径：版本号相等不代表 API 没变（preview 期尤其如此）。
 * 这里的判据全部是**运行时真实可见的形状**——比版本号可靠。
 */

/** 期望的宿主能力清单。`probe(root)` 返回 ok/degraded/missing。 */
export const HOST_CAPABILITIES = [
  {
    key: 'webServer',
    need: '挂件脚本与 4 条只读路由',
    probe(root) {
      const svc = get(root, 'webServer')
      if (!svc) return 'missing'
      return typeof svc.register === 'function' ? 'ok' : 'degraded'
    },
  },
  {
    key: 'systemPrompt',
    need: '规则段与一行现状',
    probe(root) {
      const svc = get(root, 'systemPrompt')
      if (!svc) return 'missing'
      return typeof svc.section === 'function' ? 'ok' : 'degraded'
    },
  },
  {
    key: 'tools',
    need: 'fangcun_tasks / fangcun_card / fangcun_write',
    probe(root) {
      const svc = get(root, 'tools')
      if (!svc) return 'missing'
      return typeof svc.register === 'function' ? 'ok' : 'degraded'
    },
  },
  {
    key: 'session/event',
    need: 'token 记账与自证',
    probe(root) {
      // 事件不是服务，只能看 root.on 能不能用。
      // ⚠ 只判 `typeof === 'function'` 不够：宿主可能把它换成"能调用但会抛"的东西，
      //   那与"根本没有"对插件是同一件事（收不到事件）。所以真调一次再注销。
      return canSubscribe(root)
    },
  },
  {
    key: 'webserver/index-inject',
    need: '挂件注入行',
    probe(root) {
      return canSubscribe(root)
    },
  },
  {
    key: 'effect',
    need: '可撤销注册（避免重复挂载）',
    probe(root) {
      return typeof root.effect === 'function' ? 'ok' : 'missing'
    },
  },
]

function get(root, name) {
  try {
    return typeof root.get === 'function' ? root.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * `root.on` 到底能不能订阅 —— **真调一次**再看能不能注销。
 *
 * 为什么要真调：`typeof fn === 'function'` 会放过"有这个方法但一调用就抛"的宿主
 * （2026-11-17 测试 ⑤ 就是这么抓出来的）。对插件来说"调不动"与"没有"是同一件事：
 * 订阅不上就等于收不到 `session/event`，记账与自证全哑。
 *
 * 订阅用一个不可能触发的假事件名，避免真的挂上去产生副作用；注销失败也算 ok
 * （能订阅才是关键）。
 */
function canSubscribe(root) {
  if (typeof root.on !== 'function') return 'missing'
  try {
    const off = root.on('fangcun/compat-probe', () => {})
    try { if (typeof off === 'function') off() } catch { /* 注销失败不影响判断 */ }
    return 'ok'
  } catch {
    return 'degraded'
  }
}

/** 三态 → 一句人话（只在不 ok 时用） */
function warnOf(key, need, state) {
  if (state === 'missing') {
    return `宿主没有 ${key} 服务/事件 —— ${need} 这块不可用（插件其余部分照常）`
  }
  return `${key} 存在但形状不像预期 —— ${need} 可能部分失效；宿主大概改过 API`
}

/**
 * 跑一次体检。**绝不抛**：任何探测出错都记成 missing 并继续。
 * @param {any} root - 插件 apply 拿到的根上下文
 * @returns {{checkedAt: string, capabilities: Record<string,string>, warnings: string[], summary: string}}
 */
export function checkHost(root) {
  const capabilities = {}
  const warnings = []
  for (const cap of HOST_CAPABILITIES) {
    let state = 'missing'
    try {
      state = cap.probe(root) || 'missing'
    } catch {
      state = 'missing'
    }
    capabilities[cap.key] = state
    if (state !== 'ok') warnings.push(warnOf(cap.key, cap.need, state))
  }
  const okCount = Object.values(capabilities).filter((v) => v === 'ok').length
  const total = HOST_CAPABILITIES.length
  return {
    checkedAt: new Date().toISOString(),
    capabilities,
    warnings,
    // 一句话现状：health 里一眼能看出"这版 DSH 还认不认我"
    summary: warnings.length === 0
      ? `全部 ${total} 项宿主能力正常`
      : `${okCount}/${total} 项正常，${warnings.length} 项有缺口（插件照常工作，只提醒）`,
  }
}
