/**
 * 生产能力契约的**执行点**：项目声明需要什么、环境到底给不给、缺项时高风险收口拒还是放。
 *
 * 这一组测试存在的理由：README 的那张契约表在此之前**没有任何代码消费**（本仓库在 `checkpoint`
 * 那条上已经吃过一次同样的亏）。所以每一条可校验性都要有断言钉着——尤其是「未知标识必须被拒」
 * 与「高风险缺项必须拒绝收口、而显式豁免能过」这两条方向相反的判定。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CAPABILITIES,
  CAPABILITY_CODES,
  CAPABILITY_IDS,
  CAPABILITY_SPECS,
  CapabilityError,
  MODES_REQUIRING_CAPABILITIES,
  checkCapabilities,
  evaluateCompletionGate,
  validateRequirements,
} from '../lib/capabilities.js'

describe('能力声明的校验：未知标识必须被拒', () => {
  it('缺省是空声明（不要求任何能力）', () => {
    assert.deepEqual(validateRequirements(undefined), [])
  })

  it('接受闭集里的标识，去重且保持顺序', () => {
    assert.deepEqual(
      validateRequirements([
        CAPABILITIES.WORKSPACE_OBSERVATION,
        CAPABILITIES.NATIVE_CHILD_DISPATCH,
        CAPABILITIES.WORKSPACE_OBSERVATION,
      ]),
      [CAPABILITIES.WORKSPACE_OBSERVATION, CAPABILITIES.NATIVE_CHILD_DISPATCH],
    )
  })

  it('拼错的名字被拒 —— 放过它等于让「声明了但没人核对」变成常态', () => {
    assert.throws(
      () => validateRequirements(['workspace_observations']),
      (error) => error instanceof CapabilityError && error.code === CAPABILITY_CODES.UNKNOWN_CAPABILITY,
    )
  })

  it('不是数组、或数组里有非字符串，都被拒', () => {
    assert.throws(() => validateRequirements('workspace_observation'), CapabilityError)
    assert.throws(() => validateRequirements([7]), CapabilityError)
    assert.throws(() => validateRequirements(['']), CapabilityError)
  })

  it('每一项能力都有描述、缺席后果与探针', () => {
    for (const id of CAPABILITY_IDS) {
      const spec = CAPABILITY_SPECS[id]
      assert.equal(typeof spec.description, 'string')
      assert.equal(typeof spec.absent, 'string')
      assert.equal(typeof spec.probe, 'string')
    }
  })
})

describe('核对：声明 × 真实环境', () => {
  it('全都在场时 ok', () => {
    const report = checkCapabilities(
      [CAPABILITIES.WORKSPACE_OBSERVATION, CAPABILITIES.NATIVE_CHILD_DISPATCH],
      { workspaceObservation: true, childDispatch: true },
    )
    assert.equal(report.ok, true)
    assert.deepEqual(report.missing, [])
  })

  it('缺一项就报出那一项、以及缺了它意味着什么', () => {
    const report = checkCapabilities([CAPABILITIES.WORKSPACE_OBSERVATION], { workspaceObservation: false })
    assert.equal(report.ok, false)
    assert.equal(report.missing.length, 1)
    assert.equal(report.missing[0].id, CAPABILITIES.WORKSPACE_OBSERVATION)
    assert.match(report.missing[0].absent, /越界/u)
  })

  it('本插件自己的机制（探针 always）不因环境缺字段而被判缺席', () => {
    const report = checkCapabilities([CAPABILITIES.EVIDENCE_LOG, CAPABILITIES.WRITE_CLAIMS], {})
    assert.equal(report.ok, true)
  })

  it('声明里混进未知标识时如实报「无从核对」，而不是当成通过', () => {
    const report = checkCapabilities(['no_such_capability'], {})
    assert.equal(report.ok, false)
    assert.equal(report.missing[0].probe, 'unknown')
  })
})

describe('收口门禁：缺项时高风险拒绝收口，显式豁免可过', () => {
  const gaps = [{ id: CAPABILITIES.WORKSPACE_OBSERVATION, description: '工作区观测（纵深防御层）' }]

  it('不受管辖的模式不因此被拒', () => {
    const verdict = evaluateCompletionGate({ mode: 'standard_task', missing: gaps })
    assert.equal(verdict.required, false)
    assert.equal(verdict.refuse, false)
  })

  it('没有缺项时放行', () => {
    const verdict = evaluateCompletionGate({ mode: 'high_risk_task', missing: [] })
    assert.equal(verdict.refuse, false)
  })

  it('高风险 + 缺项 + 没有豁免 → 拒绝，并把缺的是什么写进理由', () => {
    const verdict = evaluateCompletionGate({ mode: 'high_risk_task', missing: gaps })
    assert.equal(verdict.required, true)
    assert.equal(verdict.refuse, true)
    assert.match(verdict.reason, /工作区观测/u)
  })

  it('高风险 + 缺项 + 显式豁免 → 放行，且把理由留下来', () => {
    const verdict = evaluateCompletionGate({
      mode: 'high_risk_task',
      missing: gaps,
      ack: '本机 CI 环境装不了观测源，已知并接受',
    })
    assert.equal(verdict.refuse, false)
    assert.equal(verdict.acknowledged, true)
    assert.equal(verdict.reason, '本机 CI 环境装不了观测源，已知并接受')
  })

  it('空白豁免不算豁免 —— 否则「随便填个空格」就能绕过门禁', () => {
    assert.equal(evaluateCompletionGate({ mode: 'high_risk_task', missing: gaps, ack: '   ' }).refuse, true)
    assert.equal(evaluateCompletionGate({ mode: 'high_risk_task', missing: gaps, ack: '' }).refuse, true)
  })

  it('受管辖的模式就是高风险那一类，且是显式清单（不靠风险标签推断）', () => {
    assert.deepEqual([...MODES_REQUIRING_CAPABILITIES], ['high_risk_task'])
  })
})
