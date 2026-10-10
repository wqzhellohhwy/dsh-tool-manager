/**
 * newdefault.test.mjs ——「完全启用/禁用」与「新增启用/禁用」的回归测试。
 *
 * 覆盖本轮三个改动：
 *   ① 搜索框要能筛「上下文注入」（filterNames）；
 *   ② 「完全启用/禁用」= 清空该层个别设置，当前全部项统一启用/禁用；
 *   ③ 「新增启用/禁用」= 只决定今后新出现的项，现有项先按当前状态定型、不受影响。
 *
 * 另外钉住一条实质改进：**未知前缀的新插件工具**也会被「新增锁定」管住
 * （改造前不命中 THIRD_PREFIXES 的名字会被默认放行 —— asar_* 当年就是这么漏的）。
 *
 * 运行: node --test tests/newdefault.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_CONFIG,
  applyDeny,
  applyFullToggle,
  applyNewDefault,
  contextEnabled,
  filterNames,
  isEffectivelyDenied,
} from '../lib/decide.mjs'

/** 纯净预设的典型配置：三层「新增锁定」全为禁用。 */
const STRICT = {
  ...EMPTY_CONFIG,
  newDefault: { context: 'disabled', third: 'disabled', mcp: 'disabled' },
}

// ── ① 搜索过滤上下文 ────────────────────────────────────────────────────────
test('filterNames：搜索框能筛上下文（大小写不敏感 / 空查询返回全部）', () => {
  const contexts = ['memory:snapshot', 'dsh-super-injector', 'sandbox:policy', 'approval:policy']
  assert.deepEqual(filterNames(contexts, ''), contexts)
  assert.deepEqual(filterNames(contexts, '  '), contexts)
  assert.deepEqual(filterNames(contexts, 'memory'), ['memory:snapshot'])
  assert.deepEqual(filterNames(contexts, 'POLICY'), ['sandbox:policy', 'approval:policy'])
  assert.deepEqual(filterNames(contexts, 'injector'), ['dsh-super-injector'])
  assert.deepEqual(filterNames(contexts, '不存在的词'), [])
})

// ── ② 兜底范围：未知前缀的新插件工具也要被管住 ───────────────────────────────
test('未知前缀的新插件工具也吃「新增锁定」（改造前会被默认放行）', () => {
  // brandnew_tool 不在 THIRD_PREFIXES / DEFAULT_THIRD_PREFIXES 里，但 host 会把它
  // 分成 third（白名单制的兜底）—— 于是它必须受 newDefault.third 约束。
  assert.equal(isEffectivelyDenied(STRICT, 'brandnew_tool', 'third'), true)
  const loose = { ...STRICT, newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' } }
  assert.equal(isEffectivelyDenied(loose, 'brandnew_tool', 'third'), false)
})

test('官方宿主工具（native）不受「新增锁定」影响', () => {
  assert.equal(isEffectivelyDenied(STRICT, 'list_mcp_resources', 'native'), false)
  assert.equal(isEffectivelyDenied(STRICT, 'load_workspace_dependencies', 'native'), false)
})

// ── ③ baseline 语义 ────────────────────────────────────────────────────────
test('baseline 为空 ⇒ 所有非 native 项都按 newDefault（与改造前行为一致）', () => {
  assert.equal(isEffectivelyDenied(STRICT, 'asar_backup', 'third'), true)
  assert.equal(isEffectivelyDenied(STRICT, 'mcp__exa__web_search_exa', 'mcp'), true)
  assert.equal(contextEnabled(STRICT, 'memory:snapshot'), false)
})

test('已定型（在 baseline 里）且未列名 ⇒ 启用，不再受 newDefault 影响', () => {
  const cfg = { ...STRICT, baseline: ['asar_backup', 'memory:snapshot'] }
  assert.equal(isEffectivelyDenied(cfg, 'asar_backup', 'third'), false)
  assert.equal(contextEnabled(cfg, 'memory:snapshot'), true)
  // 不在 baseline 的仍然按 newDefault
  assert.equal(isEffectivelyDenied(cfg, 'brandnew_tool', 'third'), true)
})

test('旧配置没有 baseline 字段也不崩', () => {
  const legacy = { ...STRICT }
  delete legacy.baseline
  assert.equal(isEffectivelyDenied(legacy, 'asar_backup', 'third'), true)
  assert.equal(contextEnabled(legacy, 'memory:snapshot'), false)
})

// ── ④ 「新增启用/禁用」：定型 + 固化，状态不突变 ──────────────────────────────
test('点「新增禁用」：现有禁用项状态不变（固化进 denyNames），只有新项吃开关', () => {
  const before = STRICT
  const names = ['asar_backup', 'list_mcp_resources', 'brandnew_tool']
  // 用改动前的 cfg 判定当前状态（模拟 UI 的 isDenied 回调）
  const isDenied = (n) => isEffectivelyDenied(before, n, n.startsWith('mcp__') ? 'mcp' : (n === 'list_mcp_resources' ? 'native' : 'third'))
  const after = applyNewDefault(before, 'third', 'disabled', names, isDenied)

  // 已定型
  assert.deepEqual([...after.baseline].sort(), [...names].sort())
  // 状态不翻转：原来禁的还是禁
  assert.equal(isEffectivelyDenied(after, 'asar_backup', 'third'), true)
  assert.equal(isEffectivelyDenied(after, 'brandnew_tool', 'third'), true)
  // native 依旧不受影响
  assert.equal(isEffectivelyDenied(after, 'list_mcp_resources', 'native'), false)
  // 固化结果确实写进了名单
  assert.ok(after.denyNames.includes('asar_backup'))
  assert.ok(after.denyNames.includes('brandnew_tool'))
  assert.equal(after.denyNames.includes('list_mcp_resources'), false, 'native 不应被写进 deny')
})

test('点「新增启用」后再出现的新工具默认可用，而老项保持禁用', () => {
  const before = STRICT
  const names = ['asar_backup']
  const after = applyNewDefault(before, 'third', 'enabled', names, (n) => isEffectivelyDenied(before, n, 'third'))
  // 老项：已定型 + 固化 ⇒ 仍然禁用
  assert.equal(isEffectivelyDenied(after, 'asar_backup', 'third'), true)
  // 新项：不在 baseline ⇒ 吃 newDefault=enabled ⇒ 可用
  assert.equal(isEffectivelyDenied(after, 'another_new_plugin_tool', 'third'), false)
})

test('上下文同样支持「新增」语义', () => {
  const before = STRICT
  const names = ['memory:snapshot']
  const after = applyNewDefault(before, 'context', 'enabled', names, (n) => !contextEnabled(before, n))
  assert.equal(contextEnabled(after, 'memory:snapshot'), false, '老项保持禁用')
  assert.equal(contextEnabled(after, 'brandnew:context'), true, '新上下文按新增=启用')
})

// ── ⑤ 「完全启用/禁用」 ────────────────────────────────────────────────────
test('完全禁用：清空该层个别设置后，全部项一律禁用', () => {
  const cfg = {
    ...STRICT,
    baseline: ['asar_backup'],
    allowNames: ['asar_backup'],            // 显式启用也要被"完全禁用"推平
    denyNames: ['mcp__exa__web_search_exa'],
  }
  const names = ['asar_backup', 'brandnew_tool']
  const after = applyFullToggle(cfg, 'third', 'disabled', names)
  assert.equal(isEffectivelyDenied(after, 'asar_backup', 'third'), true)
  assert.equal(isEffectivelyDenied(after, 'brandnew_tool', 'third'), true)
  assert.equal(after.allowNames.includes('asar_backup'), false, '该层 allow 应被清空')
  assert.equal(after.baseline.includes('asar_backup'), false, '该层应从 baseline 移除（重新未定型）')
  // 其他层不受影响
  assert.equal(isEffectivelyDenied(after, 'mcp__exa__web_search_exa', 'mcp'), true)
})

test('完全启用：显式禁用也要被推平，全部项一律启用', () => {
  const cfg = {
    ...STRICT,
    denyNames: ['asar_backup', 'brandnew_tool'],
    baseline: ['brandnew_tool'],
  }
  const names = ['asar_backup', 'brandnew_tool']
  const after = applyFullToggle(cfg, 'third', 'enabled', names)
  assert.equal(isEffectivelyDenied(after, 'asar_backup', 'third'), false)
  assert.equal(isEffectivelyDenied(after, 'brandnew_tool', 'third'), false)
  assert.equal(after.denyNames.includes('asar_backup'), false, '该层 deny 应被清空')
})

test('完全启用/禁用之后，单个开关照常有最高优先级（不会被压住）', () => {
  const names = ['asar_backup']
  const full = applyFullToggle(STRICT, 'third', 'enabled', names)
  assert.equal(isEffectivelyDenied(full, 'asar_backup', 'third'), false)
  // 再单独禁用这一个
  const one = applyDeny(full, 'asar_backup', true, 'third')
  assert.equal(isEffectivelyDenied(one, 'asar_backup', 'third'), true)
  // 再单独启用
  const two = applyDeny(one, 'asar_backup', false, 'third')
  assert.equal(isEffectivelyDenied(two, 'asar_backup', 'third'), false)
})

test('完全禁用上下文 / 完全启用上下文', () => {
  const contexts = ['memory:snapshot', 'sandbox:policy']
  const off = applyFullToggle({ ...STRICT, allowContexts: ['memory:snapshot'] }, 'context', 'disabled', contexts)
  assert.equal(contextEnabled(off, 'memory:snapshot'), false)
  assert.equal(contextEnabled(off, 'sandbox:policy'), false)
  const on = applyFullToggle({ ...STRICT, denyContexts: [...contexts] }, 'context', 'enabled', contexts)
  assert.equal(contextEnabled(on, 'memory:snapshot'), true)
  assert.equal(contextEnabled(on, 'sandbox:policy'), true)
})
