/**
 * preset.test.mjs —— 内置 clean-agent 预设定义的回归测试（node --test）。
 *
 * 守住三条最容易退化的约束：
 *   1. persona 必须 includeRuntimeContext: true —— false 会让
 *      suppressRuntimeContext() 把上下文整体抹除，使 GUI 的上下文开关全废；
 *   2. 过滤器必须用**包名子路径**引用，不能是预设目录下的相对 ./xxx.mjs ——
 *      DSH 0.2 的 package-inventory 解析相对模块会向上找 profile 的
 *      package.json，缺 version 时抛 REQUEST_EXTENSION，整个会话发不出请求；
 *   3. plugins 只能引用 DSH 官方包 / cordis:group / 本包子路径，保证可移植。
 *
 * 运行: node --test tests/preset.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLEAN_AGENT_PRESET_ID, buildCleanAgentPreset } from '../lib/index.js'

const preset = buildCleanAgentPreset()

test('预设身份与排序', () => {
  assert.equal(preset.id, 'clean-agent')
  assert.equal(CLEAN_AGENT_PRESET_ID, 'clean-agent')
  assert.equal(preset.name, 'Clean Agent')
  assert.ok(Number.isFinite(preset.order))
  assert.ok(preset.description.length > 20)
})

test('persona 必须 includeRuntimeContext: true(否则上下文开关全废)', () => {
  const persona = preset.plugins.find((p) => p.id === 'persona')
  assert.ok(persona, '缺少 persona 行')
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.equal(persona.config?.includeRuntimeContext, true,
    'persona.includeRuntimeContext 必须是 true —— false 会调用 suppressRuntimeContext() 抹除全部上下文')
  assert.ok(String(persona.config?.prefix ?? '').includes('{{model}}'))
})

test('过滤器用包名子路径引用,不能是相对 ./xxx.mjs', () => {
  const filter = preset.plugins.find((p) => p.id === 'clean-tool-filter')
  assert.ok(filter, '缺少 clean-tool-filter 行')
  assert.equal(filter.name, '@dsh-external/dsh-tool-manager/preset-filter')
  assert.equal(filter.name.startsWith('.'), false, '相对路径模块会触发 REQUEST_EXTENSION')
  assert.equal(filter.config?.scopeId, 'clean-agent', 'scopeId 必须与预设 id 一致')
})

test('plugins 只引用官方包 / cordis:group / 本包子路径(可移植)', () => {
  for (const entry of preset.plugins) {
    const n = entry.name
    const ok = n.startsWith('@deepseek-ai/dsh-')
      || n === 'cordis:group'
      || n === '@dsh-external/dsh-tool-manager/preset-filter'
    assert.ok(ok, `不可移植的模块引用: ${n}`)
    assert.equal(String(n).startsWith('./'), false, `不允许相对路径: ${n}`)
  }
})

test('compaction 组行结构完整', () => {
  const group = preset.plugins.find((p) => p.id === 'compaction')
  assert.ok(group)
  assert.equal(group.name, 'cordis:group')
  assert.equal(group.group, true)
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  assert.equal(Array.isArray(group.config), true)
  assert.equal(group.config.length, 3)
})

test('平台相关行用运行时布尔值,而不是 YAML 的 !!js 标签', () => {
  const pwsh = preset.plugins.find((p) => p.id === 'tool-pwsh')
  assert.ok(pwsh)
  assert.equal(typeof pwsh.disabled, 'boolean')
})

test('工具面覆盖 DSH 原生工具集合', () => {
  const ids = new Set(preset.plugins.map((p) => p.id))
  for (const need of ['tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-str-replace-editor',
    'tool-jobs', 'skill-filesystem', 'tool-skill', 'tool-goal',
    'tool-ask-user', 'tool-todo', 'tool-web']) {
    assert.ok(ids.has(need), `预设缺少 ${need}`)
  }
})

// ── 2026-10-12：补齐官方 standard 的功能行 ──────────────────────────────────

test('补齐 standard 有的官方行（命令 / 计划模式 / 子agent / present / 插件管理）', () => {
  const ids = new Set(preset.plugins.map((p) => p.id))
  for (const need of ['command-goal', 'planning', 'delegation', 'present', 'tool-plugin-manager', 'tool-bash']) {
    assert.ok(ids.has(need), `预设缺少官方行 ${need}`)
  }
})

test('delegation 组含全部子 agent / workflow 行（照抄官方 standard）', () => {
  const deleg = preset.plugins.find((p) => p.id === 'delegation')
  assert.ok(deleg, '缺少 delegation 组')
  assert.equal(deleg.group, true)
  assert.deepEqual(deleg.isolate, { workflowEngine: true })
  const dIds = deleg.config.map((x) => x.id)
  for (const need of ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
    'tool-subagent-fork', 'tool-subagent-codex', 'tool-subagent-claude-code',
    'workflow-ptc', 'tool-workflow', 'tool-ralph']) {
    assert.ok(dIds.includes(need), `delegation 缺少 ${need}`)
  }
  const sub = deleg.config.find((x) => x.id === 'tool-subagent')
  assert.equal(sub.name, '@deepseek-ai/dsh-tool-subagent')
  assert.equal(sub.config.toolName, 'subagent', '工具名必须显式声明，否则工具面与 standard 不一致')
  // codex / claude-code provider 官方默认关闭，这里照抄
  assert.equal(deleg.config.find((x) => x.id === 'tool-subagent-codex').disabled, true)
  assert.equal(deleg.config.find((x) => x.id === 'tool-subagent-claude-code').disabled, true)
  assert.equal(deleg.config.find((x) => x.id === 'tool-ralph').disabled, true)
})

test('plan-mode 必须带非空 section —— 漏了会让整个预设装配失败', () => {
  // 实测教训：@deepseek-ai/dsh-plan-mode 的 section 是必填 config，不给会
  // registry 记 broken: "PlanModeConfig needs a non-empty section"，整个 clean-agent
  // 直接不可用（不是"少一个工具"，是全部作废）。
  const planning = preset.plugins.find((p) => p.id === 'planning')
  assert.ok(planning, '缺少 planning 组')
  assert.equal(planning.group, true)
  assert.deepEqual(planning.isolate, { planMode: true })
  const pm = planning.config.find((x) => x.id === 'plan-mode')
  assert.ok(pm, '缺少 plan-mode 行')
  assert.equal(typeof pm.config?.section, 'string')
  assert.ok(pm.config.section.length > 500, 'section 必须是官方那段完整文本')
  assert.ok(pm.config.section.includes('exit_plan_mode'), 'section 应指示如何退出计划模式')
})

test('subagent 的 modelSelectionSettings 依赖 Host 前置（真实部署由 dsh-web-app 提供）', () => {
  // 它要求 Host scope 里有 @deepseek-ai/dsh-tool-subagent/model-selection-settings，
  // 该行由 @deepseek-ai/dsh-web-app 的 "web-only host rows" 提供 —— desktop / backup / web
  // 三个 profile 都带 web-app，所以真实部署没问题；headless 之类没带的 profile 会
  // 报 broken（这也是隔离验证时先补这行才能装上的原因）。
  const deleg = preset.plugins.find((p) => p.id === 'delegation')
  const sub = deleg.config.find((x) => x.id === 'tool-subagent')
  assert.equal(sub.config.modelSelectionSettings, true)
})

test('shell 行两个平台都装配，由 disabled 决定生效（不能只留 pwsh）', () => {
  const bash = preset.plugins.find((p) => p.id === 'tool-bash')
  const pwsh = preset.plugins.find((p) => p.id === 'tool-pwsh')
  assert.ok(bash && pwsh)
  assert.equal(bash.disabled, process.platform === 'win32')
  assert.equal(pwsh.disabled, process.platform !== 'win32')
})
