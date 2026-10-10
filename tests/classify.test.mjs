/**
 * classify.test.mjs —— 工具来源分类的回归测试(node --test)。
 *
 * 覆盖的真实故障(2026-10-11 用户报告):
 *   「asar_ 开头的工具明明是 dsh-asar-patcher 的工具,却被归类为 DSH 原生工具」。
 *   旧 classify() 用「硬编码第三方前缀 + 兜底归 native」,任何没被列举的新插件
 *   工具都会显示成「原生 / 默认启用」,而纯净预设本该默认屏蔽它们 ——
 *   分类错误的方向恰好是「漏屏蔽」。
 *
 * 另一条被反复质疑、这里用源码证据钉死的结论:
 *   list_mcp_resources / list_mcp_resource_templates / read_mcp_resource
 *   **不是** dsh-mcp-connector 插件的工具,而是 DSH 官方包
 *   @deepseek-ai/dsh-mcp-resources 注册的三个「共享资源工具」
 *   (app.asar 内 registerResourceTools() 源码 + 官方文档 "The three shared
 *    resource tools");dsh-mcp-connector 注册的是 mcp_connector_* 一族。
 *
 * 运行: node --test tests/classify.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { NATIVE_HOST_TOOLS, classify } from '../lib/index.js'

test('dsh-asar-patcher 的 6 个 asar_* 工具归 third(不再冒充 native)', () => {
  const tools = ['asar_backup', 'asar_entries', 'asar_info', 'asar_read', 'asar_restore', 'asar_splice']
  for (const n of tools) {
    assert.equal(classify(n), 'third', `${n} 应归 third`)
  }
  // 依据:它们由 C:/Users/53518/dsh-plugins/dsh-asar-patcher 的 lib/tools.js
  // 通过 defineTool({name:'asar_*'}) 注册,app.asar 内 0 命中 —— 非 DSH 官方。
  for (const n of tools) assert.equal(NATIVE_HOST_TOOLS.has(n), false)
})

test('DSH 官方宿主工具归 native(三个 MCP 共享资源工具 + workspace dependencies)', () => {
  const official = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'load_workspace_dependencies']
  for (const n of official) {
    assert.equal(classify(n), 'native', `${n} 应归 native`)
    assert.equal(NATIVE_HOST_TOOLS.has(n), true)
  }
})

test('三个 MCP 共享资源工具不是 mcp 前缀工具,也不属于 mcp 连接器', () => {
  for (const n of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
    assert.equal(n.startsWith('mcp__'), false, `${n} 不带 mcp__ 前缀`)
    assert.equal(n.startsWith('mcp_connector_'), false, `${n} 不是 dsh-mcp-connector 的工具`)
    assert.equal(classify(n), 'native')
  }
})

test('mcp__ 前缀的工具归 mcp', () => {
  assert.equal(classify('mcp__exa__web_search_exa'), 'mcp')
  assert.equal(classify('mcp__tavily__tavily_search'), 'mcp')
})

test('dsh-mcp-connector 的 mcp_connector_* 归 third(不因含 mcp 字样而误判)', () => {
  for (const n of ['mcp_connector_catalog', 'mcp_connector_status', 'mcp_connector_connect']) {
    assert.equal(classify(n), 'third', `${n} 应归 third`)
  }
})

test('未知名字兜底归 third(宁可默认屏蔽,也不默认放行)', () => {
  for (const n of ['brand_new_plugin_tool', 'whatever_tool', 'zzz']) {
    assert.equal(classify(n), 'third', `${n} 应兜底归 third`)
  }
})

test('已知第三方插件工具仍归 third', () => {
  const third = [
    'dev_inject_plugin', 'memory', 'dtodo', 'skill_manage', 'de_channel_send',
    'undo_snapshot', 'redteam_run', 'ssh_exec', 'context_audit', 'describe_image',
    'file_mount_forget', 'anysearch_search',
  ]
  for (const n of third) assert.equal(classify(n), 'third', `${n} 应归 third`)
})
