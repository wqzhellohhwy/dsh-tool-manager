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
  /**
   * 每层的**持续模式**（三选一，互斥）：
   *   'on'  启用模式 —— 该层全部启用，压制一切个别设置；
   *   'off' 禁用模式 —— 该层全部禁用，压制一切个别设置；
   *   'new' 新增模式 —— 按 baseline/newDefault 走常规判定（默认值）。
   * 旧配置没有这个字段时一律按 'new' 处理 ⇒ 行为与改造前一致。
   */
  mode: LayerMode
  /**
   * 已定型项名单（工具名 + 上下文名）。
   *
   * 「新增启用/禁用」的判定基线：**不在 baseline 里的项 = 新出现的项**，由
   * `newDefault[cat]` 决定；已在 baseline 里的项不再受该开关影响（它们的状态
   * 在点「新增X用」的那一刻就被固化进 allow/deny 名单了）。
   *
   * 空数组（旧配置 / 从未点过「新增」）= 所有项都视为新项 —— 这与改造前的
   * 行为完全一致，因此升级不会引起状态突变。
   */
  baseline: string[]
  configs: SavedConfig[]
}

/** 工具来源分类（与 host classify 一致）。 */
export type ToolCategory = 'native' | 'mcp' | 'third' | 'unknown'

/** 每层的持续模式：启用 / 禁用 / 新增（三选一，互斥）。 */
export type LayerMode = 'on' | 'off' | 'new'

/** 每层的模式表。 */
export type LayerModes = Record<LockCat, LayerMode>

/** 读某层模式的防御性取值（旧配置没有这个字段）。 */
export function modeOf(cfg: Config, cat: LockCat): LayerMode {
  const raw = cfg.mode?.[cat]
  return raw === 'on' || raw === 'off' ? raw : 'new'
}

export const EMPTY_CONFIG: Config = {
  denyPrefixes: [], denyNames: [], allowPrefixes: [], allowNames: [],
  denyContexts: [], allowContexts: [],
  newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' },
  mode: { context: 'new', third: 'new', mcp: 'new' },
  baseline: [],
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

/** 读 baseline 的防御性取值（旧配置文件里没有这个字段）。 */
function baselineOf(cfg: Config): string[] {
  return Array.isArray(cfg.baseline) ? cfg.baseline : []
}

/** 工具当前是否被纯净预设屏蔽(GUI 的显示口径)。 */
export function isEffectivelyDenied(cfg: Config, name: string, category?: ToolCategory): boolean {
  // ① native（host 白名单核实的官方宿主工具）不参与**兜底**屏蔽，但仍可被显式
  //    名单禁用、也会被层模式压制 —— 所以这里只算分类，不做提前返回。
  const lockCat = lockCategoryOf(name, category)

  // ② 持续模式排在最前：这是"模式"，要压制一切个别设置。
  if (lockCat !== null) {
    const mode = modeOf(cfg, lockCat)
    if (mode === 'on') return false
    if (mode === 'off') return true
  }

  // ③ 新增模式：显式名单优先（native 也认这两层）。
  if (cfg.allowNames.includes(name)) return false
  if (cfg.allowPrefixes.some((p) => name.startsWith(p))) return false
  if (cfg.denyNames.includes(name)) return true
  if (cfg.denyPrefixes.some((p) => name.startsWith(p))) return true

  // ④ native / 无法分类：不参与兜底屏蔽。
  if (lockCat === null) return false

  // ⑤ 已定型（进过 baseline）且未列名 ⇒ 启用。这就是「新增锁定」的本意：
  //    老项的状态在点「新增X用」时已固化进名单，不再受 newDefault 影响。
  if (baselineOf(cfg).includes(name)) return false

  // ⑥ 未定型 = 新出现的项 ⇒ 由「新增启用/禁用」决定。
  return cfg.newDefault[lockCat] === 'disabled'
}

/** 名字 → 归属的锁定层。native / 未知返回 null（不参与屏蔽）。 */
function lockCategoryOf(name: string, category?: ToolCategory): LockCat | null {
  if (category === 'native' || category === 'unknown') return null
  if (category === 'mcp') return 'mcp'
  if (category === 'third') return 'third'
  // 没有 category 信息时按名字推断（预设过滤器侧就是这条路径）。
  if (name.startsWith('mcp__')) return 'mcp'
  if (DEFAULT_THIRD_PREFIXES.some((p) => name.startsWith(p))) return 'third'
  if (THIRD_PREFIXES.some((p) => name.startsWith(p))) return 'third'
  return null
}

/**
 * 该类工具「启用」时必须补写 allowNames 才能生效。
 *
 * 判定与 isEffectivelyDenied 的兜底分支严格对齐：
 *   - 命中用户自定义 denyPrefixes        : 前缀判禁，必须靠 allowNames 豁免；
 *   - 未定型的新项 + newDefault[cat]=禁用 : 走第 ④ 步兜底判禁，必须靠 allowNames 豁免；
 *   - 已定型项 / native                  : 未列名即启用，不需要补。
 */
export function needsAllowExemption(cfg: Config, name: string, category?: ToolCategory): boolean {
  if (cfg.denyPrefixes.some((p) => name.startsWith(p))) return true
  const lockCat = lockCategoryOf(name, category)
  if (lockCat === null) return false
  // 层模式不是"新增"时，个别开关都被模式压制：启用模式本来就可见，
  // 禁用模式下写 allowNames 也不会生效 —— 两种情况都不需要补。
  if (modeOf(cfg, lockCat) !== 'new') return false
  if (baselineOf(cfg).includes(name)) return false
  return cfg.newDefault[lockCat] === 'disabled'
}

/** 把单个工具设为启用/禁用,返回新 Config(双向清理 allow/deny 名单,避免残留复活)。 */
export function applyDeny(cfg0: Config, name: string, denied: boolean, category?: ToolCategory): Config {
  const next: Config = { ...cfg0, denyNames: [...cfg0.denyNames], allowNames: [...cfg0.allowNames] }
  if (denied) {
    if (!next.denyNames.includes(name)) next.denyNames.push(name)
    next.allowNames = next.allowNames.filter((n) => n !== name)
  } else {
    next.denyNames = next.denyNames.filter((n) => n !== name)
    if (needsAllowExemption(cfg0, name, category) && !next.allowNames.includes(name)) {
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

/** 上下文是否实际启用:启用模式/禁用模式 > 显式名单 > 已定型 > 新增锁定默认。 */
export function contextEnabled(cfg: Config, name: string): boolean {
  const mode = modeOf(cfg, 'context')
  if (mode === 'on') return true
  if (mode === 'off') return false
  if (cfg.allowContexts.includes(name)) return true
  if (cfg.denyContexts.includes(name)) return false
  if (baselineOf(cfg).includes(name)) return true
  return cfg.newDefault.context !== 'disabled'
}

/**
 * 名字列表的搜索过滤（工具与上下文共用同一口径：大小写不敏感的子串匹配）。
 * 抽成纯函数是因为上下文列表此前**完全没接搜索框**，需要在测试里钉住。
 */
export function filterNames(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return names
  return names.filter((n) => n.toLowerCase().includes(q))
}

// ── 命名配置（保存 / 覆盖保存）────────────────────────────────────────────────

/**
 * 抽出当前的六个名单快照。
 * 命名配置**只**存这六个名单 —— `mode`（模式）/ `newDefault`（新增策略）/ `baseline`
 * （定型状态）属于"策略"，切换配置时保持不变。
 */
export function snapshotOf(cfg: Config): SavedConfig['state'] {
  return {
    denyPrefixes: [...cfg.denyPrefixes],
    denyNames: [...cfg.denyNames],
    allowPrefixes: [...cfg.allowPrefixes],
    allowNames: [...cfg.allowNames],
    denyContexts: [...cfg.denyContexts],
    allowContexts: [...cfg.allowContexts],
  }
}

/** 新建一个命名配置（追加到 configs 末尾）。 */
export function addSavedConfig(cfg: Config, id: string, name: string, savedAt: string): Config {
  const saved: SavedConfig = { id, name, savedAt, state: snapshotOf(cfg) }
  return { ...cfg, configs: [...cfg.configs, saved] }
}

/**
 * 把当前状态**覆盖**写入指定的命名配置：只更新目标项的 state 与 savedAt，
 * 不新建、不改名、不动其它配置。id 不存在时原样返回。
 */
export function overwriteSavedConfig(cfg: Config, id: string, savedAt: string): Config {
  if (!cfg.configs.some((c) => c.id === id)) return cfg
  return {
    ...cfg,
    configs: cfg.configs.map((c) => (c.id === id ? { ...c, savedAt, state: snapshotOf(cfg) } : c)),
  }
}

// ── 层模式（启用 / 禁用 / 新增，三选一互斥）与「新增启用/禁用」────────────────

/**
 * 切换某一层的**持续模式**。
 *
 *   'on'  启用模式：该层全部启用，压制一切个别设置；
 *   'off' 禁用模式：该层全部禁用，压制一切个别设置；
 *   'new' 新增模式：按 baseline/newDefault 走常规判定。
 *
 * 三者互斥 —— 模式只有一个字段，设置任何一个都会让另外两个退出。
 * 这是持续开关（不像旧版"完全启用/禁用"那样清空名单），因此**模式生效期间**
 * 单个工具的开关不会起作用；退出模式（回到 'new'）后原有名单原封不动。
 */
export function setLayerMode(cfg: Config, cat: LockCat, mode: LayerMode): Config {
  return { ...cfg, mode: { ...(cfg.mode ?? EMPTY_CONFIG.mode), [cat]: mode } }
}

/**
 * 「新增启用/禁用」：只决定**今后新出现**的工具/上下文的默认状态，现有项保持现状。
 *
 * 两步：
 *   ① **固化**：按**改动前**的配置判定每个现有项的实际状态，把其中"禁用"的写进
 *      deny 名单 —— 否则它们被并入 baseline 后会翻成"未列名 ⇒ 启用"，状态突变；
 *   ② **定型**：把现有项全部并入 baseline，使它们从此不再受 newDefault 影响。
 * 之后 newDefault 只对 baseline 之外的新项生效。
 *
 * @param allNames 该层的全部项。
 * @param isDenied 用**改动前**的 cfg 判定某个名字当前是否被屏蔽。
 */
export function applyNewDefault(
  cfg: Config,
  cat: LockCat,
  state: LockState,
  allNames: string[],
  isDenied: (name: string) => boolean,
): Config {
  const frozen = allNames.filter((n) => isDenied(n))
  const baseline = [...new Set([...baselineOf(cfg), ...allNames])]
  // 点「新增X用」同时把该层切回**新增模式**（三种模式互斥，启用/禁用模式就此退出）。
  const next: Config = {
    ...cfg,
    baseline,
    newDefault: { ...cfg.newDefault, [cat]: state },
    mode: { ...(cfg.mode ?? EMPTY_CONFIG.mode), [cat]: 'new' },
  }
  if (cat === 'context') {
    next.denyContexts = [...new Set([...cfg.denyContexts, ...frozen])]
    next.allowContexts = cfg.allowContexts.filter((n) => !frozen.includes(n))
  } else {
    next.denyNames = [...new Set([...cfg.denyNames, ...frozen])]
    next.allowNames = cfg.allowNames.filter((n) => !frozen.includes(n))
  }
  return next
}
