/**
 * decide.ts —— dsh-tool-manager 的「工具/上下文启停判定」纯逻辑。
 *
 * 为什么独立成模块:
 *   1. 这里的判定必须与 clean-tool-filter.mjs 的 shouldDeny()(工具面)和 2c
 *      分支(上下文)严格一致;集中到纯函数里才不会在 GUI、预设过滤器两处漂移;
 *   2. 这些函数原先内联在 React 组件内部,无法被测试 —— 2026-10-11 修掉的
 *      「单独启用某个工具却用不了」正是 needsAllowExemption 漏掉一类兜底判定
 *      造成的,需要可回归的单测(tests/decide.test.mjs)守住。
 *
 * 判定链(与 clean-tool-filter.mjs 的 shouldDeny 逐条对齐,优先级高→低):
 *   allowNames > allowPrefixes > denyNames > denyPrefixes(用户)
 *   > DEFAULT_THIRD_PREFIXES > mcp 兜底(newDefault.mcp) > 第三方兜底(newDefault.third)
 */

export type LockState = 'enabled' | 'disabled'

export interface NewDefault {
  context: LockState
  third: LockState
  mcp: LockState
}

/** 保存的命名配置(不含 newDefault——「新增锁定」状态不随配置保存/切换)。 */
export interface SavedConfig {
  id: string
  name: string
  savedAt: string
  state: {
    denyPrefixes: string[]
    denyNames: string[]
    allowPrefixes: string[]
    allowNames: string[]
    denyContexts: string[]
    allowContexts: string[]
  }
}

export interface Config {
  denyPrefixes: string[]
  denyNames: string[]
  allowPrefixes: string[]
  allowNames: string[]
  denyContexts: string[]
  allowContexts: string[]
  newDefault: NewDefault
  configs: SavedConfig[]
}

export const EMPTY_CONFIG: Config = {
  denyPrefixes: [], denyNames: [], allowPrefixes: [], allowNames: [],
  denyContexts: [], allowContexts: [],
  newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' },
  configs: [],
}

/**
 * 与 clean-tool-filter.mjs 的 DEFAULT_DENY_PREFIXES 一致(anysearch_ 已移出默认屏蔽)。
 * 该名单在预设过滤器里是「无条件判禁」的一层,而不是走 newDefault.third 兜底。
 */
export const DEFAULT_THIRD_PREFIXES = [
  'dev_', 'memory', 'dtodo', 'skill_manage', 'undo_', 'redteam_',
  'ssh_', 'context_audit', 'describe_image', 'de_', 'file_mount_forget',
  'mcp_connector_', 'asar_',
]

/**
 * 第三方插件工具完整前缀(与 host classify 的兜底集合一致,含预设名单外的
 * anysearch_ / dev_mode_ 等,用于「新增锁定」对名单外第三方工具的兜底判定)。
 */
export const THIRD_PREFIXES = [
  'dev_mode_', 'dev_', 'anysearch_', 'memory', 'dtodo', 'skill_manage',
  'de_', 'undo_', 'context_audit', 'ssh_', 'redteam_', 'describe_image',
  'file_mount_forget', 'mcp_connector_', 'asar_',
]

/** 工具当前是否被纯净预设屏蔽(GUI 的显示口径)。 */
export function isEffectivelyDenied(cfg: Config, name: string): boolean {
  if (cfg.allowNames.includes(name)) return false
  if (cfg.allowPrefixes.some((p) => name.startsWith(p))) return false
  if (cfg.denyNames.includes(name)) return true
  if (cfg.denyPrefixes.some((p) => name.startsWith(p))) return true
  if (DEFAULT_THIRD_PREFIXES.some((p) => name.startsWith(p))) return true
  if (name.startsWith('mcp__')) return cfg.newDefault.mcp === 'disabled'
  if (THIRD_PREFIXES.some((p) => name.startsWith(p))) return cfg.newDefault.third === 'disabled'
  return false
}

/**
 * 该类工具「启用」时必须补写 allowNames 才能生效:它们除了 denyNames 之外
 * 还有一层兜底判定,仅把名字从 denyNames 移除不足以让它们可见。
 *   - MCP(mcp__*)            : 走 newDefault.mcp 兜底,默认禁用时无条件判禁。
 *   - 第三方前缀(THIRD_PREFIXES): 走 newDefault.third 兜底,默认禁用时无条件判禁。
 *   - 用户自定义 denyPrefixes : 前缀命中即判禁,与 denyNames 内容无关。
 * 三者统一走 allowNames(判定链中优先级最高)豁免,保证启用/禁用双向都真实生效。
 *
 * 【2026-10-11 修复】旧实现只查 mcp__ 与 DEFAULT_THIRD_PREFIXES,漏了
 * THIRD_PREFIXES 中「不在 DEFAULT 里」的前缀(anysearch_ / asar_ / dev_mode_)
 * 以及用户自己用「屏蔽前缀(附加)」加的 denyPrefixes ⇒ 这类工具点「启用」时
 * 只从 denyNames 移除、不写 allowNames,于是被兜底判定继续屏蔽,表现为
 * 「单独启用某个工具却用不了」。现在与 isEffectivelyDenied 的兜底分支严格对齐。
 */
export function needsAllowExemption(cfg: Config, name: string): boolean {
  return name.startsWith('mcp__')
    || cfg.denyPrefixes.some((p) => name.startsWith(p))
    || THIRD_PREFIXES.some((p) => name.startsWith(p))
}

/** 把单个工具设为启用/禁用,返回新 Config(双向清理 allow/deny 名单,避免残留复活)。 */
export function applyDeny(cfg0: Config, name: string, denied: boolean): Config {
  const next: Config = { ...cfg0, denyNames: [...cfg0.denyNames], allowNames: [...cfg0.allowNames] }
  if (denied) {
    if (!next.denyNames.includes(name)) next.denyNames.push(name)
    next.allowNames = next.allowNames.filter((n) => n !== name)
  } else {
    next.denyNames = next.denyNames.filter((n) => n !== name)
    if (needsAllowExemption(cfg0, name) && !next.allowNames.includes(name)) {
      next.allowNames.push(name)
    }
  }
  return next
}

/** 上下文注入的纯函数式禁用/启用(denyContexts + allowContexts 双向清理)。 */
export function applyContextDeny(cfg0: Config, name: string, denied: boolean): Config {
  const next: Config = { ...cfg0, denyContexts: [...cfg0.denyContexts], allowContexts: [...cfg0.allowContexts] }
  if (denied) {
    if (!next.denyContexts.includes(name)) next.denyContexts.push(name)
    next.allowContexts = next.allowContexts.filter((n) => n !== name)
  } else {
    next.denyContexts = next.denyContexts.filter((n) => n !== name)
    if (!next.allowContexts.includes(name)) next.allowContexts.push(name)
  }
  return next
}

/** 上下文是否实际启用:显式启用 > 显式禁用 > 新增锁定默认。 */
export function contextEnabled(cfg: Config, name: string): boolean {
  if (cfg.allowContexts.includes(name)) return true
  if (cfg.denyContexts.includes(name)) return false
  return cfg.newDefault.context !== 'disabled'
}
