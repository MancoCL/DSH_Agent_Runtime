/**
 * 工具注册接线的测试。
 *
 * 为什么这个文件非有不可
 * ----------------------
 * 一次真实加载把**五个工具全丢了**：`registerTools` 的形参表里没有 `roleGuard`，而调用点传了它，
 * 于是在工厂调用那一行抛 `ReferenceError`，被同一个函数的 `catch` 收成 `scope_tool: failed`——
 * 插件照常加载、门禁照常生效、报告里也留了痕，只是没有任何 `gac_*` 工具。整套 910 条测试全绿，
 * 因为**没有一条走到「注册」这一段**：真路径要先从 `@deepseek-ai/dsh-tools` 解析出 `defineTool`，
 * 而临时 `DSH_HOME` 下那条解析必然失败（`test/prompt-wiring.test.js` 与
 * `test/workspace-witness.test.js` 都是这么跑的），于是它们只验到了提示段落与订阅。
 *
 * 所以这里给 `registerTools` 一个**注入 `defineTool` 的接缝**，让它能在没有 DSH 的机器上走完
 * 注册。断言的核心不是「函数返回了什么」，而是「五个工具真的都注册上了」——那正是线上丢掉的
 * 东西。同时验两件本仓库吃过亏的事：每个工具都必须声明 `output`（`gac_metrics` 曾漏掉它，而
 * 输出校验会拒绝整次调用），以及注册失败必须**如实**报出来而不是返回一份看起来正常的清单。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { registerTools } from '../lib/index.js'
import { EvidenceLog } from '../lib/evidence-store.js'
import { createGacCore } from '../lib/plugin.js'
import { ProjectState } from '../lib/project-state.js'
import { TaskStore } from '../lib/task-store.js'
import { EVIDENCE_TOOL_NAME } from '../lib/tool-evidence.js'
import { METRICS_TOOL_NAME } from '../lib/tool-metrics.js'
import { PROJECT_TOOL_NAME } from '../lib/tool-project.js'
import { SCOPE_TOOL_NAME } from '../lib/tool-scope.js'
import { TASK_TOOL_NAME } from '../lib/tool-task.js'

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 五个工具的名字，逐字取自各自的模块。 */
const ALL_TOOLS = [
  PROJECT_TOOL_NAME,
  SCOPE_TOOL_NAME,
  TASK_TOOL_NAME,
  METRICS_TOOL_NAME,
  EVIDENCE_TOOL_NAME,
]

/**
 * 一个已纳管的临时工程，外加一份够用的依赖包。
 *
 * @param {object} [options]
 * @param {boolean} [options.throwOnDefine]
 * @param {object} [options.roleGuard]
 * @returns {object}
 */
function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gac-register-'))
  scratchRoots.push(root)
  mkdirSync(join(root, '.dsh', 'gac'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'gac', 'project.json'),
    JSON.stringify({ project: { id: 'register-demo', title: 'Register demo' } }),
    'utf8',
  )

  const registered = []
  const defineTool = (spec) => {
    if (options.throwOnDefine === true) throw new Error('defineTool 炸了')
    registered.push(spec)
    return spec
  }
  const store = new TaskStore({ root })
  const evidence = new EvidenceLog({ root })
  const deps = {
    core: createGacCore({ resolveRoot: () => root }),
    state: new ProjectState({ resolveRoot: () => root }),
    claimStoreFor: () => undefined,
    taskStoreFor: () => store,
    evidenceLogFor: () => evidence,
    rootOf: () => root,
    adapterFor: () => ({
      capabilities: ['verification'],
      executors: { verification: ['verifier'] },
      execution: { revoke_shell_for_read_only_roles: false },
    }),
    executorsFor: () => [{
      name: 'verifier',
      supports: () => true,
      run: async () => ({ status: 'in_progress', summary: '等待会话执行' }),
    }],
    ...(options.roleGuard === undefined ? {} : { roleGuard: options.roleGuard }),
    ...(options.observationAvailableFor === undefined
      ? {}
      : { observationAvailableFor: options.observationAvailableFor }),
    ...(options.eventLogFor === undefined ? {} : { eventLogFor: options.eventLogFor }),
    defineTool,
  }
  const ctx = { tools: { register: () => {} } }
  return { root, store, deps, ctx, registered }
}

describe('注册接线：五个工具一个都不能少', () => {
  it('全部注册成功，并如实报出名字', async () => {
    // 这一条就是线上丢掉的那件事。它之所以能在这里断言，是因为 `defineTool` 可注入——真路径要
    // 先解析 DSH 包，而那条路径在测试环境里走不通。
    const h = harness()
    const outcome = await registerTools(h.ctx, h.deps)
    assert.equal(outcome.status, 'registered', `注册没成功：${outcome.note}`)
    assert.deepEqual([...outcome.tools], ALL_TOOLS)
    assert.deepEqual(h.registered.map((spec) => spec.name), ALL_TOOLS)
  })

  it('每一个都声明了 output —— 漏一个会让整次调用被输出校验拒绝', async () => {
    // `gac_metrics` 第一次加进来时漏了 `output`，五个工具一个都没注册上，而当时单测全绿。
    const h = harness()
    await registerTools(h.ctx, h.deps)
    for (const spec of h.registered) {
      assert.equal(typeof spec.output, 'object', `${spec.name} 必须声明 output`)
      assert.equal(typeof spec.output.schema, 'object', `${spec.name} 必须有 output.schema`)
      assert.equal(typeof spec.output.render, 'function', `${spec.name} 必须有 output.render`)
    }
  })

  it('observationAvailableFor 真的接到了 gac_metrics 上，而不是只出现在形参表里', async () => {
    // 活体踩到过：那个环境事实被转发给了 `gac_evidence`（两处注册的参数形状一样，改错了地方），
    // 于是指标说「观测源是否在场未被告知」——而当时单测全绿，因为那些单测直接造
    // `createMetricsTool`，测的是那个函数本身、不是这里的接线。这条用的是**注册进来的那一份**。
    const h = harness({ observationAvailableFor: () => false })
    await registerTools(h.ctx, h.deps)

    const metricsTool = h.registered.find((spec) => spec.name === METRICS_TOOL_NAME)
    assert.ok(metricsTool !== undefined, 'gac_metrics 必须注册上')
    const value = await metricsTool.execute({}, { agent: { session: { id: 'session-1' } } })

    assert.equal(value.evidence.witness.available, false, '观测源不在场这件事必须传到指标里')
    assert.match(value.summary, /工作区观测不可用/u)
  })

  it('eventLogFor 真的接到了 gac_task 上 —— `audit` 动作在真实插件里曾经抛「未定义」', async () => {
    // 活体踩到过：`gacEventLogFor` 定义在 `apply` 里、却在 `registerTools` 里被引用，于是
    // `audit` 动作在真实插件里抛 `gacEventLogFor is not defined`，而单测全绿——它们传的是假的
    // `eventLogFor`，接线断没断看不出来。这条用**注册进来的那一份**跑一次真实的 `audit`。
    const h = harness({ eventLogFor: () => ({ load: () => [] }) })
    await registerTools(h.ctx, h.deps)

    const taskTool = h.registered.find((spec) => spec.name === TASK_TOOL_NAME)
    await taskTool.execute({
      action: 'create',
      task_id: 'REQ-AUDIT',
      mode: 'standard_task',
      plan: {
        nodes: [{
          id: 'T1',
          objective: '实现',
          required_capabilities: ['implementation'],
          write_scope: ['src/'],
        }],
      },
    }, { agent: { session: { id: 'session-1' } } })

    const value = await taskTool.execute(
      { action: 'audit', task_id: 'REQ-AUDIT' },
      { agent: { session: { id: 'session-1' } } },
    )
    assert.equal(value.task_id, 'REQ-AUDIT')
    assert.equal(typeof value.message, 'string')
  })

  it('每个动作的返回字段都在 output.schema 里声明过 —— 这一类坑已经踩了三次', async () => {
    // 三次都是同一个形状：`plan_id`、`missing_capabilities`、以及 `audit` 的整份视图——返回里
    // 多了（或类型不符）一个字段，输出的 `additionalProperties: false` 就把**整次调用**拒掉，
    // 而单测全绿，因为测试用的是透传的 `defineTool`，不做输出校验。这条把「返回什么」与
    // 「声明了什么」在**同一个 spec** 上对起来，并按类型核对。
    const h = harness({
      observationAvailableFor: () => false,
      eventLogFor: () => ({ load: () => [] }),
    })
    await registerTools(h.ctx, h.deps)
    const taskTool = h.registered.find((spec) => spec.name === TASK_TOOL_NAME)
    const exec = { agent: { session: { id: 'session-1' } } }
    const declared = taskTool.output.schema.properties

    /** 递归核对：对象里每一个键都必须在声明里出现；数组元素按声明的 items 核。 */
    const assertDeclared = (value, schema, where) => {
      assert.equal(typeof value, 'object')
      for (const [key, entry] of Object.entries(value)) {
        const spec = schema[key]
        assert.ok(spec !== undefined, `${where} 的字段 ${key} 没有在 output.schema 里声明`)
        if (!Array.isArray(entry) || spec.items === undefined) continue
        for (const [index, item] of entry.entries()) {
          if (spec.items.type === 'string') {
            assert.equal(typeof item, 'string', `${where}.${key}[${index}] 应当是字符串`)
            continue
          }
          // 只有声明了具体形状的对象才继续往里核；`additionalProperties: true` 表示「形状任意」，
          // 那是有意的（审计视图里的节点状态、时间线就是这种），不该被这条测试挡住。
          if (spec.items.properties !== undefined) {
            assertDeclared(item, spec.items.properties, `${where}.${key}[${index}]`)
          }
        }
      }
    }

    await taskTool.execute({
      action: 'create',
      task_id: 'REQ-SCHEMA',
      mode: 'high_risk_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
          { id: 'T2', objective: '验证', depends_on: ['T1'], required_capabilities: ['verification'], write_scope: [] },
        ],
      },
    }, exec)

    const calls = [
      { action: 'status', task_id: 'REQ-SCHEMA' },
      { action: 'list' },
      { action: 'audit', task_id: 'REQ-SCHEMA' },
      { action: 'advance', task_id: 'REQ-SCHEMA' },
      { action: 'complete', task_id: 'REQ-SCHEMA', evidence: {} },
    ]
    for (const args of calls) {
      const value = await taskTool.execute(args, exec)
      assertDeclared(value, declared, `动作 ${args.action}`)
    }
  })

  it('任何一步抛错都如实报成 failed，而不是返回一份看起来正常的清单', async () => {
    const h = harness({ throwOnDefine: true })
    const outcome = await registerTools(h.ctx, h.deps)
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.note, /defineTool 炸了/u)
    assert.deepEqual(outcome.tools, [])
  })

  it('roleGuard 真的接到了 gac_task 上，而不是只出现在形参表里', async () => {
    // 这一条比「注册成功」更深一层：注册成功只说明没有抛错，而这里驱动一次真实的派遣，看收权
    // 请求有没有带着正确的只读节点到达。接线断掉时它会是空的——正是那次线上事故的形状。
    const syncs = []
    const h = harness({ roleGuard: { sync: (input) => syncs.push(input) } })
    const outcome = await registerTools(h.ctx, h.deps)
    assert.equal(outcome.status, 'registered')

    const taskTool = h.registered.find((spec) => spec.name === TASK_TOOL_NAME)
    const exec = { agent: { session: { id: 'session-1' } } }
    await taskTool.execute({
      action: 'create',
      task_id: 'REQ-REG',
      mode: 'standard_task',
      plan: {
        nodes: [{
          id: 'T1',
          objective: '独立验证',
          required_capabilities: ['verification'],
          write_scope: [],
        }],
      },
    }, exec)
    await taskTool.execute({ action: 'advance', task_id: 'REQ-REG' }, exec)

    assert.ok(syncs.length > 0, '派遣之后应当有一次收权重算')
    assert.deepEqual(syncs.at(-1).readOnlyNodes, ['T1'])
    assert.equal(syncs.at(-1).sessionId, 'session-1')
  })
})
