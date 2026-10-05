/**
 * `gac_task` 工具测试。
 *
 * 这里最要紧的一条是接口层能不能守住协调器的核心保证：**执行者不宣告完成**。所以测试
 * 不只检查「回报后被接受」，更要检查「没带执行身份的回报不会推进状态」——那是这条
 * 保证在工具边界上唯一的落点。
 *
 * `defineTool` 用恒等替身：本套件测的是工具自身行为，运行时那套参数校验另有专门测试。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { TaskStore } from '../lib/task-store.js'
import { TASK_TOOL_NAME, createTaskTool, taskToolOptions } from '../lib/tool-task.js'

const identityDefineTool = (options) => options

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时项目根，套件结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-task-tool-'))
  scratchRoots.push(root)
  return root
}

/** 一份两节点的标准计划：实现随后验证。 */
function standardPlan() {
  return {
    nodes: [
      {
        id: 'T1',
        objective: '实现功能',
        required_capabilities: ['implementation'],
        write_scope: ['src/'],
      },
      {
        id: 'T2',
        objective: '独立验证',
        depends_on: ['T1'],
        required_capabilities: ['verification'],
        write_scope: [],
      },
    ],
  }
}

/**
 * 一个接在临时项目上的工具实例。
 *
 * @returns {{tool: object, store: TaskStore, exec: object}}
 */
function harness() {
  const store = new TaskStore({ root: scratch() })
  const tool = createTaskTool({
    defineTool: identityDefineTool,
    taskStoreFor: () => store,
    sessionRootFor: () => store.root,
  })
  return { tool, store, exec: { agent: { session: { id: 'session-1' } } } }
}

/**
 * 建一个标准任务并返回工具返回体。
 *
 * @param {object} h
 * @returns {Promise<object>}
 */
async function createStandard(h) {
  return h.tool.execute({
    action: 'create',
    task_id: 'REQ-1',
    mode: 'standard_task',
    plan: standardPlan(),
  }, h.exec)
}

describe('工具形状', () => {
  it('名字固定', () => {
    assert.equal(TASK_TOOL_NAME, 'gac_task')
    assert.equal(harness().tool.name, 'gac_task')
  })

  it('把「你不能宣告完成」写进描述，而不是留给模型猜', () => {
    const { tool } = harness()
    assert.match(tool.description, /你不能宣告完成/u)
    assert.match(tool.description, /dispatch_id/u)
    assert.match(tool.description, /终态/u)
  })

  it('列出全部动作，且不声明任何必填参数', () => {
    const store = new TaskStore({ root: scratch() })
    const options = taskToolOptions({ taskStoreFor: () => store, sessionRootFor: () => store.root })
    assert.deepEqual([...options.parameters.action.enum], [
      'create', 'grill', 'contract', 'plan', 'advance', 'reopen', 'review', 'status', 'list', 'complete',
    ])
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.equal(Object.hasOwn(spec, 'required'), false, `${name} 不应带 required 键`)
    }
  })

  it('会话没有可解析的项目根时明确报错，而不是假装记录了任务', async () => {
    // 任务按项目存放；解析不到根目录时，静默失败会让模型以为任务已被记录。
    const tool = createTaskTool({
      defineTool: identityDefineTool,
      taskStoreFor: () => undefined,
      sessionRootFor: () => undefined,
    })
    await assert.rejects(
      () => tool.execute({ action: 'list' }, { agent: { session: { id: 's' } } }),
      /无法定位任务记录/u,
    )
  })
})

describe('create', () => {
  it('建立任务并给出下一步', async () => {
    const h = harness()
    const value = await createStandard(h)
    assert.equal(value.action, 'created')
    assert.equal(value.task_id, 'REQ-1')
    assert.deepEqual(value.nodes, ['T1'], 'T1 无依赖，应当先派')
    assert.match(value.message, /T1/u)
  })

  it('落盘，因此重载后任务仍在', async () => {
    const h = harness()
    await createStandard(h)
    const reloaded = new TaskStore({ root: h.store.root }).load('REQ-1')
    assert.equal(reloaded.task_id, 'REQ-1')
    assert.equal(reloaded.nodes.size, 2)
  })

  it('同 ID 拒绝覆盖', async () => {
    const h = harness()
    await createStandard(h)
    await assert.rejects(() => createStandard(h), /已存在/u)
  })

  it('拒绝缺少 plan', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'create', task_id: 'REQ-1' }, h.exec),
      /需要 plan/u,
    )
  })

  it('拒绝有环的计划', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-1',
        plan: {
          nodes: [
            { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [], depends_on: ['B'] },
            { id: 'B', objective: 'b', required_capabilities: ['implementation'], write_scope: [], depends_on: ['A'] },
          ],
        },
      }, h.exec),
      (error) => error.code === 'GAC_DAG_CYCLE',
    )
  })
})

describe('advance — 不能宣告完成', () => {
  it('第一次推进就地派遣，并如实报告「等待」而不是「已派遣」', async () => {
    const h = harness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    // 本 harness 没有配置执行者，所以派遣之后无可等待的结果。说成 dispatch 会让
    // 「已派遣」被读成「已在跑」；说成 await 才是实情。
    assert.equal(value.action, 'await')
    // 执行身份必须在盘上，因为回报时要拿它对齐。
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, 'REQ-1-T1-A1')
  })

  it('派遣后进入等待，而不是重复派遣', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'await')
    assert.deepEqual(value.nodes, ['T1'])
  })

  it('带对了执行身份的结果被接受，并推进到下一节点', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    assert.deepEqual(value.classifications, ['accepted'])
    // T1 完成后 T2 就绪，同一轮里就应当被派遣——所以看盘上的状态，而不是看返回的
    // 行动名：行动名在同一轮里可能已经推进到「等待」。
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').status, 'completed')
    assert.equal(task.nodes.get('T2').status, 'in_progress')
    assert.equal(task.nodes.get('T2').execution.active_dispatch_id, 'REQ-1-T2-A1')
  })

  it('身份对不上的结果被判过期，且一个字节都不改', async () => {
    // 这条是「执行者不宣告完成」在接口上的落点：没有正确身份，说什么都不推进。
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A0', status: 'completed' },
    }, h.exec)
    assert.deepEqual(value.classifications, ['stale'])
    assert.match(value.message, /未被接受/u)
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').status, 'in_progress', '状态不得被过期结果推进')
  })

  it('完全不传 dispatch_id 也不推进状态', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', status: 'completed' },
    }, h.exec)
    assert.deepEqual(value.classifications, ['stale'])
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'in_progress')
  })

  it('两个节点依次完成后给出收口', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T2', dispatch_id: 'REQ-1-T2-A1', status: 'completed' },
    }, h.exec)
    assert.equal(value.action, 'complete_task')
    assert.match(value.message, /可以收口/u)
  })

  it('节点失败时给出修复', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'failed' },
    }, h.exec)
    assert.equal(value.action, 'repair')
    assert.deepEqual(value.nodes, ['T1'])
  })

  it('终态节点不会被迟到结果动摇', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    assert.notEqual(value.classifications[0], 'accepted')
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'completed')
  })

  it('找不到任务时提示先建任务，而不是自动建一个', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'advance', task_id: 'REQ-absent' }, h.exec),
      /找不到任务/u,
    )
  })
})

/**
 * 一个接了执行者与适配器的实例，用来验证「派遣」不等于「登记」。
 *
 * @param {object} [options]
 * @param {object} [options.executors] - 适配器里的 executors 映射。
 * @param {readonly object[]} [options.runtimeExecutors] - 可用执行者；缺省给一对 builder/verifier。
 * @param {readonly object[]} [options.evidence] - 运行时发出过的证据记录，供收口核对引用。
 * @returns {{tool: object, store: TaskStore, exec: object, calls: object[]}}
 */
function dispatchHarness(options = {}) {
  const store = new TaskStore({ root: scratch() })
  const calls = []
  const adapters = {
    capabilities: ['implementation', 'verification'],
    executors: options.executors ?? {
      implementation: ['builder'],
      verification: ['verifier'],
    },
    // 适配器上额外的字段（例如 execution 那一节）：合并进来而不是让每个用例各造一份适配器，
    // 是为了让「工具读到适配器的哪个字段」这件事只有一处。
    ...(options.adapterExtras ?? {}),
  }
  /** 造一个会记录调用并报完成的执行者。 */
  const make = (name, summary) => ({
    name,
    supports: () => true,
    run: async (input) => {
      calls.push(input)
      return { status: 'completed', summary, artifact: `${name}-artifact` }
    },
  })
  const executors = options.runtimeExecutors ?? [make('builder', '实现完成'), make('verifier', '验证通过')]
  const tool = createTaskTool({
    defineTool: identityDefineTool,
    taskStoreFor: () => store,
    sessionRootFor: () => store.root,
    adapterFor: () => adapters,
    executorsFor: () => executors,
    evidenceFor: () => options.evidence ?? [],
    ...(options.roleGuard === undefined ? {} : { roleGuard: options.roleGuard }),
  })
  return { tool, store, exec: { agent: { session: { id: 'session-1' } } }, calls }
}

/**
 * 造一条运行时发出过的证据记录。
 *
 * 只填验证层真正会看的字段：号、工具、是否报错、退出码。证据的形状由
 * `compileEvidence` 定义，测试里手写一份完整记录只会与它悄悄走样。
 *
 * @param {string} id
 * @param {object} [overrides]
 * @returns {object}
 */
function evidenceRecord(id, overrides = {}) {
  return { schema_version: 1, id, tool: 'pwsh', is_error: false, exit_code: 0, ...overrides }
}

/**
 * 一份六问齐备、五个维度都有结论的复核报告草稿。
 *
 * 只填 `compileReviewReport` 真正会核对的字段，理由与 `evidenceRecord` 相同：手写一份完整记录
 * 只会与定义悄悄走样。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function reviewDraft(overrides = {}) {
  return {
    summary: '复核通过',
    blocking_issues: [],
    engineering_quality: {
      reuse: '无',
      duplication: '无',
      unnecessary_abstraction: '无',
      change_scope: '无',
      dependency: '无',
    },
    verification_independence: {
      builder_tests_only: false,
      expectations_from_requirement: true,
      falsification_present: true,
      uncovered_criteria: [],
      verifier_reran_builder_tests_only: false,
      plan_modified_by_builder: false,
    },
    ...overrides,
  }
}

describe('advance 真的调用执行者', () => {
  it('派遣之后执行者真的被调用', async () => {
    // 这一条是本阶段的核心：在此之前「派遣」只写盘不调用，于是返回里的
    // 「已派遣」与「已在跑」长得一样，而实际上什么都没发生。
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(h.calls.length, 1, '执行者必须被调用一次')
    assert.equal(h.calls[0].node.id, 'T1')
    assert.equal(h.calls[0].dispatchId, 'REQ-1-T1-A1')
    // 执行者报完成，状态就该被推进，且下一轮接着派遣 T2。
    assert.equal(value.status, 'in_progress')
    assert.deepEqual(value.classifications, ['accepted'])
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'completed')
  })

  it('一条命令跑完 STANDARD 任务的 Builder 与 Verifier', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1', 'T2'])
    assert.equal(value.action, 'complete_task')
  })

  it('按能力路由：实现节点给 builder，验证节点给 verifier', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1', 'T2'])
    // 两个节点由不同执行者承载，这正是「不固定岗位」的落点。
    const routed = h.calls.map((call) => call.node.required_capabilities[0])
    assert.deepEqual(routed, ['implementation', 'verification'])
  })

  it('执行者报 blocked 时登记为阻塞，而不是当作完成', async () => {
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async () => ({ status: 'blocked', summary: '需要生产环境凭据' }),
      }],
    })
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(value.classifications, ['accepted'])
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'blocked')
  })

  it('执行者说仍在进行时保持执行中，不伪造完成', async () => {
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async () => ({ status: 'in_progress', summary: '会话还在跑' }),
      }],
    })
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(value.classifications, [], '仍在进行不是可迁移的结果')
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'in_progress')
    assert.match(value.message, /会话还在跑/u)
  })

  it('适配器没声明执行者时不猜一个，并如实说明', async () => {
    const h = dispatchHarness({ executors: {} })
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(h.calls.length, 0)
    assert.match(value.message, /没有可承载|没有可声明|未派遣/u)
  })

  it('路由选中的执行者承载不了该节点时如实登记，而不是伪造成功', async () => {
    // 典型情形：节点要写文件，而可用执行者没有写工具。
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => false,
        run: async () => ({ status: 'completed', summary: '不该被调用' }),
      }],
    })
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(h.calls.length, 0, '承载不了就不该被调用')
    assert.match(value.message, /不能承载/u)
    assert.deepEqual(value.classifications, [])
  })
})

describe('complete — 收口必须过证据判定', () => {
  it('证据不足时拒绝收口，且不改动状态', async () => {
    // 半个收口比没收口更难收拾：状态一旦置为 completed，后续结果就再动不了它。
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: { all_criteria_covered: false },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, ['criteria_uncovered'])
    assert.equal(h.store.load('REQ-1').status, 'in_progress')
  })

  it('节点未全部完成时拒绝收口，并指出是哪个节点', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, ['node_not_completed', 'node_not_completed'])
    assert.match(value.message, /T1/u)
  })

  it('阻塞评审与未决审批都拦住收口', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: {
        all_criteria_covered: true,
        blocking_review_issue: true,
        unresolved_approval: true,
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual([...value.blockers].sort(), ['blocking_review_issue', 'unresolved_approval'])
  })

  it('证据齐备时收口，任务进入终态', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'completed')
    assert.equal(h.store.load('REQ-1').status, 'completed')
  })

  it('收口之后不再反复要求收口，而是报 done', async () => {
    // 没有这一步时 complete_task 会一直重复，任务永远收不了口。
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'done')
  })

  it('缺少 evidence 视为证据未覆盖，不放行', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'complete', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'complete_refused')
  })
})

describe('验证计划门禁 —— 计划必须在实现之前', () => {
  /**
   * 一个高风险任务，含实现与验证两个节点。
   *
   * @param {object} h
   * @returns {Promise<object>}
   */
  async function createHighRisk(h) {
    return h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR',
      mode: 'high_risk_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
          { id: 'T2', objective: '独立验证', depends_on: ['T1'], required_capabilities: ['verification'], write_scope: [] },
        ],
      },
    }, h.exec)
  }

  /** 一份覆盖 AC1 的完整计划参数。 */
  const PLAN_ARGS = {
    criteria: ['AC1'],
    verification_plan: {
      cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: '正常输入被接受' },
        { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: '越界输入被拒绝' },
      ],
    },
  }

  it('高风险任务在验证节点被派遣之前要求先登记计划', async () => {
    const h = dispatchHarness()
    await createHighRisk(h)
    // T1 是实现节点，不需要计划就能开工。
    const first = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(first.action, 'dispatch')
    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1'])
    // T1 完成后 T2 就绪，但它承载验证能力且没有计划，于是停下。
    const second = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(second.action, 'plan_required')
    assert.deepEqual(second.nodes, ['T2'])
    assert.match(second.message, /实现之前/u)
    // T2 没有被派遣，也没有被调用。
    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1'])
    assert.equal(h.store.load('REQ-HR').nodes.get('T2').status, 'pending')
  })

  it('只拦验证节点，不拦实现节点', async () => {
    // 把整条流水线停住会让「先出计划、再实现」退化成三步串行，白白丢掉可并行的部分。
    const h = dispatchHarness()
    await createHighRisk(h)
    const first = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(first.action, 'dispatch')
  })

  it('登记计划之后验证节点可以派遣', async () => {
    const h = dispatchHarness()
    await createHighRisk(h)
    const planned = await h.tool.execute({ action: 'plan', task_id: 'REQ-HR', ...PLAN_ARGS }, h.exec)
    assert.equal(planned.action, 'planned')
    assert.ok(planned.plan_id)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'complete_task')
    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1', 'T2'])
  })

  it('标准任务不需要计划，行为不变', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'complete_task')
  })

  it('缺反例的计划当场被拒，并指名到具体 AC', async () => {
    const h = dispatchHarness()
    await createHighRisk(h)
    await assert.rejects(
      () => h.tool.execute({
        action: 'plan',
        task_id: 'REQ-HR',
        criteria: ['AC1'],
        verification_plan: {
          cases: [{ id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' }],
        },
      }, h.exec),
      (error) => error.code === 'GAC_FALSIFICATION_EVIDENCE_MISSING',
    )
  })

  it('覆盖不全的计划当场被拒，并报出缺哪条 AC', async () => {
    const h = dispatchHarness()
    await createHighRisk(h)
    await assert.rejects(
      () => h.tool.execute({
        action: 'plan',
        task_id: 'REQ-HR',
        criteria: ['AC1', 'AC2'],
        verification_plan: PLAN_ARGS.verification_plan,
      }, h.exec),
      (error) => {
        assert.equal(error.code, 'GAC_VERIFICATION_COVERAGE_GAP')
        assert.deepEqual(error.detail.uncovered, ['AC2'])
        return true
      },
    )
  })

  it('同一份计划重复登记是幂等的，不算错误', async () => {
    const h = dispatchHarness()
    await createHighRisk(h)
    await h.tool.execute({ action: 'plan', task_id: 'REQ-HR', ...PLAN_ARGS }, h.exec)
    const again = await h.tool.execute({ action: 'plan', task_id: 'REQ-HR', ...PLAN_ARGS }, h.exec)
    assert.equal(again.action, 'plan_unchanged')
  })

  it('实现之后替换计划会被拒', async () => {
    // 计划的意义是「在实现之前从需求推导」；实现之后再换一份，它推导的已经是实现。
    const h = dispatchHarness()
    await createHighRisk(h)
    await h.tool.execute({ action: 'plan', task_id: 'REQ-HR', ...PLAN_ARGS }, h.exec)
    await assert.rejects(
      () => h.tool.execute({
        action: 'plan',
        task_id: 'REQ-HR',
        criteria: ['AC1'],
        verification_plan: {
          cases: [
            { id: 'V1', covers: ['AC1'], type: 'positive', expect: '被改过的期望' },
            { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
          ],
        },
      }, h.exec),
      /拒绝以另一份/u,
    )
  })
})

describe('验证证据门禁 —— 收口要看证据', () => {
  /** 把高风险任务推到全部节点完成。 */
  async function reachAllDone(h) {
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR',
      mode: 'high_risk_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
          { id: 'T2', objective: '验证', depends_on: ['T1'], required_capabilities: ['verification'], write_scope: [] },
        ],
      },
    }, h.exec)
    await h.tool.execute({
      action: 'plan',
      task_id: 'REQ-HR',
      criteria: ['AC1'],
      verification_plan: {
        cases: [
          { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
          { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
        ],
      },
    }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    // 高风险流程现在多一步：收口前必须有独立复核报告。放在这个助手里面，是因为本组用例测的是
    // 验证证据那一关，而不是「有没有复核」——复核自己有单独一组用例。
    await h.tool.execute({
      action: 'review',
      task_id: 'REQ-HR',
      review_report: reviewDraft(),
    }, h.exec)
    return h.store.loadPlan('REQ-HR')
  }

  it('没有验证计划的高风险任务不能收口', async () => {
    const h = dispatchHarness()
    // 直接建一个不含验证节点的高风险任务，绕过计划门禁到达收口。
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR',
      mode: 'high_risk_task',
      plan: { nodes: [
        { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
      ] },
    }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, ['GAC_VERIFICATION_PLAN_MISSING'])
  })

  it('报告里的 plan_id 与计划不符时被拒，并报出两边', async () => {
    const h = dispatchHarness()
    await reachAllDone(h)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: 'plan-deadbeef',
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_VERIFICATION_PLAN_MUTATED'), true)
    assert.match(value.message, /报告对应的不是当前计划/u)
  })

  it('取证摊薄的报告被拒，并指出共用了哪份证据', async () => {
    const h = dispatchHarness()
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-shared' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-shared' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_EVIDENCE_POOLED_ACROSS_CASES'), true)
    assert.match(value.message, /ev-shared/u)
  })

  it('证据齐备且计划对得上时收口成功', async () => {
    // 引用必须指向运行时真实发出过的证据号；这里把证据交给 harness，模拟一次真的跑过的
    // 命令。
    const h = dispatchHarness({
      evidence: [evidenceRecord('ev-1'), evidenceRecord('ev-2')],
    })
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1#AC1' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2#AC1' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'completed')
    assert.equal(h.store.load('REQ-HR').status, 'completed')
  })

  it('运行时没发过的证据号一律不认', async () => {
    // 这是本阶段的核心：在此之前 evidence_ref 只是模型写下的字符串，写下 ev-1 与真的跑过
    // 一条命令在数据上完全一样，于是「每条用例都有证据」可以靠编造满足。
    const h = dispatchHarness({ evidence: [evidenceRecord('ev-1')] })
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1#AC1' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-999#AC1' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_EVIDENCE_NOT_FROM_RUNTIME'), true)
    assert.match(value.message, /ev-999/u)
    assert.match(value.message, /没有发出过/u)
  })

  it('退出码非零的命令不能证明任何东西通过', async () => {
    // 可核对的事实，不是判断：退出码非零的命令跑失败了。
    const h = dispatchHarness({
      evidence: [evidenceRecord('ev-1'), evidenceRecord('ev-2', { exit_code: 1 })],
    })
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.match(value.message, /退出码为 1/u)
  })

  it('报错的那次调用不能充当通过证据', async () => {
    const h = dispatchHarness({
      evidence: [
        evidenceRecord('ev-1'),
        evidenceRecord('ev-2', { is_error: true, error_code: 'GAC_WRITE_SCOPE_DENIED' }),
      ],
    })
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.match(value.message, /GAC_WRITE_SCOPE_DENIED/u)
  })

  it('同一个证据号配不同明细是合法的：一次套件运行里各用例各自成立', async () => {
    // 引用带明细的全部意义在这里。跑一遍测试套件同时支撑多条用例是常态，把它们一律判成
    // 取证摊薄会让真实用法无法通过。
    const h = dispatchHarness({ evidence: [evidenceRecord('ev-1')] })
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1#用例解析空配置' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-1#用例拒绝越界' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'completed')
  })

  it('同一个证据号配相同明细是取证摊薄', async () => {
    const h = dispatchHarness({ evidence: [evidenceRecord('ev-1')] })
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1#同一段' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-1#同一段' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_EVIDENCE_POOLED_ACROSS_CASES'), true)
  })

  it('缺证据的报告被拒，并指出缺哪条用例', async () => {
    const h = dispatchHarness()
    const plan = await reachAllDone(h)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [{ case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' }],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_INDEPENDENT_EVIDENCE_MISSING'), true)
    assert.match(value.message, /V2/u)
  })
})

describe('访谈循环门禁 —— 需求必须以用户确认结束', () => {
  const RECORD = {
    grill_action: 'record',
    round: {
      focus: '范围',
      questions: [
        { id: 'Q1', question: '影响哪些文件？', answer: '只有 src/a.c' },
        { id: 'Q2', question: '要兼容旧行为吗？', answer: '不知道' },
      ],
    },
  }

  it('一开始什么都不知道', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'grill', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'grill_status')
    assert.match(value.message, /还没有进行过访谈/u)
  })

  it('记下一轮，并把「不知道」列为未决', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    assert.equal(value.action, 'round_recorded')
    assert.deepEqual(value.nodes, ['Q2'], '「不知道」是一条真实答复，但决策还没定')
  })

  it('提出收敛，但明确说明它不结束访谈', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    const value = await h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'converge' }, h.exec)
    assert.equal(value.action, 'convergence_proposed')
    assert.match(value.message, /不结束访谈/u)
    assert.match(value.message, /没有外部依据/u)
  })

  it('没有用户确认原话就不能冻结需求', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'converge' }, h.exec)
    await assert.rejects(
      () => h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'confirm' }, h.exec),
      (error) => error.code === 'GAC_GRILLING_NOT_CONFIRMED',
    )
  })

  it('拿到确认原话后冻结需求', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'converge' }, h.exec)
    const value = await h.tool.execute({
      action: 'grill',
      task_id: 'REQ-1',
      grill_action: 'confirm',
      confirmation: '可以，就按这个做',
      acceptance_criteria: ['AC1'],
    }, h.exec)
    assert.equal(value.action, 'requirement_frozen')
    assert.match(value.message, /AC1|1 条/u)
  })

  it('冻结之后不能再追加轮次', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'converge' }, h.exec)
    await h.tool.execute({
      action: 'grill', task_id: 'REQ-1', grill_action: 'confirm', confirmation: '可以',
    }, h.exec)
    await assert.rejects(
      () => h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec),
      (error) => error.code === 'GAC_REQUIREMENT_ALREADY_FROZEN',
    )
  })
})

describe('接口契约门禁 —— 必须在动手之前', () => {
  /** 一份契约参数，含子动作。 */
  const CONTRACT_ARGS = {
    contract_action: 'freeze',
    criteria: ['AC1'],
    interface_contract: {
      name: 'parseConfig',
      covers: ['AC1'],
      operations: [
        {
          name: 'parseConfig',
          signature: 'parseConfig(text: string): Config',
          behavior: '解析失败时抛出 ConfigError；空文本返回空配置。',
          errors: ['ConfigError'],
          covers: ['AC1'],
        },
      ],
    },
  }

  /**
   * 一个声明了 require_contract 的实例。
   *
   * @returns {object}
   */
  function contractHarness() {
    const store = new TaskStore({ root: scratch() })
    const mk = (name) => ({
      name,
      supports: () => true,
      run: async () => ({ status: 'completed', summary: `${name} 完成` }),
    })
    return {
      store,
      exec: { agent: { session: { id: 'session-1' } } },
      tool: createTaskTool({
        defineTool: identityDefineTool,
        taskStoreFor: () => store,
        sessionRootFor: () => store.root,
        adapterFor: () => ({
          executors: { implementation: ['builder'], verification: ['verifier'] },
          execution: { require_contract: { modes: ['standard_task', 'high_risk_task'] } },
        }),
        executorsFor: () => [mk('builder'), mk('verifier')],
      }),
    }
  }

  it('声明了 require_contract 时，写文件的节点在契约冻结前不派遣', async () => {
    const h = contractHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'contract_required')
    assert.deepEqual(value.nodes, ['T1'])
    assert.match(value.message, /结构性失败/u)
    // T1 没有被派遣，也没有被执行者调用。
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'pending')
  })

  it('同一批里有 ≥2 个写文件的节点时，即使适配器没声明也要求契约', async () => {
    // 这条规则是走一遍真实需求时暴露出来的：本仓库适配器只对 high_risk_task 要求契约，
    // 于是「并行写功能代码 + 写测试代码」——契约存在的全部理由——恰好不在门禁覆盖内，
    // 两个节点连契约都没有就并行开工了。用风险档位当判据是选错了轴：决定要不要契约的是
    // 任务的形状（有没有并行写入），不是它的风险级别。
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-P',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '写功能代码', required_capabilities: ['implementation'], write_scope: ['lib/a.js'] },
        { id: 'T2', objective: '写测试代码', required_capabilities: ['implementation'], write_scope: ['test/a.test.js'] },
      ] },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-P' }, h.exec)
    assert.equal(value.action, 'contract_required')
    // 两个写者都要被拦下：只拦一个，另一个仍会照着尚未存在的约定开工。
    assert.deepEqual([...value.nodes].sort(), ['T1', 'T2'])
    assert.match(value.message, /并行开工/u)
  })

  it('只有一个写者时不设这道门，不制造无谓仪式', async () => {
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-S',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '改一个文件', required_capabilities: ['implementation'], write_scope: ['lib/a.js'] },
      ] },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-S' }, h.exec)
    assert.notEqual(value.action, 'contract_required')
  })

  it('并行写入时契约冻结后两个写者一起放行', async () => {
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-P',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '写功能代码', required_capabilities: ['implementation'], write_scope: ['lib/a.js'] },
        { id: 'T2', objective: '写测试代码', required_capabilities: ['implementation'], write_scope: ['test/a.test.js'] },
      ] },
    }, h.exec)
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-P',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-P' }, h.exec)
    assert.notEqual(value.action, 'contract_required')
    // 两个写者同批派遣，也就是真的并行开工。
    assert.deepEqual([...h.calls].map((call) => call.node.id).sort(), ['T1', 'T2'])
  })

  it('适配器声明了模式要求契约时，单个写者也要先有契约', async () => {
    // 工程侧可以加严：单写者的高风险改动也可能需要先把接口写下来。
    const h = contractHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'contract_required')
    assert.match(value.message, /工程适配器声明了/u)
  })

  it('契约冻结之后可以派遣', async () => {
    const h = contractHarness()
    await createStandard(h)
    const frozen = await h.tool.execute({ action: 'contract', task_id: 'REQ-1', ...CONTRACT_ARGS }, h.exec)
    assert.equal(frozen.action, 'contract_frozen')
    assert.ok(frozen.plan_id)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    // 一波只走一层：T1 跑完，T2 就绪，于是下一步仍是 dispatch——它的意思是「还有活儿
    // 可以推」，而不是「刚才那批已经被派遣了」。
    assert.equal(value.action, 'dispatch')
    assert.deepEqual(value.nodes, ['T2'])
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'completed')
  })

  it('未声明 require_contract 时不设这道门，行为与之前一致', async () => {
    // 门禁由工程适配器声明而不是硬编码：小改动不需要先写契约，要求它写只是无谓的仪式。
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'dispatch')
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'completed')
  })

  it('只拦写文件的节点，不拦只回传报告的节点', async () => {
    const h = contractHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-R',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '出方案', required_capabilities: ['implementation'], write_scope: [] },
      ] },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-R' }, h.exec)
    assert.equal(value.action, 'complete_task', '不写文件的节点无需契约，直接跑完')
    assert.equal(h.store.load('REQ-R').nodes.get('T1').status, 'completed')
  })

  it('同一份契约重复冻结是幂等的', async () => {
    const h = contractHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'contract', task_id: 'REQ-1', ...CONTRACT_ARGS }, h.exec)
    const again = await h.tool.execute({ action: 'contract', task_id: 'REQ-1', ...CONTRACT_ARGS }, h.exec)
    assert.equal(again.action, 'contract_unchanged')
  })

  it('以另一份契约覆盖已冻结的会被拒', async () => {
    const h = contractHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'contract', task_id: 'REQ-1', ...CONTRACT_ARGS }, h.exec)
    await assert.rejects(
      () => h.tool.execute({
        action: 'contract',
        contract_action: 'freeze',
        task_id: 'REQ-1',
        criteria: ['AC1'],
        interface_contract: {
          name: 'parseConfig',
          covers: ['AC1'],
          operations: [
            { name: 'parseConfig', signature: 'parseConfig(text: string): Config', behavior: '改过了', covers: ['AC1'] },
          ],
        },
      }, h.exec),
      /拒绝以另一份/u,
    )
  })

  it('contract status 报出已冻结的契约', async () => {
    const h = contractHarness()
    await createStandard(h)
    const before = await h.tool.execute({ action: 'contract', task_id: 'REQ-1' }, h.exec)
    assert.match(before.message, /还没有冻结/u)
    await h.tool.execute({ action: 'contract', task_id: 'REQ-1', ...CONTRACT_ARGS }, h.exec)
    const after = await h.tool.execute({ action: 'contract', task_id: 'REQ-1' }, h.exec)
    assert.match(after.message, /已冻结/u)
    assert.ok(after.plan_id)
  })
})

describe('验证证据门禁 —— 触发条件是「计划在不在」，不是风险档位', () => {
  /**
   * 一个 standard_task，含一个不写文件的节点，并登记一份计划。
   *
   * @param {object} h
   * @param {boolean} withPlan
   * @returns {Promise<object|undefined>}
   */
  async function standardWithPlan(h, withPlan) {
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-S',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '出方案', required_capabilities: ['implementation'], write_scope: [] },
      ] },
    }, h.exec)
    if (!withPlan) {
      // 没有计划时也要先把节点跑完，否则拦下它的是「节点未完成」那道门，
      // 这条用例就测不到它想测的那道门。
      await h.tool.execute({ action: 'advance', task_id: 'REQ-S' }, h.exec)
      return undefined
    }
    await h.tool.execute({
      action: 'plan',
      task_id: 'REQ-S',
      criteria: ['AC1'],
      verification_plan: { cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
        { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      ] },
    }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-S' }, h.exec)
    return h.store.loadPlan('REQ-S')
  }

  it('standard_task 只要登记了计划，收口就必须附验证证据', async () => {
    // 这条是走一遍真实需求时踩到的：只看模式会留下绕行口——登记了 20 用例的冻结计划、
    // 却因为不声明高风险而在收口时完全不做证据核对，计划的全部价值在终点被丢掉，而表面
    // 上一切正常。门禁守的应当是它所守护的那件东西是否存在。
    const h = dispatchHarness({ evidence: [evidenceRecord('ev-1')] })
    await standardWithPlan(h, true)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-S',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_INDEPENDENT_EVIDENCE_MISSING'), true)
  })

  it('standard_task 附上对得上的证据就能收口', async () => {
    const h = dispatchHarness({ evidence: [evidenceRecord('ev-1')] })
    const plan = await standardWithPlan(h, true)
    const { planId } = await import('../lib/verification.js')
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-S',
      evidence: {
        all_criteria_covered: true,
        verification: {
          plan_id: planId(plan),
          executions: [
            { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1#正例' },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-1#反例' },
          ],
        },
      },
    }, h.exec)
    assert.equal(value.action, 'completed')
  })

  it('没有计划、也不是高风险的任务，行为不变', async () => {
    // 门禁不该凭空扩大到没有计划的任务上：没有计划就没有要核对的承诺。
    const h = dispatchHarness()
    await standardWithPlan(h, false)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-S',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'completed')
  })

  it('高风险任务没有计划时仍然拒绝，并指明要先登记计划', async () => {
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR',
      mode: 'high_risk_task',
      plan: { nodes: [
        { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: [] },
      ] },
    }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, ['GAC_VERIFICATION_PLAN_MISSING'])
  })
})

describe('独立复核门禁 —— 六问齐备才能收口', () => {
  /**
   * 一个含审查节点的高风险任务，推到全部节点完成；给了报告就先登记一份。
   *
   * 计划里放一个 `review` 节点是有意的：这一关的触发条件之一是「计划里有承载审查能力的节点」，
   * 而那正是通用规则（不看工程怎么声明）。
   *
   * @param {object} h
   * @param {object|undefined} report
   * @returns {Promise<object>} 已冻结的验证计划。
   */
  async function reachReviewable(h, report) {
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-R',
      mode: 'high_risk_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
          { id: 'T2', objective: '验证', depends_on: ['T1'], required_capabilities: ['verification'], write_scope: [] },
          { id: 'T3', objective: '复核', depends_on: ['T2'], required_capabilities: ['review'], write_scope: [] },
        ],
      },
    }, h.exec)
    await h.tool.execute({
      action: 'plan',
      task_id: 'REQ-R',
      criteria: ['AC1'],
      verification_plan: {
        cases: [
          { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
          { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
        ],
      },
    }, h.exec)
    for (let round = 0; round < 3; round += 1) {
      await h.tool.execute({ action: 'advance', task_id: 'REQ-R' }, h.exec)
    }
    if (report !== undefined) {
      await h.tool.execute({ action: 'review', task_id: 'REQ-R', review_report: report }, h.exec)
    }
    return h.store.loadPlan('REQ-R')
  }

  /**
   * 收口时附上的验证证据：与计划对得上，且每条用例各有自己的明细。
   *
   * @param {object} plan
   * @returns {Promise<object>}
   */
  async function completeBody(plan) {
    const { planId } = await import('../lib/verification.js')
    return {
      all_criteria_covered: true,
      verification: {
        plan_id: planId(plan),
        executions: [
          { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1#正例' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-1#反例' },
        ],
      },
    }
  }

  /**
   * 一个能承载审查节点的 harness。
   *
   * 适配器必须声明 review 的执行者：能力路由是从工程声明里查的，没声明就派不出去。
   *
   * @param {object} [options]
   * @returns {object}
   */
  function reviewHarness(options = {}) {
    return dispatchHarness({
      executors: { implementation: ['builder'], verification: ['verifier'], review: ['reviewer'] },
      evidence: [evidenceRecord('ev-1')],
      ...options,
    })
  }

  it('计划里有审查节点时，没有复核报告就不能收口', async () => {
    const h = reviewHarness()
    const plan = await reachReviewable(h, undefined)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, ['GAC_REVIEW_REPORT_MISSING'])
    assert.match(value.message, /T3/u)
  })

  it('复核自己申报了「只依赖 Builder 的测试」时收口被拒，并指名是哪一问', async () => {
    // 报的是**已经记录在案的事实**：改口改不掉，能做的是把活儿修好再复核一次。
    const h = reviewHarness()
    const plan = await reachReviewable(h, reviewDraft({
      verification_independence: {
        ...reviewDraft().verification_independence,
        builder_tests_only: true,
      },
    }))
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_REVIEW_INDEPENDENCE_FAILED'), true)
    assert.match(value.message, /只依赖了 Builder 自己写的测试/u)
  })

  it('复核申报了未覆盖的验收标准时收口被拒，并列出那些标准', async () => {
    const h = reviewHarness()
    const plan = await reachReviewable(h, reviewDraft({
      verification_independence: {
        ...reviewDraft().verification_independence,
        uncovered_criteria: ['AC2'],
      },
    }))
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.match(value.message, /AC2/u)
  })

  it('六问没答完时，报告根本登记不进去', async () => {
    // 一份缺答案的复核不该变成一个可被引用的产物——那会让「答了没有」这件事事后无从核对。
    const h = reviewHarness()
    await reachReviewable(h, undefined)
    const partial = reviewDraft()
    delete partial.verification_independence.falsification_present
    await assert.rejects(
      () => h.tool.execute({ action: 'review', task_id: 'REQ-R', review_report: partial }, h.exec),
      (error) => error.code === 'GAC_REVIEW_INDEPENDENCE_UNANSWERED',
    )
    assert.equal(h.store.hasReview('REQ-R'), false)
  })

  it('六问齐备且方向都对时收口通过', async () => {
    const h = reviewHarness()
    const plan = await reachReviewable(h, reviewDraft())
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(value.action, 'completed')
    assert.equal(h.store.load('REQ-R').status, 'completed')
  })

  it('修好之后重新复核会覆盖上一份，收口随之通过', async () => {
    // 复核是「对已完成的活儿的一次观察」，后来的观察取代先前的观察——因此这里允许覆盖，而计划
    // 与契约不允许。若在这里拒绝覆盖，唯一的出路是删掉那份说真话的报告，那恰好是门禁要防的。
    const h = reviewHarness()
    const plan = await reachReviewable(h, reviewDraft({
      blocking_issues: ['并行写入没有契约'],
    }))
    const refused = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(refused.action, 'complete_refused')
    assert.equal(refused.blockers.includes('GAC_REVIEW_BLOCKING_ISSUES'), true)

    await h.tool.execute({ action: 'review', task_id: 'REQ-R', review_report: reviewDraft() }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(value.action, 'completed')
  })

  it('复核引用了运行时没发过的证据号时收口被拒', async () => {
    const h = reviewHarness()
    const plan = await reachReviewable(h, reviewDraft({ evidence: ['ev-999#AC1'] }))
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-R',
      evidence: await completeBody(plan),
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_REVIEW_EVIDENCE_NOT_FROM_RUNTIME'), true)
    assert.match(value.message, /ev-999/u)
  })

  it('标准任务没有审查节点时，这一关不凭空扩大', async () => {
    // 门禁守的是它所守护的那件东西：没有审查节点的标准任务不该多出一步仪式。
    const h = dispatchHarness({ evidence: [evidenceRecord('ev-1')] })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'completed')
  })
})

describe('只读角色收权 —— 派遣时收、回报时放', () => {
  /** 一个「派给会话、停在 in_progress」的执行者：只读节点的常态。 */
  const STAYS_IN_PROGRESS = {
    name: 'verifier',
    supports: () => true,
    run: async () => ({ status: 'in_progress', summary: '等待会话执行' }),
  }

  /** 一个立刻报完成的执行者，用来让实现节点走完。 */
  const COMPLETES = {
    name: 'builder',
    supports: () => true,
    run: async () => ({ status: 'completed', summary: '实现完成' }),
  }

  /**
   * 一个记下每次收权请求的假收权器。
   *
   * @returns {{guard: object, syncs: object[]}}
   */
  function recordingGuard() {
    const syncs = []
    return { guard: { sync: (input) => { syncs.push(input) } }, syncs }
  }

  it('派遣停在会话里的只读节点之后，按空的写范围收权', async () => {
    const { guard, syncs } = recordingGuard()
    const h = dispatchHarness({ roleGuard: guard, runtimeExecutors: [COMPLETES, STAYS_IN_PROGRESS] })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    // 第一波只有 T1（实现）；T2 依赖它，所以此刻没有只读节点在飞。
    assert.deepEqual(syncs.at(-1).readOnlyNodes, [])

    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const last = syncs.at(-1)
    assert.deepEqual(last.readOnlyNodes, ['T2'], '验证节点声明了空写范围，因此要收权')
    assert.equal(last.taskId, 'REQ-1')
    assert.equal(last.sessionId, 'session-1')
    assert.equal(last.includeShell, false, 'shell 默认不收：验证者要靠它跑用例')
  })

  it('回报之后收权解除 —— 不能把会话永久关在写入之外', async () => {
    const { guard, syncs } = recordingGuard()
    const h = dispatchHarness({ roleGuard: guard, runtimeExecutors: [COMPLETES, STAYS_IN_PROGRESS] })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(syncs.at(-1).readOnlyNodes, ['T2'])

    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T2', dispatch_id: 'REQ-1-T2-A1', status: 'completed' },
    }, h.exec)
    assert.deepEqual(syncs.at(-1).readOnlyNodes, [], '节点报完了，写入面就该回来')
  })

  it('收口时也重算一次，而不是把收权留在那儿', async () => {
    const { guard, syncs } = recordingGuard()
    const h = dispatchHarness({ roleGuard: guard, runtimeExecutors: [COMPLETES, STAYS_IN_PROGRESS] })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T2', dispatch_id: 'REQ-1-T2-A1', status: 'completed' },
    }, h.exec)
    const before = syncs.length
    await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-1',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.ok(syncs.length > before, '收口也要重算')
    assert.deepEqual(syncs.at(-1).readOnlyNodes, [])
  })

  it('适配器声明连 shell 一起收回时，那次请求带上 includeShell', async () => {
    const { guard, syncs } = recordingGuard()
    const h = dispatchHarness({
      roleGuard: guard,
      runtimeExecutors: [COMPLETES, STAYS_IN_PROGRESS],
      adapterExtras: { execution: { revoke_shell_for_read_only_roles: true } },
    })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(syncs.at(-1).includeShell, true)
  })

  it('写节点在飞时不收权 —— 判据是声明的写范围，不是能力名', async () => {
    const { guard, syncs } = recordingGuard()
    const h = dispatchHarness({ roleGuard: guard, runtimeExecutors: [STAYS_IN_PROGRESS, COMPLETES] })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    // T1 声明了 src/，它停在会话里也不收权：它正是那个该写文件的人。
    assert.deepEqual(syncs.at(-1).readOnlyNodes, [])
  })

  it('没有收权器时什么都不发生，也不抛错', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await assert.doesNotReject(() => h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec))
  })
})

describe('reopen', () => {
  it('重新打开已完成的节点，并作废其执行身份', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    const value = await h.tool.execute({
      action: 'reopen',
      task_id: 'REQ-1',
      node_id: 'T1',
      reason: '发现范围需要扩张',
    }, h.exec)
    assert.equal(value.action, 'reopened')
    assert.deepEqual(value.nodes, ['T1'])
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').status, 'pending')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, null)
  })

  it('重新打开后的下一次派遣铸造新身份，不复用旧的', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'failed' },
    }, h.exec)
    await h.tool.execute({ action: 'reopen', task_id: 'REQ-1', node_id: 'T1', reason: '换做法' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, 'REQ-1-T1-A2')
  })

  it('拒绝没有原因的重新打开', async () => {
    const h = harness()
    await createStandard(h)
    await assert.rejects(
      () => h.tool.execute({ action: 'reopen', task_id: 'REQ-1', node_id: 'T1' }, h.exec),
      /原因/u,
    )
  })
})

describe('status 与 list', () => {
  it('status 报出每个节点的状态与下一步', async () => {
    const h = harness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'status', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.status, 'pending')
    assert.deepEqual(value.nodes, ['T1:pending', 'T2:pending'])
    assert.match(value.message, /下一步/u)
  })

  it('status 在派遣后反映执行中', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'status', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.status, 'in_progress')
    assert.deepEqual(value.nodes, ['T1:in_progress', 'T2:pending'])
  })

  it('list 列出全部任务', async () => {
    const h = harness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'list' }, h.exec)
    assert.deepEqual(value.tasks, ['REQ-1'])
  })

  it('没有任务时 list 如实说明', async () => {
    const h = harness()
    const value = await h.tool.execute({ action: 'list' }, h.exec)
    assert.deepEqual(value.tasks, [])
    assert.match(value.message, /还没有任务记录/u)
  })

  it('缺少 task_id 时报错，而不是猜一个', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'status' }, h.exec),
      /需要 task_id/u,
    )
  })

  it('未知动作被拒', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'obliterate', task_id: 'REQ-1' }, h.exec),
      /未知动作/u,
    )
  })
})
