import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DispatchTracker } from '../lib/dispatch-tracker.js'
import { TaskStore } from '../lib/task-store.js'
import { compileTask, dispatch } from '../lib/coordinator.js'
import { createTaskTool } from '../lib/tool-task.js'

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
    assert.equal(store.load('async').nodes.get('A').status, 'in_progress')
    const runs = [...tracker.runs.values()]
    completions.get('B')({ status: 'completed', summary: 'B 完成' })
    completions.get('A')({ status: 'completed', summary: 'A 完成' })
    await Promise.all(runs.map((run) => run.done))
    assert.equal(store.load('async').nodes.get('A').status, 'completed')
    assert.equal(store.load('async').nodes.get('B').status, 'completed')
    assert.equal(notifications.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('取消信号属于派遣，取消后的成功不能登记；中断恢复不伪造完成', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-cancel-'))
  try {
    const store = new TaskStore({ root })
    const tracker = new DispatchTracker({ root, store })
    let release
    let settled
    tracker.submit({ taskId: 'x', dispatchId: 'd', owner: 'owner', run: (signal) => new Promise((resolve) => { assert.equal(signal.aborted, true); release = resolve }), settle: (value) => { settled = value }, notify: async () => {} })
    tracker.cancel('owner')
    await Promise.resolve()
    release({ status: 'completed' })
    await tracker.runs.get('d').done
    assert.equal(settled.status, 'failed')
    const task = dispatch(compileTask({ task_id: 'lost', nodes: [{ id: 'A', objective: '实现', required_capabilities: ['implementation'], write_scope: ['a.js'] }] }), ['A'])
    store.save(task)
    assert.equal(tracker.recover(task).nodes.get('A').status, 'failed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('通知发送失败留在持久化账本，恢复后并发补发只交付一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-outbox-'))
  try {
    const tracker = new DispatchTracker({ root, store: {} })
    tracker.submit({ taskId: 'x', dispatchId: 'd', owner: 'owner', run: async () => ({}), settle: () => '真实结果已到达', notify: async () => { throw new Error('宿主暂不可用') } })
    await tracker.runs.get('d').done
    const restored = new DispatchTracker({ root, store: {} })
    let delivered = 0
    const notify = async () => { delivered++ }
    await Promise.all([restored.flush('owner', notify), restored.flush('owner', notify)])
    assert.equal(delivered, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
