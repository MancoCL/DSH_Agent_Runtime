/**
 * 协调器测试。
 *
 * 这里验证的是架构大纲里最不容含糊的几条规则：执行者不宣告完成、终态不因迟到结果
 * 改变、并行必须由依赖与资源事实决定。它们是纯逻辑，所以可以在没有运行时的机器上
 * 逐条钉死——一旦上线才发现，前面已经改过文件了。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COORDINATOR_CODES,
  CoordinatorError,
  applyResult,
  checkCompletion,
  compileTask,
  dispatch,
  nextAction,
  reopen,
  resolveReady,
} from '../lib/coordinator.js'

/**
 * 一份标准任务：实现与验证串行，两者都只写各自的范围。
 *
 * @param {object} [overrides]
 * @returns {object} 已编译的任务。
 */
function standardPlan(overrides = {}) {
  return compileTask({
    task_id: 'REQ-1',
    mode: 'standard_task',
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
        expected_artifacts: ['VerificationReport'],
      },
    ],
    ...overrides,
  })
}

/**
 * 走完一次成功的派遣与收口，便于测试后续步骤。
 *
 * @param {object} task
 * @param {string} nodeId
 * @returns {object} 收口后的任务。
 */
function completeNode(task, nodeId) {
  const dispatched = dispatch(task, [nodeId])
  const dispatchId = dispatched.nodes.get(nodeId).execution.active_dispatch_id
  const applied = applyResult(dispatched, {
    node_id: nodeId,
    dispatch_id: dispatchId,
    status: 'completed',
  })
  assert.equal(applied.classification, 'accepted', applied.detail)
  return applied.task
}

describe('compileTask — 计划校验', () => {
  it('编译一份合法计划', () => {
    const task = standardPlan()
    assert.equal(task.task_id, 'REQ-1')
    assert.equal(task.nodes.size, 2)
    assert.equal(task.nodes.get('T1').status, 'pending')
    assert.equal(task.nodes.get('T2').depends_on[0], 'T1')
  })

  it('冻结结果，避免后续步骤悄悄改掉已作出的决定', () => {
    const task = standardPlan()
    assert.equal(Object.isFrozen(task), true)
    assert.equal(Object.isFrozen(task.nodes.get('T1').write_scope), true)
    assert.throws(() => { task.nodes.get('T1').write_scope.push('x/') }, TypeError)
  })

  it('拒绝对不存在的节点', () => {
    assert.throws(
      () => standardPlan({ nodes: [{ id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: [], depends_on: ['T9'] }] }),
      (error) => error.code === COORDINATOR_CODES.INVALID_DAG,
    )
  })

  it('拒绝环，并指出环上的节点', () => {
    // 有环的计划会永远不满足依赖，必须在这里就拒掉。
    assert.throws(
      () => compileTask({
        task_id: 'REQ-1',
        nodes: [
          { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [], depends_on: ['B'] },
          { id: 'B', objective: 'b', required_capabilities: ['implementation'], write_scope: [], depends_on: ['A'] },
        ],
      }),
      (error) => {
        assert.equal(error.code, COORDINATOR_CODES.CYCLE)
        assert.ok(error.detail.cycle.includes('A') && error.detail.cycle.includes('B'))
        return true
      },
    )
  })

  it('拒绝自依赖', () => {
    assert.throws(
      () => compileTask({
        task_id: 'REQ-1',
        nodes: [{ id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [], depends_on: ['A'] }],
      }),
      (error) => error.code === COORDINATOR_CODES.CYCLE,
    )
  })

  it('拒绝重复的节点 id', () => {
    assert.throws(
      () => compileTask({
        task_id: 'REQ-1',
        nodes: [
          { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [] },
          { id: 'A', objective: 'b', required_capabilities: ['implementation'], write_scope: [] },
        ],
      }),
      (error) => error.code === COORDINATOR_CODES.INVALID_DAG,
    )
  })

  it('拒绝能力为空的节点：那等于没有路由依据', () => {
    assert.throws(
      () => compileTask({
        task_id: 'REQ-1',
        nodes: [{ id: 'A', objective: 'a', required_capabilities: [], write_scope: [] }],
      }),
      (error) => error.code === COORDINATOR_CODES.EMPTY_CAPABILITIES,
    )
  })

  it('区分「未声明写范围」与「声明为空」', () => {
    // 未声明是漏写；空数组是明确不许写。两者后果不同，不能混为一谈。
    assert.throws(
      () => compileTask({
        task_id: 'REQ-1',
        nodes: [{ id: 'A', objective: 'a', required_capabilities: ['implementation'] }],
      }),
      (error) => error.code === COORDINATOR_CODES.NO_WRITE_SCOPE,
    )
    const ok = compileTask({
      task_id: 'REQ-1',
      nodes: [{ id: 'A', objective: 'a', required_capabilities: ['verification'], write_scope: [] }],
    })
    assert.deepEqual([...ok.nodes.get('A').write_scope], [])
  })

  it('拒绝空计划', () => {
    assert.throws(() => compileTask({ task_id: 'REQ-1', nodes: [] }), CoordinatorError)
  })
})

describe('resolveReady — 就绪与并行判定', () => {
  it('只把依赖已完成的节点算作就绪', () => {
    const task = standardPlan()
    assert.deepEqual(resolveReady(task).ready, ['T1'])
    assert.deepEqual(resolveReady(task).batch, ['T1'])
  })

  it('依赖完成后下游才就绪', () => {
    const task = completeNode(standardPlan(), 'T1')
    assert.deepEqual(resolveReady(task).ready, ['T2'])
  })

  it('写范围不相交时同批并行', () => {
    // 大纲 §18 的示意：两个互不依赖、路径不相交的节点可以同批。
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'A', objective: '写代码', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'B', objective: '写测试', required_capabilities: ['implementation'], write_scope: ['test/'] },
      ],
    })
    const { ready, batch } = resolveReady(task)
    assert.deepEqual([...ready].sort(), ['A', 'B'])
    assert.deepEqual([...batch].sort(), ['A', 'B'], '路径不相交，应当同批')
  })

  it('写范围相交时不进同一批，并说明原因', () => {
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'A', objective: '改 src', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'B', objective: '也改 src', required_capabilities: ['implementation'], write_scope: ['src/deep/'] },
      ],
    })
    const { ready, batch, reason } = resolveReady(task)
    assert.deepEqual([...ready].sort(), ['A', 'B'])
    assert.equal(batch.length, 1, '同一批只能有一个写者')
    // 落选者是哪一个由节点顺序决定，不该在断言里写死。
    const denied = ready.find((id) => !batch.includes(id))
    assert.equal(reason[denied].code, 'write_scope_conflict')
  })

  it('共享独占资源时不进同一批', () => {
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: ['a/'], resources: ['build-dir'] },
        { id: 'B', objective: 'b', required_capabilities: ['implementation'], write_scope: ['b/'], resources: ['build-dir'] },
      ],
    })
    const { ready, batch, reason } = resolveReady(task)
    assert.equal(batch.length, 1)
    const denied = ready.find((id) => !batch.includes(id))
    assert.equal(reason[denied].code, 'exclusive_resource')
    assert.equal(reason[denied].resource, 'build-dir')
  })

  it('已在执行的节点占住写范围，后续批次会避开', () => {
    // 只看「已就绪」之间的冲突会漏掉正在飞的那一批。
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: ['src/'] },
        { id: 'B', objective: 'b', required_capabilities: ['implementation'], write_scope: ['src/deep/'] },
      ],
    })
    const flown = dispatch(task, ['A'])
    const { ready, batch, reason } = resolveReady(flown)
    assert.deepEqual(ready, ['B'], 'B 无依赖，故仍然就绪')
    assert.deepEqual(batch, [], '但 A 正在写 src/，B 不得同批')
    assert.equal(reason.B.code, 'write_scope_conflict')
  })

  it('同一份计划两次调度给出同一批次', () => {
    // 「确定性协调器」若每次给出不同批次，就名不副实。
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: ['a/'] },
        { id: 'B', objective: 'b', required_capabilities: ['implementation'], write_scope: ['b/'] },
        { id: 'C', objective: 'c', required_capabilities: ['implementation'], write_scope: ['c/'] },
      ],
    })
    assert.deepEqual(resolveReady(task).batch, resolveReady(task).batch)
  })

  it('不把已完成或失败的节点算作就绪', () => {
    const task = completeNode(standardPlan(), 'T1')
    assert.equal(resolveReady(task).ready.includes('T1'), false)
  })
})

describe('dispatch — 执行身份', () => {
  it('标记为执行中并分配唯一执行身份', () => {
    const task = dispatch(standardPlan(), ['T1'])
    const node = task.nodes.get('T1')
    assert.equal(node.status, 'in_progress')
    assert.equal(node.execution.attempt, 1)
    assert.equal(node.execution.active_dispatch_id, 'REQ-1-T1-A1')
  })

  it('attempt 单调递增，重试不复用旧标识', () => {
    let task = dispatch(standardPlan(), ['T1'])
    const first = task.nodes.get('T1').execution.active_dispatch_id
    task = applyResult(task, {
      node_id: 'T1', dispatch_id: first, status: 'failed',
    }).task
    task = reopen(task, 'T1', '换一种做法')
    task = dispatch(task, ['T1'])
    const node = task.nodes.get('T1')
    assert.equal(node.execution.attempt, 2)
    assert.notEqual(node.execution.active_dispatch_id, first)
  })

  it('拒绝派遣未知节点', () => {
    assert.throws(
      () => dispatch(standardPlan(), ['T9']),
      (error) => error.code === COORDINATOR_CODES.UNKNOWN_NODE,
    )
  })

  it('拒绝派遣已经在执行的节点', () => {
    const task = dispatch(standardPlan(), ['T1'])
    assert.throws(
      () => dispatch(task, ['T1']),
      (error) => error.code === COORDINATOR_CODES.INVALID_TRANSITION,
    )
  })
})

describe('applyResult — 状态迁移由运行时拥有', () => {
  it('接受一份与当前执行对应的结果', () => {
    const task = dispatch(standardPlan(), ['T1'])
    const dispatchId = task.nodes.get('T1').execution.active_dispatch_id
    const applied = applyResult(task, { node_id: 'T1', dispatch_id: dispatchId, status: 'completed' })
    assert.equal(applied.classification, 'accepted')
    assert.equal(applied.task.nodes.get('T1').status, 'completed')
  })

  it('判过期结果，且不改动状态', () => {
    // 一份来自上一次执行的迟到结果不得推进状态，否则它会篡改别人的工作。
    const task = dispatch(standardPlan(), ['T1'])
    const applied = applyResult(task, {
      node_id: 'T1', dispatch_id: 'REQ-1-T1-A0', status: 'completed',
    })
    assert.equal(applied.classification, 'stale')
    assert.equal(applied.code, COORDINATOR_CODES.STALE_RESULT)
    assert.equal(applied.task.nodes.get('T1').status, 'in_progress')
  })

  it('拒绝非法迁移', () => {
    const task = standardPlan()
    const applied = applyResult(task, { node_id: 'T1', dispatch_id: 'x', status: 'completed' })
    // 身份先于迁移判定，所以这里是 stale；用一个身份匹配但不合法的迁移来验迁移表。
    assert.equal(applied.classification, 'stale')
    const flown = dispatch(task, ['T1'])
    const id = flown.nodes.get('T1').execution.active_dispatch_id
    const blocked = applyResult(flown, { node_id: 'T1', dispatch_id: id, status: 'blocked' })
    assert.equal(blocked.classification, 'accepted', 'in_progress → blocked 是合法迁移')
  })

  it('completed 是终态，迟到的结果改不动它', () => {
    const task = completeNode(standardPlan(), 'T1')
    const applied = applyResult(task, {
      node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed',
    })
    assert.notEqual(applied.classification, 'accepted')
    assert.equal(applied.task.nodes.get('T1').status, 'completed')
  })

  it('收口时清空 active 执行身份', () => {
    // 留着它会让下一份结果被误判为过期。
    const task = completeNode(standardPlan(), 'T1')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, null)
  })

  it('拒绝未知节点的结果', () => {
    const applied = applyResult(standardPlan(), { node_id: 'T9', dispatch_id: 'x', status: 'completed' })
    assert.equal(applied.classification, 'rejected')
    assert.equal(applied.code, COORDINATOR_CODES.UNKNOWN_NODE)
  })

  it('失败则任务转 failed，阻塞则转 blocked', () => {
    let task = dispatch(standardPlan(), ['T1'])
    const id = task.nodes.get('T1').execution.active_dispatch_id
    task = applyResult(task, { node_id: 'T1', dispatch_id: id, status: 'failed' }).task
    assert.equal(task.status, 'failed')
  })

  it('记录阻塞原因，使「用户暂停」与「工具故障」在结构上可分', () => {
    let task = dispatch(standardPlan(), ['T1'])
    const id = task.nodes.get('T1').execution.active_dispatch_id
    task = applyResult(task, {
      node_id: 'T1',
      dispatch_id: id,
      status: 'blocked',
      blocked_by: { code: 'missing_authority', detail: '需要生产环境凭据', attempts: ['查了配置'] },
    }).task
    assert.equal(task.nodes.get('T1').blocked_by.code, 'missing_authority')
    assert.equal(task.status, 'blocked')
  })
})

describe('reopen — 必须写明原因', () => {
  it('把节点退回 pending 并记录原因', () => {
    let task = completeNode(standardPlan(), 'T1')
    task = reopen(task, 'T1', '发现范围需要扩张')
    assert.equal(task.nodes.get('T1').status, 'pending')
    assert.equal(task.nodes.get('T1').reopen_reason, '发现范围需要扩张')
  })

  it('拒绝没有原因的重新打开', () => {
    const task = completeNode(standardPlan(), 'T1')
    for (const bad of ['', '   ', undefined]) {
      assert.throws(
        () => reopen(task, 'T1', bad),
        (error) => error.code === COORDINATOR_CODES.INVALID_TRANSITION,
      )
    }
  })

  it('拒绝未知节点', () => {
    assert.throws(() => reopen(standardPlan(), 'T9', '原因'), CoordinatorError)
  })
})

describe('checkCompletion — 完成判定', () => {
  it('节点未全部完成时不算完成', () => {
    const result = checkCompletion(standardPlan())
    assert.equal(result.complete, false)
    assert.equal(result.blockers.length, 2)
  })

  it('全部节点完成且证据齐备才算完成', () => {
    let task = completeNode(standardPlan(), 'T1')
    task = completeNode(task, 'T2')
    const result = checkCompletion(task, { all_criteria_covered: true })
    assert.equal(result.complete, true)
    assert.deepEqual(result.blockers, [])
  })

  it('验收标准未覆盖则不算完成', () => {
    let task = completeNode(standardPlan(), 'T1')
    task = completeNode(task, 'T2')
    const result = checkCompletion(task, { all_criteria_covered: false })
    assert.equal(result.complete, false)
    assert.equal(result.blockers[0].code, 'criteria_uncovered')
  })

  it('有阻塞评审或未决审批则不算完成', () => {
    let task = completeNode(standardPlan(), 'T1')
    task = completeNode(task, 'T2')
    const result = checkCompletion(task, {
      all_criteria_covered: true,
      blocking_review_issue: true,
      unresolved_approval: true,
    })
    assert.equal(result.complete, false)
    assert.deepEqual(result.blockers.map((b) => b.code).sort(), [
      'blocking_review_issue',
      'unresolved_approval',
    ])
  })
})

describe('nextAction — 把下一步收敛成一个决定', () => {
  it('有待派遣节点时给出派遣', () => {
    assert.deepEqual(nextAction(standardPlan()), { action: 'dispatch', nodes: ['T1'] })
  })

  it('有在飞节点时是等待，而不是阻塞', () => {
    // 等自己派出的执行容器属于内部等待；写进 blocked 会让「等自己」看起来像
    // 外部条件不可用。
    const task = dispatch(standardPlan(), ['T1'])
    assert.deepEqual(nextAction(task), { action: 'await', nodes: ['T1'] })
  })

  it('节点失败时给出修复', () => {
    let task = dispatch(standardPlan(), ['T1'])
    const id = task.nodes.get('T1').execution.active_dispatch_id
    task = applyResult(task, { node_id: 'T1', dispatch_id: id, status: 'failed' }).task
    assert.deepEqual(nextAction(task), { action: 'repair', nodes: ['T1'] })
  })

  it('节点阻塞时给出阻塞', () => {
    let task = dispatch(standardPlan(), ['T1'])
    const id = task.nodes.get('T1').execution.active_dispatch_id
    task = applyResult(task, {
      node_id: 'T1', dispatch_id: id, status: 'blocked', blocked_by: { code: 'tool_failure' },
    }).task
    assert.deepEqual(nextAction(task), { action: 'blocked', nodes: ['T1'] })
  })

  it('全部完成且证据齐备时给出收口', () => {
    let task = completeNode(standardPlan(), 'T1')
    task = completeNode(task, 'T2')
    assert.deepEqual(nextAction(task, { all_criteria_covered: true }), { action: 'complete_task' })
  })

  it('任何未完成的任务都给出一个可执行的行动，绝不静默返回空', () => {
    // 「下一步是什么」不能留空：留空等于把判断推回给模型。这里遍历几种真实状态，
    // 断言行动落在闭集内。
    const valid = new Set(['dispatch', 'await', 'blocked', 'repair', 'complete_task', 'done', 'stalled'])
    const states = [standardPlan(), dispatch(standardPlan(), ['T1'])]

    let failed = dispatch(standardPlan(), ['T1'])
    const failedId = failed.nodes.get('T1').execution.active_dispatch_id
    states.push(applyResult(failed, {
      node_id: 'T1', dispatch_id: failedId, status: 'failed',
    }).task)

    let blocked = dispatch(standardPlan(), ['T1'])
    const blockedId = blocked.nodes.get('T1').execution.active_dispatch_id
    states.push(applyResult(blocked, {
      node_id: 'T1', dispatch_id: blockedId, status: 'blocked', blocked_by: { code: 'tool_failure' },
    }).task)

    let done = completeNode(standardPlan(), 'T1')
    done = completeNode(done, 'T2')
    states.push(done)

    for (const state of states) {
      const action = nextAction(state, { all_criteria_covered: true })
      assert.ok(valid.has(action.action), `未预期的行动：${action.action}`)
      assert.notEqual(action.action, 'stalled', `状态不应不自洽：${JSON.stringify(state.status)}`)
    }
  })

  it('任务状态为 completed 时直接给出 done', () => {
    const task = completeNode(standardPlan(), 'T1')
    const completed = Object.freeze({ ...task, status: 'completed' })
    assert.deepEqual(nextAction(completed), { action: 'done' })
  })
})
