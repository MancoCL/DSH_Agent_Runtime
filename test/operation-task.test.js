import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperationStore } from '../lib/operation-store.js'
import { TaskStore } from '../lib/task-store.js'
import { createTaskTool } from '../lib/tool-task.js'
import { createGacCore } from '../lib/plugin.js'

test('任务入口拒绝 direct、自报模式及缺少独立验证；所有权跨恢复有效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-op-task-'))
  try {
    const tasks = new TaskStore({ root })
    const ops = new OperationStore({ root, activeTasks: () => tasks.list().map((id) => tasks.load(id)) })
    const op = ops.begin('root')
    const tool = createTaskTool({ defineTool: (value) => value, taskStoreFor: () => tasks, sessionRootFor: () => root, operationsFor: () => ops })
    const exec = { agent: { session: { id: 'root' } } }
    const nodes = [{ id: 'B', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/a.js'] }, { id: 'V', objective: '独立验证', role: 'verification_execution', required_capabilities: ['verification'], depends_on: ['B'], write_scope: [] }]
    await assert.rejects(() => tool.execute({ action: 'create', task_id: 'one', operation_id: op.operation_id, plan: { nodes } }, exec), /APPROVAL_REQUIRED/u)
    ops.assess(op.operation_id, 'root', { change_kind: 'behavior', behavior_summary: '跨模块行为', target_paths: ['src/a.js'], complexity_reasons: [{ kind: 'cross_module', basis: '实现和协议需要同时变化' }] })
    await ops.requestUpgrade(op.operation_id, 'root', async () => ({ selected: ['同意升级'] }))
    await assert.rejects(() => tool.execute({ action: 'create', task_id: 'bad', mode: 'high_risk_task', operation_id: op.operation_id, plan: { nodes } }, exec), /MISMATCH/u)
    await assert.rejects(() => tool.execute({ action: 'create', task_id: 'bad', operation_id: op.operation_id, plan: { nodes: nodes.slice(0, 1) } }, exec), /VERIFIER_REQUIRED/u)
    await tool.execute({ action: 'create', task_id: 'one', operation_id: op.operation_id, plan: { nodes } }, exec)
    assert.equal(new TaskStore({ root }).load('one').owner_session_id, 'root')
    assert.throws(() => ops.begin('root'), /LOCKED/u)
    await assert.rejects(() => tool.execute({ action: 'advance', task_id: 'one' }, { agent: { session: { id: 'foreign' } } }), /OWNER/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('direct 范围可写、越界和待批准拒绝；不创建节点 scope，不阻断测试 Shell', () => {
  let operation = { status: 'active_direct', assessment: { change_kind: 'behavior', target_paths: ['src/a.js'] } }
  const core = createGacCore({ coordinatorWriteFor: () => ({ protected_paths: [], operation }) })
  const exec = (name, args) => ({ name, arguments: args, agent: { session: { id: 'root' } } })
  assert.equal(core.preExecute(exec('write', { file_path: 'src/a.js' })).kind, 'allow')
  assert.equal(core.preExecute(exec('write', { file_path: 'other.js' })).kind, 'deny')
  assert.equal(core.preExecute(exec('pwsh', { command: 'npm test' })).kind, 'allow')
  operation = { ...operation, status: 'upgrade_pending' }
  assert.equal(core.preExecute(exec('write', { file_path: 'src/a.js' })).kind, 'deny')
})
