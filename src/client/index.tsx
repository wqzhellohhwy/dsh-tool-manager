/**
 * @dsh-external/dsh-tool-manager — client 设置页(settings.section)。
 * 在 DSH Web GUI 设置侧栏新增「工具管理」页面:枚举当前寄存器全部工具,
 * 按来源(原生/MCP/第三方)分组(MCP 按 mcp server 名、第三方按归属大插件),
 * 允许对「纯净预设(clean-agent)」单独屏蔽/启用任意工具;配置经同源 API
 * 持久化到 $DSH_HOME/.dsh/tool-manager.json,clean-agent 的 clean-tool-filter.mjs
 * 装配时读取并生效(新会话生效)。
 *
 * 交互模型(2026-08-28 重构):
 *   - 每个工具有两个独立控件:「☑️ 选中」(用于批量操作) + 「启用/禁用」开关(单个生效)。
 *   - 顶部批量工具栏:全选(作用于当前筛选结果)/禁用选中/启用选中;
 *     以及「选中并禁用所有 MCP」「选中并禁用所有第三方」两个一键动作。
 *   - 一键禁用只写纯净预设屏蔽名单(denyNames),不真的关闭 MCP/插件服务。
 *
 * ⚠️ 组件契约:settings.section 的注册组件必须是 React 组件(与 mcp-manager /
 * undo 插件一致);纯 DOM 的 { render() } 形状会导致 active:false、页面空白。
 * 本文件用 JSX(tsx)编译,tsdown 自动转 react/jsx-runtime——不要改成
 * React.createElement 全局名,那在运行时是 undefined。
 */
import { Fragment, useEffect, useMemo, useState, type ReactElement, type ChangeEvent, type KeyboardEvent } from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

const API = '/tool-manager/api'

interface ToolRow {
  name: string
  description: string
  category: 'mcp' | 'native' | 'third' | 'unknown'
  group: string
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

type LockState = 'enabled' | 'disabled'
type LockCat = 'context' | 'third' | 'mcp'

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

const EMPTY_CONFIG: Config = {
  denyPrefixes: [], denyNames: [], allowPrefixes: [], allowNames: [],
  denyContexts: [], allowContexts: [],
  newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' },
  configs: [],
}

// 与 clean-tool-filter.mjs 默认名单一致(anysearch_ 已移出默认屏蔽)。
const DEFAULT_THIRD_PREFIXES = [
  'dev_', 'memory', 'dtodo', 'skill_manage', 'undo_', 'redteam_',
  'ssh_', 'context_audit', 'describe_image', 'de_', 'file_mount_forget',
]

// 第三方插件工具完整前缀(与 host classify 一致,含预设名单外的 anysearch_ 等,
// 用于「新增锁定」对名单外第三方工具的兜底判定)。
const THIRD_PREFIXES = [
  'dev_mode_', 'dev_', 'anysearch_', 'memory', 'dtodo', 'skill_manage',
  'de_', 'undo_', 'context_audit', 'ssh_', 'redteam_', 'describe_image',
  'file_mount_forget',
]

const LOCK_ICON: Record<LockState, string> = { enabled: '🟢', disabled: '🔴' }

const CATEGORY_LABEL: Record<string, string> = {
  mcp: 'MCP 工具（默认启用）',
  native: 'DSH 原生工具 / 纯净预设装配（默认启用）',
  third: '宿主第三方插件工具（纯净预设默认屏蔽）',
  unknown: '其他',
}

const CATEGORY_ORDER = ['native', 'third', 'mcp', 'unknown'] as const

const styles = `
.tm-page{font-size:14px;line-height:1.6;padding:14px 16px;max-width:860px;color:var(--dsw-alias-label-primary)}
.tm-page h3{margin:0 0 8px;font-size:16px;color:var(--dsw-alias-label-primary)}
.tm-desc{color:var(--dsw-alias-label-secondary);margin:0 0 14px;font-size:13px}
.tm-rule{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-bottom:12px}
.tm-rule label{display:inline-block;margin-right:10px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.tm-input{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;width:210px;margin-right:6px;font-family:inherit}
.tm-btn{background:var(--dsw-alias-state-business-primary);color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px;white-space:nowrap;font-family:inherit}
.tm-btn.ghost{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.tm-btn.danger{background:transparent;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.tm-btn:disabled{opacity:.4;cursor:not-allowed}
.tm-group{margin-bottom:14px}
.tm-group h4{margin:0 0 6px;font-size:13px;color:var(--dsw-alias-brand-primary)}
.tm-subgroup{margin-bottom:10px}
.tm-subhead{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.tm-group-actions{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.tm-fold{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:4px;width:22px;height:22px;line-height:1;cursor:pointer;padding:0;font-size:12px;font-family:inherit;flex:0 0 auto}
.tm-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0;font-weight:600}
.tm-subcount{color:var(--dsw-alias-label-tertiary);font-weight:400;margin-left:6px}
.tm-btn.tm-mini{padding:2px 8px;font-size:12px}
.tm-btn.tm-blue{background:#2563eb;color:#fff;border:1px solid #2563eb}
.tm-btn.tm-danger{background:#e5484d;color:#fff;border:1px solid #e5484d}
.tm-btn.tm-success{background:#16a34a;color:#fff;border:1px solid #16a34a}
.tm-tools{display:flex;flex-wrap:wrap;gap:6px}
.tm-chip{display:flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:13px;background:var(--dsw-alias-bg-layer-2)}
.tm-chip input[type=checkbox]{cursor:pointer}
.tm-chip.denied{opacity:.55}
.tm-chip.denied .tm-name{text-decoration:line-through}
.tm-chip.selected{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary) inset}
.tm-name{color:var(--dsw-alias-label-primary);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-switch{border:none;border-radius:999px;padding:2px 10px;cursor:pointer;font-size:12px;font-family:inherit;line-height:1.5;white-space:nowrap}
.tm-switch.on{background:#16a34a;color:#fff}
.tm-switch.off{background:#6b7280;color:#fff}
.tm-batch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.tm-batch.tm-sticky{position:sticky;top:8px;z-index:30;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.tm-label{font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:44px}
.tm-batch.tm-rows{flex-direction:column;align-items:stretch}
.tm-batch-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tm-save-row{display:flex;gap:8px;align-items:center;margin-top:12px}
.tm-status{font-size:13px;color:var(--dsw-alias-state-success-primary)}
.tm-status.err{color:var(--dsw-alias-state-error-primary)}
.tm-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:8px}
.tm-search{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.tm-search .tm-input{width:280px;margin-right:0}
.tm-filter{display:flex;gap:6px}
.tm-btn.tm-active{background:var(--dsw-alias-state-business-primary);color:#fff;border-color:var(--dsw-alias-state-business-primary)}
.tm-count{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}
.tm-name mark{background:transparent;color:var(--dsw-alias-brand-primary);font-weight:600}
.tm-h4-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tm-lock{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit}
.tm-lock.off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.tm-config{flex-direction:column;align-items:stretch}
.tm-config-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tm-config-list{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tm-config-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
.tm-config-chip.sel{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary) inset;color:var(--dsw-alias-brand-primary)}
.tm-config-edit{display:inline-flex;gap:6px;align-items:center}
`

function ToolManagerSection(): ReactElement {
  const [tools, setTools] = useState<ToolRow[]>([])
  const [cfg, setCfg] = useState<Config>(EMPTY_CONFIG)
  const [status, setStatus] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'denied'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [contextNames, setContextNames] = useState<string[]>([])
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null)
  const [cfgEdit, setCfgEdit] = useState<null | 'save' | 'rename'>(null)
  const [cfgNameInput, setCfgNameInput] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API}/tools`)
        const body = await res.json()
        if (cancelled) return
        setTools((body?.tools ?? []) as ToolRow[])
        setContextNames((body?.contexts ?? []) as string[])
        setCfg((body?.config ?? EMPTY_CONFIG) as Config)
      } catch (e) {
        if (!cancelled) setStatus('⚠️ 无法连接 host API（/tool-manager/api）：' + String(e))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  const isEffectivelyDenied = (name: string): boolean => {
    if (cfg.allowNames.includes(name)) return false
    if (cfg.allowPrefixes.some((p) => name.startsWith(p))) return false
    if (cfg.denyNames.includes(name)) return true
    if (cfg.denyPrefixes.some((p) => name.startsWith(p))) return true
    if (DEFAULT_THIRD_PREFIXES.some((p) => name.startsWith(p))) return true
    if (name.startsWith('mcp__')) return cfg.newDefault.mcp === 'disabled'
    if (THIRD_PREFIXES.some((p) => name.startsWith(p))) return cfg.newDefault.third === 'disabled'
    return false
  }

  // 把单个工具设为启用/禁用,返回新 Config(双向清理 allow/deny 名单,避免残留复活)。
  const applyDeny = (cfg0: Config, name: string, denied: boolean): Config => {
    const next: Config = { ...cfg0, denyNames: [...cfg0.denyNames], allowNames: [...cfg0.allowNames] }
    if (denied) {
      if (!next.denyNames.includes(name)) next.denyNames.push(name)
      next.allowNames = next.allowNames.filter((n) => n !== name)
    } else {
      next.denyNames = next.denyNames.filter((n) => n !== name)
      if (DEFAULT_THIRD_PREFIXES.some((p) => name.startsWith(p)) && !next.allowNames.includes(name)) {
        next.allowNames.push(name)
      }
    }
    return next
  }

  const persist = (next: Config): void => {
    void (async () => {
      try {
        const res = await fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        })
        const body = await res.json()
        setStatus(body?.ok ? '✅ 已保存，新会话生效' : '❌ 保存失败：' + (body?.error ?? 'unknown'))
      } catch (e) {
        setStatus('❌ 保存失败：' + String(e))
      }
    })()
  }

  const commit = (next: Config): void => {
    setCfg(next)
    persist(next)
  }

  const toggle = (name: string, denied: boolean): void => {
    commit(applyDeny(cfg, name, denied))
  }

  const batchSetDenied = (names: string[], denied: boolean): void => {
    if (names.length === 0) return
    commit(names.reduce((acc, n) => applyDeny(acc, n, denied), cfg))
  }

  const toggleSelect = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const reset = (): void => {
    setSelected(new Set())
    commit({ ...EMPTY_CONFIG, newDefault: cfg.newDefault, configs: cfg.configs })
  }

  const matches = (t: ToolRow): boolean => {
    const q = query.trim().toLowerCase()
    if (q && !t.name.toLowerCase().includes(q) && !(t.description ?? '').toLowerCase().includes(q)) return false
    const d = isEffectivelyDenied(t.name)
    if (filter === 'enabled' && d) return false
    if (filter === 'denied' && !d) return false
    return true
  }

  const filteredTools = useMemo(() => tools.filter(matches), [tools, query, filter, cfg])

  const sections = useMemo(() => {
    const byCat = new Map<string, ToolRow[]>()
    for (const t of filteredTools) {
      const arr = byCat.get(t.category) ?? []
      arr.push(t)
      byCat.set(t.category, arr)
    }
    const out: { cat: string; label: string; subs: { key: string; label: string; rows: ToolRow[] }[] }[] = []
    for (const cat of CATEGORY_ORDER) {
      const rows = byCat.get(cat)
      if (!rows || rows.length === 0) continue
      if (cat === 'mcp' || cat === 'third') {
        const byGroup = new Map<string, ToolRow[]>()
        for (const t of rows) {
          const g = t.group || '其他'
          const arr = byGroup.get(g) ?? []
          arr.push(t)
          byGroup.set(g, arr)
        }
        const subs = [...byGroup.entries()]
          .map(([g, rs]) => ({ key: g, label: g, rows: rs }))
          .sort((a, b) => a.label.localeCompare(b.label))
        out.push({ cat, label: CATEGORY_LABEL[cat] ?? cat, subs })
      } else {
        out.push({ cat, label: CATEGORY_LABEL[cat] ?? cat, subs: [{ key: cat, label: '', rows }] })
      }
    }
    return out
  }, [filteredTools])

  const contextSet = useMemo(() => new Set(contextNames), [contextNames])

  const selectableTools = useMemo(() => filteredTools.filter((t) => t.category !== 'native'), [filteredTools])

  const selectAllNames = useMemo(
    () => [...selectableTools.map((t) => t.name), ...contextNames],
    [selectableTools, contextNames],
  )

  const allSelectableSelected = selectAllNames.length > 0 && selectAllNames.every((n) => selected.has(n))

  const toggleSelectAll = (): void => {
    setSelected((prev) => {
      const allSel = selectAllNames.length > 0 && selectAllNames.every((n) => prev.has(n))
      const next = new Set(prev)
      for (const n of selectAllNames) {
        if (allSel) next.delete(n)
        else next.add(n)
      }
      return next
    })
  }

  // 上下文注入的纯函数式禁用/启用(denyContexts + allowContexts 双向清理)。
  const applyContextDeny = (cfg0: Config, name: string, denied: boolean): Config => {
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

  const toggleContext = (name: string): void => {
    commit(applyContextDeny(cfg, name, contextEnabled(name)))
  }

  const selectAllContexts = (): void => {
    setSelected((prev) => {
      const allSel = contextNames.length > 0 && contextNames.every((n) => prev.has(n))
      const next = new Set(prev)
      for (const n of contextNames) {
        if (allSel) next.delete(n)
        else next.add(n)
      }
      return next
    })
  }

  const enableAllContexts = (): void => {
    commit({ ...cfg, denyContexts: [], allowContexts: [...contextNames] })
  }

  const disableAllContexts = (): void => {
    commit({ ...cfg, denyContexts: [...contextNames], allowContexts: [] })
  }

  /** 上下文是否实际启用:显式启用 > 显式禁用 > 新增锁定默认。 */
  const contextEnabled = (name: string): boolean => {
    if (cfg.allowContexts.includes(name)) return true
    if (cfg.denyContexts.includes(name)) return false
    return cfg.newDefault.context !== 'disabled'
  }

  /** 切换某层的「新增锁定」:enabled=新出现的内容默认可用,disabled=默认屏蔽。 */
  const toggleNewDefault = (cat: LockCat): void => {
    const next: LockState = cfg.newDefault[cat] === 'enabled' ? 'disabled' : 'enabled'
    commit({ ...cfg, newDefault: { ...cfg.newDefault, [cat]: next } })
  }

  // ── 命名配置(保存/启用/重命名/删除) ─────────────────────────────
  const saveAsConfig = (): void => {
    setCfgEdit('save')
    setCfgNameInput('')
  }

  const startRenameConfig = (): void => {
    if (!selectedConfigId) return
    const cur = cfg.configs.find((c) => c.id === selectedConfigId)
    setCfgEdit('rename')
    setCfgNameInput(cur ? cur.name : '')
  }

  const submitCfgEdit = (): void => {
    const name = cfgNameInput.trim()
    if (!name || !cfgEdit) return
    if (cfgEdit === 'save') {
      const saved: SavedConfig = {
        id: 'cfg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        savedAt: new Date().toISOString(),
        state: {
          denyPrefixes: [...cfg.denyPrefixes],
          denyNames: [...cfg.denyNames],
          allowPrefixes: [...cfg.allowPrefixes],
          allowNames: [...cfg.allowNames],
          denyContexts: [...cfg.denyContexts],
          allowContexts: [...cfg.allowContexts],
        },
      }
      commit({ ...cfg, configs: [...cfg.configs, saved] })
      setSelectedConfigId(saved.id)
    } else if (cfgEdit === 'rename' && selectedConfigId) {
      commit({ ...cfg, configs: cfg.configs.map((c) => (c.id === selectedConfigId ? { ...c, name } : c)) })
    }
    setCfgEdit(null)
    setCfgNameInput('')
  }

  const applySavedConfig = (saved: SavedConfig): void => {
    commit({
      ...cfg,
      denyPrefixes: [...saved.state.denyPrefixes],
      denyNames: [...saved.state.denyNames],
      allowPrefixes: [...saved.state.allowPrefixes],
      allowNames: [...saved.state.allowNames],
      denyContexts: [...saved.state.denyContexts],
      allowContexts: [...saved.state.allowContexts],
      // newDefault(新增锁定)不随配置切换
    })
    setStatus('✅ 已启用配置「' + saved.name + '」，新会话生效')
  }

  const deleteSavedConfig = (): void => {
    if (!selectedConfigId) return
    commit({ ...cfg, configs: cfg.configs.filter((c) => c.id !== selectedConfigId) })
    setSelectedConfigId(null)
  }

  // 批量启用/禁用「选中」:工具走 denyNames、上下文走 denyContexts。
  const setSelectedDenied = (denied: boolean): void => {
    if (selected.size === 0) return
    const toolNames: string[] = []
    const ctxNames: string[] = []
    for (const name of selected) {
      if (contextSet.has(name)) ctxNames.push(name)
      else toolNames.push(name)
    }
    let next = cfg
    for (const n of toolNames) next = applyDeny(next, n, denied)
    for (const n of ctxNames) next = applyContextDeny(next, n, denied)
    commit(next)
  }

  const toolsOfCategory = (cat: 'mcp' | 'third'): string[] => tools.filter((t) => t.category === cat).map((t) => t.name)

  const selectCategory = (cat: 'mcp' | 'third'): void => {
    setSelected((prev) => new Set([...prev, ...toolsOfCategory(cat)]))
  }

  const enableCategory = (cat: 'mcp' | 'third'): void => {
    batchSetDenied(toolsOfCategory(cat), false)
  }

  const disableCategory = (cat: 'mcp' | 'third'): void => {
    batchSetDenied(toolsOfCategory(cat), true)
  }

  const toggleCollapse = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const disableGroup = (rows: ToolRow[]): void => {
    batchSetDenied(rows.map((t) => t.name), true)
  }

  const enableGroup = (rows: ToolRow[]): void => {
    batchSetDenied(rows.map((t) => t.name), false)
  }

  const selectGroup = (rows: ToolRow[]): void => {
    const names = rows.map((t) => t.name)
    setSelected((prev) => {
      const allSelected = names.length > 0 && names.every((n) => prev.has(n))
      const next = new Set(prev)
      for (const n of names) {
        if (allSelected) next.delete(n)
        else next.add(n)
      }
      return next
    })
  }

  const highlight = (text: string, q: string): ReactElement | string => {
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx < 0) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  return (
    <div className="tm-page">
      <h3>预设工具管理（纯净预设 clean-agent）</h3>
      <p className="tm-desc">
        针对 clean-agent 纯净预设控制工具面：MCP 工具与 DSH 原生工具默认启用，第三方插件工具默认屏蔽。
        每个工具右侧的开关控制「启用/禁用」，左侧 ☑️ 用于批量选中。改动即时自动保存，对新会话生效。
      </p>
      {!loaded ? (
        <p className="tm-hint">加载中…</p>
      ) : (
        <>
          <div className="tm-search">
            <input
              className="tm-input"
              placeholder="搜索工具名或描述…"
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            />
            <div className="tm-filter">
              {([
                ['all', '全部'],
                ['enabled', '已启用'],
                ['denied', '已屏蔽'],
              ] as const).map(([val, label]) => (
                <button
                  key={val}
                  className={'tm-btn ghost' + (filter === val ? ' tm-active' : '')}
                  onClick={() => setFilter(val)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="tm-count">
            共 {tools.length} 个工具
            {query.trim() || filter !== 'all' ? `，筛选后 ${filteredTools.length} 个` : ''}
          </div>

          <div className="tm-batch tm-sticky">
            <span className="tm-count">已选 {selected.size} 个</span>
            <button className="tm-btn tm-blue" onClick={toggleSelectAll} title="选中除官方 DSH 原生工具外的所有可见工具">
              {allSelectableSelected ? '取消全选' : '全选'}
            </button>
            <button className="tm-btn tm-success" onClick={() => setSelectedDenied(false)} disabled={selected.size === 0}>
              启用选中
            </button>
            <button className="tm-btn tm-danger" onClick={() => setSelectedDenied(true)} disabled={selected.size === 0}>
              禁用选中
            </button>
            <button className="tm-btn ghost" onClick={saveAsConfig} title="把当前工具/上下文启用状态保存为命名配置（不含新增锁定状态）">
              保存为配置
            </button>
          </div>

          <div className="tm-batch tm-config">
            <div className="tm-config-actions">
              <span className="tm-label">配置</span>
              <button
                className="tm-btn tm-mini tm-success"
                disabled={!selectedConfigId}
                onClick={() => {
                  const s = cfg.configs.find((c) => c.id === selectedConfigId)
                  if (s) applySavedConfig(s)
                }}
                title="把当前工具状态切换为所选配置保存的状态"
              >
                启用
              </button>
              <button className="tm-btn tm-mini tm-blue" disabled={!selectedConfigId} onClick={startRenameConfig} title="重命名所选配置">重命名</button>
              <button className="tm-btn tm-mini tm-danger" disabled={!selectedConfigId} onClick={deleteSavedConfig} title="删除所选配置">删除</button>
            </div>
            <div className="tm-config-list">
              {cfg.configs.length === 0 ? (
                <span className="tm-hint">暂无保存的配置：点击上方「保存为配置」保存当前状态</span>
              ) : (
                cfg.configs.map((c) => (
                  <button
                    key={c.id}
                    className={'tm-config-chip' + (selectedConfigId === c.id ? ' sel' : '')}
                    onClick={() => setSelectedConfigId(c.id)}
                    title={c.name + '（' + new Date(c.savedAt).toLocaleString() + '）'}
                  >
                    {c.name}
                  </button>
                ))
              )}
              {cfgEdit ? (
                <span className="tm-config-edit">
                  <input
                    className="tm-input"
                    placeholder={cfgEdit === 'save' ? '配置名称…' : '新名称…'}
                    value={cfgNameInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setCfgNameInput(e.target.value)}
                    onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') submitCfgEdit() }}
                    autoFocus
                  />
                  <button className="tm-btn ghost" onClick={submitCfgEdit}>确定</button>
                  <button className="tm-btn danger" onClick={() => setCfgEdit(null)}>取消</button>
                </span>
              ) : null}
            </div>
          </div>

          <div className="tm-batch tm-rows">
            <div className="tm-batch-row">
              <span className="tm-label">上下文</span>
              <button className="tm-btn tm-mini tm-blue" onClick={selectAllContexts}>一键选中</button>
              <button className="tm-btn tm-mini tm-success" onClick={enableAllContexts}>一键启用</button>
              <button className="tm-btn tm-mini tm-danger" onClick={disableAllContexts}>一键禁用</button>
              <button
                className={'tm-lock' + (cfg.newDefault.context === 'disabled' ? ' off' : '')}
                onClick={() => toggleNewDefault('context')}
                title={'新增锁定：新出现的上下文注入默认' + (cfg.newDefault.context === 'enabled' ? '启用' : '禁用')}
              >
                {LOCK_ICON[cfg.newDefault.context]} 新增{cfg.newDefault.context === 'enabled' ? '启用' : '禁用'}
              </button>
            </div>
            <div className="tm-batch-row">
              <span className="tm-label">第三方</span>
              <button className="tm-btn tm-mini tm-blue" onClick={() => selectCategory('third')}>一键选中</button>
              <button className="tm-btn tm-mini tm-success" onClick={() => enableCategory('third')}>一键启用</button>
              <button className="tm-btn tm-mini tm-danger" onClick={() => disableCategory('third')}>一键禁用</button>
              <button
                className={'tm-lock' + (cfg.newDefault.third === 'disabled' ? ' off' : '')}
                onClick={() => toggleNewDefault('third')}
                title={'新增锁定：新出现的第三方插件工具默认' + (cfg.newDefault.third === 'enabled' ? '启用' : '禁用')}
              >
                {LOCK_ICON[cfg.newDefault.third]} 新增{cfg.newDefault.third === 'enabled' ? '启用' : '禁用'}
              </button>
            </div>
            <div className="tm-batch-row">
              <span className="tm-label">MCP</span>
              <button className="tm-btn tm-mini tm-blue" onClick={() => selectCategory('mcp')}>一键选中</button>
              <button className="tm-btn tm-mini tm-success" onClick={() => enableCategory('mcp')}>一键启用</button>
              <button className="tm-btn tm-mini tm-danger" onClick={() => disableCategory('mcp')}>一键禁用</button>
              <button
                className={'tm-lock' + (cfg.newDefault.mcp === 'disabled' ? ' off' : '')}
                onClick={() => toggleNewDefault('mcp')}
                title={'新增锁定：新出现的 MCP 工具默认' + (cfg.newDefault.mcp === 'enabled' ? '启用' : '禁用')}
              >
                {LOCK_ICON[cfg.newDefault.mcp]} 新增{cfg.newDefault.mcp === 'enabled' ? '启用' : '禁用'}
              </button>
            </div>
          </div>

          <div className="tm-rule">
            <label>屏蔽前缀（附加）</label>
            <PrefixInput cfg={cfg} commit={commit} />
          </div>

          {contextNames.length > 0 ? (
            <div className="tm-group">
              <h4>上下文注入（动态上下文）</h4>
              <div className="tm-subgroup">
                <div className="tm-subhead">
                  <span className="tm-subtitle">
                    共 {contextNames.length} 项
                    <span className="tm-subcount"></span>
                  </span>
                  <div className="tm-group-actions">
                    <button className="tm-btn tm-mini tm-blue" onClick={selectAllContexts}>选中分组</button>
                    <button className="tm-btn tm-mini tm-success" onClick={enableAllContexts}>全部启用</button>
                    <button className="tm-btn tm-mini tm-danger" onClick={disableAllContexts}>全部禁用</button>
                  </div>
                </div>
                <div className="tm-tools">
                  {contextNames.map((name) => {
                    const enabled = contextEnabled(name)
                    const sel = selected.has(name)
                    return (
                      <div
                        className={'tm-chip' + (!enabled ? ' denied' : '') + (sel ? ' selected' : '')}
                        key={name}
                        title={'动态上下文：' + name + (enabled ? '（已注入）' : '（已禁用注入）')}
                      >
                        <input type="checkbox" checked={sel} onChange={() => toggleSelect(name)} title="选中（用于批量操作）" />
                        <span className="tm-name">{name}</span>
                        <button
                          className={'tm-switch' + (enabled ? ' on' : ' off')}
                          role="switch"
                          aria-checked={enabled}
                          onClick={() => toggleContext(name)}
                          title={enabled ? '点击禁用注入' : '点击启用注入'}
                        >
                          {enabled ? '启用' : '禁用'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {sections.map((sec) => (
            <Fragment key={sec.cat}>
              <div className="tm-group">
              <h4>{sec.label}</h4>
              {sec.subs.map((sub) => {
                const isCollapsed = collapsed.has(sub.key)
                const groupAllSelected = sub.rows.length > 0 && sub.rows.every((t) => selected.has(t.name))
                return (
                  <div className="tm-subgroup" key={sub.key}>
                    <div className="tm-subhead">
                      <button
                        className="tm-fold"
                        onClick={() => toggleCollapse(sub.key)}
                        title={isCollapsed ? '展开' : '折叠'}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      <span className="tm-subtitle">
                        {sub.label || '全部'}
                        <span className="tm-subcount">{sub.rows.length}</span>
                      </span>
                      <div className="tm-group-actions">
                        <button
                          className="tm-btn tm-mini tm-blue"
                          onClick={() => selectGroup(sub.rows)}
                          title={groupAllSelected ? '取消选中的该分组工具' : '选中该分组内所有工具（用于批量操作）'}
                        >
                          {groupAllSelected ? '取消选中' : '选中分组'}
                        </button>
                        <button
                          className="tm-btn tm-mini tm-success"
                          onClick={() => enableGroup(sub.rows)}
                          title="把该分组内所有工具设为启用"
                        >
                          启用分组
                        </button>
                        <button
                          className="tm-btn tm-mini tm-danger"
                          onClick={() => disableGroup(sub.rows)}
                          title="把该分组内所有工具设为禁用"
                        >
                          禁用分组
                        </button>
                      </div>
                    </div>
                    {!isCollapsed ? (
                      <div className="tm-tools">
                        {sub.rows.map((t) => {
                          const denied = isEffectivelyDenied(t.name)
                          const sel = selected.has(t.name)
                          return (
                            <div
                              className={'tm-chip' + (denied ? ' denied' : '') + (sel ? ' selected' : '')}
                              key={t.name}
                              title={(t.description || '') + '（' + (t.group ? t.group + ' · ' : '') + (denied ? '已禁用' : '已启用') + '）'}
                            >
                              <input
                                type="checkbox"
                                checked={sel}
                                onChange={() => toggleSelect(t.name)}
                                title="选中（用于批量操作）"
                              />
                              <span className="tm-name">{highlight(t.name, query.trim())}</span>
                              <button
                                className={'tm-switch' + (denied ? ' off' : ' on')}
                                role="switch"
                                aria-checked={!denied}
                                onClick={() => toggle(t.name, !denied)}
                                title={denied ? '点击启用' : '点击禁用'}
                              >
                                {denied ? '禁用' : '启用'}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
            </Fragment>
          ))}

          <div className="tm-save-row">
            <button className="tm-btn ghost" onClick={reset}>恢复默认</button>
            {status ? (
              <span className={'tm-status' + (status.startsWith('❌') || status.startsWith('⚠️') ? ' err' : '')}>{status}</span>
            ) : null}
          </div>
          <div className="tm-hint">
            提示：启用/禁用即时自动保存；工具通过前缀/精确名 deny 名单生效，「上下文注入」通过 denyContexts 名单禁用（默认全启用）。所有操作只写纯净预设配置，不关闭 MCP/插件服务本身。修改后请新建 clean-agent 会话验证。
            配置文件：$DSH_HOME/.dsh/tool-manager.json
          </div>
        </>
      )}
    </div>
  )
}

function PrefixInput(props: {
  cfg: Config
  commit: (next: Config) => void
}): ReactElement {
  const [value, setValue] = useState('')
  const { cfg, commit } = props

  const add = (): void => {
    const v = value.trim()
    if (v && !cfg.denyPrefixes.includes(v)) {
      commit({ ...cfg, denyPrefixes: [...cfg.denyPrefixes, v] })
    }
    setValue('')
  }

  return (
    <>
      <input
        className="tm-input"
        placeholder="screenshot_"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
        onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') add() }}
      />
      <button className="tm-btn ghost" onClick={add}>＋</button>
      {cfg.denyPrefixes.map((p) => (
        <span className="tm-chip" key={p} style={{ marginRight: 6 }}>
          {p}
          <button
            className="tm-btn danger"
            style={{ padding: '0 4px', margin: '0 0 0 4px' }}
            onClick={() => commit({ ...cfg, denyPrefixes: cfg.denyPrefixes.filter((q) => q !== p) })}
          >
            ✕
          </button>
        </span>
      ))}
    </>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'tool-manager',
    order: 20,
    label: () => '预设工具管理',
  }, ToolManagerSection))
}