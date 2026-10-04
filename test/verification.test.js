/**
 * 独立验证规则测试。
 *
 * 这些规则的价值全在「能抓住什么」。所以测试不只断言「合法输入通过」，更要断言每一类
 * 缺口都被**指名**抓出来：哪一个 AC 没覆盖、哪一个 AC 缺反例、哪几条用例缺证据、哪份
 * 证据被摊薄。给一个计数而不给名字的缺口，既不能被修复也不能被复核。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CASE_TYPES,
  VERIFICATION_CODES,
  VerificationError,
  checkPlanIdentity,
  compileVerificationPlan,
  evaluateVerification,
  findCaseTypeGaps,
  findCoverageGaps,
  freezePlan,
  planId,
} from '../lib/verification.js'

/** 两条验收标准，后续用例围绕它们构造。 */
const CRITERIA = ['AC1', 'AC2']

/**
 * 一份覆盖完整的计划：每条 AC 各有正例与反例。
 *
 * @param {object} [overrides]
 * @returns {Readonly<object>}
 */
function completePlan(overrides = {}) {
  return compileVerificationPlan({
    cases: [
      { id: 'V1', covers: ['AC1'], type: 'positive', expect: '正常输入被接受' },
      { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: '越界输入被拒绝' },
      { id: 'V3', covers: ['AC2'], type: 'positive', expect: '字段被移除' },
      { id: 'V4', covers: ['AC2'], type: 'falsification', expect_failure: '字段仍存在时断言失败' },
    ],
    ...overrides,
  }, { criteria: CRITERIA })
}

/**
 * 一份全部通过、各有独立证据的报告。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function passingReport(overrides = {}) {
  return {
    executions: [
      { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
      { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
      { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
      { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
    ],
    ...overrides,
  }
}

describe('CASE_TYPES', () => {
  it('只有两类，因为验收标准只有两个方向要证明', () => {
    assert.deepEqual([...CASE_TYPES], ['positive', 'falsification'])
  })
})

describe('compileVerificationPlan — 计划必须自洽', () => {
  it('接受一份完整计划并冻结它', () => {
    const plan = completePlan()
    assert.equal(plan.cases.length, 4)
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.cases), true)
    // 冻结让「实现侧不得改写计划」成为做不到的事，而不是一条纪律。
    assert.throws(() => { plan.cases.push({}) }, TypeError)
  })

  it('拒绝没有用例的计划', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [] }),
      (error) => error.code === VERIFICATION_CODES.PLAN_MISSING,
    )
  })

  it('拒绝重复的用例 id', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'y' },
      ] }),
      /重复/u,
    )
  })

  it('拒绝未声明 covers 的用例：它无法参与可追溯性', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: [], type: 'positive', expect: 'x' },
      ] }),
      /covers/u,
    )
  })

  it('拒绝没有 expect_failure 的反例', () => {
    // 没有这一句，反例退化成一个更弱的正例：它仍然会通过，但证明不了任何错实现会被抓住。
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1'], type: 'falsification' },
      ] }),
      (error) => error.code === VERIFICATION_CODES.FALSIFICATION_MISSING,
    )
  })

  it('拒绝没有 expect 的正例', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive' },
      ] }),
      /必须写明 expect/u,
    )
  })

  it('拒绝未知的用例类型', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1'], type: 'smoke', expect: 'x' },
      ] }),
      /type 必须是/u,
    )
  })

  it('给了验收标准就当场核对覆盖，不等收口才发现漏了一条', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
        { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      ] }, { criteria: CRITERIA }),
      (error) => {
        assert.equal(error.code, VERIFICATION_CODES.AC_UNCOVERED)
        assert.deepEqual(error.detail.uncovered, ['AC2'])
        return true
      },
    )
  })

  it('给了验收标准就当场核对反例，而不只核对覆盖', () => {
    // 只查覆盖会让一份全由正例组成的计划通过编译，而那样的计划无法区分
    // 「实现正确」与「断言太弱」——这正是反例存在的理由。
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1', 'AC2'], type: 'positive', expect: 'x' },
      ] }, { criteria: CRITERIA }),
      (error) => {
        assert.equal(error.code, VERIFICATION_CODES.FALSIFICATION_MISSING)
        assert.deepEqual(error.detail.criteria, ['AC1', 'AC2'])
        return true
      },
    )
  })

  it('只有反例、没有正例时也当场被拒', () => {
    assert.throws(
      () => compileVerificationPlan({ cases: [
        { id: 'V1', covers: ['AC1', 'AC2'], type: 'falsification', expect_failure: 'y' },
      ] }, { criteria: CRITERIA }),
      (error) => {
        assert.equal(error.code, VERIFICATION_CODES.AC_UNCOVERED)
        assert.deepEqual(error.detail.without_positive, ['AC1', 'AC2'])
        return true
      },
    )
  })

  it('没给验收标准时不在编译期核对，缺口留到判定阶段报出', () => {
    // 计划可以先于验收标准定稿；此时无从核对，而假装核对过比不核对更糟。
    const plan = compileVerificationPlan({ cases: [
      { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
    ] })
    assert.equal(plan.cases.length, 1)
    const result = evaluateVerification(
      { executions: [{ case_id: 'V1', outcome: 'passed', evidence_ref: 'e1' }] },
      plan,
      CRITERIA,
    )
    assert.equal(result.ok, false)
    assert.equal(
      result.violations.some((v) => v.code === VERIFICATION_CODES.FALSIFICATION_MISSING),
      true,
    )
  })
})

describe('findCoverageGaps 与 findCaseTypeGaps — 缺口必须指名', () => {
  it('指出没被任何用例覆盖的 AC', () => {
    const plan = compileVerificationPlan({ cases: [
      { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
      { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
    ] })
    assert.deepEqual(findCoverageGaps(plan, CRITERIA), ['AC2'])
  })

  it('分别指出缺正例与缺反例的 AC', () => {
    const plan = compileVerificationPlan({ cases: [
      { id: 'V1', covers: ['AC1', 'AC2'], type: 'positive', expect: 'x' },
    ] })
    const gaps = findCaseTypeGaps(plan, CRITERIA)
    assert.deepEqual(gaps.without_positive, [])
    assert.deepEqual(gaps.without_falsification, ['AC1', 'AC2'])
  })
})

describe('evaluateVerification — 全部通过', () => {
  it('齐备时判定通过，并给出可追溯链', () => {
    const plan = completePlan()
    const result = evaluateVerification(passingReport(), plan, CRITERIA)
    assert.equal(result.ok, true, JSON.stringify(result.violations))
    assert.deepEqual(result.traceability.map((entry) => entry.criterion), CRITERIA)
    assert.deepEqual(result.traceability[0].cases.sort(), ['V1', 'V2'])
    assert.deepEqual(result.traceability[0].evidence.sort(), ['ev-1', 'ev-2'])
  })
})

describe('evaluateVerification — 每一类缺口都被抓出', () => {
  it('缺证据：用例有通过记录但没有证据引用', () => {
    // 有「通过」却没有证据，等于让人凭一句话相信。
    const plan = completePlan()
    const report = passingReport({
      executions: [
        { case_id: 'V1', outcome: 'passed' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
    const result = evaluateVerification(report, plan, CRITERIA)
    assert.equal(result.ok, false)
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.EVIDENCE_MISSING)
    assert.deepEqual(violation.detail.cases, ['V1'])
  })

  it('未执行的用例不算通过证据', () => {
    const plan = completePlan()
    const report = passingReport({
      executions: [
        { case_id: 'V1', outcome: 'not_run' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
    const result = evaluateVerification(report, plan, CRITERIA)
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.EVIDENCE_MISSING)
    assert.deepEqual(violation.detail.cases, ['V1'])
  })

  it('失败的用例不算通过证据', () => {
    const plan = completePlan()
    const report = passingReport({
      executions: [
        { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
    const result = evaluateVerification(report, plan, CRITERIA)
    assert.equal(result.ok, false)
    assert.equal(
      result.violations.some((v) => v.code === VERIFICATION_CODES.EVIDENCE_MISSING),
      true,
    )
  })

  it('取证摊薄：同一份证据被多条用例引用', () => {
    // 形式上完全合法——用例齐、AC 齐、证据也在——只是那些证据是同一个观测。
    // 计数发现不了它，必须比对证据本身。
    const plan = completePlan()
    const report = passingReport({
      executions: [
        { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-shared' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-shared' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
    const result = evaluateVerification(report, plan, CRITERIA)
    assert.equal(result.ok, false)
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.EVIDENCE_POOLED)
    assert.equal(violation.detail.pooled[0].evidence_ref, 'ev-shared')
    assert.deepEqual(violation.detail.pooled[0].cases.sort(), ['V1', 'V2'])
  })

  it('报告里出现计划外的用例 id 会被抓出', () => {
    // 通常意味着报告对应的是另一份计划，或用例改名后没同步计划。
    const plan = completePlan()
    const report = passingReport({
      executions: [
        ...passingReport().executions,
        { case_id: 'V99', outcome: 'passed', evidence_ref: 'ev-99' },
      ],
    })
    const result = evaluateVerification(report, plan, CRITERIA)
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.CASE_UNKNOWN)
    assert.equal(violation.detail.case_id, 'V99')
  })

  it('缺反例时指名到具体 AC，而不是给一个计数', () => {
    const plan = compileVerificationPlan({ cases: [
      { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
      { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      { id: 'V3', covers: ['AC2'], type: 'positive', expect: 'z' },
    ] })
    const report = {
      executions: [
        { case_id: 'V1', outcome: 'passed', evidence_ref: 'e1' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'e2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'e3' },
      ],
    }
    const result = evaluateVerification(report, plan, CRITERIA)
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.FALSIFICATION_MISSING)
    assert.deepEqual(violation.detail.criteria, ['AC2'])
  })

  it('缺正例时同样指名', () => {
    const plan = compileVerificationPlan({ cases: [
      { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
      { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      { id: 'V3', covers: ['AC2'], type: 'falsification', expect_failure: 'z' },
    ] })
    const report = {
      executions: [
        { case_id: 'V1', outcome: 'passed', evidence_ref: 'e1' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'e2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'e3' },
      ],
    }
    const result = evaluateVerification(report, plan, CRITERIA)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.AC_UNCOVERED && v.detail.without_positive,
    )
    assert.deepEqual(violation.detail.without_positive, ['AC2'])
  })

  it('空报告把每条用例都列为缺证据', () => {
    const plan = completePlan()
    const result = evaluateVerification({ executions: [] }, plan, CRITERIA)
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.EVIDENCE_MISSING)
    assert.deepEqual(violation.detail.cases.sort(), ['V1', 'V2', 'V3', 'V4'])
  })

  it('同一用例多次通过时，只要有独立证据就算齐备', () => {
    // 重跑同一用例并留下两份证据是正常的（例如修好再跑一次）。
    const plan = completePlan()
    const report = passingReport({
      executions: [
        { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1-old' },
        { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
    const result = evaluateVerification(report, plan, CRITERIA)
    assert.equal(result.ok, true, JSON.stringify(result.violations))
  })
})

describe('计划身份——内容寻址', () => {
  it('同一份计划给出同一个 id', () => {
    assert.equal(planId(completePlan()), planId(completePlan()))
  })

  it('计划被改写时 id 随之改变', () => {
    // 这样「报告用的是旧计划」可以被发现，而不是看起来一切正常。
    const before = planId(completePlan())
    const after = planId(compileVerificationPlan({ cases: [
      { id: 'V1', covers: ['AC1'], type: 'positive', expect: '被改过的期望' },
      { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      { id: 'V3', covers: ['AC2'], type: 'positive', expect: 'z' },
      { id: 'V4', covers: ['AC2'], type: 'falsification', expect_failure: 'w' },
    ] }))
    assert.notEqual(before, after)
  })

  it('id 与用例顺序无关', () => {
    // 顺序不携带语义，重新排列不该让它看起来像换了计划。
    const ordered = compileVerificationPlan({
      cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
        { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      ],
    })
    const reordered = compileVerificationPlan({
      cases: [
        { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
      ],
    })
    assert.equal(planId(ordered), planId(reordered))
  })

  it('报告与计划不一致时如实报出两边', () => {
    const plan = completePlan()
    const verdict = checkPlanIdentity(plan, { plan_id: 'plan-deadbeef' })
    assert.equal(verdict.matches, false)
    assert.equal(verdict.expected, planId(plan))
    assert.equal(verdict.reported, 'plan-deadbeef')
  })

  it('报告没写计划 id 时视为不一致', () => {
    assert.equal(checkPlanIdentity(completePlan(), {}).matches, false)
  })

  it('报告写了正确的计划 id 时一致', () => {
    const plan = completePlan()
    assert.equal(checkPlanIdentity(plan, { plan_id: planId(plan) }).matches, true)
  })
})

describe('freezePlan', () => {
  it('深冻结，连嵌套数组也改不动', () => {
    const plan = completePlan()
    const frozen = freezePlan({ ...plan })
    assert.throws(() => { frozen.cases[0].covers.push('AC9') }, TypeError)
  })
})

describe('VerificationError', () => {
  it('携带稳定 code，便于按码分支而不是解析消息', () => {
    try {
      compileVerificationPlan({ cases: [] })
      assert.fail('应当抛错')
    } catch (error) {
      assert.equal(error instanceof VerificationError, true)
      assert.equal(error.code, VERIFICATION_CODES.PLAN_MISSING)
    }
  })
})
