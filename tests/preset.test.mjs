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
