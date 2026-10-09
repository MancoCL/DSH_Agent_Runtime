import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/index.js'
import { ProjectState } from '../lib/project-state.js'
import { TaskStore } from '../lib/task-store.js'
import { OperationStore } from '../lib/operation-store.js'
import { DispatchTracker } from '../lib/dispatch-tracker.js'
import { EvidenceLog } from '../lib/evidence-store.js'
import { createGacCore } from '../lib/plugin.js'
import { planId } from '../lib/verification.js'

test('注册入口贯通 direct 写权限、用户升级、后台派遣、真实证据与独立收口', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gac-implementation-'))
  try {
    const adapter = { project: { id: 'integration' }, risk: { high_risk_paths: ['src/'] }, capabilities: ['implementation', 'verification'], executors: { implementation: ['builder'], verification: ['verifier'] } }
    mkdirSync(join(root, '.dsh/gac'), { recursive: true })
    writeFileSync(join(root, '.dsh/gac/project.json'), JSON.stringify(adapter))
    const tasks = new TaskStore({ root })
    const operations = new OperationStore({ root, activeTasks: () => tasks.list() })
    const tracker = new DispatchTracker({ root, store: tasks })
    tracker.notify = async () => {}
    const evidence = new EvidenceLog({ root })
    const core = createGacCore({ resolveRoot: () => root, coordinatorWriteFor: () => ({ protected_paths: [], operation: operations.current('root') }) })
    const registered = new Map()
    const exec = { agent: { session: { id: 'root', header: {} } } }
    let questions = 0
    const registration = await registerTools({ tools: { register: (tool) => registered.set(tool.name, tool) } }, { defineTool: (spec) => spec, core, state: new ProjectState({ resolveRoot: () => root }), rootOf: () => root, taskStoreFor: () => tasks, operationsFor: () => operations, trackerFor: () => tracker, helpersFor: () => ({ start() { throw new Error('根会话没有专家授权') } }), evidenceLogFor: () => evidence, claimStoreFor: () => undefined, adapterFor: () => adapter, askFor: () => async () => { questions++; return { selected: ['同意升级'] } }, executorsFor: () => [{ name: 'builder', supports: () => true, run: async () => ({ status: 'completed', summary: '实现完成' }) }, { name: 'verifier', supports: () => true, run: async () => {
      evidence.record({ tool: 'pwsh', session_id: 'independent-verifier', value: { exitCode: 0, stdout: 'TAP version 13\nok 1 - 接口正例\n1..1' } })
      return { status: 'completed', summary: '独立验证通过', semantic: { role: 'verification_execution', child_session_id: 'independent-verifier', payload: { plan_id: planId(tasks.loadPlan('complex')), executions: [{ case_id: 'C1', outcome: 'passed', evidence_ref: 'self:1#tap:2' }] } } }
    } }] })
    assert.equal(registration.status, 'registered')
    assert.ok(registration.tools.includes('gac_expert'))
    const project = registered.get('gac_project')
    const task = registered.get('gac_task')
    const op = await project.execute({ action: 'begin' }, exec)
    await project.execute({ action: 'assess', operation_id: op.operation_id, assessment: { change_kind: 'comment', behavior_summary: '补充核心目录注释', target_paths: ['src/a.js'] } }, exec)
    assert.equal(questions, 0)
    assert.equal(tasks.list().length, 0)
    assert.equal(core.preExecute({ name: 'write', arguments: { file_path: 'src/a.js' }, ...exec }).kind, 'allow')
    await project.execute({ action: 'assess', operation_id: op.operation_id, assessment: { change_kind: 'behavior', behavior_summary: '复杂跨模块非核心改动', target_paths: ['src/a.js'], complexity_reasons: [{ kind: 'cross_module', basis: '两个解析模块必须共同调整' }] } }, exec)
    assert.equal(core.preExecute({ name: 'write', arguments: { file_path: 'src/a.js' }, ...exec }).kind, 'deny')
    const args = { action: 'create', task_id: 'complex', operation_id: op.operation_id, plan: { nodes: [{ id: 'B', objective: '实现', required_capabilities: ['implementation'], write_scope: ['src/a.js'] }, { id: 'V', objective: '验证', role: 'verification_execution', required_capabilities: ['verification'], depends_on: ['B'], write_scope: [] }] } }
    await assert.rejects(() => task.execute(args, exec), /APPROVAL_REQUIRED/u)
    await project.execute({ action: 'request_upgrade', operation_id: op.operation_id }, exec)
    await task.execute(args, exec)
    assert.equal(questions, 1)
    await task.execute({ action: 'plan', task_id: 'complex', criteria: ['AC1'], verification_plan: { cases: [{ id: 'C1', type: 'positive', covers: ['AC1'], expect: '接口符合需求' }] } }, exec)
    for (let wave = 0; wave < 2; wave++) {
      assert.equal((await task.execute({ action: 'advance', task_id: 'complex' }, exec)).action, 'awaiting_results')
      await Promise.all([...tracker.runs.values()].map((run) => run.done))
    }
    assert.equal(tasks.loadVerification('complex').source_session_id, 'independent-verifier')
    const completed = await task.execute({ action: 'complete', task_id: 'complex', evidence: { all_criteria_covered: true } }, exec)
    assert.equal(completed.action, 'completed', completed.message)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
