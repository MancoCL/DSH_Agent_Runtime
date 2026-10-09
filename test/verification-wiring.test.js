import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verificationInputs } from '../lib/verification-inputs.js'
import { compileEvidence, createEvidenceResolver } from '../lib/evidence.js'
import { compileVerificationPlan, evaluateVerification, planId } from '../lib/verification.js'

test('派遣输入来自适配器与任务存储；未知事实保持缺失', () => {
  const detail = { artifact: 'test_detail', content: '既有测试入口' }
  const deps = verificationInputs({ verification_context: { test_entry: 'node --test', capabilities: ['shell'] } }, { loadDesign: () => ({ artifacts: { test_detail: detail } }), loadPlan: () => ({ cases: [{ id: 'C1' }] }) })
  assert.match(deps.engineeringFactsFor(), /node --test/u)
  assert.equal(deps.testDetailFor('one'), detail)
  assert.equal(deps.planCasesFor('one')[0].id, 'C1')
  assert.equal(verificationInputs({}, {}).engineeringFactsFor(), undefined)
})
test('批量证据只认可实际通过的独立条目；笼统 PASS 与旧通过不能覆盖新失败', () => {
  const plan = compileVerificationPlan({ cases: [{ id: 'C1', type: 'positive', covers: ['AC1'], expect: '正确输出' }, { id: 'C2', type: 'falsification', covers: ['AC1'], expect_failure: '拒绝错误输出' }] })
  const ev = compileEvidence({ tool: 'pwsh', value: { exitCode: 0, stdout: 'TAP version 13\nok 1 - 正例\nok 2 - 反例\n1..2' } }, { id: 'ev-1' })
  const report = { plan_id: planId(plan), executions: [{ case_id: 'C1', outcome: 'passed', evidence_ref: 'ev-1#tap:2' }, { case_id: 'C2', outcome: 'passed', evidence_ref: 'ev-1#tap:3' }] }
  assert.equal(evaluateVerification(report, plan, ['AC1'], { resolveEvidence: createEvidenceResolver([ev]) }).ok, true)
  assert.equal(evaluateVerification({ ...report, executions: report.executions.map((entry, index) => ({ ...entry, evidence_ref: `ev-1#invented:${index}` })) }, plan, ['AC1'], { resolveEvidence: createEvidenceResolver([ev]) }).ok, false)
  assert.equal(evaluateVerification({ ...report, executions: [...report.executions, { case_id: 'C1', outcome: 'failed', failure_classification: 'product_implementation', note: '最新执行失败' }] }, plan, ['AC1']).ok, false)
})
