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
      'create', 'advance', 'reopen', 'status', 'list', 'complete',
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
  })
  return { tool, store, exec: { agent: { session: { id: 'session-1' } } }, calls }
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
