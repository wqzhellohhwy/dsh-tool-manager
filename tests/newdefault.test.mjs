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
  applyNewDefault,
  contextEnabled,
  filterNames,
  isEffectivelyDenied,
  modeOf,
  needsAllowExemption,
  setLayerMode,
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

// ── ⑤ 层模式（启用模式 / 禁用模式 / 新增，三选一互斥）────────────────────────
test('禁用模式：持续压制该层显式启用，全部项一律禁用', () => {
  const cfg = {
    ...STRICT,
    baseline: ['asar_backup'],
    allowNames: ['asar_backup'],            // 显式启用也要被模式压住
    denyNames: ['mcp__exa__web_search_exa'],
  }
  const after = setLayerMode(cfg, 'third', 'off')
  assert.equal(isEffectivelyDenied(after, 'asar_backup', 'third'), true)
  assert.equal(isEffectivelyDenied(after, 'brandnew_tool', 'third'), true)
  // 模式不动名单：退出后原设置原封不动
  assert.ok(after.allowNames.includes('asar_backup'), '模式不应清空名单')
  assert.ok(after.baseline.includes('asar_backup'), '模式不应改动 baseline')
  // 其他层不受影响
  assert.equal(isEffectivelyDenied(after, 'mcp__exa__web_search_exa', 'mcp'), true)
})

test('启用模式：持续压制该层显式禁用，全部项一律启用', () => {
  const cfg = {
    ...STRICT,
    denyNames: ['asar_backup', 'brandnew_tool'],
    baseline: ['brandnew_tool'],
  }
  const after = setLayerMode(cfg, 'third', 'on')
  assert.equal(isEffectivelyDenied(after, 'asar_backup', 'third'), false)
  assert.equal(isEffectivelyDenied(after, 'brandnew_tool', 'third'), false)
  assert.ok(after.denyNames.includes('asar_backup'), '模式不应清空名单')
})

test('退出模式（回到新增）后，原有名单恢复生效', () => {
  const cfg = { ...STRICT, denyNames: ['asar_backup'] }
  const off = setLayerMode(cfg, 'third', 'off')
  assert.equal(isEffectivelyDenied(off, 'asar_backup', 'third'), true)
  const back = setLayerMode(off, 'third', 'new')
  assert.equal(isEffectivelyDenied(back, 'asar_backup', 'third'), true, '名单里的禁用仍生效')
  const on = setLayerMode({ ...STRICT, denyNames: ['asar_backup'] }, 'third', 'on')
  assert.equal(isEffectivelyDenied(on, 'asar_backup', 'third'), false, '启用模式压住显式禁用')
  const back2 = setLayerMode(on, 'third', 'new')
  assert.equal(isEffectivelyDenied(back2, 'asar_backup', 'third'), true, '退出启用模式后显式禁用恢复')
})

test('三种模式互斥：设置任何一个都会让另外两个退出', () => {
  let cfg = setLayerMode(STRICT, 'mcp', 'on')
  assert.equal(modeOf(cfg, 'mcp'), 'on')
  cfg = setLayerMode(cfg, 'mcp', 'off')
  assert.equal(modeOf(cfg, 'mcp'), 'off')
  assert.notEqual(modeOf(cfg, 'mcp'), 'on')
  // 点「新增X用」把该层切回 new
  cfg = applyNewDefault(cfg, 'mcp', 'disabled', [], () => false)
  assert.equal(modeOf(cfg, 'mcp'), 'new')
  // 其他层不受影响
  assert.equal(modeOf(cfg, 'third'), 'new')
  assert.equal(modeOf(cfg, 'context'), 'new')
})

test('旧配置没有 mode 字段 ⇒ 按新增模式处理，不崩', () => {
  const legacy = { ...STRICT }
  delete legacy.mode
  assert.equal(modeOf(legacy, 'third'), 'new')
  assert.equal(isEffectivelyDenied(legacy, 'asar_backup', 'third'), true)
  assert.equal(contextEnabled(legacy, 'memory:snapshot'), false)
})

test('模式对上下文同样生效（启用模式全注入 / 禁用模式全不注入）', () => {
  const contexts = ['memory:snapshot', 'sandbox:policy']
  const off = setLayerMode({ ...STRICT, allowContexts: ['memory:snapshot'] }, 'context', 'off')
  assert.equal(contextEnabled(off, 'memory:snapshot'), false)
  assert.equal(contextEnabled(off, 'sandbox:policy'), false)
  const on = setLayerMode({ ...STRICT, denyContexts: [...contexts] }, 'context', 'on')
  assert.equal(contextEnabled(on, 'memory:snapshot'), true)
  assert.equal(contextEnabled(on, 'sandbox:policy'), true)
})

test('模式生效期间不补写 allowNames（写了也不会生效）', () => {
  const off = setLayerMode({ ...STRICT, denyNames: ['brandnew_tool'] }, 'third', 'off')
  assert.equal(needsAllowExemption(off, 'brandnew_tool', 'third'), false)
  const on = setLayerMode(STRICT, 'third', 'on')
  assert.equal(needsAllowExemption(on, 'brandnew_tool', 'third'), false)
  // 回到新增模式后，才需要按兜底补写
  const back = setLayerMode(off, 'third', 'new')
  assert.equal(needsAllowExemption(back, 'brandnew_tool', 'third'), true)
})
