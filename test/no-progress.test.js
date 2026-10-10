import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/task-store.js'
import { dispatch } from '../lib/coordinator.js'
import {
  NO_PROGRESS_CODES,
  NO_PROGRESS_DEFAULTS,
  createProgressWatch,
  createTaskTool,
  resolveNoProgressThresholds,
} from '../lib/tool-task.js'

/**
 * 一个最小可用的任务工具：只要一个项目根、一个存储。
 *
 * @param {object} [options]
 * @param {object|null} [options.noProgress] - 适配器 `execution.no_progress`。
 * @returns {{root: string, store: object, tool: object, exec: object}}
 */
function fixture({ noProgress } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gac-noprog-'))
  const store = new TaskStore({ root })
  const tool = createTaskTool({
    defineTool: (value) => value,
    taskStoreFor: () => store,
    sessionRootFor: () => root,
    adapterFor: () => (noProgress === undefined ? {} : { execution: { no_progress: noProgress } }),
    executorsFor: () => [],
  })
  return { root, store, tool, exec: { agent: { session: { id: 'owner' } } } }
}

/**
 * 建一个只有 `pending` 节点的任务。
 *
 * @param {object} tool
 * @param {object} exec
 * @param {string} taskId
 * @returns {Promise<object>}
 */
function createTask(tool, exec, taskId) {
  return tool.execute({
    action: 'create',
    task_id: taskId,
    plan: {
      nodes: [{
        id: 'T1',
        objective: '实现 T1',
        required_capabilities: ['implementation'],
        write_scope: ['src/t1.js'],
      }],
    },
  }, exec)
}

/** 一份会撞上 GAC_TASK_ALREADY_EXISTS 的计划（同一个 task_id 再建一次）。 */
const duplicatePlan = {
  nodes: [{
    id: 'T9',
    objective: '另一个节点',
    required_capabilities: ['implementation'],
    write_scope: ['src/t9.js'],
  }],
}

test('无进展阈值：默认值可覆盖，非法值忽略，null 显式关掉', () => {
  assert.deepEqual(resolveNoProgressThresholds(undefined), { ...NO_PROGRESS_DEFAULTS })
  assert.deepEqual(resolveNoProgressThresholds({ repeat_limit: 5 }), {
    repeat_limit: 5,
    failure_limit: NO_PROGRESS_DEFAULTS.failure_limit,
  })
  assert.deepEqual(resolveNoProgressThresholds({ repeat_limit: null }), {
    repeat_limit: null,
    failure_limit: NO_PROGRESS_DEFAULTS.failure_limit,
  })
  // 手滑写成的非法阈值一律忽略：被静默接受的 `0` 会变成「永不限制」，
  // 那会让这一节看起来配好了、实际什么都没做。
  assert.equal(resolveNoProgressThresholds({ repeat_limit: '3' }).repeat_limit, NO_PROGRESS_DEFAULTS.repeat_limit)
  assert.equal(resolveNoProgressThresholds({ repeat_limit: 0 }).repeat_limit, NO_PROGRESS_DEFAULTS.repeat_limit)
  assert.equal(resolveNoProgressThresholds({ repeat_limit: -1 }).repeat_limit, NO_PROGRESS_DEFAULTS.repeat_limit)
})

test('看门狗：同一指纹连续三次才算重复，指纹一变就归零并解除失败限制', () => {
  const watch = createProgressWatch({ now: () => 1000 })
  assert.equal(watch.observe({ sessionId: 's', taskId: 't', fingerprint: 'a' }).limited, false)
  assert.equal(watch.observe({ sessionId: 's', taskId: 't', fingerprint: 'a' }).limited, false)
  const third = watch.observe({ sessionId: 's', taskId: 't', fingerprint: 'a' })
  assert.equal(third.limited, true)
  assert.equal(third.repeat, 3)
  // 新事件 → 归零
  assert.equal(watch.observe({ sessionId: 's', taskId: 't', fingerprint: 'b' }).limited, false)

  // 同一个动作同一个错误第三次之后拒绝再执行；换了错误码不共用计数。
  assert.equal(watch.recordFailure({ sessionId: 's', taskId: 't', action: 'create', code: 'GAC_TASK_ALREADY_EXISTS' }).refused, false)
  assert.equal(watch.recordFailure({ sessionId: 's', taskId: 't', action: 'create', code: 'GAC_TASK_ALREADY_EXISTS' }).refused, false)
  assert.equal(watch.recordFailure({ sessionId: 's', taskId: 't', action: 'create', code: 'GAC_TASK_ALREADY_EXISTS' }).refused, true)
  assert.equal(watch.recordFailure({ sessionId: 's', taskId: 't', action: 'create', code: 'GAC_DAG_CYCLE' }).refused, false)
  assert.deepEqual(watch.refuse({ sessionId: 's', taskId: 't', action: 'create' }), {
    count: 3,
    code: 'GAC_TASK_ALREADY_EXISTS',
  })
  assert.equal(watch.refuse({ sessionId: 's', taskId: 't', action: 'advance' }), undefined, '限制按动作隔离')
  // 真实新事件到达后解除限制（否则一次失败会把模型永久锁在门外）。
  watch.observe({ sessionId: 's', taskId: 't', fingerprint: 'c' })
  assert.equal(watch.refuse({ sessionId: 's', taskId: 't', action: 'create' }), undefined)
})

test('连续无效状态查询触发限制：第三次起不再重复转述同一份状态', async () => {
  const { root, tool, exec } = fixture()
  try {
    await createTask(tool, exec, 'p1')
    const first = await tool.execute({ action: 'status', task_id: 'p1' }, exec)
    const second = await tool.execute({ action: 'status', task_id: 'p1' }, exec)
    assert.equal(first.no_progress, undefined)
    assert.equal(second.no_progress, undefined)
    const third = await tool.execute({ action: 'status', task_id: 'p1' }, exec)
    assert.equal(third.no_progress.code, NO_PROGRESS_CODES.REPEATED_QUERY)
    assert.equal(third.no_progress.repeat, 3)
    assert.match(third.message, /无进展/u)
    assert.match(third.message, /结束本轮/u)
    assert.match(third.message, /不要用 Start-Sleep 或循环查询/u)
    // 数组形状不变（有别的测试按 `id:status` 断言），attempt 之类只进文本。
    assert.deepEqual(third.nodes, ['T1:pending'])
    const fourth = await tool.execute({ action: 'status', task_id: 'p1' }, exec)
    assert.equal(fourth.no_progress.repeat, 4)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('限制查询不动状态：节点既不失败也不阻塞，只是不再重复作答', async () => {
  const { root, store, tool, exec } = fixture()
  try {
    await createTask(tool, exec, 'p2')
    for (let i = 0; i < 4; i += 1) await tool.execute({ action: 'status', task_id: 'p2' }, exec)
    const task = store.load('p2')
    assert.equal(task.status, 'pending')
    assert.equal(task.nodes.get('T1').status, 'pending')
    assert.equal(task.nodes.get('T1').execution.last_failure, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('有新事件就归零：派遣之后同一次状态不再是「重复查询」', async () => {
  const { root, store, tool, exec } = fixture()
  try {
    await createTask(tool, exec, 'p3')
    for (let i = 0; i < 3; i += 1) await tool.execute({ action: 'status', task_id: 'p3' }, exec)
    const limited = await tool.execute({ action: 'status', task_id: 'p3' }, exec)
    assert.equal(limited.no_progress.code, NO_PROGRESS_CODES.REPEATED_QUERY)
    // 真实新事件：节点被派遣（状态、attempt、生命周期都变了）。
    const dispatched = dispatch(store.load('p3'), ['T1'], undefined, null, { ownerSessionId: 'owner', at: 5000 })
    store.save(dispatched)
    const after = await tool.execute({ action: 'status', task_id: 'p3' }, exec)
    assert.equal(after.no_progress, undefined)
    assert.deepEqual(after.nodes, ['T1:in_progress'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('同一个错误连续三次停止相同操作：第四次不再执行，换动作仍可用', async () => {
  const { root, tool, exec } = fixture()
  try {
    await createTask(tool, exec, 'p4')
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(
        () => tool.execute({ action: 'create', task_id: 'p4', plan: duplicatePlan }, exec),
        (error) => error.code === 'GAC_TASK_ALREADY_EXISTS',
      )
    }
    const refused = await tool.execute({ action: 'create', task_id: 'p4', plan: duplicatePlan }, exec)
    assert.equal(refused.no_progress.code, NO_PROGRESS_CODES.REPEATED_FAILURE)
    assert.equal(refused.no_progress.error, 'GAC_TASK_ALREADY_EXISTS')
    assert.equal(refused.no_progress.count, 3)
    assert.deepEqual(refused.blockers, [NO_PROGRESS_CODES.REPEATED_FAILURE])
    assert.match(refused.message, /已停止重复执行 create/u)
    assert.match(refused.message, /reopen/u)
    // 限制是「同一个动作 + 同一个错误码 + 同一个任务」，不是把这个会话锁死。
    const status = await tool.execute({ action: 'status', task_id: 'p4' }, exec)
    assert.equal(status.status, 'pending')
    assert.equal(status.no_progress, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('新进展解除失败限制：真事件到达后同一个动作会再执行一次', async () => {
  const { root, store, tool, exec } = fixture({ noProgress: { failure_limit: 3 } })
  try {
    await createTask(tool, exec, 'p5')
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => tool.execute({ action: 'create', task_id: 'p5', plan: duplicatePlan }, exec))
    }
    assert.equal(
      (await tool.execute({ action: 'create', task_id: 'p5', plan: duplicatePlan }, exec)).no_progress.code,
      NO_PROGRESS_CODES.REPEATED_FAILURE,
    )
    // 任务出现新进展（这里直接落一次派遣，等价于真实的新事件）。
    store.save(dispatch(store.load('p5'), ['T1'], undefined, null, { ownerSessionId: 'owner', at: 6000 }))
    await tool.execute({ action: 'status', task_id: 'p5' }, exec)
    await assert.rejects(
      () => tool.execute({ action: 'create', task_id: 'p5', plan: duplicatePlan }, exec),
      '限制解除后同一个动作会真的再执行一次（仍然是同一个错误）',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('工程可以把失败限制关掉：null 时不再拦任何动作', async () => {
  const { root, tool, exec } = fixture({ noProgress: { failure_limit: null } })
  try {
    await createTask(tool, exec, 'p6')
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        () => tool.execute({ action: 'create', task_id: 'p6', plan: duplicatePlan }, exec),
        (error) => error.code === 'GAC_TASK_ALREADY_EXISTS',
      )
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
