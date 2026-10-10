import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DispatchTracker } from '../lib/dispatch-tracker.js'
import { TaskStore } from '../lib/task-store.js'
import {
  applyResult,
  compileTask,
  dispatch,
  markDispatchProgress,
  nextAction,
  orphanDispatch,
  reopen,
} from '../lib/coordinator.js'
import { createTaskTool } from '../lib/tool-task.js'

/** 造一个已经派遣出去、正处于 `in_progress` 的任务。 */
function dispatchedTask(taskId, { mode = 'standard_task', writeScope = ['src/a.js'], attemptToken } = {}) {
  const task = compileTask({
    task_id: taskId,
    mode,
    nodes: [{ id: 'A', objective: '实现 A', required_capabilities: ['implementation'], write_scope: writeScope }],
  })
  return dispatch(task, ['A'], attemptToken, null, { ownerSessionId: 'owner', at: 1000 })
}

test('advance 不等待子节点；乱序结果写入最新快照并逐个通知', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-async-'))
  try {
    const store = new TaskStore({ root })
    const tracker = new DispatchTracker({ root, store })
    const notifications = []
    tracker.notify = async (_, message) => notifications.push(message)
    const completions = new Map()
    const executor = { name: 'builder', supports: () => true, run: ({ node }) => new Promise((resolve) => completions.set(node.id, resolve)) }
    const tool = createTaskTool({ defineTool: (value) => value, taskStoreFor: () => store, sessionRootFor: () => root, trackerFor: () => tracker, adapterFor: () => ({ executors: { implementation: ['builder'] } }), executorsFor: () => [executor] })
    const exec = { agent: { session: { id: 'owner' } } }
    await tool.execute({ action: 'create', task_id: 'async', plan: { nodes: ['A', 'B'].map((id) => ({ id, objective: id, required_capabilities: ['implementation'], write_scope: [`src/${id}.js`] })) } }, exec)
    await tool.execute({ action: 'contract', contract_action: 'freeze', task_id: 'async', criteria: ['AC1'], interface_contract: { name: '双模块约定', covers: ['AC1'], operations: [{ name: 'run', signature: 'run(): void', behavior: '两个模块分别完成各自行为', covers: ['AC1'] }] } }, exec)
    const response = await tool.execute({ action: 'advance', task_id: 'async' }, exec)
    assert.equal(response.action, 'awaiting_results')
    assert.match(response.message, /不要用 Start-Sleep 或循环查询/u)
    assert.equal(store.load('async').nodes.get('A').status, 'in_progress')
    const runs = [...tracker.runs.values()]
    // 派遣身份是**持久化**的：重启之后才回答得了「谁派的、派给哪个子会话」（问题 A ①）。
    assert.equal(store.load('async').nodes.get('A').execution.owner_session_id, 'owner')
    assert.equal(store.load('async').nodes.get('A').execution.lifecycle_state, 'starting')
    completions.get('B')({ status: 'completed', summary: 'B 完成' })
    completions.get('A')({ status: 'completed', summary: 'A 完成' })
    await Promise.all(runs.map((run) => run.done))
    assert.equal(store.load('async').nodes.get('A').status, 'completed')
    assert.equal(store.load('async').nodes.get('B').status, 'completed')
    assert.equal(notifications.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('取消信号属于派遣，取消后的成功不能登记', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-cancel-'))
  try {
    const store = new TaskStore({ root })
    const tracker = new DispatchTracker({ root, store })
    let release
    let settled
    tracker.submit({ taskId: 'x', nodeId: 'A', dispatchId: 'd', owner: 'owner', run: (signal) => new Promise((resolve) => { assert.equal(signal.aborted, true); release = resolve }), settle: (value) => { settled = value }, notify: async () => {} })
    tracker.cancel('owner')
    await Promise.resolve()
    release({ status: 'completed' })
    await tracker.runs.get('d').done
    assert.equal(settled.status, 'failed')
    // 取消有自己的码（问题 C 第 ④ 类）：它必须与「启动失败」「结果不合契约」在记录里可区分。
    assert.deepEqual(settled.blocked_by, ['GAC_DISPATCH_CANCELLED'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('通知发送失败留在持久化账本，恢复后并发补发只交付一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-outbox-'))
  try {
    const tracker = new DispatchTracker({ root, store: {} })
    tracker.submit({ taskId: 'x', nodeId: 'A', dispatchId: 'd', owner: 'owner', run: async () => ({}), settle: () => '真实结果已到达', notify: async () => { throw new Error('宿主暂不可用') } })
    await tracker.runs.get('d').done
    const restored = new DispatchTracker({ root, store: {} })
    let delivered = 0
    const notify = async () => { delivered++ }
    await Promise.all([restored.flush('owner', notify), restored.flush('owner', notify)])
    assert.equal(delivered, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('派遣后重建 Tracker：恢复不把无法确认的执行者判成失败，也不释放它的写范围', () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-recover-'))
  try {
    const store = new TaskStore({ root })
    const created = dispatchedTask('lost')
    store.save(created)
    // 换一个 Tracker 实例 —— 模拟插件重载：内存里这次 run 不见了，但子 Agent 可能仍在跑。
    const tracker = new DispatchTracker({ root, store, now: () => 2000 })
    const recovered = tracker.recover(created)
    const node = recovered.nodes.get('A')
    assert.equal(node.status, 'blocked', '不得无依据宣告失败')
    assert.deepEqual(node.blocked_by, ['GAC_DISPATCH_ORPHANED'])
    assert.equal(node.execution.lifecycle_state, 'unknown')
    assert.equal(node.execution.attempt, 1, 'attempt 不能因恢复而回退')
    assert.equal(node.execution.last_failure.code, 'GAC_DISPATCH_ORPHANED')
    assert.equal(node.execution.last_failure.dispatch_id, 'lost-A-A1', '作废的执行身份必须留在诊断里')
    assert.equal(node.execution.last_failure.retryable, false, '执行者可能仍在写，绝不能自动重试')
    assert.equal(store.load('lost').nodes.get('A').status, 'blocked', '诊断要落盘')
    assert.ok(!JSON.stringify(recovered).includes('GAC_DISPATCH_INTERRUPTED'), '旧码不再出现')
    // 幂等：重复恢复不产生第二份诊断，也不改写任务。
    assert.equal(tracker.recover(recovered), recovered)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('恢复时宿主能确认执行者仍在运行：保留执行态与写范围', () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-live-'))
  try {
    const store = new TaskStore({ root })
    const created = dispatchedTask('live')
    store.save(created)
    const probes = []
    const tracker = new DispatchTracker({ root, store, now: () => 2000, livenessFor: (probe) => { probes.push(probe); return 'running' } })
    tracker.noteChildSession({ taskId: 'live', nodeId: 'A', dispatchId: 'live-A-A1', childSessionId: 'child-1' })
    const recovered = tracker.recover(store.load('live'))
    const node = recovered.nodes.get('A')
    assert.equal(node.status, 'in_progress')
    assert.equal(node.execution.active_dispatch_id, 'live-A-A1', '确认在跑时不得摘掉执行身份')
    assert.equal(node.execution.lifecycle_state, 'running')
    assert.equal(node.execution.child_session_id, 'child-1')
    assert.equal(node.blocked_by ?? null, null)
    assert.deepEqual(probes[0], {
      taskId: 'live',
      nodeId: 'A',
      dispatchId: 'live-A-A1',
      attempt: 1,
      childSessionId: 'child-1',
      ownerSessionId: 'owner',
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('宿主查得到子会话已经不在：仍然标未知而不是失败，并在诊断里说明依据', () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-absent-'))
  try {
    const store = new TaskStore({ root })
    const created = dispatchedTask('gone')
    store.save(created)
    const tracker = new DispatchTracker({ root, store, now: () => 2000, livenessFor: () => 'absent' })
    tracker.noteChildSession({ taskId: 'gone', nodeId: 'A', dispatchId: 'gone-A-A1', childSessionId: 'child-9' })
    const node = tracker.recover(store.load('gone')).nodes.get('A')
    assert.equal(node.status, 'blocked')
    assert.match(node.execution.last_failure.detail, /已经查不到子会话 child-9/u)
    assert.equal(node.execution.last_failure.code, 'GAC_DISPATCH_ORPHANED')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('派遣与恢复并发：本进程登记着的派遣不因恢复扫描被改写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-race-'))
  try {
    const store = new TaskStore({ root })
    const created = dispatchedTask('running')
    store.save(created)
    const tracker = new DispatchTracker({ root, store })
    let release
    tracker.submit({ taskId: 'running', nodeId: 'A', dispatchId: 'running-A-A1', owner: 'owner', run: () => new Promise((resolve) => { release = resolve }), settle: () => undefined, notify: async () => {} })
    await Promise.resolve()
    const loaded = store.load('running')
    // 宿主回报还在路上：恢复扫描必须原样返回，既不标未知，也不动生命周期。
    assert.equal(tracker.recover(loaded), loaded)
    assert.equal(store.load('running').nodes.get('A').status, 'in_progress')
    release({ status: 'completed', summary: '完成' })
    await tracker.runs.get('running-A-A1').done
    // 结算回调返回 undefined（这次派遣结束了但没人结算）：节点仍在执行态，恢复时才进入未知。
    assert.equal(tracker.recover(store.load('running')).nodes.get('A').status, 'blocked')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('旧 attempt 的迟到结果改不动新 attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-attempt-'))
  try {
    const store = new TaskStore({ root })
    const first = dispatchedTask('retry')
    const failed = applyResult(first, {
      node_id: 'A',
      dispatch_id: 'retry-A-A1',
      status: 'failed',
      blocked_by: ['GAC_CHILD_START_FAILED'],
      at: 1500,
    })
    assert.equal(failed.classification, 'accepted')
    assert.equal(failed.task.nodes.get('A').execution.last_failure.code, 'GAC_CHILD_START_FAILED')
    const second = dispatch(reopen(failed.task, 'A', '重新派遣'), ['A'], undefined, null, { ownerSessionId: 'owner', at: 1600 })
    store.save(second)
    const stale = applyResult(second, { node_id: 'A', dispatch_id: 'retry-A-A1', status: 'completed' })
    assert.equal(stale.classification, 'stale')
    assert.equal(stale.task.nodes.get('A').execution.active_dispatch_id, 'retry-A-A2')
    // 旧身份的进度/孤儿登记同样改不动新 attempt。
    assert.equal(markDispatchProgress(second, 'A', 'retry-A-A1', 'running'), second)
    assert.equal(orphanDispatch(second, 'A', 'retry-A-A1', { at: 1700 }), second)
    assert.equal(store.load('retry').nodes.get('A').execution.lifecycle_state, 'registered')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('结算抛错：节点状态不被篡改，死因落盘，且协调会话一定收到通知', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-settle-'))
  try {
    const store = new TaskStore({ root })
    const created = dispatchedTask('settle')
    store.save(created)
    const tracker = new DispatchTracker({ root, store })
    const sent = []
    tracker.submit({
      taskId: 'settle',
      nodeId: 'A',
      dispatchId: 'settle-A-A1',
      owner: 'owner',
      run: async () => ({ status: 'completed', summary: '干完了' }),
      settle: () => { throw new Error('盘写坏了') },
      notify: async (message) => { sent.push(message) },
    })
    await tracker.runs.get('settle-A-A1').done
    assert.equal(sent.length, 1, '结算失败也必须有人被告知')
    assert.match(sent[0], /GAC_DISPATCH_SETTLE_FAILED/u)
    const node = store.load('settle').nodes.get('A')
    assert.equal(node.status, 'in_progress', '通知失败/结算失败不得伪装成执行结果')
    assert.equal(node.execution.last_failure.code, 'GAC_DISPATCH_SETTLE_FAILED')
    assert.equal(node.execution.last_failure.retryable, true)
    assert.ok(tracker.diagnostics().some((fault) => fault.code === 'GAC_DISPATCH_SETTLE_FAILED'))
    await tracker.flush('owner', async (message) => { sent.push(message) })
    assert.equal(sent.length, 1, '已投递的通知不重复投')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('恢复标未知之后，调度器不会立刻派出第二个可能重复写入的执行者', () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-nodup-'))
  try {
    const store = new TaskStore({ root })
    const created = dispatchedTask('highrisk', { mode: 'high_risk_task', writeScope: ['lib/'] })
    store.save(created)
    const tracker = new DispatchTracker({ root, store, now: () => 2000 })
    const recovered = tracker.recover(created)
    assert.equal(recovered.nodes.get('A').status, 'blocked')
    const next = nextAction(recovered)
    assert.notEqual(next.action, 'dispatch', '状态未知的节点不得被再次派遣')
    assert.equal(recovered.status, 'blocked')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
