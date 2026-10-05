/**
 * 独立复核：验证独立性六问与工程质量逐维度（大纲 §31、§32，适配计划 §4.4 阶段 4）。
 *
 * @module dsh-gac-runtime/review
 *
 * 它补的是验证闭环的最后一格
 * ------------------------
 * 「测试都过了」与「我们知道它是对的」之间隔着一次**复核**：验证计划执行完了，谁来回答
 * 「这次验证本身可不可信」。计划里那三道门禁（覆盖、反例、证据）守的是**产物齐全**，而这一层
 * 守的是**产物可信**——一个齐全的验证过程仍然可能建立在「只跑了实现者自己写的测试」之上，
 * 而那种情况在数据上完全看不出来。
 *
 * 六问不是问卷，每一条都对应一个真实的失败模式
 * -----------------------------------------
 * 前五条来自大纲 §31，最后一条来自「计划冻结」这件事本身。它们之所以是**布尔量或清单**而不是
 * 一段自由文本，是因为自由文本无法被核对：`builder_tests_only: true` 与 `false` 是两件不同的
 * 事实，而「验证充分，符合要求」什么也没说。这里能做的只有把「沉默」变成「明确的申报」，并
 * 拒绝一份**自己承认了问题**的复核——它拦不住撒谎，但拦住它是另一件事（见下面「这一层管不了
 * 什么」）。
 *
 * 未回答不是「否」，而是一道缺口
 * ----------------------------
 * 登记时就把 `null` 与缺键拒掉：`builder_tests_only: null` 既不是「是」也不是「否」，放它过去
 * 会让一份没回答的复核看起来像一份答完的复核。这条与验收标准申报的 `all_criteria_covered`
 * 同一个道理：门禁只能核对申报，所以申报必须存在。
 *
 * 这一层管不了什么（必须写下来）
 * ----------------------------
 *  1. **它核对的是申报，不是事实。** 六问由复核者回答，而运行时不读实现、不读测试，判不了那些
 *     回答是不是真的。它做到的只有：回答必须存在、方向必须自洽、与同一份记录里的其他申报不能
 *     互相矛盾（例如「验收标准全覆盖」与「未覆盖 AC 列表非空」同时出现）。
 *  2. **它不重新执行验证。** 证据引用只核对「这个号是运行时发过的」——引用一条**失败**的命令
 *     作为缺陷证据是合法的，因此这里判的是签发，不是通过与失败。
 *  3. **独立性的真正来源是信息路径。** 六问是对路径的一次自我描述；把两份产物交给同一个模型去
 *     写，六问照样能填绿。适配计划 §7 边界 5 说得很清楚：独立性来自不同的 system prompt、
 *     不同的 messages、不同的执行顺序，而不是来自这一层。
 */

import { digest } from './evidence.js'

/** 机器可分支的结构化门禁码。 */
export const REVIEW_CODES = Object.freeze({
  MALFORMED: 'GAC_REVIEW_MALFORMED',
  REPORT_MISSING: 'GAC_REVIEW_REPORT_MISSING',
  INDEPENDENCE_UNANSWERED: 'GAC_REVIEW_INDEPENDENCE_UNANSWERED',
  INDEPENDENCE_FAILED: 'GAC_REVIEW_INDEPENDENCE_FAILED',
  QUALITY_MISSING: 'GAC_REVIEW_QUALITY_MISSING',
  BLOCKING_ISSUES: 'GAC_REVIEW_BLOCKING_ISSUES',
  EVIDENCE_UNVERIFIED: 'GAC_REVIEW_EVIDENCE_NOT_FROM_RUNTIME',
})

/**
 * 结构化复核错误。
 */
export class ReviewError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 验证独立性六问。
 *
 * `expected` 是「一份可信的验证」应当给出的答案：`true` 表示这件事必须成立，`false` 表示这件事
 * 必须不成立，`'empty'` 表示这份清单必须为空。它不是一个评分标准，而是每条问题的**正确方向**：
 * 方向反了就说明这次验证在方法上有洞，而不是「复核者态度不够积极」。
 *
 * 词表是**约定的最小集**：项目可以扩展工程质量维度，但这六条的名字必须固定，否则「复核答了没有」
 * 会随项目而变，门禁就无从施加。
 */
export const INDEPENDENCE_QUESTIONS = Object.freeze([
  Object.freeze({
    key: 'builder_tests_only',
    kind: 'boolean',
    expected: false,
    ask: '这次验证是否只依赖了 Builder 自己写的测试？',
    why: '实现与它的测试出自同一份理解，理解一旦有偏，两边会一起绿。',
  }),
  Object.freeze({
    key: 'expectations_from_requirement',
    kind: 'boolean',
    expected: true,
    ask: '期望值是否从需求与冻结契约推导，而不是从实现反推出来的？',
    why: '从实现反推期望，等于用被检验的东西去定义检验标准。',
  }),
  Object.freeze({
    key: 'falsification_present',
    kind: 'boolean',
    expected: true,
    ask: '是否包含写明 expect_failure 的反例（什么样的错误实现应当被抓住）？',
    why: '只有正例的验证集无法区分「实现正确」与「断言太弱」。',
  }),
  Object.freeze({
    key: 'uncovered_criteria',
    kind: 'strings',
    expected: 'empty',
    ask: '有哪些验收标准没有被通过证据覆盖？（给出 id；全都有则给空数组）',
    why: '未覆盖的标准在收口时会被当成「已覆盖」，除非这里明确列出来。',
  }),
  Object.freeze({
    key: 'verifier_reran_builder_tests_only',
    kind: 'boolean',
    expected: false,
    ask: '独立验证是否只是重跑了 Builder 的测试？',
    why: '重跑同一套测试得到的是同一个理解给出的同一个结论。',
  }),
  Object.freeze({
    key: 'plan_modified_by_builder',
    kind: 'boolean',
    expected: false,
    ask: '冻结的验证计划是否被实现侧改写过？',
    why: '计划一旦被实现侧改写，它推导的就不再是需求，而是实现。',
  }),
])

/**
 * 工程质量逐维度。
 *
 * 维度取自 `assets/ENGINEERING_POLICY.md`：复用、语义重复、投机抽象、改动范围、依赖策略。每个
 * 维度要求一句**结论**而不是一段感想——「无」是合法答案，留空不是。
 */
export const QUALITY_DIMENSIONS = Object.freeze([
  Object.freeze({ key: 'reuse', ask: '是否先找了可复用的既有实现？复用了什么？' }),
  Object.freeze({ key: 'duplication', ask: '是否引入了有漂移风险的语义重复？（表面相似不算）' }),
  Object.freeze({ key: 'unnecessary_abstraction', ask: '是否新增了没有真实调用方的抽象层？' }),
  Object.freeze({ key: 'change_scope', ask: '改动范围是否最小？有没有顺手改无关文件？' }),
  Object.freeze({ key: 'dependency', ask: '是否新增依赖？现有能力为什么不够？' }),
])

/** 六问的键，供工具描述与测试使用。 */
export const INDEPENDENCE_KEYS = Object.freeze(INDEPENDENCE_QUESTIONS.map((entry) => entry.key))

/** 质量维度的键。 */
export const QUALITY_KEYS = Object.freeze(QUALITY_DIMENSIONS.map((entry) => entry.key))

/** 复核报告允许出现的顶层键。未声明的键一律拒绝。 */
const REPORT_FIELDS = Object.freeze([
  'schema_version',
  'summary',
  'evidence',
  'blocking_issues',
  'engineering_quality',
  'verification_independence',
])

/**
 * 校验并冻结一份复核报告。
 *
 * 登记时就把「没回答」拒掉：一份缺答案的复核不该变成一个可被引用的产物。方向不对的答案**不**
 * 在这里拒——那是 {@link evaluateReview} 的事，因为一份如实记录了「验证方法有洞」的报告是有
 * 价值的事实，拒绝记录它只会让人把洞藏起来。
 *
 * @param {unknown} raw
 * @returns {Readonly<object>}
 * @throws {ReviewError}
 */
export function compileReviewReport(raw) {
  const fail = (message, code, detail) => {
    throw new ReviewError(message, code, detail)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('复核报告必须是一个对象', REVIEW_CODES.MALFORMED)
  }
  const extra = Object.keys(raw).filter((field) => !REPORT_FIELDS.includes(field))
  if (extra.length > 0) {
    fail(`复核报告带有未声明的字段：${extra.join(', ')}`, REVIEW_CODES.MALFORMED, { extra })
  }
  if (typeof raw.summary !== 'string' || raw.summary.trim() === '') {
    // 没有结论的复核报告，读的人只能从六问的答案里去猜它想说什么。
    fail('复核报告必须写明 summary：这次复核的结论是什么', REVIEW_CODES.MALFORMED)
  }

  const independence = raw.verification_independence
  if (independence === null || typeof independence !== 'object' || Array.isArray(independence)) {
    fail(
      '复核报告必须逐条回答验证独立性六问（verification_independence）',
      REVIEW_CODES.INDEPENDENCE_UNANSWERED,
      { questions: [...INDEPENDENCE_KEYS] },
    )
  }
  const unanswered = []
  const answers = {}
  for (const question of INDEPENDENCE_QUESTIONS) {
    const value = independence[question.key]
    if (value === undefined || value === null) {
      unanswered.push(question.key)
      continue
    }
    if (question.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        fail(
          `验证独立性六问里的 ${question.key} 必须回答 true 或 false，收到 ${JSON.stringify(value)}`,
          REVIEW_CODES.INDEPENDENCE_UNANSWERED,
          { question: question.key },
        )
      }
      answers[question.key] = value
      continue
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
      fail(
        `验证独立性六问里的 ${question.key} 必须是一个验收标准 id 数组（全都有就给空数组）`,
        REVIEW_CODES.INDEPENDENCE_UNANSWERED,
        { question: question.key },
      )
    }
    answers[question.key] = Object.freeze([...value])
  }
  if (unanswered.length > 0) {
    // null 不是「否」：放它过去会让一份没回答的复核看起来像一份答完的复核。
    fail(
      `验证独立性六问还有没回答的：${unanswered.join('、')}。`
      + '未回答不是一个答案，收口时它无法被核对',
      REVIEW_CODES.INDEPENDENCE_UNANSWERED,
      { questions: unanswered },
    )
  }

  const quality = raw.engineering_quality
  if (quality === null || typeof quality !== 'object' || Array.isArray(quality)) {
    fail('复核报告必须逐维度回答工程质量（engineering_quality）', REVIEW_CODES.QUALITY_MISSING, {
      dimensions: [...QUALITY_KEYS],
    })
  }
  const missingQuality = []
  const qualityAnswers = {}
  for (const dimension of QUALITY_DIMENSIONS) {
    const value = quality[dimension.key]
    if (typeof value !== 'string' || value.trim() === '') {
      missingQuality.push(dimension.key)
      continue
    }
    qualityAnswers[dimension.key] = value
  }
  if (missingQuality.length > 0) {
    // 「无」是合法答案，留空不是：留空无法与「没看」区分开。
    fail(
      `工程质量还有没回答的维度：${missingQuality.join('、')}。`
      + '没有问题的维度也要写一句结论（写「无」即可），留空无法与「没看」区分',
      REVIEW_CODES.QUALITY_MISSING,
      { dimensions: missingQuality },
    )
  }

  const blocking = raw.blocking_issues === undefined ? [] : raw.blocking_issues
  if (!Array.isArray(blocking) || blocking.some((item) => typeof item !== 'string' || item.trim() === '')) {
    fail('blocking_issues 必须是一个字符串数组', REVIEW_CODES.MALFORMED)
  }
  const evidence = raw.evidence === undefined ? [] : raw.evidence
  if (!Array.isArray(evidence) || evidence.some((item) => typeof item !== 'string' || item.trim() === '')) {
    fail('evidence 必须是一个证据引用字符串数组（引用形如 `证据号#明细`）', REVIEW_CODES.MALFORMED)
  }

  return Object.freeze({
    // 形状随版本走：六问与五个维度都在这一版，因此携带它们的记录按这一版校验。
    schema_version: 1,
    summary: raw.summary,
    evidence: Object.freeze([...evidence]),
    blocking_issues: Object.freeze([...blocking]),
    engineering_quality: Object.freeze(qualityAnswers),
    verification_independence: Object.freeze(answers),
  })
}

/**
 * 核对一份复核报告自己说了什么。
 *
 * 与 {@link compileReviewReport} 的分工：编译管形状（答案存不存在、类型对不对），这里管自洽
 * （答案的方向对不对、与同一份记录里的其他申报有没有互相矛盾）。分开的理由是两者的触发时机
 * 不同——形状在登记时就必须对，自洽要在收口时核对。
 *
 * @param {Readonly<object>} report
 * @param {object} [options]
 * @param {readonly string[]} [options.issuedEvidence] - 运行时发出过的证据号。**不给这个参数时
 *   引用只被当作字符串处理**——那种模式只适合单元测试，因为编造的引用与真实的引用在字符串
 *   层面无法区分。
 * @returns {{ok: boolean, violations: {code: string, detail: object}[]}}
 */
export function evaluateReview(report, options = {}) {
  const violations = []
  const independence = report?.verification_independence ?? {}
  const unanswered = INDEPENDENCE_QUESTIONS
    .filter((question) => independence[question.key] === undefined || independence[question.key] === null)
    .map((question) => question.key)
  if (unanswered.length > 0) {
    // 只在记录被手工改过、或来自更早的版本时才会走到这里：登记时那一关已经拒过。
    violations.push({
      code: REVIEW_CODES.INDEPENDENCE_UNANSWERED,
      detail: { questions: unanswered },
    })
  }

  for (const question of INDEPENDENCE_QUESTIONS) {
    const answer = independence[question.key]
    if (answer === undefined || answer === null) continue
    if (question.kind === 'boolean') {
      if (answer !== question.expected) {
        violations.push({
          code: REVIEW_CODES.INDEPENDENCE_FAILED,
          detail: {
            question: question.key,
            answer,
            expected: question.expected,
            ask: question.ask,
            why: question.why,
          },
        })
      }
      continue
    }
    // 清单类的「方向」是「必须为空」。非空不是错误，而是一次如实的自我申报——它恰好说明
    // 这次验证还没覆盖完整，因此收口必须停下。
    if (Array.isArray(answer) && answer.length > 0) {
      violations.push({
        code: REVIEW_CODES.INDEPENDENCE_FAILED,
        detail: { question: question.key, criteria: [...answer], ask: question.ask, why: question.why },
      })
    }
  }

  const quality = report?.engineering_quality ?? {}
  const missingQuality = QUALITY_DIMENSIONS
    .filter((dimension) => typeof quality[dimension.key] !== 'string' || quality[dimension.key].trim() === '')
    .map((dimension) => dimension.key)
  if (missingQuality.length > 0) {
    violations.push({ code: REVIEW_CODES.QUALITY_MISSING, detail: { dimensions: missingQuality } })
  }

  const blocking = Array.isArray(report?.blocking_issues) ? report.blocking_issues : []
  if (blocking.length > 0) {
    violations.push({
      code: REVIEW_CODES.BLOCKING_ISSUES,
      detail: { issues: [...blocking] },
    })
  }

  if (options.issuedEvidence !== undefined) {
    // 只核对**签发**：引用一条失败的命令作为缺陷证据是合法的，因此这里判的不是「能不能充当
    // 通过凭据」。运行时没发过的号一律不认。
    const issued = new Set(Array.isArray(options.issuedEvidence) ? options.issuedEvidence : [])
    const rejected = (Array.isArray(report?.evidence) ? report.evidence : [])
      .filter((ref) => !issued.has(typeof ref === 'string' ? ref.split('#')[0] : ref))
    if (rejected.length > 0) {
      violations.push({ code: REVIEW_CODES.EVIDENCE_UNVERIFIED, detail: { refs: rejected } })
    }
  }

  return { ok: violations.length === 0, violations }
}

/**
 * 一份复核报告的身份，用于核对「收口时读的是不是当时复核的那一份」。
 *
 * 内容寻址而不是发放随机 id：报告被改写时 id 随之改变，于是「这份报告是照着哪次复核收的口」
 * 可以被发现，而不是看起来一切正常。
 *
 * @param {Readonly<object>} report
 * @returns {string}
 */
export function reviewId(report) {
  const independence = report?.verification_independence ?? {}
  const quality = report?.engineering_quality ?? {}
  // 按固定顺序取键：顺序不携带语义，若把它算进身份，键的排列一变就会看起来像换了一份报告。
  const canonical = JSON.stringify([
    typeof report?.summary === 'string' ? report.summary : '',
    INDEPENDENCE_KEYS.map((key) => independence[key] ?? null),
    QUALITY_KEYS.map((key) => quality[key] ?? null),
    Array.isArray(report?.blocking_issues) ? report.blocking_issues : [],
    // 字段名必须与盖章时写进去的那个一致：这里读 `plan_id` 而那边写 `reviewed_plan_id`，会让
    // 报告身份对「复核的是哪份计划」完全不敏感——而那正是身份要表达的东西。
    typeof report?.reviewed_plan_id === 'string' ? report.reviewed_plan_id : '',
  ])
  return `review-${digest(canonical)}`
}
