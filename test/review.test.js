/**
 * 独立复核模块测试（大纲 §31、§32，适配计划 §4.4 阶段 4）。
 *
 * 六问的词表是从原运行时的 `templates/review.json` 搬过来的，因此测试里那六条 key 是**逐字**
 * 写下来的：它们是一份约定，改了名字门禁就无从施加，而「名字悄悄变了」这件事只能靠一条钉住
 * 词表的断言发现。
 *
 * 与验证层测试同一口径：能机器核对的是「答了没有、方向对不对、与其他申报矛盾不矛盾」，不能核
 * 对的是「回答是不是真的」。后者写在模块头，不在测试里假装。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  INDEPENDENCE_KEYS,
  INDEPENDENCE_QUESTIONS,
  QUALITY_KEYS,
  REVIEW_CODES,
  ReviewError,
  compileReviewReport,
  evaluateReview,
  reviewId,
} from '../lib/review.js'
import { readEngineeringPolicy } from '../lib/engineering-policy.js'

/** 一份六问齐备、五个维度都有结论的报告草稿。 */
function draft(overrides = {}) {
  return {
    summary: '复核通过：契约、计划、证据三者对得上',
    blocking_issues: [],
    evidence: [],
    engineering_quality: {
      reuse: '复用了 write-scope 的包含判定，没有第二份实现',
      duplication: '无',
      unnecessary_abstraction: '无',
      change_scope: '只改了目标文件',
      dependency: '没有新增依赖',
    },
    verification_independence: {
      builder_tests_only: false,
      expectations_from_requirement: true,
      falsification_present: true,
      uncovered_criteria: [],
      verifier_reran_builder_tests_only: false,
      plan_modified_by_builder: false,
    },
    ...overrides,
  }
}

/**
 * 在一份草稿上改一条答案。
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {object}
 */
function answer(key, value) {
  return draft({ verification_independence: { ...draft().verification_independence, [key]: value } })
}

/**
 * 在一份草稿上改一个维度。
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {object}
 */
function dimension(key, value) {
  return draft({ engineering_quality: { ...draft().engineering_quality, [key]: value } })
}

describe('六问与五个维度的词表', () => {
  it('六问的键逐字固定，且顺序稳定', () => {
    // 词表是约定的最小集：项目可以加维度，但这六条的名字必须固定，否则「复核答了没有」会随
    // 项目而变。它与原模板 templates/review.json 的 verification_independence 逐字对应。
    assert.deepEqual([...INDEPENDENCE_KEYS], [
      'builder_tests_only',
      'expectations_from_requirement',
      'falsification_present',
      'uncovered_criteria',
      'verifier_reran_builder_tests_only',
      'plan_modified_by_builder',
    ])
  })

  it('五个质量维度的键逐字固定', () => {
    assert.deepEqual([...QUALITY_KEYS], [
      'reuse',
      'duplication',
      'unnecessary_abstraction',
      'change_scope',
      'dependency',
    ])
  })

  it('每条问题都写明「什么样的答案才可信」以及理由', () => {
    for (const question of INDEPENDENCE_QUESTIONS) {
      assert.ok(['boolean', 'strings'].includes(question.kind), `${question.key} 的 kind`)
      assert.equal(typeof question.ask, 'string')
      assert.equal(typeof question.why, 'string')
      assert.ok(question.why.length > 0, `${question.key} 必须写明这条为什么重要`)
    }
  })
})

describe('compileReviewReport —— 答完才允许成为产物', () => {
  it('一份答完的报告被编译并冻结', () => {
    const report = compileReviewReport(draft())
    assert.equal(report.schema_version, 1)
    assert.equal(Object.isFrozen(report), true)
    assert.equal(Object.isFrozen(report.verification_independence), true)
    assert.equal(Object.isFrozen(report.engineering_quality), true)
    assert.equal(Object.isFrozen(report.blocking_issues), true)
    assert.equal(Object.isFrozen(report.evidence), true)
  })

  it('拒绝不是对象的东西', () => {
    for (const bad of [null, undefined, 'review', 42, []]) {
      assert.throws(
        () => compileReviewReport(bad),
        (error) => error instanceof ReviewError && error.code === REVIEW_CODES.MALFORMED,
        `应当拒绝 ${JSON.stringify(bad)}`,
      )
    }
  })

  it('没有结论的报告被拒', () => {
    // 读的人只能从六问的答案里去猜它想说什么。
    assert.throws(() => compileReviewReport(draft({ summary: '   ' })), /summary/u)
  })

  it('未声明的字段一律拒绝，而不是放过', () => {
    assert.throws(
      () => compileReviewReport(draft({ verdict: 'pass' })),
      (error) => error.code === REVIEW_CODES.MALFORMED,
    )
  })

  it('六问缺一条就不许登记，并指名缺的是哪一条', () => {
    const partial = draft()
    delete partial.verification_independence.falsification_present
    assert.throws(
      () => compileReviewReport(partial),
      (error) => error.code === REVIEW_CODES.INDEPENDENCE_UNANSWERED
        && error.detail.questions.includes('falsification_present'),
    )
  })

  it('null 不是答案：它既不是「是」也不是「否」', () => {
    // 放 null 过去，会让一份没回答的复核看起来像一份答完的复核。
    assert.throws(
      () => compileReviewReport(answer('builder_tests_only', null)),
      (error) => error.code === REVIEW_CODES.INDEPENDENCE_UNANSWERED,
    )
  })

  it('布尔量那几问必须是真布尔量', () => {
    for (const value of ['false', 0, 1, {}]) {
      assert.throws(
        () => compileReviewReport(answer('plan_modified_by_builder', value)),
        (error) => error.code === REVIEW_CODES.INDEPENDENCE_UNANSWERED,
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

  it('清单那一问必须是字符串数组，空数组合法', () => {
    assert.deepEqual(
      compileReviewReport(answer('uncovered_criteria', [])).verification_independence.uncovered_criteria,
      [],
    )
    assert.deepEqual(
      compileReviewReport(answer('uncovered_criteria', ['AC2'])).verification_independence.uncovered_criteria,
      ['AC2'],
    )
    for (const value of ['AC2', ['AC2', ''], [7], null]) {
      assert.throws(
        () => compileReviewReport(answer('uncovered_criteria', value)),
        (error) => error.code === REVIEW_CODES.INDEPENDENCE_UNANSWERED,
        `应当拒绝 ${JSON.stringify(value)}`,
      )
    }
  })

  it('五个维度都要有结论，「无」是合法答案、留空不是', () => {
    assert.equal(compileReviewReport(dimension('dependency', '无')).engineering_quality.dependency, '无')
    assert.throws(
      () => compileReviewReport(dimension('reuse', '   ')),
      (error) => error.code === REVIEW_CODES.QUALITY_MISSING
        && error.detail.dimensions.includes('reuse'),
    )
  })

  it('blocking_issues 与 evidence 必须是字符串数组', () => {
    assert.deepEqual(compileReviewReport(draft()).blocking_issues, [])
    assert.deepEqual(compileReviewReport(draft()).evidence, [])
    assert.throws(
      () => compileReviewReport(draft({ blocking_issues: '无' })),
      (error) => error.code === REVIEW_CODES.MALFORMED,
    )
    assert.throws(
      () => compileReviewReport(draft({ evidence: [''] })),
      (error) => error.code === REVIEW_CODES.MALFORMED,
    )
  })
})

describe('evaluateReview —— 复核自己说了什么', () => {
  it('答完且方向都对时通过', () => {
    const verdict = evaluateReview(compileReviewReport(draft()))
    assert.equal(verdict.ok, true)
    assert.deepEqual(verdict.violations, [])
  })

  it('方向反了的布尔量逐条报出来，并说明为什么', () => {
    // 五条布尔量各反一次：任一条反了都说明这次验证在方法上有洞，而不是「态度不够积极」。
    for (const question of INDEPENDENCE_QUESTIONS.filter((entry) => entry.kind === 'boolean')) {
      const verdict = evaluateReview(answer(question.key, !question.expected))
      assert.equal(verdict.ok, false, `${question.key} 反了应当被拒`)
      const violation = verdict.violations.find((entry) => entry.detail.question === question.key)
      assert.equal(violation.code, REVIEW_CODES.INDEPENDENCE_FAILED)
      assert.equal(violation.detail.ask, question.ask)
      assert.equal(violation.detail.why, question.why)
    }
  })

  it('申报了未覆盖的验收标准时被拒，并列出那些标准', () => {
    // 这不是「答案填错了」：它是一次如实的自我申报，恰好说明验证还没覆盖完整。
    const verdict = evaluateReview(answer('uncovered_criteria', ['AC2', 'AC5']))
    assert.equal(verdict.ok, false)
    const violation = verdict.violations.find((entry) => entry.code === REVIEW_CODES.INDEPENDENCE_FAILED)
    assert.deepEqual(violation.detail.criteria, ['AC2', 'AC5'])
  })

  it('留下阻塞问题时被拒，并带上问题原文', () => {
    const verdict = evaluateReview(draft({ blocking_issues: ['并行写入没有契约', '解码未做越界检查'] }))
    const violation = verdict.violations.find((entry) => entry.code === REVIEW_CODES.BLOCKING_ISSUES)
    assert.deepEqual(violation.detail.issues, ['并行写入没有契约', '解码未做越界检查'])
  })

  it('手工改过、缺字段的记录在这里也会被报出来', () => {
    // 登记那一关已经拒过缺答案的报告；这条守的是「记录被手工改过」与「记录来自更早的版本」。
    const verdict = evaluateReview({ verification_independence: {}, engineering_quality: {} })
    assert.equal(verdict.ok, false)
    assert.equal(
      verdict.violations.some((entry) => entry.code === REVIEW_CODES.INDEPENDENCE_UNANSWERED),
      true,
    )
    assert.equal(
      verdict.violations.some((entry) => entry.code === REVIEW_CODES.QUALITY_MISSING),
      true,
    )
  })

  it('证据引用只核对签发，因此引用一条失败的命令是合法的', () => {
    // 复核引用一条失败的命令，正是在拿它当缺陷证据。若按「能不能充当通过凭据」判，这种引用会
    // 被误判成编造，而它恰恰是复核最常见的用法。
    assert.equal(evaluateReview(draft({ evidence: ['ev-2#退出码 1'] }), {
      issuedEvidence: ['ev-1', 'ev-2'],
    }).ok, true)
  })

  it('运行时没发过的证据号一律不认', () => {
    const verdict = evaluateReview(draft({ evidence: ['ev-1#AC1', 'ev-999#AC1'] }), {
      issuedEvidence: ['ev-1'],
    })
    const violation = verdict.violations.find((entry) => entry.code === REVIEW_CODES.EVIDENCE_UNVERIFIED)
    assert.deepEqual(violation.detail.refs, ['ev-999#AC1'])
  })

  it('不给已签发号时跳过引用核对（只适合单测，文档里写明了）', () => {
    assert.equal(evaluateReview(draft({ evidence: ['随便编的'] })).ok, true)
  })
})

describe('工程质量策略素材', () => {
  it('资源文件在场，读出来的是策略原文而不是空串', () => {
    // 适配计划 §8 对这一项的处置是「原文保留，纳入插件资源」。素材不在场时，审查者拿不到判断
    // 标准，而「审查按工程质量策略做了」会变成一句无从核对的话——所以这条断言存在。
    const policy = readEngineeringPolicy()
    assert.equal(policy.reason, undefined, `策略素材读不出来：${policy.reason}`)
    assert.ok(policy.text.length > 1000, `策略素材太短，像是被截过：${policy.text.length}`)
    assert.match(policy.text, /Prefer the simplest implementation that fully satisfies/u)
    assert.match(policy.text, /Reviewer 阻塞实质工程问题/u)
  })

  it('读第二次拿到同一份（缓存），不是每次读盘', () => {
    assert.equal(readEngineeringPolicy(), readEngineeringPolicy())
  })
})

describe('reviewId —— 报告的身份', () => {
  it('同一份内容给出同一个身份，与键的顺序无关', () => {
    const reordered = draft()
    reordered.verification_independence = {
      plan_modified_by_builder: false,
      uncovered_criteria: [],
      falsification_present: true,
      expectations_from_requirement: true,
      verifier_reran_builder_tests_only: false,
      builder_tests_only: false,
    }
    assert.equal(reviewId(compileReviewReport(draft())), reviewId(compileReviewReport(reordered)))
  })

  it('答案一变，身份就变', () => {
    assert.notEqual(
      reviewId(compileReviewReport(draft())),
      reviewId(compileReviewReport(answer('falsification_present', false))),
    )
  })

  it('把计划身份算进去：复核的对象换了，报告就不再是同一份', () => {
    // 字段名与 `gac_task` 盖章时用的那个一致（reviewed_plan_id）：两边用两个名字，会让身份对
    // 「复核的是哪份计划」不敏感，而识别这正是它存在的理由。
    assert.notEqual(
      reviewId({ ...draft(), reviewed_plan_id: 'plan-1' }),
      reviewId({ ...draft(), reviewed_plan_id: 'plan-2' }),
    )
  })
})
