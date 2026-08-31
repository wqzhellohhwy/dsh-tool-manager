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
 *   - mcp     : 以 mcp__ 开头(宿主 dsh-mcp-manager 注册的 MCP 工具)
 *   - native  : clean-agent 预设装配的原生工具(经 standing scope 注册)
 *   - third   : 宿主层第三方插件注册的全局工具(默认会被 clean-agent 屏蔽)
 *   - unknown : 其他
 *
 * 说明:枚举的是工具的 GLOBAL 注册面(view(undefined).knownNames),与任何
 * 具体会话无关,因此设置页能看到「如果启用,这个工具会出现在纯净预设里」
 * 的完整候选;默认屏蔽名单见 clean-tool-filter.mjs 的 DEFAULT_DENY_PREFIXES。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from 'cordis'

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
}

export const name = '@dsh-external/dsh-tool-manager'
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
  configs: SavedConfig[]
}

const EMPTY: Config = {
  denyPrefixes: [], denyNames: [], allowPrefixes: [], allowNames: [],
  denyContexts: [], allowContexts: [],
  newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' },
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

// 分类工具来源
function classify(name: string): string {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.startsWith('dev_') || name.startsWith('memory') || name.startsWith('dtodo')
    || name.startsWith('skill_manage') || name.startsWith('undo_') || name.startsWith('redteam_')
    || name.startsWith('ssh_') || name.startsWith('context_audit') || name.startsWith('describe_image')
    || name.startsWith('de_') || name.startsWith('anysearch_') || name.startsWith('file_mount_forget')) return 'third'
  return 'native'
}

// 第三方工具 → 归属大插件(显示组名)。顺序即优先级(长前缀在前)。
const THIRD_PLUGIN_MAP: Array<[string, string]> = [
  ['dev_mode_', 'dsh-mode-boost'],
  ['dev_', 'dsh-super-injector'],
  ['anysearch_', 'anysearch-dsh'],
  ['memory', 'dsh-memory-evolve'],
  ['dtodo', 'dsh-memory-evolve'],
  ['skill_manage', 'dsh-memory-evolve'],
  ['de_', 'dsh-memory-evolve'],
  ['undo_', 'dsh-undo-plugin'],
  ['context_audit', 'dsh-context-doctor'],
  ['ssh_', 'ssh'],
  ['redteam_', 'redteam'],
  ['describe_image', 'describe-image'],
  ['file_mount_forget', 'dsh-file-mount'],
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

export function apply(ctx: AppContext): void {
  const logger = ctx.get?.('logger') as { info?: (msg: string) => void } | undefined
  const webServer = ctx.get?.('webServer')
  if (!webServer) {
    logger?.info?.('[tool-manager] webServer 服务不可用,跳过 API 注册')
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/tool-manager/api',
    handler: async (req: any, res: any) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/^\/tool-manager\/api/, '') || '/'
        const method = String(req.method ?? 'GET').toUpperCase()

        if (method === 'GET' && path === '/tools') {
          const contexts = await listContexts(ctx)
          return json(res, 200, { ok: true, tools: listTools(ctx), config: readConfig(), contexts })
        }
        if (method === 'GET' && path === '/config') {
          return json(res, 200, { ok: true, config: readConfig() })
        }
        if (method === 'POST' && path === '/config') {
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
            configs: Array.isArray(body?.configs) ? body.configs : [],
          }
          const ok = writeConfig(next)
          return json(res, ok ? 200 : 500, { ok, config: ok ? next : readConfig() })
        }
        return json(res, 404, { ok: false, error: 'not found: ' + path })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) })
      }
    },
  }), 'tool-manager: api')

  logger?.info?.('[tool-manager] API: /tool-manager/api (tools|config)')
}