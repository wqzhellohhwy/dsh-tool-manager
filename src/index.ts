/**
 * @dsh-external/dsh-tool-manager — 纯净预设工具管理（host 端）。
 *
 * 功能:在 DSH Web GUI 的设置页提供一个「工具管理」页面,让用户针对
 * clean-agent 纯净预设单独屏蔽/启用某些工具。配置持久化到
 * `$DSH_HOME/.dsh/tool-manager.json`,clean-agent 预设的
 * clean-tool-filter.mjs 读取同一文件、按名称/前缀动态决定 deny 名单。
 *
 * HTTP API(同源,挂在本机 dsh webserver 上):
 *   GET  /tool-manager/api/tools   枚举当前寄存器中的全部工具(含来源分类)
 *   GET  /tool-manager/api/config  读当前配置
 *   POST /tool-manager/api/config  保存配置(denyPrefixes/denyNames/allowPrefixes/allowNames)
 *
 * 工具来源分类(category):
 *   - mcp     : 以 mcp__ 开头(宿主 MCP 连接器注册的 MCP 工具)
 *   - native  : 白名单内的 DSH 官方宿主工具(见 NATIVE_HOST_TOOLS;三个 MCP 共享
 *               资源工具 + load_workspace_dependencies)
 *   - third   : 其余一切宿主层全局工具(= 第三方插件注册的,纯净预设默认屏蔽)
 *   - unknown : 预留,当前不会产生
 *
 * 说明:枚举的是工具的 GLOBAL 注册面(view(undefined).knownNames),与任何
 * 具体会话无关,因此设置页能看到「如果启用,这个工具会出现在纯净预设里」
 * 的完整候选;默认屏蔽名单见 clean-tool-filter.mjs 的 DEFAULT_DENY_PREFIXES。
 * 注意 DSH 的原生工具(read/write/pwsh/glob 等)由 agent preset 在会话作用域
 * 注册,不进全局寄存器,GUI 无法枚举它们。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from 'cordis'
import { CLEAN_AGENT_PRESET_ID, buildCleanAgentPreset } from './preset'

// 供测试与外部消费：内置预设的 id 与构造函数。
export { CLEAN_AGENT_PRESET_ID, buildCleanAgentPreset } from './preset'

type AppContext = Context & {
  webServer?: {
    register(route: {
      kind: 'prefix'
      path: string
      handler(req: unknown, res: unknown): void | Promise<void>
    }): unknown
  }
  tools?: {
    view(scope?: unknown): {
      knownNames: Set<string> | ArrayLike<string>
      visible: Map<string, unknown>
    }
    get(name: string, scope?: unknown): { description?: string } | undefined
  }
  systemPrompt?: {
    assemble(context?: unknown): Promise<{
      sections?: Array<{ name?: string }>
      contexts?: Array<{ name?: string }>
    }>
  }
  /** cordis 依赖注入：等服务可用后回调（服务未装配时不回调，也不报错）。 */
  inject?: (deps: string[], callback: (child: AppContext) => void) => unknown
  /** DSH 的 agent preset 注册表（@deepseek-ai/dsh-agent-preset-registry）。 */
  agentPresets?: {
    definitions?: Map<string, { config?: { id?: string }; broken?: string }>
    register(definition: unknown): Promise<() => Promise<void> | void>
  }
}

export const name = '@dsh-external/dsh-tool-manager'
// 刻意**不**硬依赖 webServer：内置 clean-agent 预设的注册与 GUI API 无关，
// 若把 'webServer' 写进 inject，插件在无 HTTP 服务的 profile（headless / tui）
// 里会整体 pending —— 预设装不进去、连日志都没有。所有服务消费都走 ctx.get 判空。
export const inject: string[] = []

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function configFile(): string {
  return join(dshHome(), 'tool-manager.json')
}

type LockState = 'enabled' | 'disabled'

interface NewDefault {
  context: LockState
  third: LockState
  mcp: LockState
}

/** 保存的命名配置(不含 newDefault——「新增锁定」状态不随配置保存/切换)。 */
interface SavedConfig {
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

interface Config {
  denyPrefixes: string[]
  denyNames: string[]
  allowPrefixes: string[]
  allowNames: string[]
  denyContexts: string[]
  allowContexts: string[]
  newDefault: NewDefault
  /** 已定型项名单（「新增启用/禁用」的判定基线，详见 client/decide.ts）。 */
  baseline: string[]
  configs: SavedConfig[]
}

const EMPTY: Config = {
  denyPrefixes: [], denyNames: [], allowPrefixes: [], allowNames: [],
  denyContexts: [], allowContexts: [],
  newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' },
  baseline: [],
  configs: [],
}

function lockOf(v: unknown): LockState {
  return v === 'disabled' ? 'disabled' : 'enabled'
}

function readConfig(): Config {
  try {
    const p = configFile()
    if (!existsSync(p)) return { ...EMPTY }
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    return {
      denyPrefixes: Array.isArray(cfg?.denyPrefixes) ? cfg.denyPrefixes : [],
      denyNames: Array.isArray(cfg?.denyNames) ? cfg.denyNames : [],
      allowPrefixes: Array.isArray(cfg?.allowPrefixes) ? cfg.allowPrefixes : [],
      allowNames: Array.isArray(cfg?.allowNames) ? cfg.allowNames : [],
      denyContexts: Array.isArray(cfg?.denyContexts) ? cfg.denyContexts : [],
      allowContexts: Array.isArray(cfg?.allowContexts) ? cfg.allowContexts : [],
      newDefault: {
        context: lockOf(cfg?.newDefault?.context),
        third: lockOf(cfg?.newDefault?.third),
        mcp: lockOf(cfg?.newDefault?.mcp),
      },
      baseline: Array.isArray(cfg?.baseline) ? cfg.baseline : [],
      configs: Array.isArray(cfg?.configs) ? cfg.configs : [],
    }
  } catch {
    return { ...EMPTY }
  }
}

function writeConfig(cfg: Config): boolean {
  try {
    const p = configFile()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

// DSH 官方在「宿主装配层」注册进全局工具寄存器的工具白名单。
//
// 【2026-10-11 修复】旧实现的 classify() 用「硬编码第三方前缀 + 兜底归 native」，
// 于是任何**没被列举**的新第三方插件工具都会被显示成「DSH 原生工具（默认启用）」。
// 实测:宿主层 dsh-asar-patcher 的 6 个 asar_* 工具(asar_info/entries/read/splice/
// restore/backup)一直躺在 native 组里,而纯净预设本该默认屏蔽它们 —— 分类错误的
// 方向恰好是「漏屏蔽」,后果比误屏蔽严重。
//
// 现在改成白名单制:只有下面这些经过源码核实的官方宿主工具算 native,其余一律 third。
// 依据(app.asar 内官方源码与文档):
//   - @deepseek-ai/dsh-mcp-resources 的 registerResourceTools() 向消费方工具作用域
//     注册三个「共享资源工具」:
//       list_mcp_resources / list_mcp_resource_templates / read_mcp_resource
//     (官方文档原文:"The three shared resource tools";它们不是 dsh-mcp-connector
//      插件的工具 —— 该插件注册的是 mcp_connector_* 一族。)
//   - @deepseek-ai/dsh-tool-workspace-dependencies 注册 load_workspace_dependencies。
// 另注:DSH 的原生工具(read/write/pwsh/glob/…)由 agent preset 在**会话作用域**注册,
// 不进入全局寄存器,因此 GUI 本来也看不到它们(这也是本页 native 组长期只有个位数的原因)。
export const NATIVE_HOST_TOOLS = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'load_workspace_dependencies',
])

// 分类工具来源(导出供 tests/classify.test.mjs 回归)
export function classify(name: string): string {
  if (name.startsWith('mcp__')) return 'mcp'
  if (NATIVE_HOST_TOOLS.has(name)) return 'native'
  // 兜底 = third。宁可把未知工具当第三方(纯净预设默认屏蔽,可在 GUI 里按需启用),
  // 也不要把它当官方工具默认放行。
  return 'third'
}

// 第三方工具 → 归属大插件(显示组名)。顺序即优先级(长前缀在前)。
const THIRD_PLUGIN_MAP: Array<[string, string]> = [
  ['dev_mode_', 'dsh-mode-boost'],
  ['dev_', 'dsh-super-injector'],
  ['anysearch_', 'anysearch-dsh'],
  ['memory', 'dsh-memory-evolve-mod'],
  ['dtodo', 'dsh-memory-evolve-mod'],
  ['skill_manage', 'dsh-memory-evolve-mod'],
  ['de_', 'dsh-memory-evolve-mod'],
  ['undo_', 'dsh-undo-plugin'],
  ['context_audit', 'dsh-context-doctor'],
  ['ssh_', 'ssh'],
  ['redteam_', 'redteam'],
  ['describe_image', 'describe-image'],
  ['file_mount_forget', 'dsh-file-mount'],
  ['mcp_connector_', 'dsh-mcp-connector'],
  ['asar_', 'dsh-asar-patcher'],
]

// 计算工具的分组键:mcp 按 server 名、third 按归属插件、其余按 category。
function groupOf(name: string, category: string): string {
  if (category === 'mcp') {
    const rest = name.slice('mcp__'.length)
    const idx = rest.indexOf('__')
    return idx >= 0 ? rest.slice(0, idx) : 'mcp'
  }
  if (category === 'third') {
    for (const [prefix, plugin] of THIRD_PLUGIN_MAP) {
      if (name.startsWith(prefix)) return plugin
    }
    return '其他插件'
  }
  return category
}

function listTools(ctx: AppContext): { name: string; description: string; category: string; group: string }[] {
  const tools = ctx.get?.('tools') as AppContext['tools'] | undefined
  if (!tools) return []
  const names = tools.view(undefined).knownNames ?? []
  return [...names]
    .sort()
    .map((n) => {
      const category = classify(n)
      return {
        name: n,
        description: String(tools.get(n)?.description ?? '').slice(0, 120),
        category,
        group: groupOf(n, category),
      }
    })
}

async function listContexts(ctx: AppContext): Promise<string[]> {
  const sp = ctx.get?.('systemPrompt') as AppContext['systemPrompt'] | undefined
  if (!sp || typeof sp.assemble !== 'function') return []
  try {
    const assembled = await sp.assemble()
    return (assembled?.contexts ?? []).map((c) => c?.name).filter((n): n is string => typeof n === 'string')
  } catch {
    return []
  }
}

async function readBody(req: any): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of (req as AsyncIterable<Buffer>)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: any, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/**
 * 注册内置的 `clean-agent` 纯净预设 —— 预设定义与过滤器随本插件发布，
 * 因此不需要任何外部仓库，也不需要在 profile 的 cordis.patch.yml 里手写 preset 行。
 *
 * 幂等与优先级：profile 里若已声明同名预设（`agentPresets.definitions` 命中），
 * 本函数直接跳过 —— profile 定义优先，避免 `Duplicate agent preset` 抛错，
 * 也保证升级/迁移期间不会出现两个来源打架。
 *
 * 注意 register() 会**立即** mountPreset 挂载 plugins；若某个 composition 模块
 * 解析失败，registry 不抛错而是把错误记在 `definitions.get(id).broken`，
 * 这里读回来打日志，避免"注册成功但预设其实是坏的"这种静默失败。
 */
async function registerCleanAgentPreset(ctx: AppContext, logger?: { info?: (m: string) => void; warn?: (m: string) => void }): Promise<void> {
  const registry = ctx.get?.('agentPresets') as AppContext['agentPresets'] | undefined
  if (!registry || typeof registry.register !== 'function') {
    logger?.info?.('[tool-manager] agentPresets 服务不可用,跳过内置 clean-agent 预设注册')
    return
  }
  const definitions = registry.definitions
  if (definitions && typeof definitions.has === 'function' && definitions.has(CLEAN_AGENT_PRESET_ID)) {
    logger?.info?.(`[tool-manager] 预设 ${CLEAN_AGENT_PRESET_ID} 已由 profile 定义,跳过内置注册`)
    return
  }
  try {
    const dispose = await registry.register(buildCleanAgentPreset())
    // 生命周期随本插件行：插件停用/重载时预设一并撤下，不留孤儿定义。
    ctx.effect?.(() => dispose, 'tool-manager: clean-agent preset')
    const broken = registry.definitions?.get(CLEAN_AGENT_PRESET_ID)?.broken
    if (broken) {
      logger?.warn?.(`[tool-manager] 内置预设 ${CLEAN_AGENT_PRESET_ID} 装配失败: ${broken}`)
    } else {
      logger?.info?.(`[tool-manager] 已注册内置预设 ${CLEAN_AGENT_PRESET_ID}`)
    }
  } catch (error) {
    logger?.warn?.(`[tool-manager] 内置预设注册失败: ${(error as Error)?.message ?? error}`)
  }
}

export function apply(ctx: AppContext): void {
  const logger = ctx.get?.('logger') as { info?: (msg: string) => void; warn?: (msg: string) => void } | undefined

  // 统一的等待服务方式：不把服务写进 `inject`（硬依赖会让插件在没有该服务的
  // profile 里**整体 pending**，连无关功能一起消失），而是在 apply 里用
  // ctx.inject 等它就绪再回调。
  //
  // ⚠️ 2026-10-11 回归修复：只把 `inject` 改成空数组是不够的 —— apply 会在
  // webServer 服务注册**之前**执行，此时 ctx.get('webServer') 是 undefined，
  // 旧写法直接 return，于是 /tool-manager/api 根本没挂上（GUI 侧表现为
  // "无法连接 host API … Unexpected end of JSON input"，实际是 404 空响应）。
  // 正确写法：注册动作本身放进 ctx.inject(['webServer'], …) 的回调里。
  const whenService = (deps: string[], run: (child: AppContext) => void): void => {
    if (typeof ctx.inject === 'function') {
      ctx.inject(deps, (child) => run(child))
    } else {
      run(ctx)
    }
  }

  // ① 内置 clean-agent 预设：与 webServer 无关，等 agentPresets 就绪即注册。
  whenService(['agentPresets'], (child) => { void registerCleanAgentPreset(child, logger) })

  // ② GUI 用的同源 HTTP API：等 webServer 就绪再挂路由。
  whenService(['webServer'], (webCtx) => {
    const webServer = webCtx.get?.('webServer')
    if (!webServer) {
      logger?.info?.('[tool-manager] webServer 服务不可用,跳过 API 注册')
      return
    }
    webCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/tool-manager/api',
      handler: async (req: any, res: any) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const reqPath = url.pathname.replace(/^\/tool-manager\/api/, '') || '/'
          const method = String(req.method ?? 'GET').toUpperCase()

          if (method === 'GET' && reqPath === '/tools') {
            const contexts = await listContexts(ctx)
            return json(res, 200, { ok: true, tools: listTools(ctx), config: readConfig(), contexts })
          }
          if (method === 'GET' && reqPath === '/config') {
            return json(res, 200, { ok: true, config: readConfig() })
          }
          if (method === 'POST' && reqPath === '/config') {
            const body = JSON.parse(await readBody(req))
            const next: Config = {
              denyPrefixes: Array.isArray(body?.denyPrefixes) ? body.denyPrefixes : [],
              denyNames: Array.isArray(body?.denyNames) ? body.denyNames : [],
              allowPrefixes: Array.isArray(body?.allowPrefixes) ? body.allowPrefixes : [],
              allowNames: Array.isArray(body?.allowNames) ? body.allowNames : [],
              denyContexts: Array.isArray(body?.denyContexts) ? body.denyContexts : [],
              allowContexts: Array.isArray(body?.allowContexts) ? body.allowContexts : [],
              newDefault: {
                context: lockOf(body?.newDefault?.context),
                third: lockOf(body?.newDefault?.third),
                mcp: lockOf(body?.newDefault?.mcp),
              },
              baseline: Array.isArray(body?.baseline) ? body.baseline : [],
              configs: Array.isArray(body?.configs) ? body.configs : [],
            }
            const ok = writeConfig(next)
            return json(res, ok ? 200 : 500, { ok, config: ok ? next : readConfig() })
          }
          return json(res, 404, { ok: false, error: 'not found: ' + reqPath })
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) })
        }
      },
    }), 'tool-manager: api')
    logger?.info?.('[tool-manager] API: /tool-manager/api (tools|config)')
  })
}