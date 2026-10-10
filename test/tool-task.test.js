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
import {
  compileDesignArtifact,
  compileDesignPackage,
  deepFreezeDesign,
  designId,
  freezeDesign,
} from '../lib/design.js'
import { BUILDER_CODES } from '../lib/builder-scope.js'
import { DESIGN_CODES } from '../lib/design.js'
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

/**
 * 一份两节点的标准计划：实现随后验证。
 */
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
 * 造一份内容合法的设计包，四份产物齐、追溯覆盖给定验收标准。
 *
 * 直接写盘而不是走派遣：本套件测的是**门禁**，让四份产物真的由子会话产出来会把每个用例都变成一次
 * 端到端演练，而这里要验的是「门禁看不看设计、看的是不是批准」。设计包自己的编译与冻结另有
 * `test/design.test.js` 覆盖。
 *
 * @param {string} taskId
 * @param {readonly string[]} criteria
 * @returns {object}
 */
function designPackageFor(taskId, criteria) {
  const artifact = (name, content) => compileDesignArtifact(
    {
      artifact: name,
      content,
      traceability: criteria.map((id) => ({ criteria: id, where: '§1' })),
    },
    { childSessionId: `design-child-${name}`, createdAt: 1 },
  )
  return compileDesignPackage(
    {
      task_id: taskId,
      requirement_ref: 'requirement-test',
      interface_contract_ref: 'contract-test',
      artifacts: {
        software_architecture: artifact('software_architecture', '架构：一个模块。'),
        software_detail: artifact('software_detail', '详设：一个函数。'),
        test_architecture: artifact('test_architecture', '测试架构：两条用例。'),
        test_detail: artifact('test_detail', '测试详设：正例与反例各一。'),
      },
      requirement_traceability: criteria.map((id) => ({ criteria: id, artifact: 'software_detail' })),
      consistency_result: { ok: true, conflicts: [] },
      unresolved_issues: [],
    },
    { criteria, frozenAt: 1 },
  )
}

/**
 * 给一个高风险任务冻上一份设计并作出批准。
 *
 * 这道门禁的**存在**由「设计门禁」那个 describe 单独验；其余高风险用例关心的是计划、证据、复核
 * 这些更下游的门禁，所以它们只需要先越过设计这一关。
 *
 * @param {object} h
 * @param {string} taskId
 * @param {readonly string[]} [criteria]
 * @returns {string} 设计 id
 */
function approveDesign(h, taskId, criteria = ['AC1']) {
  const pkg = deepFreezeDesign(designPackageFor(taskId, criteria))
  const frozen = freezeDesign(pkg, undefined)
  assert.equal(frozen.status, 'frozen')
  const design = frozen.design
  h.store.saveDesign(taskId, design)
  h.store.saveDesignApproval(taskId, {
    schema_version: 1,
    design_id: designId(design),
    decision: 'approved',
    reason: '测试替身：设计已核对',
    decided_by_session_id: 'session-1',
    decided_at: 1,
  })
  return designId(design)
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

describe('收口门禁：声明需要的能力缺项时，高风险任务拒绝收口', () => {
  /**
   * 一个声明了 `required_capabilities` 的 harness。
   *
   * `missing` 直接注入，不经过真实接缝——这条门禁判的是「声明 × 环境」，环境由调用方给出，
   * 因此这里测的是判定本身。真实环境的接线由入口那侧的报告测试钉着。
   *
   * @param {object} [options]
   * @param {string[]} [options.missing] - 缺哪些能力。
   * @param {boolean} [options.inject] - 是否注入这个访问器（缺省注入）。
   * @returns {object}
   */
  function capabilityHarness({ missing = [], inject = true } = {}) {
    const store = new TaskStore({ root: scratch() })
    const gaps = missing.map((id) => ({ id, description: `能力 ${id}`, absent: `缺了它：${id}` }))
    return {
      store,
      exec: { agent: { session: { id: 'session-1' } } },
      tool: createTaskTool({
        defineTool: identityDefineTool,
        taskStoreFor: () => store,
        sessionRootFor: () => store.root,
        ...(inject
          ? { capabilitiesFor: () => ({ required: missing, missing: gaps }) }
          : {}),
      }),
    }
  }

  /**
   * 建一个高风险任务（它的计划门禁要求 mode 与计划同时在）。
   *
   * @param {object} h
   * @param {string} [taskId]
   * @returns {Promise<object>}
   */
  async function createHighRisk(h, taskId = 'REQ-HR') {
    return h.tool.execute({
      action: 'create',
      task_id: taskId,
      mode: 'high_risk_task',
      plan: standardPlan(),
    }, h.exec)
  }

  it('拒因的每个字段都在 output.schema 里声明过 —— 否则整条拒因会被输出校验拒掉', async () => {
    // 活体踩到过：拒因里带了 `missing_capabilities` 而 schema 没声明，于是模型看到的是
    // `"value.missing_capabilities" is not a declared property`，而不是「缺了什么、为什么不能收口」。
    // 这与 `plan_id` 那次是同一个坑（那段注释就写在 schema 里），而单测全绿——因为测试用的
    // `defineTool` 是透传的，不做输出校验。这条断言把「返回什么」与「声明了什么」对起来。
    const h = capabilityHarness({ missing: ['workspace_observation'] })
    await createHighRisk(h)

    const value = await h.tool.execute({ action: 'complete', task_id: 'REQ-HR', evidence: {} }, h.exec)
    const declared = Object.keys(h.tool.output.schema.properties)

    assert.equal(value.action, 'complete_refused', '先确认这条路径真的走到了')
    for (const key of Object.keys(value)) {
      assert.ok(declared.includes(key), `字段 ${key} 没有在 output.schema 里声明`)
    }
  })

  it('高风险 + 缺项 + 没有豁免 → 拒绝，并说清缺的是什么、缺了它意味着什么', async () => {
    const h = capabilityHarness({ missing: ['workspace_observation'] })
    await createHighRisk(h)

    const value = await h.tool.execute({ action: 'complete', task_id: 'REQ-HR', evidence: {} }, h.exec)

    assert.equal(value.action, 'complete_refused')
    assert.ok(value.blockers.includes('GAC_COMPLETION_CAPABILITY_MISSING'))
    assert.deepEqual(value.missing_capabilities, ['workspace_observation'])
    assert.match(value.message, /缺了它：workspace_observation/u)
    assert.match(value.message, /capability_ack/u, '要告诉调用方怎么继续，而不是只说不行')
    assert.equal(h.store.load('REQ-HR').capability_ack, undefined, '被拒时不该留下豁免')
  })

  it('高风险 + 缺项 + 显式豁免 → 过这道门禁，且豁免留在任务记录里', async () => {
    const h = capabilityHarness({ missing: ['workspace_observation'] })
    await createHighRisk(h)

    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {},
      capability_ack: '本机 CI 装不了观测源，已知并接受',
    }, h.exec)

    // 这道门禁放行了：后面的拒绝（计划未冻结之类）不该是能力那条。
    assert.equal(value.blockers?.includes('GAC_COMPLETION_CAPABILITY_MISSING') ?? false, false)
    const ack = h.store.load('REQ-HR').capability_ack
    assert.equal(ack.reason, '本机 CI 装不了观测源，已知并接受')
    assert.deepEqual(ack.missing, ['workspace_observation'])
    assert.equal(typeof ack.at, 'number')
  })

  it('空白豁免不算豁免 —— 随便填个空格不能绕过门禁', async () => {
    const h = capabilityHarness({ missing: ['workspace_observation'] })
    await createHighRisk(h)

    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {},
      capability_ack: '   ',
    }, h.exec)

    assert.equal(value.action, 'complete_refused')
    assert.ok(value.blockers.includes('GAC_COMPLETION_CAPABILITY_MISSING'))
  })

  it('标准任务不受这条门禁管辖（它不要求独立验证与证据）', async () => {
    const h = capabilityHarness({ missing: ['workspace_observation'] })
    await createStandard(h)

    const value = await h.tool.execute({ action: 'complete', task_id: 'REQ-1', evidence: {} }, h.exec)

    assert.equal(value.blockers?.includes('GAC_COMPLETION_CAPABILITY_MISSING') ?? false, false)
  })

  it('没有注入访问器时这条门禁不生效 —— 生效与否必须能从接线看出来', async () => {
    const h = capabilityHarness({ missing: ['workspace_observation'], inject: false })
    await createHighRisk(h)

    const value = await h.tool.execute({ action: 'complete', task_id: 'REQ-HR', evidence: {} }, h.exec)

    assert.equal(value.blockers?.includes('GAC_COMPLETION_CAPABILITY_MISSING') ?? false, false)
  })

  it('豁免随记录落盘、重启后仍可审计', async () => {
    const h = capabilityHarness({ missing: ['workspace_observation'] })
    await createHighRisk(h)
    await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: {},
      capability_ack: '已知并接受',
    }, h.exec)

    // 换一个 store 实例读同一份盘上记录：这就是「重启之后还在不在」。
    const reloaded = new TaskStore({ root: h.store.root }).load('REQ-HR')
    assert.equal(reloaded.capability_ack.reason, '已知并接受')
    assert.deepEqual(reloaded.capability_ack.missing, ['workspace_observation'])
  })
})

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
      'create', 'grill', 'contract', 'plan', 'design', 'advance', 'reopen', 'review', 'status', 'list',
      'complete',
      // 只读审计：把链条从已落盘的产物与追加日志里派生出来（不新增存储）。
      'audit',
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
  return { schema_version: 1, id, tool: 'pwsh', is_error: false, exit_code: 0, case_results: Object.fromEntries(['用例解析空配置', '用例拒绝越界', '正例', '反例'].map(name => [name, { name, outcome: 'passed' }])), ...overrides }
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

describe('设计门禁 —— 未经批准的设计不能进入实施', () => {
  /**
   * 一个高风险任务，含实现与验证两个节点，**不带设计**。
   *
   * 这一组用例测的正是「没有设计时会发生什么」，所以这里刻意不预先批准设计。
   *
   * @param {object} h
   * @returns {Promise<object>}
   */
  function createDesignless(h) {
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

  /**
   * 冻一份设计在盘上，返回它。
   *
   * @param {object} h
   * @param {readonly string[]} [criteria]
   * @returns {object}
   */
  function freezeOnDisk(h, criteria = ['AC1']) {
    const frozen = freezeDesign(deepFreezeDesign(designPackageFor('REQ-HR', criteria)), undefined)
    assert.equal(frozen.status, 'frozen')
    h.store.saveDesign('REQ-HR', frozen.design)
    return frozen.design
  }

  /**
   * 造一份**自相矛盾**的设计包：架构承诺了 AC1 与 AC2，详设只提 AC1。
   *
   * 这正是活体验收里冻结下来的那一份的形状（14 条冲突里 6 条是空追溯表，其余是编号写成了长字符串）。
   * 它四份产物齐全、内容非空、引用契约也对，只看「齐不齐」是看不出来的。
   *
   * @returns {object}
   */
  function inconsistentDesignFor() {
    const artifact = (name, content, criteria) => compileDesignArtifact({
      artifact: name,
      content,
      traceability: criteria.map((id) => ({ criteria: id, where: '§1' })),
    })
    return compileDesignPackage({
      task_id: 'REQ-HR',
      requirement_ref: 'requirement-test',
      interface_contract_ref: 'contract-test',
      artifacts: {
        software_architecture: artifact('software_architecture', '架构：一个模块。', ['AC1', 'AC2']),
        software_detail: artifact('software_detail', '详设：一个函数。', ['AC1']),
        test_architecture: artifact('test_architecture', '测试架构：两条用例。', ['AC1', 'AC2']),
        test_detail: artifact('test_detail', '测试详设：正例与反例各一。', ['AC1', 'AC2']),
      },
      requirement_traceability: [
        { criteria: 'AC1', artifact: 'software_detail' },
        { criteria: 'AC2', artifact: 'software_architecture' },
      ],
      unresolved_issues: [],
    }, { criteria: ['AC1', 'AC2'], frozenAt: 1 })
  }

  it('没有设计包时实现节点被拦下，并说清下一步做什么', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'design_required')
    assert.deepEqual(value.nodes, ['T1'])
    assert.match(value.message, /还没有冻结的设计包/u)
    assert.equal(h.calls.length, 0)
  })

  it('设计冻了但没人裁决时仍然拦下，并指向裁决', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    freezeOnDisk(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'design_required')
    assert.match(value.message, /请由主会话作出裁决/u)
  })

  it('裁决挂在另一版设计上时算过期，不算批准', async () => {
    // 设计被修订后身份就变了，而旧裁决仍然躺在盘上、字段齐全、看起来完全正常。不比对身份，
    // 「改完设计再直接开工」就是一条不需要任何人批准的路。
    const h = dispatchHarness()
    await createDesignless(h)
    const design = freezeOnDisk(h)
    const other = designPackageFor('REQ-HR', ['AC1', 'AC2'])
    assert.notEqual(designId(other), designId(design))
    h.store.saveDesignApproval('REQ-HR', {
      schema_version: 1,
      design_id: designId(other),
      decision: 'approved',
      reason: '批准的是上一版',
    })
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'design_required')
    assert.match(value.message, /已被修订/u)
  })

  it('批准之后实现节点才开工', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    freezeOnDisk(h)
    const approved = await h.tool.execute({
      action: 'design',
      task_id: 'REQ-HR',
      design_action: 'approve',
      reason: '四份产物齐、追溯无缺口',
    }, h.exec)
    assert.equal(approved.action, 'design_approved')
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'dispatch')
    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1'])
  })

  it('自相矛盾的设计包既签不了批准，也进不了实施', async () => {
    // 活体验收里真实发生过：设计包以 `consistency_result.ok = false` 冻结（架构承诺的验收标准，
    // 详设里根本没有），而批准只看裁决在不在、裁的是不是这一版——于是自相矛盾的设计可以被批准
    // 并开工。一致性不是审核者的印象，它是「这份设计能不能被照着做」这件事本身。
    const h = dispatchHarness()
    await createDesignless(h)
    h.store.saveDesign('REQ-HR', inconsistentDesignFor())
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'design_required')
    assert.match(value.message, /设计包本身还不成立/u)
    assert.match(value.message, /自相矛盾/u)
    // 连批准也签不了：签下去的那一刻它就落盘了，而「报错的同时改动了治理状态」是最坏的一种失败。
    await assert.rejects(
      () => h.tool.execute({
        action: 'design', task_id: 'REQ-HR', design_action: 'approve', reason: '看着没问题',
      }, h.exec),
      /设计包本身还不成立/u,
    )
    // 但「回去改」正是对一份还不成立的设计该说的话。
    const revised = await h.tool.execute({
      action: 'design', task_id: 'REQ-HR', design_action: 'revise', reason: '详设漏了 AC2',
    }, h.exec)
    assert.equal(revised.action, 'design_revision_requested')
  })

  it('请求修订之后实现节点仍不开工', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    freezeOnDisk(h)
    const revised = await h.tool.execute({
      action: 'design',
      task_id: 'REQ-HR',
      design_action: 'revise',
      reason: '详设没有写清并发写怎么定序',
    }, h.exec)
    assert.equal(revised.action, 'design_revision_requested')
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'design_required')
    assert.match(value.message, /请由主会话作出裁决/u)
  })

  it('设计门禁只拦实现节点：盲的验证设计节点照常派遣', async () => {
    // 把验证设计一起拦住，等于把「设计与验证设计并行」这条已验收的性质换回串行。
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR',
      mode: 'high_risk_task',
      plan: {
        nodes: [
          { id: 'D1', objective: '从需求推导验证方案', role: 'verification_design', required_capabilities: ['verification'], write_scope: [] },
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        ],
      },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(value.action, 'dispatch')
    assert.deepEqual(h.calls.map((call) => call.node.id), ['D1'])
  })

  it('标准任务不需要设计', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'dispatch')
  })

  it('status 子动作在有没有设计时都给出可读的现状', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    const empty = await h.tool.execute({ action: 'design', task_id: 'REQ-HR' }, h.exec)
    assert.equal(empty.action, 'design_status')
    assert.equal(empty.design_id, undefined)
    assert.match(empty.message, /还没有冻结的设计包/u)

    const design = freezeOnDisk(h)
    const frozen = await h.tool.execute({ action: 'design', task_id: 'REQ-HR' }, h.exec)
    assert.equal(frozen.design_id, designId(design))
    assert.match(frozen.message, /还没有人对这份设计作出裁决/u)
  })

  it('裁决必须写明理由', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    freezeOnDisk(h)
    await assert.rejects(
      () => h.tool.execute({ action: 'design', task_id: 'REQ-HR', design_action: 'approve' }, h.exec),
      /必须写明 reason/u,
    )
    assert.equal(h.store.loadDesignApproval('REQ-HR'), undefined)
  })

  it('未知的 design 子动作被拒，而不是当成 status 悄悄过去', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    await assert.rejects(
      () => h.tool.execute({ action: 'design', task_id: 'REQ-HR', design_action: 'looks_good' }, h.exec),
      /未知的 design 子动作/u,
    )
  })

  it('子会话不能签发裁决：批准必须来自主会话', async () => {
    // 让派出设计的人自己批准它，等于让同一次推理既当作者又当审稿人。
    const h = dispatchHarness()
    await createDesignless(h)
    freezeOnDisk(h)
    const child = { agent: { session: { id: 'child-1', header: { parentSession: 'session-1' } } } }
    await assert.rejects(
      () => h.tool.execute({
        action: 'design',
        task_id: 'REQ-HR',
        design_action: 'approve',
        reason: '我自己批的',
      }, child),
      /必须由主会话签发/u,
    )
    assert.equal(h.store.loadDesignApproval('REQ-HR'), undefined)
  })

  it('还没有设计包时裁决被拒，而不是落下一份悬空的批准', async () => {
    const h = dispatchHarness()
    await createDesignless(h)
    await assert.rejects(
      () => h.tool.execute({
        action: 'design',
        task_id: 'REQ-HR',
        design_action: 'approve',
        reason: '批一下',
      }, h.exec),
      /没有可裁决的对象/u,
    )
  })
})

describe('验证计划门禁 —— 计划必须在实现之前', () => {
  /**
   * 一个高风险任务，含实现与验证两个节点。
   *
   * 这里先冻上一份设计并批准：本组用例测的是**计划**门禁，而高风险任务的实现节点在计划门禁之前
   * 还要过设计门禁（设计门禁自己有一组用例）。不先越过它，这些用例测到的会是一道与它们无关的门。
   *
   * @param {object} h
   * @returns {Promise<object>}
   */
  async function createHighRisk(h) {
    const created = await h.tool.execute({
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
    approveDesign(h, 'REQ-HR')
    return created
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
    // 本组测的是**验证证据**那一关：先越过设计门禁（它自己有一组用例），否则这些用例停在一道
    // 与它们无关的门上。
    approveDesign(h, 'REQ-HR')
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
    approveDesign(h, 'REQ-HR')
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, ['GAC_VERIFICATION_PLAN_MISSING'])
  })

  it('收口时没交验证载荷 → 报「没交载荷」，而不是「计划被改写」', async () => {
    // 活体验收实测到的误报：`complete` 里压根没有 `verification`，而拒因写的是「报告对应的不是当前
    // 计划（报告写的是 undefined）」——把读的人引向「有人改过计划」。盘上计划身份核对其实是 matches。
    // 两个码分开之后，读的人能直接看出缺的是载荷。
    const h = dispatchHarness()
    await reachAllDone(h)
    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: { all_criteria_covered: true },
    }, h.exec)
    assert.equal(value.action, 'complete_refused')
    assert.equal(value.blockers.includes('GAC_VERIFICATION_PAYLOAD_MISSING'), true)
    assert.equal(value.blockers.includes('GAC_VERIFICATION_PLAN_MUTATED'), false, '不该报成计划被改写')
    assert.match(value.message, /没有交验证载荷/u)
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
      requirement: '把配置字段删掉，删干净。AC1：删掉之后配置解析不再接受这个字段。',
    }, h.exec)
    assert.equal(value.action, 'requirement_frozen')
    assert.match(value.message, /AC1|1 条/u)
  })

  it('没有需求正文就不给冻结 —— 只存编号会让读不到实现的角色去猜', async () => {
    // 活体验收里真实发生过：`requirement` 是空字符串，`acceptance_criteria` 只有 `AC1`…`AC6`
    // 六个编号，于是不读实现的验证设计节点只能照契约里 operation 的顺序猜「编号↔口径」，
    // 交回来的计划与任务书的编号整体错位，而且**没有任何门禁看得出来**——形状完全正常。
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'converge' }, h.exec)
    await assert.rejects(
      () => h.tool.execute({
        action: 'grill',
        task_id: 'REQ-1',
        grill_action: 'confirm',
        confirmation: '可以，就按这个做',
        acceptance_criteria: ['AC1'],
      }, h.exec),
      (error) => error.code === 'GAC_GRILLING_MALFORMED' && /需求正文/u.test(error.message),
    )
  })

  it('冻结之后不能再追加轮次', async () => {
    const h = dispatchHarness()
    await createStandard(h)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', ...RECORD }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-1', grill_action: 'converge' }, h.exec)
    await h.tool.execute({
      action: 'grill', task_id: 'REQ-1', grill_action: 'confirm', confirmation: '可以',
      requirement: '把配置字段删掉。',
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
    approveDesign(h, 'REQ-HR')
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
    approveDesign(h, 'REQ-R')
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

describe('设计节点是验证计划的作者（语义不再倒置）', () => {
  const goodPlan = {
    cases: [
      { id: 'C1', covers: ['AC1'], type: 'positive', expect: '文件存在' },
      { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '文件缺失时应当判失败' },
    ],
  }

  /**
   * 一个按角色回不同产物的执行者。
   *
   * @param {object} [options]
   * @returns {object}
   */
  function designHarness({ plan = goodPlan } = {}) {
    return dispatchHarness({
      runtimeExecutors: [{
        name: 'verifier',
        supports: () => true,
        run: async ({ node }) => (node.role === 'verification_design'
          ? {
            status: 'completed',
            summary: '方案写好了',
            semantic: { role: 'verification_design', payload: { plan } },
          }
          : { status: 'completed', summary: '验证完成' }),
      }],
    })
  }

  /**
   * 一个高风险任务的计划：设计节点 + 执行节点。
   *
   * @param {object} [designOverrides]
   * @returns {object}
   */
  function highRiskPlan(designOverrides = {}) {
    return {
      nodes: [
        {
          id: 'D1',
          objective: '设计验证方案',
          required_capabilities: ['verification'],
          write_scope: [],
          ...designOverrides,
        },
        {
          id: 'V1',
          objective: '执行验证',
          required_capabilities: ['verification'],
          write_scope: [],
          depends_on: ['D1'],
        },
      ],
    }
  }

  /**
   * @param {object} h
   * @param {object} plan
   * @returns {Promise<object>}
   */
  function createHighRisk(h, plan) {
    return h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR-T',
      mode: 'high_risk_task',
      plan,
    }, h.exec)
  }

  it('显式声明为设计节点的，可以在没有冻结计划时开工；计划由它产出并自动冻结', async () => {
    const h = designHarness()
    await createHighRisk(h, highRiskPlan({ role: 'verification_design' }))

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR-T' }, h.exec)

    assert.notEqual(value.action, 'plan_required', `不该被计划门禁挡住：${value.message}`)
    assert.match(value.message, /已由设计节点冻结验证计划/u)
    assert.equal(h.store.hasPlan('REQ-HR-T'), true, '计划应当已经落盘')
    assert.equal(h.store.loadPlan('REQ-HR-T').cases.length, 2)
    assert.equal(h.store.load('REQ-HR-T').nodes.get('D1').status, 'completed')
  })

  it('**没声明角色**的验证节点仍然被计划门禁挡住 —— 那条豁免不能靠推断拿到', async () => {
    const h = designHarness()
    await createHighRisk(h, highRiskPlan())

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR-T' }, h.exec)

    assert.equal(value.action, 'plan_required')
    assert.equal(h.store.load('REQ-HR-T').nodes.get('D1').status, 'pending')
  })

  it('计划冻上之后，后续的验证节点照常被放行', async () => {
    const h = designHarness()
    await createHighRisk(h, highRiskPlan({ role: 'verification_design' }))
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR-T' }, h.exec)

    const second = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR-T' }, h.exec)

    assert.notEqual(second.action, 'plan_required')
    assert.equal(h.store.load('REQ-HR-T').nodes.get('V1').status, 'completed')
  })

  it('方案不合法 → 节点判失败，理由来自编译器，且盘上没有计划', async () => {
    // 反例没写 `expect_failure`：这是与验收标准无关的硬性拒绝。
    const h = designHarness({ plan: { cases: [{ id: 'C1', covers: ['AC1'], type: 'falsification' }] } })
    await createHighRisk(h, highRiskPlan({ role: 'verification_design' }))

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR-T' }, h.exec)

    assert.match(value.message, /验证方案被拒/u)
    assert.match(value.message, /expect_failure/u)
    assert.equal(h.store.hasPlan('REQ-HR-T'), false)
    assert.equal(h.store.load('REQ-HR-T').nodes.get('D1').status, 'failed')
  })

  it('与已冻结计划不同的第二份方案被拒 —— 计划一经冻结不得改写', async () => {
    const h = designHarness({ plan: { cases: [{ id: 'X1', covers: ['AC1'], type: 'positive', expect: 'x' }] } })
    await createHighRisk(h, highRiskPlan({ role: 'verification_design' }))
    await h.tool.execute({
      action: 'plan',
      task_id: 'REQ-HR-T',
      criteria: [],
      verification_plan: { cases: [{ id: 'P1', covers: ['AC1'], type: 'positive', expect: 'p' }] },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-HR-T' }, h.exec)

    assert.match(value.message, /计划一经冻结不得改写/u)
    assert.equal(h.store.load('REQ-HR-T').nodes.get('D1').status, 'failed')
  })
})

describe('验证与复核的语义产物由运行时自动登记', () => {
  const CASES = [
    { id: 'C1', covers: ['AC1'], type: 'positive', expect: '文件存在' },
    { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '文件缺失时应当判失败' },
  ]
  const CHILD = 'child-verify-1'

  /**
   * 高风险任务：设计节点产出计划，验证执行节点逐条给结论。
   *
   * @param {object} [options]
   * @param {object} [options.state] - 「子会话知道的计划 id」，由 `createAndDesign` 填。
   * @returns {object}
   */
  function verificationHarness({ executions = [
    { case_id: 'C1', outcome: 'passed', evidence_ref: 'self:1' },
    { case_id: 'C2', outcome: 'passed', evidence_ref: 'self:2' },
  ], state } = {}) {
    return dispatchHarness({
      // 子会话「第 1、2 次工具调用」对应的证据记录：运行时签发过、来自那个子会话。
      evidence: [
        { schema_version: 1, id: 'ev-11', session_id: CHILD, tool: 'pwsh', is_error: false, exit_code: 0 },
        { schema_version: 1, id: 'ev-12', session_id: CHILD, tool: 'pwsh', is_error: false, exit_code: 0 },
      ],
      runtimeExecutors: [{
        name: 'verifier',
        supports: () => true,
        run: async ({ node }) => {
          if (node.role === 'verification_design') {
            return {
              status: 'completed',
              summary: '方案',
              semantic: {
                role: 'verification_design',
                child_session_id: 'child-design-1',
                payload: { plan: { cases: CASES } },
              },
            }
          }
          // 计划 id 由**提示词**交给执行节点（`buildChildPrompt` 对执行角色会带上它），这里用
          // `state` 模拟「子会话照抄了它」——真实子会话拿到的是同一份东西。
          return {
            status: 'completed',
            summary: '逐条跑完了',
            semantic: {
              role: 'verification_execution',
              child_session_id: CHILD,
              payload: { plan_id: state?.planId, executions },
            },
          }
        },
      }],
    })
  }

  /**
   * 建任务、让设计节点冻计划，并把计划 id 交给「子会话」。
   *
   * @param {object} h
   * @param {object} state
   * @returns {Promise<void>}
   */
  async function createAndDesign(h, state) {
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-V',
      // 用 `standard_task`：计划门禁只对 `high_risk_task` 生效，而这个用例要验的是**语义产物的
      // 自动登记与收口消费**。计划一旦存在，收口的证据门禁照样生效（`needsVerification` 看的是
      // 「有没有计划」），所以这里仍然是完整的那条链，只是不必再配一份复核报告。
      mode: 'standard_task',
      plan: {
        nodes: [
          {
            id: 'D1',
            objective: '设计方案',
            required_capabilities: ['verification'],
            write_scope: [],
            role: 'verification_design',
          },
          {
            id: 'V1',
            objective: '执行方案',
            required_capabilities: ['verification'],
            write_scope: [],
            depends_on: ['D1'],
          },
        ],
      },
    }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-V' }, h.exec)
    const { planId } = await import('../lib/verification.js')
    state.planId = planId(h.store.loadPlan('REQ-V'))
  }

  it('验证子会话报 self:<n>，运行时解析成真实签发的号并登记验证报告', async () => {
    const state = { planId: undefined }
    const h = verificationHarness({ state })
    await createAndDesign(h, state)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-V' }, h.exec)

    assert.match(value.message, /已登记验证报告（2 条用例/u)
    const report = h.store.loadVerification('REQ-V')
    assert.equal(report.plan_id, state.planId, '计划 id 必须是运行时冻结的那一个')
    assert.deepEqual(report.executions.map((entry) => entry.evidence_ref), ['ev-11', 'ev-12'])
    assert.equal(report.source_session_id, CHILD)
  })

  it('收口直接用运行时登记的那份报告 —— 父会话不必再手写载荷', async () => {
    const state = { planId: undefined }
    const h = verificationHarness({ state })
    await createAndDesign(h, state)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-V' }, h.exec)

    const done = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-V',
      evidence: { all_criteria_covered: true },
    }, h.exec)

    assert.equal(done.action, 'completed', `不该被证据门禁拒：${done.message}`)
  })

  it('计划 id 对不上 → 当场判失败，而不是一路滑到收口', async () => {
    const h = verificationHarness({ state: { planId: 'plan-deadbeef' } })
    await createAndDesign(h, { planId: undefined })

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-V' }, h.exec)

    assert.match(value.message, /验证报告对不上当前计划/u)
    assert.equal(h.store.hasVerification('REQ-V'), false)
  })

  it('解析不到的引用 → 节点判失败，且盘上没有验证报告', async () => {
    const state = { planId: undefined }
    const h = verificationHarness({
      state,
      executions: [
        { case_id: 'C1', outcome: 'passed', evidence_ref: 'self:99' },
        { case_id: 'C2', outcome: 'passed', evidence_ref: 'self:2' },
      ],
    })
    await createAndDesign(h, state)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-V' }, h.exec)

    assert.match(value.message, /证据引用解析不到/u)
    assert.equal(h.store.hasVerification('REQ-V'), false)
    assert.equal(h.store.load('REQ-V').nodes.get('V1').status, 'failed')
  })

  it('两条用例共用一份证据 → 被同一套校验拒掉（取证摊薄）', async () => {
    const state = { planId: undefined }
    const h = verificationHarness({
      state,
      executions: [
        { case_id: 'C1', outcome: 'passed', evidence_ref: 'self:1' },
        { case_id: 'C2', outcome: 'passed', evidence_ref: 'self:1' },
      ],
    })
    await createAndDesign(h, state)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-V' }, h.exec)

    assert.match(value.message, /验证报告被拒/u)
    assert.equal(h.store.hasVerification('REQ-V'), false)
  })

  it('复核节点交回六问五维，运行时自动登记，并盖上它自己观察到的计划 id', async () => {
    const h = dispatchHarness({
      executors: { implementation: ['builder'], verification: ['verifier'], review: ['reviewer'] },
      runtimeExecutors: [{
        name: 'reviewer',
        supports: () => true,
        run: async ({ node }) => (node.role === 'review'
          ? {
            status: 'completed',
            summary: '复核完成',
            semantic: { role: 'review', child_session_id: 'child-review-1', payload: reviewDraft() },
          }
          : { status: 'completed', summary: '实现完成' }),
      }],
    })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-R',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
          {
            id: 'R1',
            objective: '复核',
            required_capabilities: ['review'],
            write_scope: [],
            depends_on: ['T1'],
            role: 'review',
          },
        ],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-R' }, h.exec)
    // 复核节点依赖实现节点，因此在**第二批**才被派遣。
    const second = await h.tool.execute({ action: 'advance', task_id: 'REQ-R' }, h.exec)

    assert.match(second.message, /已登记独立复核报告/u, `第一批：${value.message}`)
    const report = h.store.loadReview('REQ-R')
    assert.ok(report !== undefined, '复核报告应当已经落盘')
    assert.equal(report.source_session_id, 'child-review-1')
    assert.equal(report.reviewed_plan_id, undefined, '这个任务没有计划，盖的就是 undefined')
  })

  it('复核产出里带的传输字段（status）不能把整份报告撞掉 —— 两个契约各有各的字段', async () => {
    // 高风险流程第二轮活体验收实测：复核节点把六问五维全答了、81 次只读调用全做完，报告却因为
    // 多带一个 `status`（产出契约要求它，复核报告的字段表里没有它）被判 MALFORMED，整份被拒。
    const h = dispatchHarness({
      executors: { implementation: ['builder'], verification: ['verifier'], review: ['reviewer'] },
      runtimeExecutors: [{
        name: 'reviewer',
        supports: () => true,
        run: async () => ({
          status: 'completed',
          summary: '复核完成',
          semantic: {
            role: 'review',
            child_session_id: 'child-review-2',
            // 产出契约里的形状：status 在顶层，报告字段也在顶层。
            payload: { status: 'completed', ...reviewDraft() },
          },
        }),
      }],
    })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-R2',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'R1', objective: '复核', required_capabilities: ['review'], write_scope: [], role: 'review' },
        ],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-R2' }, h.exec)

    assert.match(value.message, /已登记独立复核报告/u)
    assert.ok(h.store.loadReview('REQ-R2') !== undefined)
  })

  it('复核报告的 evidence 用 self:<n>#明细 时由运行时解析成真实号（第三轮活体就断在这道缝上）', async () => {
    // 复核者照提示词交 `self:<n>`，而收口门禁拿 `evidence` 里的字符串逐字比对运行时发过的号——
    // 不解析就必然判「不是运行时发出过的证据号」，于是收口被挡，而唯一补救办法是父会话手工重登。
    const h = dispatchHarness({
      executors: { implementation: ['builder'], verification: ['verifier'], review: ['reviewer'] },
      evidence: [
        { schema_version: 1, id: 'ev-21', session_id: 'child-review-9', tool: 'pwsh', is_error: false, exit_code: 0 },
        { schema_version: 1, id: 'ev-22', session_id: 'child-review-9', tool: 'pwsh', is_error: false, exit_code: 0 },
      ],
      runtimeExecutors: [{
        name: 'reviewer',
        supports: () => true,
        run: async () => ({
          status: 'completed',
          summary: '复核完成',
          semantic: {
            role: 'review',
            child_session_id: 'child-review-9',
            payload: {
              status: 'completed',
              ...reviewDraft(),
              // 复核报告的引用形式是「证据号#明细」，明细是复核者自己写的说明，必须原样保留。
              evidence: ['self:1# 目录枚举与字节读回', 'self:2# 证据账本逐条重建'],
            },
          },
        }),
      }],
    })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-R4',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'R1', objective: '复核', required_capabilities: ['review'], write_scope: [], role: 'review' },
        ],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-R4' }, h.exec)

    assert.match(value.message, /已登记独立复核报告/u)
    assert.deepEqual(h.store.loadReview('REQ-R4').evidence, [
      'ev-21# 目录枚举与字节读回',
      'ev-22# 证据账本逐条重建',
    ])
  })

  it('复核报告真的缺答案时仍然被拒（白名单不等于放水）', async () => {
    const h = dispatchHarness({
      executors: { implementation: ['builder'], verification: ['verifier'], review: ['reviewer'] },
      runtimeExecutors: [{
        name: 'reviewer',
        supports: () => true,
        run: async () => ({
          status: 'completed',
          summary: '复核完成',
          semantic: {
            role: 'review',
            child_session_id: 'child-review-3',
            payload: { status: 'completed', summary: '复核完成' },
          },
        }),
      }],
    })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-R3',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'R1', objective: '复核', required_capabilities: ['review'], write_scope: [], role: 'review' },
        ],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-R3' }, h.exec)

    assert.match(value.message, /复核报告被拒/u)
    assert.equal(h.store.hasReview('REQ-R3'), false)
  })
})

describe('冻结需求时传错参数名会被响亮拒绝（活体验收里静默丢了 2 条验收标准）', () => {
  it('用 criteria 而不是 acceptance_criteria 传标准 → 拒绝并指出正确字段名', async () => {
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-GRILL',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        ],
      },
    }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-GRILL', grill_action: 'record', round: { questions: [{ id: 'Q1', question: '验收标准是什么', answer: 'AC1/AC2' }] } }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-GRILL', grill_action: 'converge' }, h.exec)

    await assert.rejects(
      async () => h.tool.execute({
        action: 'grill',
        task_id: 'REQ-GRILL',
        grill_action: 'confirm',
        confirmation: '就按这个做',
        criteria: ['AC1', 'AC2'],
      }, h.exec),
      /acceptance_criteria/u,
    )
  })
})

describe('时间戳不能是 0（活体验收的复核报告如实记过这条缺口）', () => {
  it('建任务、冻需求、冻计划、冻契约四处都写下真实时刻', async () => {
    // 缺省值是 `0`，而工具层原先一处都没传 `now`——于是盘上「什么时候冻的」全都答不出来。
    // 复核报告把它记为缺口而非阻塞问题，这类缺口不会挡住任何门禁，只会让事后审计无从下手。
    const before = Date.now()
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-TS',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        ],
      },
    }, h.exec)
    await h.tool.execute({
      action: 'grill',
      task_id: 'REQ-TS',
      grill_action: 'record',
      round: { questions: [{ id: 'Q1', question: '验收标准是什么', answer: 'AC1' }] },
    }, h.exec)
    await h.tool.execute({ action: 'grill', task_id: 'REQ-TS', grill_action: 'converge' }, h.exec)
    await h.tool.execute({
      action: 'grill',
      task_id: 'REQ-TS',
      grill_action: 'confirm',
      confirmation: '就按这个做',
      acceptance_criteria: ['AC1'],
      requirement: '把配置字段删掉。AC1：删掉之后配置解析不再接受这个字段。',
    }, h.exec)
    await h.tool.execute({
      action: 'contract',
      task_id: 'REQ-TS',
      contract_action: 'freeze',
      interface_contract: {
        name: 'demo',
        operations: [{ name: 'op', signature: 'op(): void', behavior: '做点什么' }],
      },
    }, h.exec)
    await h.tool.execute({
      action: 'plan',
      task_id: 'REQ-TS',
      criteria: ['AC1'],
      verification_plan: {
        cases: [
          { id: 'C1', covers: ['AC1'], type: 'positive', expect: '文件存在' },
          { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '文件缺失应当判失败' },
        ],
      },
    }, h.exec)
    const after = Date.now()

    for (const [label, value] of [
      ['created_at', h.store.load('REQ-TS').created_at],
      ['frozen_at（需求）', h.store.loadGrilling('REQ-TS').frozen_at],
      ['frozen_at（计划）', h.store.loadPlan('REQ-TS').frozen_at],
      ['frozen_at（契约）', h.store.loadContract('REQ-TS').frozen_at],
    ]) {
      assert.ok(
        typeof value === 'number' && value >= before && value <= after,
        `${label} 应当是真实时刻，收到 ${value}`,
      )
    }
  })
})

describe('create 的下一步话术说准顺序（活体验收里父会话先调 grill 连吃三次「找不到任务」）', () => {
  it('建完任务后指出 grill 与 contract 作用于已存在的任务，再讲派遣', async () => {
    const h = dispatchHarness()
    const value = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-ORDER',
      mode: 'standard_task',
      plan: {
        nodes: [
          { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        ],
      },
    }, h.exec)

    assert.match(value.message, /都作用于\*\*已存在\*\*的任务/u)
    assert.match(value.message, /grill/u)
    assert.match(value.message, /contract/u)
  })
})

describe('审计动作：把链条从盘上派生出来（只读，不新增存储）', () => {
  it('时间线来自追加日志（按任务筛过），缺口来自盘上事实', async () => {
    const store = new TaskStore({ root: scratch() })
    const { compileTask } = await import('../lib/coordinator.js')
    store.save(compileTask({
      task_id: 'REQ-AUD',
      mode: 'standard_task',
      nodes: [
        { id: 'T1', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
      ],
    }), { create: true })
    const tool = createTaskTool({
      defineTool: (options) => options,
      taskStoreFor: () => store,
      sessionRootFor: () => store.root,
      // 生产环境里这两个依赖都在；测试直接造工具，所以按最小形状给上。
      adapterFor: () => ({ execution: { require_contract: [] } }),
      evidenceFor: () => [],
      eventLogFor: () => ({
        load: () => [
          { at: 5, type: 'gac/task-created', data: { task_id: 'REQ-AUD', mode: 'standard_task' } },
          { at: 9, type: 'gac/task-created', data: { task_id: '别的任务', mode: 'standard_task' } },
        ],
      }),
    })
    const exec = { agent: { session: { id: 'session-1' } } }

    const value = await tool.execute({ action: 'audit', task_id: 'REQ-AUD' }, exec)

    assert.equal(value.action, 'audit')
    assert.equal(value.timeline.length, 1, '时间线只该有这个任务的事件')
    assert.match(value.timeline[0].summary, /建立任务/u)
    assert.equal(value.ok, false)
    assert.equal(value.gaps.some((gap) => /需求未冻结/u.test(gap)), true)
    assert.equal(value.gaps.some((gap) => /没有验证计划/u.test(gap)), true)
    // **只读**：审计不改任何状态。
    assert.equal(store.load('REQ-AUD').status, 'pending')
  })
})

describe('失败节点的返回文本 —— 不写成「执行完成」，且带出可追溯信息', () => {
  it('结论与措辞一致，并带出执行者给的可追溯信息', async () => {
    // 活体验收实测到的那句自相矛盾：「节点 T1 由 child:spawn 执行完成。 T1 失败…」——读的人第一句
    // 就得到相反的结论；而子会话 id 与「绑了什么作用域」在失败分支里一个字都没出现。
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async () => ({
          status: 'failed',
          summary: '做不到',
          detail: '子会话 child-x；已绑定写作用域 [src/]',
        }),
      }],
    })
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)

    assert.match(value.message, /执行结束（结论 failed）/u)
    assert.doesNotMatch(value.message, /执行完成/u)
    assert.match(value.message, /子会话 child-x/u)
    assert.match(value.message, /已绑定写作用域/u)
  })
})

describe('同一批真的并行 —— 不是「协调器算了两个、执行排着队」', () => {
  /**
   * 冻结一份最小接口契约（同批两个写者必须先过这道门禁）。
   *
   * @param {object} h
   * @param {string} taskId
   * @returns {Promise<object>}
   */
  function freezeContractFor(h, taskId) {
    return h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: taskId,
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)
  }

  it('第二个节点在第一个跑完之前就已启动', async () => {
    // 这条钉的是实现侧的伪并行：`resolveReady` 明明把两个写范围不相交的节点算进同一批，而派遣循环
    // 原先是 `for … await`，等于一个跑完再起第二个。原生子会话的 `start()` 返回带 `result` 的 run，
    // 本来就允许同时持有多个——所以「逻辑并行 ≠ 实际并行」在这里是**我们的**问题，不是平台限制。
    const events = []
    const executor = {
      name: 'builder',
      supports: () => true,
      run: async ({ node }) => {
        events.push(`start:${node.id}`)
        await new Promise((resolve) => { setTimeout(resolve, 25) })
        events.push(`end:${node.id}`)
        return { status: 'completed', summary: `${node.id} 完成` }
      },
    }
    const h = dispatchHarness({ runtimeExecutors: [executor] })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-PAR',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '甲', required_capabilities: ['implementation'], write_scope: ['a/'] },
        { id: 'T2', objective: '乙', required_capabilities: ['implementation'], write_scope: ['b/'] },
      ] },
    }, h.exec)
    // 同一批里有两个写者，所以要先冻结接口契约——这条门禁本身是对的（各自发明接口就会分叉），
    // 本用例要验的是「契约冻上之后，两个节点是真的同时开工」。
    await freezeContractFor(h, 'REQ-PAR')
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-PAR' }, h.exec)

    assert.deepEqual(events.filter((entry) => entry.startsWith('start')), ['start:T1', 'start:T2'])
    assert.ok(
      events.indexOf('start:T2') < events.indexOf('end:T1'),
      `第二个节点必须在第一个跑完之前就已启动；实际顺序：${events.join(' → ')}`,
    )
    assert.deepEqual(value.classifications, ['accepted', 'accepted'])
  })

  it('同批的结果按批次顺序登记，任务记录的写入仍然串行', async () => {
    // 启动重叠，但记录写入保持确定性：先收哪个、后收哪个不能随调度漂移。
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async ({ node }) => ({ status: 'completed', summary: `${node.id} 完成` }),
      }],
    })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-PAR2',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '甲', required_capabilities: ['implementation'], write_scope: ['a/'] },
        { id: 'T2', objective: '乙', required_capabilities: ['implementation'], write_scope: ['b/'] },
      ] },
    }, h.exec)
    await freezeContractFor(h, 'REQ-PAR2')
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-PAR2' }, h.exec)
    const dispatched = value.transitions.filter((entry) => entry.kind === 'dispatched').map((entry) => entry.node_id)
    const reported = value.transitions.filter((entry) => entry.kind === 'reported').map((entry) => entry.node_id)
    assert.deepEqual(dispatched, ['T1', 'T2'])
    assert.deepEqual(reported, ['T1', 'T2'], '回顾报必须按批次顺序，不随调度漂移')
  })
})

describe('受控自动推进 —— max_waves 声明一次调用最多连走几波', () => {
  /**
   * 建一条两段的链：T1 实现完成后 T2 才就绪。
   *
   * 只有 T1 一个写者，所以不会撞上接口契约门禁——这个 describe 要验的是推进节奏，
   * 不是门禁。
   *
   * @param {object} h
   * @param {string} taskId
   * @returns {Promise<object>}
   */
  function createChain(h, taskId) {
    return h.tool.execute({
      action: 'create',
      task_id: taskId,
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '实现功能', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'T2', objective: '独立验证', depends_on: ['T1'], required_capabilities: ['verification'], write_scope: [] },
      ] },
    }, h.exec)
  }

  it('缺省只走一波，与从前一字不差', async () => {
    const h = dispatchHarness()
    await createChain(h, 'REQ-W1')
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-W1' }, h.exec)

    assert.equal(h.calls.length, 1, '缺省 max_waves 时不连走')
    assert.deepEqual(value.classifications, ['accepted'])
    assert.equal(value.action, 'dispatch', '还有活儿可以推，但这一波到此为止')
    assert.ok(!value.message.includes('自动连走'), '没连走就不该说连走')
  })

  it('max_waves: 2 时连着走两波，一次调用把 T1 与 T2 都跑完', async () => {
    const h = dispatchHarness()
    await createChain(h, 'REQ-W2')
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-W2', max_waves: 2 }, h.exec)

    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1', 'T2'])
    assert.deepEqual(value.classifications, ['accepted', 'accepted'])
    assert.ok(
      value.message.includes('自动连走了 2 波'),
      `连走了几波必须说出来，否则调用方读不出这一份记录覆盖了几波；实际：${value.message}`,
    )
    assert.notEqual(value.action, 'dispatch', '两波之后 T2 也跑完了，不该还说「还有活儿」')
  })

  it('这一波里有节点失败时立刻停，哪怕波数还没走满', async () => {
    // 三节点：T1 失败、T2 完成、T3 依赖 T2。这样第一波之后**仍然**有就绪节点（T3），
    // `nextAction` 说的是 `dispatch`——只有「有坏消息就停」这一条能拦住第二波。
    // 换句话说，这条用例是专门为那条判据写的：没有它，循环会照常推下去。
    //
    // 自己记一遍调用：`dispatchHarness` 的 `calls` 是它自带执行者记的，这里换了执行者。
    const seen = []
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async ({ node }) => {
          seen.push(node.id)
          return node.id === 'T1'
            ? { status: 'failed', summary: '没做成' }
            : { status: 'completed', summary: `${node.id} 完成` }
        },
      }],
    })
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-W3',
      mode: 'standard_task',
      plan: { nodes: [
        { id: 'T1', objective: '实现功能', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'T2', objective: '先看一遍', required_capabilities: ['verification'], write_scope: [] },
        { id: 'T3', objective: '再看一遍', depends_on: ['T2'], required_capabilities: ['verification'], write_scope: [] },
      ] },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-W3', max_waves: 5 }, h.exec)

    assert.deepEqual(seen, ['T1', 'T2'], '失败之后不能再推第二波')
    assert.deepEqual(value.classifications, ['accepted', 'accepted'])
    assert.ok(!value.message.includes('自动连走'), '只走了一波，不说连走')
  })

  it('门禁拦下整批时立刻停 —— 需要裁决的事不能替调用者决定', async () => {
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-W4',
      mode: 'high_risk_task',
      plan: { nodes: [
        { id: 'T1', objective: '实现功能', required_capabilities: ['implementation'], write_scope: ['src/'] },
      ] },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-W4', max_waves: 5 }, h.exec)

    assert.equal(value.action, 'design_required')
    assert.equal(h.calls.length, 0)
    assert.ok(!value.message.includes('自动连走'))
  })

  it('非法 max_waves 被响亮拒绝，而不是静默截断', async () => {
    const h = dispatchHarness()
    await createChain(h, 'REQ-W5')

    for (const bad of [0, -1, 1.5, '2', true, 21]) {
      await assert.rejects(
        () => h.tool.execute({ action: 'advance', task_id: 'REQ-W5', max_waves: bad }, h.exec),
        /max_waves/u,
        `${JSON.stringify(bad)} 应当被拒绝`,
      )
    }
    assert.equal(h.calls.length, 0, '被拒绝的调用不该已经派遣过任何东西')
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

  it('原生子会话执行只读节点时不收权主协调会话', async () => {
    const { guard, syncs } = recordingGuard()
    const h = dispatchHarness({ roleGuard: guard, runtimeExecutors: [COMPLETES, STAYS_IN_PROGRESS], adapterExtras: { execution: { native_child_dispatch: true } } })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(syncs.at(-1).readOnlyNodes, [])
    assert.equal(syncs.at(-1).sessionId, 'session-1')
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

  it('派遣消息里带上仍在等回报的派遣身份 —— 否则模型拿不到它要回报的东西', async () => {
    // 活体实测发现的：`dispatch_id` 只在结构化产出里，而模型读的是渲染出来的文本。于是「回报结果
    // 时必须带上派遣时发给你的 dispatch_id」这句要求，在工具这一侧是空的——子 agent 只能去读
    // `.dsh/gac/tasks/<id>.json`。一条要求模型回报它看不见的东西的规则，等于制造一次必然失败的回报。
    const h = dispatchHarness({ runtimeExecutors: [COMPLETES, STAYS_IN_PROGRESS] })
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.match(value.message, /等待回报的派遣身份/u)
    assert.match(value.message, /T2=REQ-1-T2-A1/u)
  })

  it('进程内执行者当场报完时，不把那串已经没用的身份塞进消息', async () => {
    // 身份已经作废，列出来只是噪声——而噪声会让真正需要看见的那一条被跳过。
    const h = dispatchHarness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.doesNotMatch(value.message, /等待回报的派遣身份/u)
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

  it('执行者抛错 → 按失败登记，而不是让整次 advance 变成一条裸 Error', async () => {
    // 活体验收实测过这一幕：子会话的产出契约被宿主拒绝，执行者里抛出的异常一路穿到工具层，
    // `advance` 只回一条 Error，节点停在 pending、没有 dispatch_id、也没有失败记录。执行者抛错
    // 就是执行失败——要能被登记、能被读出来。
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async () => { throw new Error('契约被宿主拒绝') },
      }],
    })
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.match(value.message, /抛错/u)
    assert.match(value.message, /契约被宿主拒绝/u)
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'failed', '节点应当被登记为失败')
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

describe('构建者分类 —— 实现与测试不由同一个节点产出', () => {
  /**
   * 一个声明了测试路径的适配器。
   *
   * 分类的判据只有适配器声明的 `authority.test_paths` 一处：不声明就完全不分类，
   * 于是已有工程的行为一个字节都不变。
   *
   * @param {readonly string[]} [testPaths]
   * @returns {object}
   */
  function scopedHarness(testPaths) {
    return dispatchHarness({
      adapterExtras: testPaths === undefined ? {} : { authority: { test_paths: testPaths } },
    })
  }

  /** 一条只含单个节点的计划。 */
  function planWith(nodes) {
    return { nodes }
  }

  it('一个节点同时写产品与测试时，任务根本建不起来', async () => {
    // 拒的是「同一次推理既写实现又写测试」：测试会照着实现的形状写，于是它验证的只是
    // 「实现和它自己一致」，而需求有没有被满足根本没被问到。给它挑一边等于把这个问题藏起来。
    const h = scopedHarness(['test/'])
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-1',
        mode: 'standard_task',
        plan: planWith([
          {
            id: 'T1',
            objective: '把实现和它的测试一起写掉',
            required_capabilities: ['implementation'],
            write_scope: ['src/', 'test/'],
          },
        ]),
      }, h.exec),
      (error) => {
        assert.equal(error.code, BUILDER_CODES.SCOPE_CLASS_MIXED)
        assert.match(error.message, /T1/u)
        // 跨类的两条来源措辞必须分开：这里是「一条测试加一条产品」，不是「某一条自己跨了」。
        assert.match(error.message, /同时含产品路径 src\/ 与测试路径 test\//u)
        assert.match(error.message, /任务未建立/u)
        return true
      },
    )
    // 拒绝要发生在落盘之前：半份任务比没有任务更难收拾。
    assert.equal(h.store.load('REQ-1'), undefined)
  })

  it('整仓写范围（"."）也跨了两类', async () => {
    const h = scopedHarness(['test/'])
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-1',
        mode: 'standard_task',
        plan: planWith([
          { id: 'T1', objective: '随便改', required_capabilities: ['implementation'], write_scope: ['.'] },
        ]),
      }, h.exec),
      (error) => {
        assert.equal(error.code, BUILDER_CODES.SCOPE_CLASS_MIXED)
        // 这一条是「某一条路径自己跨了」：整仓写范围既在改产品、又在改测试。
        assert.match(error.message, /既不在测试路径 \[test\/\] 之内、又与它相交/u)
        return true
      },
    )
  })

  it('拆成两个节点之后通过，而且两个都进同一批', async () => {
    const h = scopedHarness(['test/'])
    const created = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-1',
      mode: 'standard_task',
      plan: planWith([
        { id: 'S1', objective: '写实现', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'T1', objective: '写测试', required_capabilities: ['implementation'], write_scope: ['test/'] },
      ]),
    }, h.exec)
    assert.equal(created.action, 'created')
    // 两个写者并行，于是还要先冻结接口契约（这一条是既有门禁，与本轮无关）。
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-1',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)
    // 分成两个节点之后，两个写范围不相交，于是它们**并行**而不是串行——这正是拆开的好处。
    // 一批派遣完两个节点，`dispatchAndInvoke` 返回的是这一轮之后的下一个动作，所以这里看的是
    // 「谁被真的调用了」而不是 `action`（两个都跑完之后它就是 `complete_task`）。
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.deepEqual(h.calls.map((call) => call.node.id).sort(), ['S1', 'T1'])
    assert.equal(value.classifications.length, 2)
  })

  it('适配器没声明测试路径时，同一份计划照旧通过', async () => {
    // 「没声明就完全不分类」是这条判据的边界：不声明不是「没有测试」，而是「本工程不区分这两类」。
    const h = dispatchHarness()
    const created = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-1',
      mode: 'standard_task',
      plan: planWith([
        {
          id: 'T1',
          objective: '实现和测试一起写',
          required_capabilities: ['implementation'],
          write_scope: ['src/', 'test/'],
        },
      ]),
    }, h.exec)
    assert.equal(created.action, 'created')
  })

  it('非实现节点跨类不拦', async () => {
    // 这条判据问的是「谁写产品、谁写测试」，所以它只审实现节点：设计节点写什么由它自己的
    // 工具面决定，验证与复核节点压根不写。
    const h = scopedHarness(['test/'])
    const created = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-1',
      mode: 'standard_task',
      plan: planWith([
        {
          id: 'D1',
          objective: '出验证方案',
          role: 'verification_design',
          required_capabilities: ['verification'],
          write_scope: ['src/', 'test/'],
        },
      ]),
    }, h.exec)
    assert.equal(created.action, 'created')
  })
})

describe('设计换版 —— 照旧版做完的活儿不能算进新版名下', () => {
  /** 一个高风险任务：T1 实现、T2 依赖它的独立验证。 */
  function createHighRisk(h) {
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

  /**
   * 把盘上的设计换成另一版，返回新版 id。
   *
   * 旧的那份必须显式删除：`saveDesign` 拒绝覆盖（设计是下游开工的输入，就地改写会让已经照它
   * 开工的分支对着一份不存在的设计干活）。这与 `saveContract` / `savePlan` 是同一套语义。
   *
   * @param {object} h
   * @param {readonly string[]} criteria
   * @returns {string}
   */
  function replaceDesign(h, criteria) {
    const frozen = freezeDesign(deepFreezeDesign(designPackageFor('REQ-HR', criteria)), undefined)
    assert.equal(frozen.status, 'frozen')
    rmSync(join(h.store.designDirectory, 'design-REQ-HR.json'), { force: true })
    h.store.saveDesign('REQ-HR', frozen.design)
    return designId(frozen.design)
  }

  it('交结果时设计已换版 → 结果作废，节点退回待派遣', async () => {
    // 执行者报「还没做完」，于是节点停在 in_progress，可以手工交一份结果回来。
    const h = dispatchHarness({
      runtimeExecutors: [{
        name: 'builder',
        supports: () => true,
        run: async () => ({ status: 'in_progress', summary: '还没做完' }),
      }],
    })
    await createHighRisk(h)
    const oldId = approveDesign(h, 'REQ-HR')
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)

    const dispatched = h.store.load('REQ-HR').nodes.get('T1')
    assert.equal(dispatched.status, 'in_progress')
    assert.equal(dispatched.execution.design_ref, oldId, '派遣时该把依据的那一版设计记下来')

    replaceDesign(h, ['AC1', 'AC2'])

    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-HR',
      report: {
        node_id: 'T1',
        dispatch_id: dispatched.execution.active_dispatch_id,
        status: 'completed',
      },
    }, h.exec)

    assert.match(value.message, /结果作废/u)
    // 退回待派遣之后，新版设计还没被批准，于是这一轮先停在设计门禁上。
    assert.equal(value.action, 'design_required')
    const bounced = h.store.load('REQ-HR').nodes.get('T1')
    assert.equal(bounced.status, 'pending')
    assert.equal(bounced.execution.active_dispatch_id, null)
  })

  it('收口拦下依据旧版设计做完的活儿，并且排在证据门禁之前', async () => {
    const h = dispatchHarness()
    await createHighRisk(h)
    const oldId = approveDesign(h, 'REQ-HR')
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    const t1 = h.store.load('REQ-HR').nodes.get('T1')
    assert.equal(t1.status, 'completed')
    assert.equal(t1.execution.design_ref, oldId)

    replaceDesign(h, ['AC1', 'AC2'])

    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: { all_criteria_covered: true },
    }, h.exec)

    assert.equal(value.action, 'complete_refused')
    assert.deepEqual(value.blockers, [DESIGN_CODES.STALE_RESULT])
    assert.match(value.message, /旧版设计/u)
    // 排在证据门禁之前是有意的：设计换了版，下面那些验证证据与复核报告都是对着旧版实现做的，
    // 这时报「证据不齐」会把调用方支去补一份马上要被作废的证据。
    assert.equal(value.blockers.includes('GAC_VERIFICATION_PLAN_MISSING'), false)
  })

  it('只对实现节点生效：设计节点照旧版设计做完的活儿不算作废', async () => {
    // 反例。设计角色的活儿就是产出设计，它开工时还没有设计包（`design_ref` 记的是当时那一版，
    // 也可能是 null）；把「依据旧版」这套判据套到它头上，等于说「你自己交的设计过时了」。
    const h = dispatchHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-HR',
      mode: 'high_risk_task',
      plan: {
        nodes: [{
          id: 'D1',
          objective: '出验证方案',
          role: 'verification_design',
          required_capabilities: ['verification'],
          write_scope: [],
        }],
      },
    }, h.exec)
    approveDesign(h, 'REQ-HR')
    await h.tool.execute({ action: 'advance', task_id: 'REQ-HR' }, h.exec)
    assert.equal(h.store.load('REQ-HR').nodes.get('D1').status, 'completed')

    replaceDesign(h, ['AC1', 'AC2'])

    const value = await h.tool.execute({
      action: 'complete',
      task_id: 'REQ-HR',
      evidence: { all_criteria_covered: true },
    }, h.exec)

    assert.equal(value.action, 'complete_refused')
    assert.equal(
      value.blockers.includes(DESIGN_CODES.STALE_RESULT),
      false,
      '设计节点不该被「依据旧版设计」拦下',
    )
    // 它被拦在计划门禁上——高风险任务本来就要有验证计划。
    assert.deepEqual(value.blockers, ['GAC_VERIFICATION_PLAN_MISSING'])
  })
})

describe('create 的拆分判据 —— 提示与拒绝是两种东西，不能互相冒充', () => {
  /**
   * 一个声明了测试路径的 harness。
   *
   * 拆分判据本身不读适配器（它读的是任务的形状：节点数、写范围、登记的验收标准），
   * 但**跨类拒绝**那一条读，而两组行为在同一个 `create` 路径上，所以这里统一接一个
   * 声明了测试路径的适配器：跨类那条用例靠着它生效，其余用例不受影响。
   *
   * @returns {object}
   */
  function splitHarness() {
    return dispatchHarness({ adapterExtras: { authority: { test_paths: ['test/'] } } })
  }

  /**
   * 一个实现节点的计划条目。
   *
   * @param {string} id
   * @param {string} path
   * @returns {object}
   */
  function writer(id, path) {
    return {
      id,
      objective: `写 ${path}`,
      required_capabilities: ['implementation'],
      write_scope: [path],
    }
  }

  /**
   * 从返回里读出全部文本，供「说了什么 / 没说什么」这类断言使用。
   *
   * 断言写在文本而不是字段名上是有意的：提示字段的确切名字属于实现细节，而 `create`
   * 的返回已经被 schema 钉住（`additionalProperties: false`）。字段名那一侧的保证由
   * `test/worker-split.test.js` 里「返回的每个字段都在 schema 里声明过」那条用例单独守着。
   *
   * @param {object} value
   * @returns {string}
   */
  function text(value) {
    const parts = []
    const visit = (node) => {
      if (typeof node === 'string') parts.push(node)
      else if (Array.isArray(node)) for (const entry of node) visit(entry)
      else if (node !== null && typeof node === 'object') for (const entry of Object.values(node)) visit(entry)
    }
    visit(value)
    return parts.join('\n')
  }

  it('过拆提示不改判：命中时任务照样建立、节点一个不少', async () => {
    // 提示与拒绝的分界是本轮改动的关键：既有那些门禁都是拒绝，而这两条判据是提示。
    // 一个「提示」若顺手把任务拒了，它就是一个伪装成建议的门禁。
    const h = splitHarness()
    const nodes = Array.from({ length: 11 }, (_, index) => writer(`T${index + 1}`, `lib/mod-${index + 1}.js`))
    const value = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-OVER',
      mode: 'standard_task',
      plan: { nodes },
    }, h.exec)

    assert.equal(value.action, 'created')
    assert.equal(h.store.load('REQ-OVER').nodes.size, 11)
  })

  it('**已经足够小的任务不被提示过拆** —— 单节点任务无话说', async () => {
    // 反例方向：能拆的最小形态。任何在这里冒出来的劝合并都是噪声，
    // 而噪声会让真正需要被看见的那一条被跳过。
    const h = splitHarness()
    const value = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-SMALL',
      mode: 'standard_task',
      plan: { nodes: [writer('T1', 'lib/small.js')] },
    }, h.exec)

    assert.equal(value.action, 'created')
    assert.doesNotMatch(
      text(value),
      /过拆|拆得过细|节点过多|拆成更少|合并节点|归口|集成节点|共享文件/u,
      `足够小的任务不该收到任何拆分提示；实际返回：${text(value)}`,
    )
  })

  it('共享文件归口是提示，不是拒绝：任务建立后仍可推进', async () => {
    // 契约要求「两级判据都不得拒绝任务创建」。这条用例把「不拒绝」与「还能继续走」
    // 一起钉住——一个不拒绝但让任务卡死的实现同样是坏的。
    const h = splitHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-SHARED',
      mode: 'standard_task',
      plan: { nodes: [writer('T1', 'lib/entry.js'), writer('T2', 'lib/entry.js')] },
    }, h.exec)
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-SHARED',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-SHARED' }, h.exec)
    assert.deepEqual(value.classifications, ['accepted'], '任务必须能继续推进')
  })

  it('归口提示指向的是集成节点，而不是「串行跑两遍」', async () => {
    // 串行与归口解决的是两个不同的问题：串行保证两者不同时写，归口保证两边写的东西
    // 被合在一起看过。只说「冲突了」会把调用方引向前者，而它的真实毛病是后者。
    const h = splitHarness()
    const value = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-ENTRY',
      mode: 'standard_task',
      plan: { nodes: [writer('T1', 'lib/entry.js'), writer('T2', 'lib/entry.js')] },
    }, h.exec)

    assert.equal(value.action, 'created')
    assert.match(
      text(value),
      /归口|集成节点/u,
      `共享文件命中的是归口要求，不是一句「冲突了」；实际返回：${text(value)}`,
    )
  })

  it('跨产品与测试路径仍被拒 —— 新增判据不得把这条拒绝变成提示', async () => {
    // 本轮最要紧的「不得回退」：新增的两条都是提示，而这一条是**拒绝**。
    // 把新增的提示逻辑写宽一点、顺手把这条也降级成提示，正是最可能发生的回退方式。
    const h = splitHarness()
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-MIXED',
        mode: 'standard_task',
        plan: {
          nodes: [{
            id: 'T1',
            objective: '把实现和它的测试一起写掉',
            required_capabilities: ['implementation'],
            write_scope: ['src/', 'test/'],
          }],
        },
      }, h.exec),
      (error) => {
        assert.equal(error.code, BUILDER_CODES.SCOPE_CLASS_MIXED)
        assert.match(error.message, /任务未建立/u)
        return true
      },
    )
    assert.equal(h.store.load('REQ-MIXED'), undefined, '拒绝必须发生在落盘之前')
  })

  it('写路径冲突的节点不会被同批派遣 —— 提示不替代既有的互斥保证', async () => {
    // 归口是建议，写范围互斥是保证。判据加上之后，后者一个字节都不能变。
    const h = splitHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'REQ-SERIAL',
      mode: 'standard_task',
      plan: { nodes: [writer('T1', 'lib/same.js'), writer('T2', 'lib/same.js')] },
    }, h.exec)
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-SERIAL',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-SERIAL' }, h.exec)
    assert.equal(
      h.calls.length,
      1,
      `同一份写路径上只能有一个节点在飞；实际：${h.calls.map((call) => call.node.id).join('、')}`,
    )
    assert.deepEqual(value.classifications, ['accepted'])
  })

  it('返回里出现的每个字段都在 output.schema 里声明过', async () => {
    // 这个坑在活体上翻版过三次（`plan_id`、`design_id`、审计视图）：输出的
    // `additionalProperties` 是 `false`，一个没声明的字段会让**整条返回**被拒掉，
    // 而单测因为 `defineTool` 是透传的照样全绿。提示型判据天生就是「多返回一个字段」，
    // 所以这条守在这里。
    const h = splitHarness()
    const value = await h.tool.execute({
      action: 'create',
      task_id: 'REQ-SCHEMA',
      mode: 'standard_task',
      plan: { nodes: [writer('T1', 'lib/entry.js'), writer('T2', 'lib/entry.js')] },
    }, h.exec)

    const declared = Object.keys(h.tool.output.schema.properties)
    for (const key of Object.keys(value)) {
      assert.ok(declared.includes(key), `字段 ${key} 没有在 output.schema 里声明`)
    }
  })
})
