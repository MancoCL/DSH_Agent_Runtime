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
  FAILURE_CLASSIFICATIONS,
  VERIFICATION_CODES,
  VerificationError,
  checkPlanIdentity,
  compileVerificationPlan,
  evaluateVerification,
  findCaseTypeGaps,
  findCoverageGaps,
  freezePlan,
  planId,
  validateFailureClassification,
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

// ---------------------------------------------------------------------------
// 失败归因（契约 FAILURE_CLASSIFICATIONS / validateFailureClassification /
// evaluateVerification 对非通过用例的归因检查）。
//
// 本节覆盖 AC-CLASS-SET、AC-CLASS-REJECT、AC-CLASS-SUPPORT 与 AC-LEGACY-CODES。
// 与前面几节不同，这里**正例与反例同等重要**：门禁既能抓住「没归因」，也不能把「归因
// 齐全」误判成违规。只测前一半，一条把合法归因一并拒掉的门禁会全绿通过。
// ---------------------------------------------------------------------------

describe('FAILURE_CLASSIFICATIONS —— 失败归因的六类闭集', () => {
  it('恰好六类，顺序与含义固定', () => {
    // 六类互斥且穷尽：改产品、改测试实现、改期望、修环境、等外部资源、承认证据不足。
    // 顺序即展示顺序，所以按契约钉死，而不是只比集合。
    assert.deepEqual([...FAILURE_CLASSIFICATIONS], [
      'product_implementation',
      'test_implementation',
      'test_expectation',
      'build_environment',
      'external_resource',
      'evidence_insufficient',
    ])
  })

  it('是冻结的，不能被就地改写', () => {
    // 闭集一旦可被就地扩张，「不在闭集内」这条判定就失去意义。
    assert.equal(Object.isFrozen(FAILURE_CLASSIFICATIONS), true)
    assert.throws(() => { FAILURE_CLASSIFICATIONS.push('whatever') }, TypeError)
  })

  it('没有重复项', () => {
    assert.equal(new Set(FAILURE_CLASSIFICATIONS).size, FAILURE_CLASSIFICATIONS.length)
  })
})

describe('validateFailureClassification —— 单条归因的三种拒绝方向', () => {
  it('缺分类被拒，并指名到用例、给出可分支的码', () => {
    const verdict = validateFailureClassification({ case_id: 'V1', outcome: 'failed' })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING)
    assert.equal(verdict.detail.case_id, 'V1')
  })

  it('分类为空字符串等同于没给分类', () => {
    // `''` 是「填了但没填」，与 undefined 一样无法据以行动，不能放行。
    const verdict = validateFailureClassification({
      case_id: 'V1',
      outcome: 'failed',
      failure_classification: '',
      note: '写了依据也不行，分类本身是空的',
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING)
  })

  it('分类为 null 等同于没给分类', () => {
    const verdict = validateFailureClassification({
      case_id: 'V1',
      outcome: 'failed',
      failure_classification: null,
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING)
  })

  it('分类不在闭集被拒，并回报收到的值', () => {
    // 自由文本式归因（「环境问题」「不清楚」）看起来说清了，实际落不到任何一类上，
    // 也就无法据以决定下一步改哪里。
    const verdict = validateFailureClassification({
      case_id: 'V2',
      outcome: 'failed',
      failure_classification: 'environment',
      note: '顺手写了个自然语言分类',
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN)
    assert.equal(verdict.detail.case_id, 'V2')
    assert.equal(verdict.detail.classification, 'environment')
  })

  it('大小写不同也算不在闭集，不做静默归一', () => {
    const verdict = validateFailureClassification({
      case_id: 'V2',
      outcome: 'failed',
      failure_classification: 'Product_Implementation',
      note: '大小写写错了',
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN)
  })

  it('分类合法但既无依据也无 note 时被拒', () => {
    // 分类是判断，不是证据。给了一个合法判断却拿不出任何依据，这次归因只是一句
    // 无从复核的断言。
    const verdict = validateFailureClassification({
      case_id: 'V3',
      outcome: 'failed',
      failure_classification: 'product_implementation',
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, VERIFICATION_CODES.FAILURE_BASIS_MISSING)
    assert.equal(verdict.detail.case_id, 'V3')
  })

  it('空白 note 不算依据，引用为空字符串也不算依据', () => {
    // 「填了」与「填了有用」不是一回事：空白字符串与空引用在数据上等于没写。
    const blankNote = validateFailureClassification({
      case_id: 'V3',
      outcome: 'failed',
      failure_classification: 'product_implementation',
      note: '   ',
      evidence_ref: '',
    })
    assert.equal(blankNote.ok, false)
    assert.equal(blankNote.code, VERIFICATION_CODES.FAILURE_BASIS_MISSING)
  })

  it('三种拒绝原因各自成码，不共用一条', () => {
    // 三条的修复动作完全不同（补分类 / 改分类 / 补依据）。合成一条码就只能靠人读文本分辨，
    // 于是「按码分支」这件事失效。
    const codes = [
      validateFailureClassification({ case_id: 'V1', outcome: 'failed' }).code,
      validateFailureClassification({
        case_id: 'V2', outcome: 'failed', failure_classification: 'nope', note: 'x',
      }).code,
      validateFailureClassification({
        case_id: 'V3', outcome: 'failed', failure_classification: 'build_environment',
      }).code,
    ]
    assert.equal(new Set(codes).size, 3)
    assert.equal(codes.includes(null), false)
  })
})

describe('validateFailureClassification —— 反例方向：合法归因不得被误伤', () => {
  it('六类闭集里的每一类，只要给出依据就全部放行', () => {
    // 这是本节最要紧的一条。逐类遍历而不是抽查一两个：闭集里的某一类被实现漏掉时，
    // 抽查很容易正好没抽到，逐类遍历不会。
    for (const classification of FAILURE_CLASSIFICATIONS) {
      const verdict = validateFailureClassification({
        case_id: `V-${classification}`,
        outcome: 'failed',
        failure_classification: classification,
        note: `这一条的依据：${classification}`,
      })
      assert.equal(verdict.ok, true, `${classification} 是闭集内的合法分类，不该被拒`)
      assert.equal(verdict.code, null)
    }
  })

  it('只有 evidence_ref、没有 note 也是合法归因', () => {
    // 能取证的场景本就该首选证据引用，此时没有 note 完全正常。
    const verdict = validateFailureClassification({
      case_id: 'V1',
      outcome: 'failed',
      failure_classification: 'test_expectation',
      evidence_ref: 'ev-42',
    })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.code, null)
  })

  it('只有 note、没有 evidence_ref 也是合法归因', () => {
    // 环境类问题常常取不到运行时证据，此时 note 是契约给的正当依据。
    const verdict = validateFailureClassification({
      case_id: 'V1',
      outcome: 'failed',
      failure_classification: 'external_resource',
      note: '上游服务返回 503，重试三次均失败',
    })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.code, null)
  })

  it('两类依据都给出时同样放行', () => {
    const verdict = validateFailureClassification({
      case_id: 'V1',
      outcome: 'failed',
      failure_classification: 'build_environment',
      evidence_ref: 'ev-7',
      note: '工具链路径未配置',
    })
    assert.equal(verdict.ok, true)
  })

  it('合法的证据不完整归类一路放行：它是诚实的一类，不是兜底垃圾桶', () => {
    // `evidence_insufficient` 让「查不清楚」也能被结构化记录，而不是被硬塞进某一类冒充结论。
    // 它若被实现当成「非法」拒掉，就等于逼人编一个具体原因。
    const verdict = validateFailureClassification({
      case_id: 'V1',
      outcome: 'failed',
      failure_classification: 'evidence_insufficient',
      note: '日志被轮转覆盖，无法判定是谁的问题',
    })
    assert.equal(verdict.ok, true)
  })

  it('判定函数不抛错：非法输入返回结论而不是异常', () => {
    // 契约要求它「只判定，不抛错」。抛错会让调用方无法把它用在遍历里逐条收集违规。
    assert.doesNotThrow(() => validateFailureClassification(undefined))
    assert.doesNotThrow(() => validateFailureClassification(null))
    assert.doesNotThrow(() => validateFailureClassification('不是对象'))
    assert.equal(validateFailureClassification(undefined).ok, false)
  })
})

describe('evaluateVerification —— 非通过用例的归因检查', () => {
  /**
   * 一份「用例全通过」的报告，把其中一条改成指定形态。
   *
   * @param {object} replacement - 替换 V1 的记录。
   * @returns {object}
   */
  function reportWithV1(replacement) {
    return passingReport({
      executions: [
        replacement,
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
  }

  it('非通过用例缺分类时被拒，且指名到该用例', () => {
    const result = evaluateVerification(
      reportWithV1({ case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1' }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
    )
    assert.ok(violation, `没抓到缺分类：${JSON.stringify(result.violations)}`)
    assert.equal(violation.detail.case_id, 'V1')
  })

  it('分类不在闭集时被拒，且把收到的值放进 detail', () => {
    const result = evaluateVerification(
      reportWithV1({
        case_id: 'V1',
        outcome: 'failed',
        failure_classification: 'flaky',
        note: '顺手写的分类',
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
    )
    assert.ok(violation, `没抓到越界分类：${JSON.stringify(result.violations)}`)
    assert.equal(violation.detail.case_id, 'V1')
    assert.equal(violation.detail.classification, 'flaky')
  })

  it('分类合法却给不出依据时被拒，且指名到该用例', () => {
    const result = evaluateVerification(
      reportWithV1({
        case_id: 'V1',
        outcome: 'failed',
        failure_classification: 'product_implementation',
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_BASIS_MISSING,
    )
    assert.ok(violation, `没抓到缺依据：${JSON.stringify(result.violations)}`)
    assert.equal(violation.detail.case_id, 'V1')
  })

  it('没写 outcome 的用例按非通过处理', () => {
    // 「跑没跑过」都说不清的用例不能算通过，于是也不能免于归因。
    const result = evaluateVerification(
      reportWithV1({ case_id: 'V1', evidence_ref: 'ev-1' }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    assert.equal(
      result.violations.some((v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING),
      true,
    )
  })

  it('多条非通过用例时逐条指名，而不是合成一条计数', () => {
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1' },
          { case_id: 'V2', outcome: 'error', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    const named = result.violations
      .filter((v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING)
      .map((v) => v.detail.case_id)
      .sort()
    assert.deepEqual(named, ['V1', 'V2'])
  })
})

describe('evaluateVerification —— 反例方向：归因齐全的合法非通过用例不得被误伤', () => {
  it('用例失败但归因齐全时，不产生任何归因类违规', () => {
    // 门禁的职责是逼出归因，不是禁止失败。一条失败的用例只要说清了「谁的问题、凭什么」，
    // 就不再是归因问题——它是否阻塞收口由别的判据管，不在这里。
    const plan = completePlan()
    const result = evaluateVerification(
      passingReport({
        executions: [
          {
            case_id: 'V1',
            outcome: 'failed',
            failure_classification: 'product_implementation',
            evidence_ref: 'ev-1',
            note: '断言显示返回值少了必填字段',
            // 用一份独立证据，避免触发取证摊薄——本条只测归因方向。
          },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      plan,
      CRITERIA,
    )
    const classificationViolations = result.violations.filter((v) => [
      VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
      VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
      VERIFICATION_CODES.FAILURE_BASIS_MISSING,
    ].includes(v.code))
    assert.deepEqual(
      classificationViolations,
      [],
      `合法归因被误伤：${JSON.stringify(classificationViolations)}`,
    )
  })

  it('六类闭集逐类走一遍完整判定，没有一类被误判', () => {
    // 逐类遍历是这条反例的关键：实现若把某一类写错（例如比较时大小写敏感、或漏掉
    // 某一项），抽查很容易漏网。
    for (const [index, classification] of FAILURE_CLASSIFICATIONS.entries()) {
      const plan = completePlan()
      const result = evaluateVerification(
        passingReport({
          executions: [
            {
              case_id: 'V1',
              outcome: 'failed',
              failure_classification: classification,
              evidence_ref: `ev-fail-${index}`,
              note: `依据 ${index}`,
            },
            { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
            { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
            { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
          ],
        }),
        plan,
        CRITERIA,
      )
      const hit = result.violations.filter((v) => [
        VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
        VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
        VERIFICATION_CODES.FAILURE_BASIS_MISSING,
      ].includes(v.code))
      assert.deepEqual(hit, [], `${classification} 被误判为归因违规`)
    }
  })

  it('全部用例通过时完全不要求归因', () => {
    // 通过的报告里没有 failure_classification 是正常的。若归因检查不看 outcome 就一律要求，
    // 存量报告会集体变红——那是典型的误伤。
    const result = evaluateVerification(passingReport(), completePlan(), CRITERIA)
    assert.equal(result.ok, true, JSON.stringify(result.violations))
  })
})

describe('归因检查不影响既有门禁语义（AC-LEGACY-CODES）', () => {
  it('既有违规码一个不少、语义未变', () => {
    // 新增归因码是**增量**。既有的六个码仍然是原来的字符串，否则按码分支的调用方会静默失配。
    assert.equal(VERIFICATION_CODES.EVIDENCE_MISSING, 'GAC_INDEPENDENT_EVIDENCE_MISSING')
    assert.equal(VERIFICATION_CODES.EVIDENCE_UNVERIFIED, 'GAC_EVIDENCE_NOT_FROM_RUNTIME')
    assert.equal(VERIFICATION_CODES.EVIDENCE_POOLED, 'GAC_EVIDENCE_POOLED_ACROSS_CASES')
    assert.equal(VERIFICATION_CODES.AC_UNCOVERED, 'GAC_VERIFICATION_COVERAGE_GAP')
    assert.equal(VERIFICATION_CODES.FALSIFICATION_MISSING, 'GAC_FALSIFICATION_EVIDENCE_MISSING')
    assert.equal(VERIFICATION_CODES.CASE_UNKNOWN, 'GAC_VERIFICATION_CASE_UNKNOWN')
  })

  it('取证摊薄在归因齐全的报告里照样被单独抓出', () => {
    // 摊薄与归因是两件事：归因说清「谁的错」，摊薄说的是「这些证据其实是同一个观测」。
    // 前者齐备不能抵消后者——否则一条带归因的共用证据可以一路放行。
    const plan = completePlan()
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-shared' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-shared' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      plan,
      CRITERIA,
    )
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.EVIDENCE_POOLED)
    assert.equal(violation.detail.pooled[0].evidence_ref, 'ev-shared')
    assert.deepEqual(violation.detail.pooled[0].cases.sort(), ['V1', 'V2'])
  })

  it('缺证据仍按 EVIDENCE_MISSING 报，不被归因码取代', () => {
    const plan = completePlan()
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'passed' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      plan,
      CRITERIA,
    )
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.EVIDENCE_MISSING)
    assert.deepEqual(violation.detail.cases, ['V1'])
  })

  it('计划外用例仍按 CASE_UNKNOWN 报', () => {
    const plan = completePlan()
    const result = evaluateVerification(
      passingReport({
        executions: [
          ...passingReport().executions,
          { case_id: 'V99', outcome: 'passed', evidence_ref: 'ev-99' },
        ],
      }),
      plan,
      CRITERIA,
    )
    const violation = result.violations.find((v) => v.code === VERIFICATION_CODES.CASE_UNKNOWN)
    assert.equal(violation.detail.case_id, 'V99')
  })

  it('返回值形状仍是 {ok, violations, traceability}，violations 元素仍是 {code, detail}', () => {
    // 契约要求「在既有返回值形状上只做增量」。新增一条带额外键的违规元素会让下游渲染失配。
    // 这里刻意用一份**确实产生违规**的报告：全通过的报告 violations 为空，下面的循环一次
    // 都不执行，等于什么都没断言。
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-shared' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-shared' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'traceability', 'violations'])
    assert.ok(result.violations.length > 0, '本条必须落在真有违规的报告上，否则断言是空的')
    for (const violation of result.violations) {
      assert.deepEqual(Object.keys(violation).sort(), ['code', 'detail'])
      assert.equal(typeof violation.code, 'string')
      assert.equal(typeof violation.detail, 'object')
    }
  })
})

// ---------------------------------------------------------------------------
// 归因口径：**只作用于「该用例最终没有通过」的记录**。
//
// 一份报告记的是执行历史，不是一次快照。同一条用例先失败、修好之后再跑通过是常态，于是
// 历史里同时躺着 `failed` 与 `passed`。那条历史失败已经被同一用例的后续通过取代，它不再
// 是一个结论——要求它归因，等于逼人给一个**已经不存在的问题**补一份「谁的问题、凭什么」，
// 而唯一能写出来的东西只能是编造。
//
// 所以判定按 `case_id` 聚合：任何一条 `passed` 记录都让该用例当前处于通过状态，其名下全部
// 历史非通过记录免于归因；一条 `passed` 都没有的 case_id 仍然是「最终没有通过」，照旧逐条
// 要求归因。
//
// 本节的正例（①）与反例（②③④）**必须成对存在**，因为它们各自钉住一个方向，而两个方向都
// 有各自的退化解：
//
//   - 只有反例：把归因检查整个删掉能全绿——「最终没通过也不要求归因」正是删掉检查的表现。
//   - 只有正例：把归因检查改成「整个 case_id 一条不落地全部豁免」也能全绿——只要报告里出现
//     过一次 `passed` 就放行一切，包括那些压根没通过过的用例。
//
// 三个反例各自钉住实现退化的一个方向，写在每条用例的注释里。
// ---------------------------------------------------------------------------

describe('evaluateVerification —— 归因口径按 case_id 聚合到「最终是否通过」', () => {
  /**
   * 一条「用例最终通过」的报告：V1 先失败（**刻意不给任何归因**）、修好后重跑通过。
   *
   * 剥离归因字段是刻意的：只要 V1 的失败记录还带着 `failure_classification`，这条测试就
   * 分不清「实现豁免了历史失败」与「实现要求归因、而报告恰好给了」——两者都会 ok。
   * 只有把归因拿掉，ok=true 才唯一地证明豁免成立。
   *
   * @returns {object}
   */
  function rerunThenPassedReport() {
    return passingReport({
      executions: [
        // 历史失败：无 outcome 之外的任何归因字段。
        { case_id: 'V1', outcome: 'failed' },
        // 同一用例的后续通过：带了证据，因此「通过」这一侧是齐备的。
        { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
        { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
        { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
        { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
      ],
    })
  }

  /**
   * 从判定结果里挑出三类归因违规，用于断言「一条都没有」。
   *
   * @param {{violations: {code: string}[]}} result
   * @returns {{code: string}[]}
   */
  function classificationViolationsOf(result) {
    return result.violations.filter((v) => [
      VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
      VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
      VERIFICATION_CODES.FAILURE_BASIS_MISSING,
    ].includes(v.code))
  }

  // ---- ① 正例：重跑并最终通过 ⇒ 历史失败免于归因 ----

  it('用例被重跑并最终通过时，其历史失败记录不要求归因', () => {
    // 被抓住的错误实现：把归因检查写成「逐条看 outcome，凡不是 passed 就要求归因」。
    // 那种实现看不见同一 case_id 的后续通过，于是任何一份「先失败后修好」的真实报告都会
    // 被判缺归因——而它报的是一条已经被推翻的中间状态，要求归因只能编造。
    const result = evaluateVerification(rerunThenPassedReport(), completePlan(), CRITERIA)
    assert.deepEqual(
      classificationViolationsOf(result),
      [],
      `历史失败被要求归因：${JSON.stringify(result.violations)}`,
    )
    // ok 一并钉死：只要还留着别的违规，`violations` 为空就必须另找理由，本条不放松。
    assert.equal(result.ok, true, JSON.stringify(result.violations))
  })

  it('多条用例各自重跑通过时，全部历史失败都免于归因', () => {
    // 只豁免第一条会漏掉「豁免只在某一条用例上恰好生效」——例如实现误用了某个只记一个
    // case_id 的变量，或把 `finallyPassed` 写成了单个字符串而非集合。
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'failed' },
          { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
          { case_id: 'V2', outcome: 'failed' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'error' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.deepEqual(
      classificationViolationsOf(result),
      [],
      `历史失败被要求归因：${JSON.stringify(result.violations)}`,
    )
    assert.equal(result.ok, true, JSON.stringify(result.violations))
  })

  it('最新失败不能被历史通过覆盖', () => {
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
          { case_id: 'V1', outcome: 'failed' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(classificationViolationsOf(result)[0]?.detail.case_id, 'V1')
    assert.equal(result.ok, false, JSON.stringify(result.violations))
  })

  // ---- ② 反例：最终没有通过 ⇒ 缺归因仍被拒 ----

  it('用例最终没有通过时，缺 failure_classification 仍被拒并指名到该用例', () => {
    // 被抓住的错误实现：把「出现过一次非通过」与「最终没有通过」混为一谈之后**过度豁免**
    //    ——例如一见某 case_id 有 N 条记录就直接跳过，或者把豁免键取成报告里出现过的任意
    //    case_id 而非「有 passed 记录的 case_id」。那样的实现会让**根本没通过过**的用例
    //    一路放行，归因门禁就名存实亡了。
    const result = evaluateVerification(
      passingReport({
        executions: [
          // V1 只有失败记录：没有任何 passed。它最终没有通过。
          { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
    )
    assert.ok(violation, `没抓到缺分类：${JSON.stringify(result.violations)}`)
    assert.equal(violation.code, 'GAC_FAILURE_CLASSIFICATION_MISSING')
    assert.equal(violation.detail.case_id, 'V1')
  })

  it('缺 outcome 的记录同样算「最终没有通过」，照旧被拒', () => {
    // 「跑没跑过」都说不清的用例不能算通过，因此它不构成任何一条 passed 记录，也就不能
    // 借豁免溜走。被抓住的错误实现：把「有 passed 记录」放宽成「记录里没有 failed」。
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', evidence_ref: 'ev-1' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
    )
    assert.ok(violation, `没抓到缺分类：${JSON.stringify(result.violations)}`)
    assert.equal(violation.detail.case_id, 'V1')
  })

  it('豁免只覆盖本 case_id：别人的通过不能替它免掉归因', () => {
    // 被抓住的错误实现：豁免判定写成「这份报告里有没有 passed」而不是「**这个** case_id
    // 有没有 passed」。一份只要有一条用例通过就整体豁免的报告，等于没有归因门禁。
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    const named = result.violations
      .filter((v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING)
      .map((v) => v.detail.case_id)
    assert.deepEqual(named, ['V1'])
  })

  it('最新失败不能被历史通过覆盖', () => {
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'passed', evidence_ref: 'ev-1' },
          { case_id: 'V1', outcome: 'failed', evidence_ref: 'ev-1-later' },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(classificationViolationsOf(result)[0]?.detail.case_id, 'V1')
    assert.equal(result.ok, false, JSON.stringify(result.violations))
  })

  // ---- ③ 反例：最终没有通过 + 分类越界 ⇒ UNKNOWN ----

  it('用例最终没有通过且分类越界时报 GAC_FAILURE_CLASSIFICATION_UNKNOWN', () => {
    // 被抓住的错误实现：豁免实现写成了「一刀切跳过」——例如用 `finallyPassed` 判断时把
    // 条件写反（`!finallyPassed.has(...)`），或者干脆 `continue` 掉了所有非通过记录。
    // 那种实现下这条用例不再产生任何违规，吞掉的正是「分类有没有落进闭集」这条判定。
    const result = evaluateVerification(
      passingReport({
        executions: [
          {
            case_id: 'V1',
            outcome: 'failed',
            failure_classification: 'flaky',
            note: '顺手写的分类，不在闭集里',
          },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
    )
    assert.ok(violation, `没抓到越界分类：${JSON.stringify(result.violations)}`)
    assert.equal(violation.code, 'GAC_FAILURE_CLASSIFICATION_UNKNOWN')
    assert.equal(violation.detail.case_id, 'V1')
    assert.equal(violation.detail.classification, 'flaky')
    // 与「缺分类」分开：分类越界时**不得**同时报缺分类——那是两个不同的修复动作。
    assert.equal(
      result.violations.some(
        (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
      ),
      false,
    )
  })

  it('分类越界与缺分类在最终没有通过时各自成码，不被合成一条', () => {
    const result = evaluateVerification(
      passingReport({
        executions: [
          { case_id: 'V1', outcome: 'failed' },
          { case_id: 'V2', outcome: 'failed', failure_classification: 'environment', note: 'x' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    const codes = result.violations
      .filter((v) => [
        VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
        VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
      ].includes(v.code))
      .map((v) => `${v.code}:${v.detail.case_id}`)
      .sort()
    assert.deepEqual(codes, [
      'GAC_FAILURE_CLASSIFICATION_MISSING:V1',
      'GAC_FAILURE_CLASSIFICATION_UNKNOWN:V2',
    ])
  })

  // ---- ④ 反例：分类合法但无依据 ⇒ BASIS_MISSING ----

  it('分类合法但既无 evidence_ref 也无 note 时报 GAC_FAILURE_BASIS_MISSING', () => {
    // 被抓住的错误实现：只校验了「分类在不在闭集里」就返回 ok，漏掉依据校验。
    // 分类是判断，不是证据——一个合法分类配上一句无据可查的断言，与没归因一样不可复核。
    const result = evaluateVerification(
      passingReport({
        executions: [
          {
            case_id: 'V1',
            outcome: 'failed',
            failure_classification: 'product_implementation',
          },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.equal(result.ok, false)
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_BASIS_MISSING,
    )
    assert.ok(violation, `没抓到缺依据：${JSON.stringify(result.violations)}`)
    assert.equal(violation.code, 'GAC_FAILURE_BASIS_MISSING')
    assert.equal(violation.detail.case_id, 'V1')
    assert.equal(violation.detail.classification, 'product_implementation')
    // 有分类就不该再报「缺分类」：那是另一条码、另一个修复动作。
    assert.equal(
      result.violations.some(
        (v) => v.code === VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
      ),
      false,
    )
  })

  it('空白 note 与空引用在最终没有通过时同样算「拿不出依据」', () => {
    // 「填了」与「填了有用」不是一回事：空白字符串、空引用在数据上等于没写。
    // 被抓住的错误实现：依据判定写成 `'note' in entry` 或 `entry.note !== undefined`。
    const result = evaluateVerification(
      passingReport({
        executions: [
          {
            case_id: 'V1',
            outcome: 'failed',
            failure_classification: 'build_environment',
            note: '   ',
            evidence_ref: '',
          },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    const violation = result.violations.find(
      (v) => v.code === VERIFICATION_CODES.FAILURE_BASIS_MISSING,
    )
    assert.ok(violation, `空白依据被当成依据：${JSON.stringify(result.violations)}`)
    assert.equal(violation.detail.case_id, 'V1')
  })

  // ---- 反例方向：豁免不得把「已给出合法归因」当成违规 ----

  it('最终没有通过但归因齐备时，豁免逻辑不额外制造违规', () => {
    // 与前面几条互补：豁免应当**只减少**要求，不能反过来把一条本来合法的归因改判成违规。
    // 被抓住的错误实现：先按 case_id 过滤、再对过滤后的集合重排索引，导致 detail 里的
    // case_id 被替换成别的用例（归因违规仍出现，但指错了人）。
    const result = evaluateVerification(
      passingReport({
        executions: [
          {
            case_id: 'V1',
            outcome: 'failed',
            failure_classification: 'test_expectation',
            evidence_ref: 'ev-fail-1',
            note: '期望值与验收标准不一致',
          },
          { case_id: 'V2', outcome: 'passed', evidence_ref: 'ev-2' },
          { case_id: 'V3', outcome: 'passed', evidence_ref: 'ev-3' },
          { case_id: 'V4', outcome: 'passed', evidence_ref: 'ev-4' },
        ],
      }),
      completePlan(),
      CRITERIA,
    )
    assert.deepEqual(
      classificationViolationsOf(result),
      [],
      `合法归因被误伤：${JSON.stringify(result.violations)}`,
    )
  })
})
