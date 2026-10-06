/**
 * 原生子会话的模型路由：按**语义角色**把子会话送到指定的 provider / 模型 / 推理档位。
 *
 * 为什么需要第二套键空间
 * --------------------
 * 适配器里原有的 `execution.provider_routes` 按**执行者名**作键，只作用于进程内执行者。而原生子会话
 * 路径上**只有一个执行者**（`child:spawn`）覆盖全部节点——按执行者名根本区分不出「验证者跑在另一个
 * 模型上」。能区分它们的只有角色：设计、实现、验证执行、复核各自要的模型与推理档位不同。
 *
 * 这个文件钉住三件最容易出的事：**名字翻译**（适配器是 snake_case，宿主收 camelCase，翻错的表现是
 * 「配置写了但毫无效果」）、**空路由与无路由的区别**（无路由是继承父会话，而传一个空对象会把父会话
 * 的模型一起清掉）、以及**角色键的词表校验**（拼错的角色名必须在读适配器时就被拒，而不是派遣时静默
 * 不生效）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  agentOptionsFor,
  buildChildPersona,
  createChildExecutor,
  describeRoute,
} from '../lib/child-executor.js'
import { roleRouteFor } from '../lib/index.js'
import { ProjectAdapterError, validateProjectAdapter } from '../lib/project.js'

/**
 * 造一个最小适配器。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function adapter(overrides = {}) {
  return validateProjectAdapter({
    schema_version: 1,
    project: { id: 'demo', title: '演示工程' },
    capabilities: ['implementation', 'verification', 'review'],
    executors: { implementation: ['builder'], verification: ['verifier'], review: ['reviewer'] },
    risk: { high_risk_paths: [], default_level: 'low' },
    execution: { native_child_dispatch: true, ...overrides },
  }, '<test>')
}

describe('角色路由：配置怎么翻成宿主的 AgentOptions', () => {
  it('snake_case 翻成宿主收的 camelCase（翻错就是「配置写了但没效果」）', () => {
    assert.deepEqual(
      agentOptionsFor({ provider: 'spawn', model: 'm-1', reasoning_effort: 'high', max_tokens: 4096 }),
      { provider: 'spawn', model: 'm-1', reasoningEffort: 'high', maxTokens: 4096 },
    )
  })

  it('只写一部分也能用（其余继承父会话）', () => {
    assert.deepEqual(agentOptionsFor({ model: 'm-1' }), { model: 'm-1' })
  })

  it('空路由返回 undefined —— 那是「继承」，而空对象会把父会话的模型一起清掉', () => {
    assert.equal(agentOptionsFor(undefined), undefined)
    assert.equal(agentOptionsFor(null), undefined)
    assert.equal(agentOptionsFor({}), undefined)
    assert.equal(agentOptionsFor({ model: '' }), undefined)
    assert.equal(agentOptionsFor({ max_tokens: 0 }), undefined)
    assert.equal(agentOptionsFor({ max_tokens: -1 }), undefined)
  })

  it('给人看的那一行把路由说清楚', () => {
    assert.equal(describeRoute(undefined, undefined), '')
    assert.match(describeRoute({ model: 'm-1' }, undefined), /路由 m-1/u)
    assert.match(describeRoute(agentOptionsFor({ provider: 'p', model: 'm', reasoning_effort: 'high' }), undefined), /路由 p\/m\/推理 high/u)
  })
})

describe('角色路由：从适配器取哪一条', () => {
  it('按角色精确匹配', () => {
    const loaded = adapter({ role_routes: { review: { model: 'strong' }, '*': { model: 'cheap' } } })
    assert.deepEqual({ ...roleRouteFor(loaded, 'review') }, { model: 'strong' })
    assert.deepEqual({ ...roleRouteFor(loaded, 'implementation') }, { model: 'cheap' })
  })

  it('没有精确匹配也没有 `*` 时返回 undefined（继承父会话）', () => {
    const loaded = adapter({ role_routes: { review: { model: 'strong' } } })
    assert.equal(roleRouteFor(loaded, 'implementation'), undefined)
    assert.equal(roleRouteFor(adapter(), 'review'), undefined)
  })

  it('适配器校验时就把拼错的角色名拒掉，而不是派遣时静默不生效', () => {
    assert.throws(
      () => adapter({ role_routes: { verifier: { model: 'm' } } }),
      (error) => error instanceof ProjectAdapterError && /role_routes/u.test(error.message),
    )
  })

  it('字段类型不对也在读适配器时被拒', () => {
    assert.throws(() => adapter({ role_routes: { review: { model: '' } } }), ProjectAdapterError)
    assert.throws(() => adapter({ role_routes: { review: { max_tokens: 1.5 } } }), ProjectAdapterError)
    assert.throws(() => adapter({ role_routes: { review: { max_tokens: 0 } } }), ProjectAdapterError)
    assert.throws(() => adapter({ role_routes: { review: 'strong' } }), ProjectAdapterError)
    assert.throws(() => adapter({ role_routes: ['review'] }), ProjectAdapterError)
  })

  it('读出来的路由是冻结的（配置不该在运行中被改）', () => {
    const loaded = adapter({ role_routes: { review: { model: 'm' } } })
    assert.equal(Object.isFrozen(loaded.execution.role_routes.review), true)
    assert.throws(() => { loaded.execution.role_routes.review.model = 'x' }, TypeError)
  })
})

describe('角色路由：真的传到了子会话创建请求上', () => {
  /**
   * 一个只记录请求的假 subagents 服务。
   *
   * @param {object} captured
   * @returns {object}
   */
  function fakeSubagents(captured) {
    return {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      start: async (_provider, request) => {
        captured.request = request
        return {
          id: 'child-route-1',
          result: Promise.resolve({
            stopReason: 'completed',
            structured: { status: 'completed', summary: '做完了' },
          }),
          dispose: async () => {},
        }
      },
    }
  }

  /**
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async function runWith({ route } = {}) {
    const captured = {}
    const executor = createChildExecutor({
      subagentsFor: () => fakeSubagents(captured),
      routeFor: route === undefined ? undefined : () => route,
    })
    const outcome = await executor.run({
      node: {
        id: 'V1',
        role: 'verification_execution',
        objective: '执行验证',
        required_capabilities: ['verification'],
        write_scope: [],
        depends_on: [],
        expected_artifacts: [],
        execution: { attempt: 1 },
      },
      task: { task_id: 'REQ-1', mode: 'high_risk_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-1-V1-A1',
      agent: { id: 'agent-1', session: { id: 'parent-session', header: { delegationDepth: 0 } } },
      signal: new AbortController().signal,
    })
    return { captured, outcome }
  }

  it('声明了角色路由 → 请求里带 agentOptions，且返回文本里看得见', async () => {
    const { captured, outcome } = await runWith({
      route: { provider: 'spawn', model: 'strong', reasoning_effort: 'high' },
    })

    assert.deepEqual(captured.request.agentOptions, {
      provider: 'spawn',
      model: 'strong',
      reasoningEffort: 'high',
    })
    assert.match(outcome.detail, /路由 spawn\/strong\/推理 high/u)
    // 提示词与人设都不该被路由改动。
    assert.match(buildChildPersona({ write_scope: [] }), /你是 GAC 运行时派出的一个执行者/u)
  })

  it('没有声明角色路由 → 请求里**没有** agentOptions 这个键（继承父会话）', async () => {
    const { captured } = await runWith({})

    assert.equal('agentOptions' in captured.request, false)
  })

  it('路由为空对象时同样不带这个键 —— 空对象会清掉父会话的模型', async () => {
    const { captured } = await runWith({ route: {} })

    assert.equal('agentOptions' in captured.request, false)
  })

  it('子会话没回结构化产出时，失败**原因**（宿主的 diagnostic）要进返回文本', async () => {
    // 活体验收实测：路由值把宿主没注册的 provider 送了进去，宿主回 `NO_ADAPTER`，而返回文本里
    // 只有「结论 failed」——失败原文只活在子会话日志里，父会话读不到。原因正是它最需要的东西。
    const captured = {}
    const executor = createChildExecutor({
      subagentsFor: () => ({
        list: () => ['spawn'],
        getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
        start: async (_provider, request) => {
          captured.request = request
          return {
            id: 'child-route-2',
            result: Promise.resolve({
              stopReason: 'error',
              diagnostic: 'no adapter registered for provider "spawn"',
            }),
            dispose: async () => {},
          }
        },
      }),
      routeFor: () => ({ provider: 'spawn' }),
    })
    const outcome = await executor.run({
      node: {
        id: 'V1',
        role: 'verification_execution',
        objective: '执行验证',
        required_capabilities: ['verification'],
        write_scope: [],
        depends_on: [],
        expected_artifacts: [],
        execution: { attempt: 1 },
      },
      task: { task_id: 'REQ-1', mode: 'high_risk_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-1-V1-A1',
      agent: { id: 'agent-1', session: { id: 'parent-session', header: { delegationDepth: 0 } } },
      signal: new AbortController().signal,
    })

    assert.equal(outcome.status, 'failed')
    assert.match(outcome.detail, /no adapter registered for provider/u)
    assert.match(outcome.detail, /路由 spawn/u, '失败时路由同样要看得见')
  })
})
