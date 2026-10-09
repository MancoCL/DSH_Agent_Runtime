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
 *
 * **非通过用例要给出失败归因**：只记「挂了」的报告无法据以行动。归因落进一个六类闭集
 * （`FAILURE_CLASSIFICATIONS`），并须带依据（证据引用或说明）。缺分类、分类越界、分类
 * 合法但无依据，三种情况各自一码且都指名到用例——三条的修复动作不同（补分类 / 改分类 /
 * 补依据），合成一条码就只能靠人读文本分辨。
 *
 * 但归因只作用于**该用例最终没有通过**的记录。一份报告是执行历史，不是一次快照：同一条
 * 用例可能先失败、修好之后再跑通过，于是历史里同时存在 `failed` 与 `passed`。此时那条
 * `failed` 已经是被后续通过推翻的中间状态，不再是一个结论，要求它归因就等于逼人对一个
 * 已被解决的现象写「谁的问题」。同一 case_id 以数组中的最新记录为准；最新通过才免去
 * 历史失败归因，后续回归失败不得被较早的通过覆盖。
 */

// 与契约、设计共用同一份短哈希（`lib/evidence.js` 的 `digest`）。
import { digest } from './evidence.js'

/** 机器可分支的结构化门禁码。 */
export const VERIFICATION_CODES = Object.freeze({
  PLAN_MISSING: 'GAC_VERIFICATION_PLAN_MISSING',
  AC_UNCOVERED: 'GAC_VERIFICATION_COVERAGE_GAP',
  FALSIFICATION_MISSING: 'GAC_FALSIFICATION_EVIDENCE_MISSING',
  EVIDENCE_MISSING: 'GAC_INDEPENDENT_EVIDENCE_MISSING',
  EVIDENCE_UNVERIFIED: 'GAC_EVIDENCE_NOT_FROM_RUNTIME',
  EVIDENCE_POOLED: 'GAC_EVIDENCE_POOLED_ACROSS_CASES',
  PLAN_MUTATED: 'GAC_VERIFICATION_PLAN_MUTATED',
  // 与 `PLAN_MUTATED` 分开：**没交验证载荷**不是「计划被改写」。两者共用过一个码，于是
  // 「收口时压根没带 `verification`」会被报成「报告对应的不是当前计划（报告写的是 undefined）」
  // ——活体验收实测到这一幕：盘上计划身份核对其实是 matches，而拒因把读的人引向「有人改过计划」。
  PAYLOAD_MISSING: 'GAC_VERIFICATION_PAYLOAD_MISSING',
  CASE_UNKNOWN: 'GAC_VERIFICATION_CASE_UNKNOWN',
  // 非通过用例的失败归因：三种情况各自一码，且都指名到具体用例。它们分开而不是共用一个
  // 「归因不合法」：没有给分类、给了一个闭集外的分类、给了分类却拿不出任何依据——三条的
  // 修复动作完全不同（补分类 / 改分类 / 补依据），合成一条码就只能靠人读文本分辨。
  FAILURE_CLASSIFICATION_MISSING: 'GAC_FAILURE_CLASSIFICATION_MISSING',
  FAILURE_CLASSIFICATION_UNKNOWN: 'GAC_FAILURE_CLASSIFICATION_UNKNOWN',
  FAILURE_BASIS_MISSING: 'GAC_FAILURE_BASIS_MISSING',
})

/**
 * 失败归因闭集：非通过用例必须落进其中一类，且只落一类。
 *
 * 为什么是**闭集**而不是自由文本：归因决定下一步做什么——改产品、改测试、改期望、修环境、
 * 等外部资源，还是承认证据不足。自由文本让「这条挂了」看起来像一句话就说清楚了，而分类
 * 才逼出「那到底是谁的错、下一步改哪里」。六类互斥且穷尽：
 *
 *   - `product_implementation`：产品实现不对，产品侧要改。
 *   - `test_implementation`：用例本身写错了（断言逻辑、驱动方式），产品可能没问题。
 *   - `test_expectation`：用例实现没问题，但期望值本身是错的（期望与验收标准不一致）。
 *   - `build_environment`：构建或运行环境的问题（编译器、依赖、路径、工具链）。
 *   - `external_resource`：外部依赖不可用（网络、第三方服务、硬件、上游数据源）。
 *   - `evidence_insufficient`：拿不出足够证据判断是谁的问题——这是**诚实**的一类，
 *     它让「查不清楚」也能被结构化记录，而不是被硬塞进上面某一类冒充结论。
 */
export const FAILURE_CLASSIFICATIONS = Object.freeze([
  'product_implementation',
  'test_implementation',
  'test_expectation',
  'build_environment',
  'external_resource',
  'evidence_insufficient',
])

/** 用例类型闭集。只有两类，因为验收标准只有两种需要证明的方向。 */
export const CASE_TYPES = Object.freeze(['positive', 'falsification'])

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
    if (options.requireFalsification !== false && typeGaps.without_falsification.length > 0) {
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
 * 校验单条失败归因。
 *
 * 非通过的用例不能只留一句「挂了」：谁的问题、凭什么这么判断，都要在数据里说清楚。
 * 三种情况各自一个错误码，并且都**指名到具体用例**——一条不指名到用例的违规无法被修复。
 *
 *   - 没给 `failure_classification` → `FAILURE_CLASSIFICATION_MISSING`
 *   - 给了但不在 `FAILURE_CLASSIFICATIONS` 闭集里 → `FAILURE_CLASSIFICATION_UNKNOWN`
 *   - 给了合法分类，却既无 `evidence_ref` 也无 `note` → `FAILURE_BASIS_MISSING`
 *
 * 只看 `failure_classification`，不看 `outcome`：调用方负责决定哪些用例需要归因（见
 * `evaluateVerification` 里按 `case_id` 聚合后的非通过分支）。这样「什么算非通过」的判定
 * 只有一处，不会在两条路径上各判一次而悄悄分叉。
 *
 * 注意本函数判定的是**单条记录**，它看不见同一 `case_id` 的其他记录，因此无法判断该用例
 * 最终是否通过——「已被后续通过取代的历史失败不再要求归因」这条规则只由调用方落实，本
 * 函数的签名与语义不因它改变。
 *
 * **只判定，不抛错**：调用方要把它用在遍历里逐条收集违规，抛错会让一条坏记录带走整份
 * 报告的结论。非对象输入（`undefined` / `null` / 字符串）按「没给分类」处理。
 *
 * @param {object} record - 执行记录：{ case_id?, outcome?, failure_classification?, evidence_ref?, note? }
 * @returns {{ok: boolean, code: string|null, detail: object}} 合法时 `code` 为 `null`，
 *   `detail` 为 `{case_id, classification?}`。
 */
export function validateFailureClassification(record) {
  const entry = record !== null && typeof record === 'object' ? record : {}
  const caseId = typeof entry.case_id === 'string' && entry.case_id !== ''
    ? entry.case_id
    : undefined
  const target = caseId ?? '<未命名用例>'
  const classification = entry.failure_classification

  if (classification === undefined || classification === null || classification === '') {
    return {
      ok: false,
      code: VERIFICATION_CODES.FAILURE_CLASSIFICATION_MISSING,
      detail: {
        case_id: target,
        message: `非通过用例 ${target} 未给出 failure_classification；`
          + `必须从 ${FAILURE_CLASSIFICATIONS.join(' / ')} 中选一类`,
      },
    }
  }

  if (typeof classification !== 'string' || !FAILURE_CLASSIFICATIONS.includes(classification)) {
    return {
      ok: false,
      code: VERIFICATION_CODES.FAILURE_CLASSIFICATION_UNKNOWN,
      detail: {
        case_id: target,
        classification,
        allowed: [...FAILURE_CLASSIFICATIONS],
        message: `非通过用例 ${target} 的 failure_classification 不在闭集内：`
          + `${JSON.stringify(classification)}（允许：${FAILURE_CLASSIFICATIONS.join(' / ')}）`,
      },
    }
  }

  // 分类是判断，不是证据。`evidence_ref` 指向运行时真实的观测；`note` 是不便取证时的
  // 文字依据。两者都没有，这次归因就只是一句无从复核的断言。
  const hasRef = typeof entry.evidence_ref === 'string' && entry.evidence_ref !== ''
  const hasNote = typeof entry.note === 'string' && entry.note.trim() !== ''
  if (!hasRef && !hasNote) {
    return {
      ok: false,
      code: VERIFICATION_CODES.FAILURE_BASIS_MISSING,
      detail: {
        case_id: target,
        classification,
        message: `非通过用例 ${target} 给出分类 ${classification}，`
          + '却既无 evidence_ref 也无 note：归因无从复核',
      },
    }
  }

  return { ok: true, code: null, detail: { case_id: target, classification } }
}

/**
 * 校验一份验证报告，并给出可追溯性判定。
 *
 * `executions` 是**执行历史**而非单次快照：同一 `case_id` 可以出现多条记录（先失败、
 * 后通过）。失败归因只作用于「该 `case_id` 最终没有通过」的记录——名下存在任何
 * `outcome === 'passed'` 的用例，其历史非通过记录免于归因。其余判定（证据、摊薄、
 * 覆盖）仍只认 `passed` 记录。
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

  // 非通过用例必须给出**可复核的失败归因**。只报「挂了」而不说「谁的问题、凭什么」，
  // 收口时读到的是一份无法据以行动的报告：没人知道该去改产品、改测试还是修环境。
  // 三类违规各自成码并指名到用例（见 `validateFailureClassification`）。缺少 `outcome`
  // 也按非通过处理——「跑没跑过」都说不清的用例，不能算通过。
  //
  // **归因只作用于「该用例最终没有通过」的记录。** 报告记的是执行历史，同一条用例可以
  // 先失败、修好后再跑通过，历史里于是同时留着 `failed` 与 `passed`。那条历史失败已经被
  // 同一用例的后续通过取代，它不再是一个结论——要求它归因，等于逼人给一个已经不存在的问题
  // 补一份「谁的问题、凭什么」的说法，而唯一能写出来的东西只能是编造。所以最后是否通过
  // 按 case_id 的最新记录判定；只有最新通过时，历史非通过记录才免于归因。
  // 最新没有通过时，每条非通过记录照旧逐条要求归因——逐条而不是
  // 按用例合成一条，因为一次失败与另一次失败的修复动作可能不同。
  const latest = new Map()
  for (const entry of executions) if (typeof entry?.case_id === 'string') latest.set(entry.case_id, entry)
  const finallyPassed = new Set()
  for (const entry of latest.values()) {
    if (entry?.outcome !== 'passed') continue
    if (typeof entry.case_id !== 'string' || entry.case_id === '') continue
    finallyPassed.add(entry.case_id)
  }
  for (const entry of executions) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.outcome === 'passed') continue
    if (typeof entry.case_id === 'string' && finallyPassed.has(entry.case_id)) continue
    const verdict = validateFailureClassification(entry)
    if (!verdict.ok) violations.push({ code: verdict.code, detail: verdict.detail })
  }

  // 只认 passed：missing / failed / error 都不是通过证据。
  const passed = new Map()
  for (const entry of latest.values()) {
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
  if (options.requireFalsification !== false && typeGaps.without_falsification.length > 0) {
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
  if (resolveEvidence) {
    const underlying = new Map()
    for (const [caseId, entries] of passed) for (const entry of entries) {
      const base = entry.evidence_ref?.split('#')[0]
      if (!base) continue
      const users = underlying.get(base) ?? []
      users.push({ caseId, ref: entry.evidence_ref })
      underlying.set(base, users)
    }
    for (const users of underlying.values()) {
      if (new Set(users.map((entry) => entry.caseId)).size < 2) continue
      if (users.some((entry) => resolveEvidence(entry.ref).record?.case_results?.[entry.ref.split('#')[1]]?.outcome !== 'passed')) violations.push({ code: VERIFICATION_CODES.EVIDENCE_POOLED, detail: { pooled: [{ evidence_ref: users[0].ref.split('#')[0], cases: users.map((entry) => entry.caseId) }], reason: '批量引用缺少实际逐项通过结果' } })
    }
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
  return `plan-${digest(canonical)}`
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
