/**
 * configs.test.mjs —— 命名配置（保存 / 覆盖保存 / 启用）的回归测试。
 *
 * 覆盖本轮新增的「保存到已有配置」：
 *   把当前六个名单**覆盖**写入已选中的那个命名配置 —— 不新建、不改名、
 *   不动其它配置，只更新目标项的 state 与 savedAt。
 *
 * 另外钉住一条容易出错的边界：命名配置**只**存六个名单；
 * `mode`（模式）/ `newDefault`（新增策略）/ `baseline`（定型状态）属于"策略"，
 * 切换或覆盖保存配置时都不应被写进配置、也不应被配置覆盖。
 *
 * 运行: node --test tests/configs.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_CONFIG,
  addSavedConfig,
  overwriteSavedConfig,
  snapshotOf,
} from '../lib/decide.mjs'

const baseCfg = () => ({
  ...EMPTY_CONFIG,
  denyNames: ['a'],
  allowNames: ['b'],
  denyContexts: ['ctx:one'],
  newDefault: { context: 'disabled', third: 'disabled', mcp: 'disabled' },
  mode: { context: 'off', third: 'new', mcp: 'new' },
  baseline: ['a', 'b'],
  configs: [],
})

test('snapshotOf 只抽六个名单，不含 mode / newDefault / baseline', () => {
  const state = snapshotOf(baseCfg())
  assert.deepEqual(Object.keys(state).sort(), [
    'allowContexts', 'allowNames', 'allowPrefixes',
    'denyContexts', 'denyNames', 'denyPrefixes',
  ])
  assert.deepEqual(state.denyNames, ['a'])
  assert.deepEqual(state.allowNames, ['b'])
  assert.deepEqual(state.denyContexts, ['ctx:one'])
  // 深拷贝：改快照不影响原配置
  state.denyNames.push('zzz')
  assert.deepEqual(baseCfg().denyNames, ['a'])
})

test('addSavedConfig：新建配置并写入当前名单', () => {
  const after = addSavedConfig(baseCfg(), 'cfg-1', '极简', '2026-10-11T00:00:00.000Z')
  assert.equal(after.configs.length, 1)
  const saved = after.configs[0]
  assert.equal(saved.id, 'cfg-1')
  assert.equal(saved.name, '极简')
  assert.equal(saved.savedAt, '2026-10-11T00:00:00.000Z')
  assert.deepEqual(saved.state.denyNames, ['a'])
  assert.equal('mode' in saved, false, '配置里不应有 mode')
  assert.equal('newDefault' in saved, false, '配置里不应有 newDefault')
  assert.equal('baseline' in saved, false, '配置里不应有 baseline')
})

test('overwriteSavedConfig：覆盖保存只改目标配置的 state 与 savedAt', () => {
  let cfg = addSavedConfig(baseCfg(), 'cfg-1', '甲', '2026-10-11T00:00:00.000Z')
  cfg = addSavedConfig(cfg, 'cfg-2', '乙', '2026-10-11T00:00:00.000Z')
  // 改点当前状态，然后把「乙」覆盖掉
  cfg = { ...cfg, denyNames: ['x', 'y'], allowContexts: ['ctx:two'] }
  const after = overwriteSavedConfig(cfg, 'cfg-2', '2026-10-11T12:00:00.000Z')

  assert.equal(after.configs.length, 2, '不应新建配置')
  const first = after.configs.find((c) => c.id === 'cfg-1')
  const second = after.configs.find((c) => c.id === 'cfg-2')
  assert.deepEqual(first.state.denyNames, ['a'], '其它配置必须原封不动')
  assert.equal(first.savedAt, '2026-10-11T00:00:00.000Z', '其它配置的时间戳不变')
  assert.deepEqual(second.state.denyNames, ['x', 'y'], '目标配置写入当前名单')
  assert.deepEqual(second.state.allowContexts, ['ctx:two'])
  assert.equal(second.savedAt, '2026-10-11T12:00:00.000Z', '目标配置时间戳更新')
  assert.equal(second.name, '乙', '不应改名')
  assert.equal(second.id, 'cfg-2', 'id 不变')
})

test('overwriteSavedConfig：id 不存在时原样返回（不误建/不误删）', () => {
  const cfg = addSavedConfig(baseCfg(), 'cfg-1', '甲', '2026-10-11T00:00:00.000Z')
  const after = overwriteSavedConfig(cfg, 'nope', '2026-10-11T12:00:00.000Z')
  assert.deepEqual(after.configs, cfg.configs)
})

test('覆盖保存后再「启用」该配置，能还原当时的名单', () => {
  let cfg = addSavedConfig(baseCfg(), 'cfg-1', '甲', 't0')
  // 当前状态变了一批
  cfg = { ...cfg, denyNames: ['p', 'q'], allowNames: [], denyContexts: ['ctx:z'] }
  cfg = overwriteSavedConfig(cfg, 'cfg-1', 't1')
  // 再乱改当前状态
  cfg = { ...cfg, denyNames: [], allowNames: ['p'], denyContexts: [] }
  // 启用配置 = 把 saved.state 灌回当前配置
  const saved = cfg.configs.find((c) => c.id === 'cfg-1')
  const restored = { ...cfg, ...saved.state }
  assert.deepEqual(restored.denyNames, ['p', 'q'])
  assert.deepEqual(restored.allowNames, [])
  assert.deepEqual(restored.denyContexts, ['ctx:z'])
})

test('覆盖保存不影响模式 / 新增策略 / 定型状态（它们不在配置里）', () => {
  let cfg = addSavedConfig(baseCfg(), 'cfg-1', '甲', 't0')
  cfg = overwriteSavedConfig(cfg, 'cfg-1', 't1')
  assert.deepEqual(cfg.mode, { context: 'off', third: 'new', mcp: 'new' })
  assert.deepEqual(cfg.newDefault, { context: 'disabled', third: 'disabled', mcp: 'disabled' })
  assert.deepEqual(cfg.baseline, ['a', 'b'])
})
