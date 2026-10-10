/**
 * preset-filter —— clean-agent 纯净预设的屏蔽过滤器（随插件一起发布）。
 *
 * 这是 `clean-tool-filter.mjs` 的插件内版本：逻辑逐行一致，只去掉本地验证插桩，
 * 并由本插件在注册 clean-agent 预设时以包内子路径（
 * `@dsh-external/dsh-tool-manager/preset-filter`）引用 —— 用**包名**而非预设目录下
 * 的相对 `./xxx.mjs`，因为 DSH 0.2 的 package-inventory 会把 preset 的 composition
 * modules 逐个解析包身份，相对路径模块会向上找到 profile 的 package.json 并在缺
 * `version` 时抛错（表现为整个会话 REQUEST_EXTENSION）。
 *
 * 两条拦截路径：
 *   1) tools.restrict —— 在预设 standing scope 内剔除 INHERITED 的宿主全局工具；
 *   2) system-prompt/assemble —— 剔除第三方 `tool:*` section（2b）与按名字禁用
 *      动态上下文（2c）。
 *
 * 配置（config）：
 *   scopeId       本预设的 agentPreset id，默认 'clean-agent'
 *   denyPrefixes  预设级默认屏蔽前缀（不传则用 DEFAULT_DENY_PREFIXES）
 *   filterSections 是否启用 section/上下文过滤，默认 true
 *
 * GUI 配置（dsh-tool-manager 设置页写入 <DSH_HOME>/tool-manager.json）：
 *   denyPrefixes / denyNames / allowPrefixes / allowNames
 *   denyContexts / allowContexts / newDefault{context,third,mcp}
 */

import { readFileSync, watch } from 'node:fs'
import { dirname, basename } from 'node:path'

export const name = 'clean-tool-filter'
export const inject = ['tools']

/**
 * 预设级默认屏蔽的第三方插件工具前缀（宿主层全局注册）。
 *   dev_*            dsh-super-injector（热重载/注入器）
 *   memory/dtodo/…   dsh-memory-evolve-mod
 *   skill_manage     dsh-memory-evolve-mod
 *   undo_*           dsh-undo-plugin
 *   redteam_*        dsh-redteam-mode
 *   ssh_*            @linxin666/dsh-ssh
 *   context_audit    dsh-context-doctor
 *   describe_image   @linxin666/dsh-tool-describe-image
 *   de_*             dsh-memory-evolve-mod（渠道/会话工具）
 *   file_mount_forget dsh-file-mount
 *   mcp_connector_*  dsh-mcp-connector
 *   asar_*           dsh-asar-patcher
 */
export const DEFAULT_DENY_PREFIXES = [
  'dev_',
  'memory',
  'dtodo',
  'skill_manage',
  'undo_',
  'redteam_',
  'ssh_',
  'context_audit',
  'describe_image',
  'de_',
  'file_mount_forget',
  'mcp_connector_',
  'asar_',
]

/** 第三方插件工具完整前缀（与 host classify 的兜底集合一致；含预设名单外的 anysearch_ 等）。 */
export const THIRD_PREFIXES = [
  'dev_mode_',
  'dev_',
  'anysearch_',
  'memory',
  'dtodo',
  'skill_manage',
  'de_',
  'undo_',
  'context_audit',
  'ssh_',
  'redteam_',
  'describe_image',
  'file_mount_forget',
  'mcp_connector_',
  'asar_',
]

interface FilterConfig {
  scopeId: string
  denyPrefixes: string[]
  filterSections: boolean
}

interface GuiConfig {
  denyPrefixes: string[]
  denyNames: string[]
  allowPrefixes: string[]
  allowNames: string[]
  denyContexts: string[]
  allowContexts: string[]
  newDefault: { context: string; third: string; mcp: string }
}

interface FilterContext {
  tools?: {
    view(scope?: unknown): { restrictableNames: Set<string> | ArrayLike<string> }
    restrict(filter: { allow?: string[]; deny?: string[] }): () => void
  }
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): unknown
  effect(callback: () => unknown, label?: string): unknown
}

function normalizeConfig(raw: unknown): FilterConfig {
  const source = (raw === undefined ? {} : raw) as Record<string, unknown>
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError('clean-tool-filter: config must be an object')
  }
  const scopeId = source.scopeId === undefined ? 'clean-agent' : source.scopeId
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw new TypeError('clean-tool-filter: config.scopeId must be a non-empty string')
  }
  const denyPrefixes = source.denyPrefixes === undefined ? DEFAULT_DENY_PREFIXES : source.denyPrefixes
  if (!Array.isArray(denyPrefixes) || denyPrefixes.some((p) => typeof p !== 'string' || p.length === 0)) {
    throw new TypeError('clean-tool-filter: config.denyPrefixes must be an array of non-empty strings')
  }
  const filterSections = source.filterSections === undefined ? true : source.filterSections
  if (typeof filterSections !== 'boolean') {
    throw new TypeError('clean-tool-filter: config.filterSections must be a boolean')
  }
  return { scopeId, denyPrefixes: denyPrefixes as string[], filterSections }
}

/** GUI 配置文件（与 dsh-tool-manager host 侧共用）。 */
function configPath(): string {
  const env = process?.env ?? {}
  // DSH_HOME 已经是 .dsh 目录本身;USERPROFILE/HOME 才是用户主目录,需要拼 .dsh。
  const base = env.DSH_HOME || `${env.USERPROFILE || env.HOME || '.'}/.dsh`
  return `${base}/tool-manager.json`
}

function readGuiConfig(): GuiConfig {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'))
    return {
      denyPrefixes: Array.isArray(cfg?.denyPrefixes) ? cfg.denyPrefixes : [],
      denyNames: Array.isArray(cfg?.denyNames) ? cfg.denyNames : [],
      allowPrefixes: Array.isArray(cfg?.allowPrefixes) ? cfg.allowPrefixes : [],
      allowNames: Array.isArray(cfg?.allowNames) ? cfg.allowNames : [],
      denyContexts: Array.isArray(cfg?.denyContexts) ? cfg.denyContexts : [],
      allowContexts: Array.isArray(cfg?.allowContexts) ? cfg.allowContexts : [],
      newDefault: {
        context: cfg?.newDefault?.context === 'disabled' ? 'disabled' : 'enabled',
        third: cfg?.newDefault?.third === 'disabled' ? 'disabled' : 'enabled',
        mcp: cfg?.newDefault?.mcp === 'disabled' ? 'disabled' : 'enabled',
      },
    }
  } catch {
    // 配置缺失/损坏时回退默认,绝不阻断装配。
    return {
      denyPrefixes: [], denyNames: [], allowPrefixes: [], allowNames: [],
      denyContexts: [], allowContexts: [],
      newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' },
    }
  }
}

export function apply(ctx: FilterContext, rawConfig?: unknown): void {
  const config = normalizeConfig(rawConfig)
  const { scopeId, denyPrefixes: presetDenyPrefixes, filterSections } = config
  let gui = readGuiConfig()

  // 屏障 2a:全局工具层视图,动态筛选要剔除的工具名。
  // 判定优先级(高→低,与 dsh-tool-manager 的 isEffectivelyDenied 一致):
  //   allowNames > allowPrefixes(用户) > denyNames > denyPrefixes(用户)
  //   > presetDenyPrefixes(默认第三方) > mcp 兜底 > 第三方兜底。
  const shouldDeny = (toolName: string): boolean => {
    if (gui.allowNames.includes(toolName)) return false
    if (gui.allowPrefixes.some((p) => toolName.startsWith(p))) return false
    if (gui.denyNames.includes(toolName)) return true
    if (gui.denyPrefixes.some((p) => toolName.startsWith(p))) return true
    if (presetDenyPrefixes.some((p) => toolName.startsWith(p))) return true
    if (toolName.startsWith('mcp__')) return gui.newDefault.mcp === 'disabled'
    if (THIRD_PREFIXES.some((p) => toolName.startsWith(p))) return gui.newDefault.third === 'disabled'
    return false
  }

  // 工具是动态注册的(宿主插件开关/晚注册),deny 名单必须随 tools/change 重建,
  // 否则晚于本过滤器装配的工具(如记忆插件的 memory/dtodo/…)不在静态快照里。
  ctx.effect(() => {
    let disposeRestrict: (() => void) | null = null
    let lastDenyKey: string | null = null
    const rebuild = (): void => {
      try {
        // 每次重建都重新读 GUI 配置,让「工具管理」页的改动即时生效。
        gui = readGuiConfig()
        const globalView = ctx.tools!.view(undefined)
        const deny = [...globalView.restrictableNames].filter((n) => shouldDeny(n)).sort()
        const key = deny.join('\u0001') + '\u0002' + JSON.stringify(gui)
        // restrict() 本身会触发 tools/change,用 key 幂等跳过,避免死循环。
        if (key === lastDenyKey) return
        lastDenyKey = key
        if (disposeRestrict) { disposeRestrict(); disposeRestrict = null }
        if (deny.length > 0) {
          disposeRestrict = ctx.tools!.restrict({ deny })
        }
      } catch (error) {
        // restrict 失败不阻断装配。
        console.error('[clean-tool-filter] restrict failed:', (error as Error)?.message ?? error)
      }
    }
    rebuild()
    const offChange = ctx.on('tools/change', () => rebuild())
    // 监听 GUI 配置文件变化:保存配置 → 立即重建 restrict,新会话即时生效。
    let watcher: { close(): void } | null = null
    try {
      watcher = watch(dirname(configPath()), (_event, filename) => {
        if (filename === basename(configPath())) rebuild()
      })
    } catch {
      // watch 不可用/目录不存在时静默降级(仍靠 tools/change 兜底)。
    }
    return () => {
      ;(offChange as () => void)?.()
      if (watcher) watcher.close()
      if (disposeRestrict) disposeRestrict()
    }
  }, 'clean-tool-filter.restrict')

  // 屏障 2b/2c:拦截 system-prompt/assemble。
  // 真实装配事件的 context.scope 是 Agent 对象,preset id 在 session.header.agentPreset。
  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
    const agent = context && context.scope
    const header = agent && agent.session ? agent.session.header : undefined
    const presetId = header && typeof header.agentPreset === 'string' ? header.agentPreset : undefined
    if (presetId !== scopeId) {
      return next()
    }
    const assembled = await next()
    if (!filterSections) return assembled
    try {
      if (!assembled || typeof assembled !== 'object') return assembled
      let result = assembled
      // 2b:剔除第三方插件的 tool:* section(插件名含连字符),官方纯功能词 section 保留。
      if (Array.isArray(assembled.sections)) {
        const keptSections = assembled.sections.filter((section: any) => {
          const sectionName = typeof section?.name === 'string' ? section.name : ''
          if (!sectionName.startsWith('tool:')) return true
          return sectionName.indexOf('-', 'tool:'.length) === -1
        })
        if (keptSections.length !== assembled.sections.length) {
          result = { ...result, sections: keptSections }
        }
      }
      // 2c:过滤动态上下文。判定优先级:
      //   allowContexts(用户显式启用) > denyContexts(用户显式禁用)
      //   > 新增锁定(默认 enabled=注入;disabled=不在名单的上下文默认剔除)。
      if (Array.isArray(assembled.contexts)) {
        const ndContext = gui.newDefault.context
        const keptContexts = assembled.contexts.filter((c: any) => {
          const contextName = c && c.name
          if (typeof contextName !== 'string') return true
          if (gui.allowContexts.includes(contextName)) return true
          if (gui.denyContexts.includes(contextName)) return false
          if (ndContext === 'disabled') return false
          return true
        })
        if (keptContexts.length !== assembled.contexts.length) {
          result = { ...result, contexts: keptContexts }
        }
      }
      return result
    } catch {
      // 过滤失败时保持原样,绝不破坏装配。
      return assembled
    }
  }, { prepend: true })
}
