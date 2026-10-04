/**
 * 独立验证：计划、可追溯性与门禁。
 *
 * @module dsh-gac-runtime/verification
 *
 * 这是 GAC 最不可替代的部分（大纲 §26–§31、§50）。它回答的问题只有一个：**这份实现
 * 是对的，我们凭什么知道？** 「测试都过了」不是答案——实现与它的测试出自同一个理解，
 * 理解一旦有偏，两边会一起绿，两边的绿灯来自同一个错误前提。
 *
 * 所以这里强制三件事：
 *
 *   1. **计划从需求推导，不读实现。** 验证计划在实现之前产出并冻结（§27）。本模块
 *      不检查「计划作者有没有偷看实现」——那无法从产物上判定——但它保证计划一旦冻结
 *      就不可由实现侧改写。
 *   2. **每条验收标准都要有反例。** 正例证明「对的能过」，反例证明「错的会被抓住」。
 *      只有正例的验证集无法区分「实现正确」与「断言太弱」（§29）。
 *   3. **证据要能追溯到验收标准。** AC → 用例 → 已执行证据三段齐全（§30）。
 *
 * 覆盖缺口与空反例都要**指名到具体 AC**，而不是给一个计数：一句「覆盖率 80%」无法
 * 让人知道该补哪一条，于是它既不能被修复也不能被复核。
 *
 * 取证摊薄（一条命令的同一份证据被拿来充当多条用例的证据）单列一码，因为它在形式上
 * 完全合法——用例齐、AC 齐、证据也在——只是那些证据其实是同一个观测。这类缺口靠计数
 * 发现不了，必须比对证据本身。
 */

/** 机器可分支的结构化门禁码。 */
export const VERIFICATION_CODES = Object.freeze({
  PLAN_MISSING: 'GAC_VERIFICATION_PLAN_MISSING',
  AC_UNCOVERED: 'GAC_VERIFICATION_COVERAGE_GAP',
  FALSIFICATION_MISSING: 'GAC_FALSIFICATION_EVIDENCE_MISSING',
  EVIDENCE_MISSING: 'GAC_INDEPENDENT_EVIDENCE_MISSING',
  EVIDENCE_UNVERIFIED: 'GAC_EVIDENCE_NOT_FROM_RUNTIME',
  EVIDENCE_POOLED: 'GAC_EVIDENCE_POOLED_ACROSS_CASES',
  PLAN_MUTATED: 'GAC_VERIFICATION_PLAN_MUTATED',
  CASE_UNKNOWN: 'GAC_VERIFICATION_CASE_UNKNOWN',
})

/**
 * 结构化验证错误。
 */
export class VerificationError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'VerificationError'
    this.code = code
    this.detail = detail
  }
}

/** 用例类型闭集。只有两类，因为验收标准只有两种需要证明的方向。 */
export const CASE_TYPES = Object.freeze(['positive', 'falsification'])

/**
 * 校验并冻结一份验证计划。
 *
 * 冻结是结构性的：返回的对象被 deep-freeze，实现侧拿到它也只能读。这样「计划不得由
 * 实现侧改写」不是一条纪律，而是一件做不到的事。
 *
 * @param {object} raw
 * @param {object} [options]
 * @param {readonly string[]} [options.criteria] - 验收标准 id 列表，用于当场核对覆盖。
 * @returns {Readonly<object>}
 * @throws {VerificationError}
 */
export function compileVerificationPlan(raw, options = {}) {
  const fail = (message, code, detail) => {
    throw new VerificationError(message, code, detail)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('验证计划必须是一个对象', VERIFICATION_CODES.PLAN_MISSING)
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    fail('验证计划至少需要一个用例', VERIFICATION_CODES.PLAN_MISSING)
  }

  const seen = new Set()
  const cases = raw.cases.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      fail('每个用例都必须是一个对象', VERIFICATION_CODES.PLAN_MISSING)
    }
    const id = entry.id
    if (typeof id !== 'string' || id === '') {
      fail('每个用例都必须有非空的 id', VERIFICATION_CODES.PLAN_MISSING)
    }
    if (seen.has(id)) {
      fail(`用例 id 重复：${id}`, VERIFICATION_CODES.PLAN_MISSING, { case: id })
    }
    seen.add(id)
    if (!CASE_TYPES.includes(entry.type)) {
      fail(
        `用例 ${id} 的 type 必须是 ${CASE_TYPES.join(' 或 ')}，收到 ${entry.type}`,
        VERIFICATION_CODES.PLAN_MISSING,
        { case: id },
      )
    }
    if (!Array.isArray(entry.covers) || entry.covers.length === 0) {
      // 不关联验收标准的用例无法参与可追溯性判定，等于没有。
      fail(`用例 ${id} 未声明 covers（它证明哪条验收标准）`, VERIFICATION_CODES.PLAN_MISSING, { case: id })
    }
    if (entry.type === 'falsification') {
      // 反例必须写明「什么样的错误实现会被抓住」。没有这一句，反例退化成一个更弱的正例。
      if (typeof entry.expect_failure !== 'string' || entry.expect_failure.trim() === '') {
        fail(
          `用例 ${id} 是反例，必须写明 expect_failure：什么样的错误实现应当被它抓住`,
          VERIFICATION_CODES.FALSIFICATION_MISSING,
          { case: id },
        )
      }
    } else if (typeof entry.expect !== 'string' || entry.expect.trim() === '') {
      fail(`用例 ${id} 是正例，必须写明 expect`, VERIFICATION_CODES.PLAN_MISSING, { case: id })
    }
    return Object.freeze({
      id,
      covers: Object.freeze([...entry.covers]),
      type: entry.type,
      ...(entry.expect === undefined ? {} : { expect: entry.expect }),
      ...(entry.expect_failure === undefined ? {} : { expect_failure: entry.expect_failure }),
    })
  })

  const plan = Object.freeze({
    schema_version: 1,
    cases: Object.freeze(cases),
    // 需求侧声明它覆盖哪些 AC。给了就当场核对，避免到收口时才发现漏了一条。
    criteria: Object.freeze([...(options.criteria ?? [])]),
    frozen_at: options.frozenAt ?? 0,
  })

  if (options.criteria !== undefined) {
    const gaps = findCoverageGaps(plan, options.criteria)
    if (gaps.length > 0) {
      fail(
        `验证计划未覆盖验收标准：${gaps.join(', ')}`,
        VERIFICATION_CODES.AC_UNCOVERED,
        { uncovered: gaps },
      )
    }
    // 覆盖不等于够用：每条 AC 还要有一个正例**和一个反例**。只查覆盖会让一份全由正例
    // 组成的计划通过编译，而那样的计划无法区分「实现正确」与「断言太弱」。
    const typeGaps = findCaseTypeGaps(plan, options.criteria)
    if (typeGaps.without_falsification.length > 0) {
      fail(
        `验证计划缺少反例的验收标准：${typeGaps.without_falsification.join(', ')}；`
        + '每条验收标准都要有一个反例，并写明什么样的错误实现应当被它抓住',
        VERIFICATION_CODES.FALSIFICATION_MISSING,
        { criteria: typeGaps.without_falsification },
      )
    }
    if (typeGaps.without_positive.length > 0) {
      fail(
        `验证计划缺少正例的验收标准：${typeGaps.without_positive.join(', ')}`,
        VERIFICATION_CODES.AC_UNCOVERED,
        { without_positive: typeGaps.without_positive },
      )
    }
  }
  return plan
}

/**
 * 找出没有正例、或没有反例的验收标准。
 *
 * 两类都要查：只有正例证明不了「错实现会被抓住」，只有反例证明不了「对实现能过」。
 *
 * @param {Readonly<object>} plan
 * @param {readonly string[]} criteria
 * @returns {{without_positive: string[], without_falsification: string[]}}
 */
export function findCaseTypeGaps(plan, criteria) {
  const withoutPositive = []
  const withoutFalsification = []
  for (const criterion of criteria) {
    const covering = plan.cases.filter((entry) => entry.covers.includes(criterion))
    if (!covering.some((entry) => entry.type === 'positive')) withoutPositive.push(criterion)
    if (!covering.some((entry) => entry.type === 'falsification')) withoutFalsification.push(criterion)
  }
  return { without_positive: withoutPositive, without_falsification: withoutFalsification }
}

/**
 * 找出没有任何用例覆盖的验收标准。
 *
 * @param {Readonly<object>} plan
 * @param {readonly string[]} criteria
 * @returns {string[]}
 */
export function findCoverageGaps(plan, criteria) {
  return criteria.filter(
    (criterion) => !plan.cases.some((entry) => entry.covers.includes(criterion)),
  )
}

/**
 * 校验一份验证报告，并给出可追溯性判定。
 *
 * @param {object} raw - 报告：{ plan_id?, executions: [{ case_id, outcome, evidence_ref }] }
 * @param {Readonly<object>} plan
 * @param {readonly string[]} criteria
 * @param {object} [options]
 * @param {(ref: string) => {usable: boolean, reason?: string}} [options.resolveEvidence]
 *   核对引用是否指向运行时真实发出过的、且能充当「通过」凭据的证据。**不给这个函数时，
 *   引用只被当作字符串处理**——那种模式只适合单元测试，因为编造的引用与真实的引用在字符串
 *   层面无法区分。
 * @returns {{
 *   ok: boolean,
 *   violations: {code: string, detail: object}[],
 *   traceability: {criterion: string, cases: string[], evidence: string[]}[]
 * }}
 */
export function evaluateVerification(raw, plan, criteria, options = {}) {
  const violations = []
  const executions = Array.isArray(raw?.executions) ? raw.executions : []
  const resolveEvidence = options.resolveEvidence

  // 未知用例：报告里出现了计划中没有的用例 id。这通常意味着报告对应的是另一份计划，
  // 或者用例被改名后没有同步计划——两种都必须拦，否则「这条过了」指的可能是别的用例。
  const known = new Set(plan.cases.map((entry) => entry.id))
  const unknown = executions
    .map((entry) => entry?.case_id)
    .filter((id) => typeof id === 'string' && !known.has(id))
  for (const id of new Set(unknown)) {
    violations.push({ code: VERIFICATION_CODES.CASE_UNKNOWN, detail: { case_id: id } })
  }

  // 只认 passed：missing / failed / error 都不是通过证据。
  const passed = new Map()
  for (const entry of executions) {
    if (entry?.outcome !== 'passed') continue
    if (typeof entry.case_id !== 'string') continue
    const list = passed.get(entry.case_id) ?? []
    list.push(entry)
    passed.set(entry.case_id, list)
  }

  const missingEvidence = []
  for (const entry of plan.cases) {
    const recorded = passed.get(entry.id)
    if (recorded === undefined) {
      missingEvidence.push(entry.id)
      continue
    }
    // 有「通过」但没有证据引用，等于让人凭一句话相信。
    if (!recorded.some((item) => typeof item.evidence_ref === 'string' && item.evidence_ref !== '')) {
      missingEvidence.push(entry.id)
    }
  }
  if (missingEvidence.length > 0) {
    violations.push({
      code: VERIFICATION_CODES.EVIDENCE_MISSING,
      detail: { cases: missingEvidence },
    })
  }

  // 引用必须指向运行时真实发出过、且能充当「通过」凭据的证据。没有这一步，报告里的
  // `evidence_ref` 只是一个模型写下的字符串——写下 `ev-1` 与真正跑过一条命令在数据上
  // 完全一样，于是「每条用例都有证据」可以靠编造满足。
  if (resolveEvidence !== undefined) {
    const rejected = []
    for (const [caseId, entries] of passed) {
      for (const item of entries) {
        const ref = item.evidence_ref
        if (typeof ref !== 'string' || ref === '') continue
        const verdict = resolveEvidence(ref)
        if (verdict.usable === false) {
          rejected.push({ case_id: caseId, evidence_ref: ref, reason: verdict.reason ?? '不可用' })
        }
      }
    }
    if (rejected.length > 0) {
      violations.push({
        code: VERIFICATION_CODES.EVIDENCE_UNVERIFIED,
        detail: { rejected },
      })
    }
  }

  // 覆盖与反例两类缺口都指名到具体 AC。
  const coverageGaps = findCoverageGaps(plan, criteria)
  if (coverageGaps.length > 0) {
    violations.push({ code: VERIFICATION_CODES.AC_UNCOVERED, detail: { uncovered: coverageGaps } })
  }
  const typeGaps = findCaseTypeGaps(plan, criteria)
  if (typeGaps.without_falsification.length > 0) {
    violations.push({
      code: VERIFICATION_CODES.FALSIFICATION_MISSING,
      detail: { criteria: typeGaps.without_falsification },
    })
  }
  if (typeGaps.without_positive.length > 0) {
    violations.push({
      code: VERIFICATION_CODES.AC_UNCOVERED,
      detail: { without_positive: typeGaps.without_positive },
    })
  }

  const traceability = criteria.map((criterion) => {
    const covering = plan.cases.filter((entry) => entry.covers.includes(criterion))
    const evidence = covering.flatMap((entry) =>
      (passed.get(entry.id) ?? [])
        .map((item) => item.evidence_ref)
        .filter((ref) => typeof ref === 'string' && ref !== ''))
    return { criterion, cases: covering.map((entry) => entry.id), evidence: [...new Set(evidence)] }
  })

  // 取证摊薄：同一份证据被多条用例共同引用。形式上完全合法——用例齐、AC 齐、证据也在
  // ——只是那些证据是同一个观测。计数发现不了它，必须比对证据本身。
  const byEvidence = new Map()
  for (const [caseId, entries] of passed) {
    for (const item of entries) {
      if (typeof item.evidence_ref !== 'string' || item.evidence_ref === '') continue
      const users = byEvidence.get(item.evidence_ref) ?? []
      users.push(caseId)
      byEvidence.set(item.evidence_ref, users)
    }
  }
  const pooled = [...byEvidence.entries()]
    .filter(([, users]) => new Set(users).size > 1)
    .map(([evidence_ref, users]) => ({ evidence_ref, cases: [...new Set(users)] }))
  if (pooled.length > 0) {
    violations.push({ code: VERIFICATION_CODES.EVIDENCE_POOLED, detail: { pooled } })
  }

  return { ok: violations.length === 0, violations, traceability }
}

/**
 * 一份验证计划的 plan_id，用于核对报告对应的是哪一份计划。
 *
 * 内容寻址而不是发放随机 id：计划被改写时 id 随之改变，于是「报告用的是旧计划」这件事
 * 可以被发现，而不是看起来一切正常。
 *
 * @param {Readonly<object>} plan
 * @returns {string}
 */
export function planId(plan) {
  // 按用例 id 排序后再哈希：顺序不携带语义，若把顺序算进身份，重新排列用例会让一份
  // 未改动的计划看起来像换了一份，于是「报告对应的是旧计划」这条判定开始误报。
  const canonical = JSON.stringify(
    [...plan.cases]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => [
        entry.id,
        entry.type,
        [...entry.covers].sort(),
        entry.expect ?? null,
        entry.expect_failure ?? null,
      ]),
  )
  let hash = 2166136261
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `plan-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 报告与计划是否对应。
 *
 * 计划被改写后仍拿旧报告交差，会让「已经验证过」指向一份不再存在的计划。
 *
 * @param {Readonly<object>} plan
 * @param {object} report
 * @returns {{matches: boolean, expected: string, reported?: string}}
 */
export function checkPlanIdentity(plan, report) {
  const expected = planId(plan)
  const reported = typeof report?.plan_id === 'string' ? report.plan_id : undefined
  return { matches: reported === expected, expected, ...(reported === undefined ? {} : { reported }) }
}

/**
 * 验证计划只读：把它交给实现侧之前先冻结。
 *
 * 单独一个函数是因为「冻结」这件事必须在交接点发生，而不是靠交接双方记得。计划在冻结
 * 前可改（那是设计阶段），冻结后连本模块也改不动它。
 *
 * @param {Readonly<object>} plan
 * @returns {Readonly<object>}
 */
export function freezePlan(plan) {
  const deepFreeze = (value) => {
    if (value === null || typeof value !== 'object') return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
  }
  return deepFreeze(plan)
}
