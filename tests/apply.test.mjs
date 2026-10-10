/**
 * apply.test.mjs —— host 装配时序的回归测试（node --test）。
 *
 * 覆盖的真实故障（2026-10-11 重启后）：
 *   「预设管理界面报 ⚠️ 无法连接 host API（/tool-manager/api）：
 *     SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON input」
 *   实测 `/tool-manager/api/tools` 返回 **404**，即路由压根没挂上。
 *
 * 根因：为了不让插件在无 HTTP 服务的 profile 里整体 pending，`inject` 被改成空数组；
 * 但 apply 因此会在 webServer 服务注册**之前**执行，此时 `ctx.get('webServer')`
 * 是 undefined，旧写法直接 return 跳过注册。正确做法是把注册动作放进
 * `ctx.inject(['webServer'], cb)` 的回调里 —— 本测试就是钉住这一点：
 * 服务在 apply 之后才就绪时，路由仍必须被注册。
 *
 * 运行: node --test tests/apply.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

/** 模拟 cordis 的 ctx：服务可按需「稍后就绪」，并记录 inject/effect/路由注册。 */
function makeHarness() {
  const state = {
    routes: [],
    registered: [],
    injects: [],
    logs: [],
    effects: [],
    response: null,
    pending: [],
  }
  const services = {}

  const mkCtx = () => ({
    get(name) {
      if (name === 'logger') {
        return { info: (m) => state.logs.push(m), warn: (m) => state.logs.push(m) }
      }
      return services[name]
    },
    inject(deps, cb) {
      state.injects.push(deps)
      if (deps.every((d) => services[d] !== undefined)) cb(mkCtx())
      else state.pending.push({ deps, cb })
    },
    effect(fn, label) { state.effects.push(label); return fn() },
    on() { return () => {} },
  })

  const flush = () => {
    for (const p of [...state.pending]) {
      if (p.deps.every((d) => services[d] !== undefined)) {
        state.pending.splice(state.pending.indexOf(p), 1)
        p.cb(mkCtx())
      }
    }
  }

  return {
    state,
    services,
    ctx: mkCtx(),
    /** 让某个服务「稍后就绪」，并触发等待它的 inject 回调。 */
    provide(name, impl) { services[name] = impl; flush() },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('webServer 在 apply 之后才就绪时,API 路由仍必须被注册(回归)', () => {
  const h = makeHarness()
  // apply 时一个服务都没就绪 —— 旧写法会在这里 return,路由永不挂载
  apply(h.ctx)
  assert.equal(h.state.routes.length, 0, 'apply 阶段不应立刻有路由（服务未就绪）')
  assert.ok(h.state.injects.some((d) => d.includes('webServer')), '应通过 ctx.inject 等待 webServer')

  // 现在 webServer 就绪
  h.provide('webServer', {
    register(route) { h.state.routes.push(route); return () => {} },
  })

  assert.equal(h.state.routes.length, 1, 'webServer 就绪后必须挂上 /tool-manager/api')
  assert.equal(h.state.routes[0].kind, 'prefix')
  assert.equal(h.state.routes[0].path, '/tool-manager/api')
  assert.ok(h.state.logs.some((m) => m.includes('API: /tool-manager/api')), '应打注册成功日志')
})

test('webServer 已就绪时(apply 之前就有)同样注册成功', () => {
  const h = makeHarness()
  h.services.webServer = { register(route) { h.state.routes.push(route); return () => {} } }
  apply(h.ctx)
  assert.equal(h.state.routes.length, 1)
})

test('完全没有 webServer 的 profile 不报错,也不影响预设注册', async () => {
  const h = makeHarness()
  apply(h.ctx)
  h.provide('agentPresets', {
    definitions: new Map(),
    register: async (def) => { h.state.registered.push(def); return async () => {} },
  })
  await tick()
  assert.equal(h.state.registered.length, 1, '预设注册不应依赖 webServer')
  assert.equal(h.state.registered[0].id, 'clean-agent')
  assert.equal(h.state.routes.length, 0, '无 webServer 时不应有路由')
})

test('provide 顺序颠倒(先 webServer 后 agentPresets)也都能装上', async () => {
  const h = makeHarness()
  apply(h.ctx)
  h.provide('webServer', { register(route) { h.state.routes.push(route); return () => {} } })
  h.provide('agentPresets', {
    definitions: new Map(),
    register: async (def) => { h.state.registered.push(def); return async () => {} },
  })
  await tick()
  assert.equal(h.state.routes.length, 1)
  assert.equal(h.state.registered.length, 1)
})

test('GET /tools 的 handler 返回合法 JSON(客户端不会再遇到空响应)', async () => {
  const h = makeHarness()
  h.provide('webServer', { register(route) { h.state.routes.push(route); return () => {} } })
  apply(h.ctx)
  const route = h.state.routes[0]

  const res = {
    writeHead(code, headers) { h.state.response = { code, headers } },
    end(body) { h.state.response = { ...h.state.response, body } },
  }
  await route.handler({ url: '/tool-manager/api/tools', method: 'GET' }, res)
  assert.equal(h.state.response.code, 200)
  const parsed = JSON.parse(h.state.response.body)
  assert.equal(parsed.ok, true)
  assert.equal(Array.isArray(parsed.tools), true)
  assert.ok(parsed.config, '应带 config')
})

test('未知子路径返回 404 JSON,而不是空响应体', async () => {
  const h = makeHarness()
  h.provide('webServer', { register(route) { h.state.routes.push(route); return () => {} } })
  apply(h.ctx)
  const route = h.state.routes[0]
  const res = {
    writeHead(code, headers) { h.state.response = { code, headers } },
    end(body) { h.state.response = { ...h.state.response, body } },
  }
  await route.handler({ url: '/tool-manager/api/nope', method: 'GET' }, res)
  assert.equal(h.state.response.code, 404)
  assert.equal(JSON.parse(h.state.response.body).ok, false)
})
