/**
 * preset.ts —— 内置的 `clean-agent` 纯净预设定义（随 dsh-tool-manager 一起安装）。
 *
 * 为什么放在插件里：预设的屏蔽策略（过滤器 + 工具/上下文名单）与 GUI 是同一套
 * 配置真值（`tool-manager.json`），二者必须同版本发布；把预设定义随插件走，
 * 就无需任何外部仓库或 profile 手写行 —— 插件装配时自动注册。
 *
 * `plugins` 列表刻意只引用 DSH 官方包 + 本插件的包内子路径，保持可移植：
 *   - 官方工具行（pwsh/fs/skill/goal/web/…）都是 `@deepseek-ai/dsh-*` 包名；
 *   - 过滤器引用 `@dsh-external/dsh-tool-manager/preset-filter`（包名而非预设目录下的
 *     相对 ./xxx.mjs，避免 DSH 0.2 package-inventory 解析相对模块时因 profile
 *     package.json 缺 version 而抛 REQUEST_EXTENSION）。
 */

/** 预设 id。GUI「预设工具管理」与过滤器的 scopeId 都以此为准。 */
export const CLEAN_AGENT_PRESET_ID = 'clean-agent'

/** 过滤器模块的引用 id（= 本包 exports 的 "./preset-filter" 子路径）。 */
export const PRESET_FILTER_MODULE = '@dsh-external/dsh-tool-manager/preset-filter'

export interface PresetEntry {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
  group?: boolean
  isolate?: Record<string, boolean>
}

export interface PresetDefinition {
  id: string
  name: string
  description: string
  order: number
  plugins: PresetEntry[]
}

export interface CleanAgentPresetOptions {
  /** 过滤器模块引用；默认 {@link PRESET_FILTER_MODULE}。 */
  filterModule?: string
  /** 过滤器自身的 config（scopeId/denyPrefixes/filterSections）。 */
  filterConfig?: Record<string, unknown>
  /** persona 前缀模板。 */
  personaPrefix?: string
  /** 预设内的排序值。 */
  order?: number
}

const DEFAULT_PERSONA_PREFIX = [
  'You are a coding agent powered by the {{model}} model. Your',
  'working directory is {{cwd}}.',
].join('\n')

/**
 * 构造 `clean-agent` 预设定义。
 *
 * 上下文说明：persona 必须 `includeRuntimeContext: true` —— 设 false 会调用
 * `systemPrompt.suppressRuntimeContext()`，把本作用域的动态上下文**整体抹除**，
 * 使「预设工具管理 → 上下文注入」的 allowContexts/denyContexts 永远无效。
 * 上下文屏障统一由 preset-filter 的 2c 分支承担（默认全屏蔽、可按名启用）。
 */
export function buildCleanAgentPreset(options: CleanAgentPresetOptions = {}): PresetDefinition {
  const {
    filterModule = PRESET_FILTER_MODULE,
    filterConfig = {},
    personaPrefix = DEFAULT_PERSONA_PREFIX,
    order = 50,
  } = options

  return {
    id: CLEAN_AGENT_PRESET_ID,
    name: 'Clean Agent',
    description: '纯净智能体：只保留系统提示词 + 技能 + MCP + DSH 原生工具'
      + '（pwsh/文件/任务/目标等）；宿主第三方插件（记忆系统、热重载系统、撤销、'
      + '红队、SSH 等）的运行时上下文注入与工具面默认全部屏蔽，可在'
      + '「设置 → 预设工具管理」里按工具/上下文逐个或分组建启用。',
    order,
    plugins: [
      // ── identity ────────────────────────────────────────────────────────────
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: personaPrefix, includeRuntimeContext: true },
      },
      {
        id: 'agent-instructions',
        name: '@deepseek-ai/dsh-agent-instructions',
        config: { maxBytes: 65536 },
      },

      // ── shell ───────────────────────────────────────────────────────────────
      {
        id: 'tool-pwsh',
        name: '@deepseek-ai/dsh-tool-pwsh',
        disabled: process.platform !== 'win32',
      },

      // ── filesystem ──────────────────────────────────────────────────────────
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      },
      { id: 'tool-str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor' },

      // ── background jobs ─────────────────────────────────────────────────────
      { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },

      // ── skills ──────────────────────────────────────────────────────────────
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

      // ── goals ───────────────────────────────────────────────────────────────
      { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },

      // ── compaction ──────────────────────────────────────────────────────────
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          {
            id: 'tool-result-pruner',
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
          },
        ],
      },

      // ── model-facing tools ──────────────────────────────────────────────────
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      {
        id: 'tool-todo',
        name: '@deepseek-ai/dsh-tool-todo',
        config: { allowParallelInProgress: true },
      },
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } },

      // ── 第三方插件过滤（工具面 2a + section/上下文 2b/2c）──────────────────
      {
        id: 'clean-tool-filter',
        name: filterModule,
        config: { ...filterConfig, scopeId: CLEAN_AGENT_PRESET_ID },
      },
    ],
  }
}
