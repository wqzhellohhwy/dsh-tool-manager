/**
 * decide.test.mjs —— dsh-tool-manager 判定逻辑的回归测试(node --test)。
 *
 * 覆盖的真实故障(2026-10-11):
 *   「在预设工具管理里单独启用某个工具,它却依然用不了」——
 *   client 的 needsAllowExemption 只查 mcp__ 与 DEFAULT_THIRD_PREFIXES,
 *   漏了 THIRD_PREFIXES 里不在 DEFAULT 的那些前缀(anysearch_ / asar_ / dev_mode_)
 *   和用户自定义 denyPrefixes,于是「启用」只从 denyNames 移除、不写 allowNames,
 *   工具继续被 newDefault.third 兜底屏蔽。
 *
 * 运行: node --test tests/decide.test.mjs   (需先 npm run build:client 产出 lib/decide.mjs)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  DEFAULT_THIRD_PREFIXES,
  EMPTY_CONFIG,
  THIRD_PREFIXES,
  applyContextDeny,
  applyDeny,
  contextEnabled,
  isEffectivelyDenied,
  needsAllowExemption,
} from '../lib/decide.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 纯净预设的典型配置:新增锁定全 disabled(= 未列名一律默认屏蔽)。 */
const STRICT = {
  ...EMPTY_CONFIG,
  newDefault: { context: 'disabled', third: 'disabled', mcp: 'disabled' },
}

/** 旧实现的补写规则(用于证明本测试确实有区分力,而不是恒真)。
 *  这里刻意**硬编码**修复前的名单,不引用新常量 —— 否则 asar_ 加进
 *  DEFAULT_THIRD_PREFIXES 之后对照就失去意义了。 */
const LEGACY_DEFAULT_THIRD_PREFIXES = [
  'dev_', 'memory', 'dtodo', 'skill_manage', 'undo_', 'redteam_',
  'ssh_', 'context_audit', 'describe_image', 'de_', 'file_mount_forget',
  'mcp_connector_',
]
const legacyNeedsAllowExemption = (name) =>
  name.startsWith('mcp__') || LEGACY_DEFAULT_THIRD_PREFIXES.some((p) => name.startsWith(p))

// ── 1. 核心回归:第三方工具「启用」后必须真的可用 ────────────────────────────
test('单独启用第三方工具后,它必须不再被屏蔽(修复前 anysearch_/asar_ 等会失败)', () => {
  const samples = [
    ...THIRD_PREFIXES.map((p) => p + 'sample'),
    'mcp__demo__tool',
  ]
  for (const name of samples) {
    // 默认状态:被屏蔽
    assert.equal(isEffectivelyDenied(STRICT, name), true, `默认应屏蔽 ${name}`)
    // 点「启用」
    const enabled = applyDeny(STRICT, name, false)
    assert.equal(
      isEffectivelyDenied(enabled, name), false,
      `启用后仍被屏蔽: ${name} -> allowNames=${JSON.stringify(enabled.allowNames)}`,
    )
    // 再点「禁用」应回到屏蔽态
    const denied = applyDeny(enabled, name, true)
    assert.equal(isEffectivelyDenied(denied, name), true, `禁用后应屏蔽 ${name}`)
    // 双向清理:不留 allowNames 残留
    assert.equal(denied.allowNames.includes(name), false, `禁用后 allowNames 不应残留 ${name}`)
  }
})

test('对照:旧版补写规则确实修不好这些工具(证明本用例有区分力)', () => {
  // asar_*:2026-10-11 之前既不在旧 DEFAULT 名单里,也不被旧规则补 allowNames
  // anysearch_*:一直只在 THIRD_PREFIXES(兜底)里,从不在旧 DEFAULT 里
  // 注:dev_mode_* 虽然也不在旧 DEFAULT 里,但被 'dev_' 前缀覆盖,旧规则同样能修好,
  //     所以不作为对照样本。
  const broken = ['anysearch_probe', 'asar_backup']
  for (const name of broken) {
    // 旧规则:只有 mcp__ 与 LEGACY_DEFAULT_THIRD_PREFIXES 命中才补 allowNames
    const legacyEnabled = legacyNeedsAllowExemption(name)
      ? { ...STRICT, allowNames: [name] }
      : { ...STRICT }
    // 对这两个名字,旧规则不会补 allowNames ⇒ 依然被判禁
    assert.equal(legacyNeedsAllowExemption(name), false, `${name} 不应命中旧规则`)
    assert.equal(isEffectivelyDenied(legacyEnabled, name), true, `${name} 旧实现下应仍被屏蔽`)
    // 而修复后的实现能修好它们
    assert.equal(isEffectivelyDenied(applyDeny(STRICT, name, false), name), false,
      `${name} 修复后应可单独启用`)
  }
})

// ── 2. 用户自定义 denyPrefixes 的工具也必须能单独启用 ───────────────────────
test('命中用户自定义 denyPrefixes 的工具,启用后必须可用', () => {
  const cfg = { ...STRICT, denyPrefixes: ['zz_'] }
  const name = 'zz_custom_tool'
  assert.equal(isEffectivelyDenied(cfg, name), true)
  assert.equal(needsAllowExemption(cfg, name), true, '应因 denyPrefixes 命中而补写 allowNames')
  const enabled = applyDeny(cfg, name, false)
  assert.equal(isEffectivelyDenied(enabled, name), false)
})

test('名单内的普通工具(不在任何兜底前缀里)启用后同样可用', () => {
  const name = 'glob'
  const denied = applyDeny(STRICT, name, true)
  assert.equal(isEffectivelyDenied(denied, name), true)
  const enabled = applyDeny(denied, name, false)
  assert.equal(isEffectivelyDenied(enabled, name), false)
})

// ── 3. allowNames 优先级最高 ────────────────────────────────────────────────
test('allowNames 压过一切屏蔽规则', () => {
  const cfg = {
    ...STRICT,
    denyNames: ['memory'],
    denyPrefixes: ['memory'],
    newDefault: { context: 'disabled', third: 'disabled', mcp: 'disabled' },
    allowNames: ['memory'],
  }
  assert.equal(isEffectivelyDenied(cfg, 'memory'), false)
})

// ── 4. 上下文启停 ──────────────────────────────────────────────────────────
test('上下文:显式启用 > 显式禁用 > 新增锁定默认', () => {
  const ctx = 'memory:snapshot'
  // 新增锁定 disabled ⇒ 未列名默认不启用
  assert.equal(contextEnabled(STRICT, ctx), false)
  // 点「启用」
  const on = applyContextDeny(STRICT, ctx, false)
  assert.deepEqual(on.allowContexts, [ctx])
  assert.deepEqual(on.denyContexts, [])
  assert.equal(contextEnabled(on, ctx), true)
  // 点「禁用」:双向清理
  const off = applyContextDeny(on, ctx, true)
  assert.deepEqual(off.allowContexts, [])
  assert.deepEqual(off.denyContexts, [ctx])
  assert.equal(contextEnabled(off, ctx), false)
  // 新增锁定 enabled 时,未列名默认启用
  const loose = { ...STRICT, newDefault: { context: 'enabled', third: 'enabled', mcp: 'enabled' } }
  assert.equal(contextEnabled(loose, 'x:unknown'), true)
})

test('上下文分组启停:全部启用/全部禁用', () => {
  const names = ['a:one', 'b:two']
  const allOn = { ...STRICT, denyContexts: [], allowContexts: [...names] }
  const allOff = { ...STRICT, denyContexts: [...names], allowContexts: [] }
  for (const n of names) {
    assert.equal(contextEnabled(allOn, n), true)
    assert.equal(contextEnabled(allOff, n), false)
  }
})

// ── 5. 与插件自带的过滤器常量保持一致(防止两处名单漂移)───────────────────
test('client 前缀表与 src/preset-filter.ts 的名单一致', () => {
  // 过滤器随本插件发布(src/preset-filter.ts → lib/preset-filter.js)，因此比对
  // 仓库内的源文件，而不是某个 profile 目录下的副本。
  const filterPath = process.env.TM_FILTER_PATH
    || join(here, '..', 'src', 'preset-filter.ts')
  const src = readFileSync(filterPath, 'utf8')

  const pick = (constName) => {
    const m = new RegExp(`const ${constName} = \\[([^\\]]*)\\]`).exec(src)
    assert.ok(m, `未能在 ${filterPath} 找到 ${constName}`)
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }

  assert.deepEqual(DEFAULT_THIRD_PREFIXES, pick('DEFAULT_DENY_PREFIXES'),
    'client DEFAULT_THIRD_PREFIXES 必须与 preset-filter DEFAULT_DENY_PREFIXES 完全一致')
  assert.deepEqual(THIRD_PREFIXES, pick('THIRD_PREFIXES'),
    'client THIRD_PREFIXES 必须与 preset-filter THIRD_PREFIXES 完全一致')
})
