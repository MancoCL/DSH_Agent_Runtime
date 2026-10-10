import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperationStore } from '../lib/operation-store.js'
import { ClaimStore } from '../lib/claim-store.js'

const assessment = (extra = {}) => ({ change_kind: 'behavior', behavior_summary: '修复局部取值', target_paths: ['src/a.js'], ...extra })
test('默认轻量操作、核心注释和普通缺陷不升级；占用冲突被拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-operation-'))
  try {
    const store = new OperationStore({ root, claims: new ClaimStore({ root }) })
    const first = store.begin('root')
    assert.equal(first.mode, 'direct_edit')
    assert.equal(store.assess(first.operation_id, 'root', assessment({ change_kind: 'comment' })).status, 'active_direct')
    const other = store.begin('other')
    assert.throws(() => store.assess(other.operation_id, 'other', assessment()), /CLAIM_CONFLICT/u)
    store.end(first.operation_id, 'root')
    assert.equal(store.assess(other.operation_id, 'other', assessment()).status, 'active_direct')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('升级必须有真实问答，拒绝和自报不授权；同意按评估版本复用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-operation-'))
  try {
    const store = new OperationStore({ root })
    const op = store.begin('root')
    const input = assessment({ complexity_reasons: [{ kind: 'multiple_causes', basis: '两个相互作用的故障源' }] })
    store.assess(op.operation_id, 'root', input)
    assert.throws(() => store.forTask(op.operation_id, 'root'), /APPROVAL_REQUIRED/u)
    await assert.rejects(() => store.requestUpgrade(op.operation_id, 'root'), /UNAVAILABLE/u)
    await store.requestUpgrade(op.operation_id, 'root', async () => ({ selected: [], custom: '同意升级' }))
    assert.throws(() => store.forTask(op.operation_id, 'root'), /APPROVAL_REQUIRED/u)
    store.assess(op.operation_id, 'root', { ...input, behavior_summary: '修复交互故障' })
    const approved = await store.requestUpgrade(op.operation_id, 'root', async () => ({ selected: ['同意升级'], answer_ref: 'reply-1' }))
    assert.equal(approved.mode, 'standard_task')
    await store.requestUpgrade(op.operation_id, 'root', () => { throw new Error('不应重复提问') })
    assert.throws(() => store.forTask(op.operation_id, 'root', 'high_risk_task'), /MISMATCH/u)
    assert.throws(() => store.forTask(op.operation_id, 'other'), /OWNER/u)
    store.assess(op.operation_id, 'root', assessment({ core_impacts: [{ kind: 'flash_boundary', basis: '修改擦写上界' }] }))
    assert.throws(() => store.forTask(op.operation_id, 'root'), /APPROVAL_REQUIRED/u)
    assert.equal(store.load(op.operation_id).suggested_mode, 'high_risk_task')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('等待期间改版、活动任务降级、非法核心类别和路径逃逸被拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-operation-'))
  let active = []
  try {
    const store = new OperationStore({ root, activeTasks: () => active })
    const op = store.begin('root')
    const input = assessment({ core_impacts: [{ kind: 'public_contract', basis: '改变 ABI 参数' }] })
    store.assess(op.operation_id, 'root', input)
    await assert.rejects(() => store.requestUpgrade(op.operation_id, 'root', async () => {
      store.assess(op.operation_id, 'root', assessment())
      return { selected: ['同意升级'] }
    }), /STALE/u)
    active = [{ owner_session_id: 'root', status: 'in_progress' }]
    assert.throws(() => store.begin('root'), /LOCKED/u)
    active = [{ status: 'failed' }, { status: 'pending' }, { owner_session_id: 'other', status: 'in_progress' }]
    assert.doesNotThrow(() => store.begin('root'))
    active = []
    assert.throws(() => store.assess(op.operation_id, 'root', assessment({ core_impacts: [{ kind: 'project_invariant', invariant_id: 'invented', basis: '猜测' }] })), /不变量/u)
    assert.throws(() => store.load('../escape'), /ID_INVALID/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
