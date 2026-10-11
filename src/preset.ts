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
 * plan 模式（`@deepseek-ai/dsh-plan-mode`）的 `section` 是**必填**的 config ——
 * 不给就会让整个 preset 装配失败（registry 记 broken: "PlanModeConfig needs a
 * non-empty `section`"，整个 clean-agent 直接不可用）。
 * 下面是官方 standard preset 的原文，逐字照抄（含"工具目录跨模式保持不变以复用
 * 请求缓存"这条关键约定）。
 */
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

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
      // 两个都装配、由平台决定哪个生效，与官方 standard 一致（否则会在非 Windows
      // 平台上完全没有 shell 工具）。
      {
        id: 'tool-bash',
        name: '@deepseek-ai/dsh-tool-bash',
        disabled: process.platform === 'win32',
      },
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
      // 【2026-10-12 修复】`/goal` 是**命令 producer**，按 preset 逐个挂载（官方
      // dsh-command-goal 的 README：Web bundle 把 goal 服务与 driver 留在 Host，
      // 禁用基础命令 producer，改在 standard/code/cordis 里挂；minimal 省略它）。
      // 之前只挂了 tool-goal（模型工具），所以 create_goal/get_goal/update_goal 能用、
      // 但 `/` 面板里没有 /goal。
      { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },

      // ── plan mode ───────────────────────────────────────────────────────────
      // 计划模式：exit_plan_mode 工具 + /plan 相关命令。
      // ⚠️ `section` 是**必填** config：不给会让整个 preset 装配失败（实测 registry
      //    记 broken: "PlanModeConfig needs a non-empty section"，clean-agent 整个
      //    不可用）。文本用官方 standard 的原文（PLAN_MODE_SECTION）。
      {
        id: 'planning',
        name: 'cordis:group',
        group: true,
        isolate: { planMode: true },
        config: [
          { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: { section: PLAN_MODE_SECTION } },
        ],
      },

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

      // ── delegation（子 agent / workflow）────────────────────────────────────
      // 官方 standard 的这一组同样整组装配：subagent / subagent_fork / workflow。
      // codex 与 claude-code 两个 provider 官方默认 disabled，照抄。
      {
        id: 'delegation',
        name: 'cordis:group',
        group: true,
        isolate: { workflowEngine: true },
        config: [
          { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
          { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
          {
            id: 'tool-subagent',
            name: '@deepseek-ai/dsh-tool-subagent',
            config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' },
          },
          {
            id: 'tool-subagent-fork',
            name: '@deepseek-ai/dsh-tool-subagent',
            config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' },
          },
          {
            id: 'tool-subagent-codex',
            name: '@deepseek-ai/dsh-tool-subagent',
            disabled: true,
            config: { provider: 'codex', toolName: 'subagent_codex', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
          },
          {
            id: 'tool-subagent-claude-code',
            name: '@deepseek-ai/dsh-tool-subagent',
            disabled: true,
            config: { provider: 'claude-code', toolName: 'subagent_claude_code', backgroundMode: 'one-shot', maxDepth: 'provider-managed' },
          },
          { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
          { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
          {
            id: 'tool-ralph',
            name: '@deepseek-ai/dsh-tool-ralph',
            disabled: true,
            config: { subagentProvider: 'spawn', maxRounds: 64 },
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
      // 交付物卡片（present 工具）：官方 standard 有，之前漏了。
      { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      // 插件管理工具：官方在 standard 里也是 disabled，照抄保持默认关闭。
      { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },

      // ── 第三方插件过滤（工具面 2a + section/上下文 2b/2c）──────────────────
      {
        id: 'clean-tool-filter',
        name: filterModule,
        config: { ...filterConfig, scopeId: CLEAN_AGENT_PRESET_ID },
      },
    ],
  }
}
