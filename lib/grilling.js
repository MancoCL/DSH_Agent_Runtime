/**
 * 修订循环：通过多轮访谈把需求细化到可以动手。
 *
 * @module dsh-gac-runtime/grilling
 *
 * 为什么需要它
 * ------------
 * 需求在第一次被描述时几乎总是不完整的，而缺失的部分往往在动手之后才暴露——那时改动
 * 已经发生，返工代价最高。访谈把「发现缺失」提前到改动之前。
 *
 * 循环由固定代码管，问题由会话提
 * ----------------------------
 * 「还缺哪些决策」是语义判断，代码做不了，所以**问题由发起会话提**。但「问了多少轮、
 * 每轮覆盖了什么、有没有收敛、用户最后有没有确认」是事实，由这里记账。两者分开：模型
 * 负责想问题，运行时负责确认这个问题集真的被问过、答过、确认过。
 *
 * 为什么必须有用户的最终确认
 * --------------------------
 * 模型可以自行判断「我问得差不多了」，但这个判断本身没有外部依据：一个理解有偏的模型
 * 会自信地认为自己问全了。所以循环不以模型的自我评估结束，而以**用户说可以了**结束。
 * 这不是形式主义——它是唯一能把「模型以为懂了」与「用户确认懂了」区分开的动作。
 *
 * 为什么轮数没有上限语义
 * ----------------------
 * 访谈轮数不该被一个数字裁掉：一条需要五轮才能问清的需求，硬性封在三轮上只会把缺失
 * 推到实现阶段。`MAX_ROUNDS_GUARD` 只作为失控保护存在，它的作用是让循环不会无限增长，而不是
 * 表达「问到这里就该够了」。
 */

// 需求 id 与契约、计划、设计共用同一份短哈希（`lib/evidence.js` 的 `digest`）。
import { digest } from './evidence.js'

/** 结构化错误码。 */
export const GRILLING_CODES = Object.freeze({
  ALREADY_FROZEN: 'GAC_REQUIREMENT_ALREADY_FROZEN',
  NOT_CONVERGED: 'GAC_GRILLING_NOT_CONVERGED',
  NOT_CONFIRMED: 'GAC_GRILLING_NOT_CONFIRMED',
  EMPTY_ROUND: 'GAC_GRILLING_EMPTY_ROUND',
  MALFORMED: 'GAC_GRILLING_MALFORMED',
})

/**
 * 结构化访谈错误。
 */
export class GrillingError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'GrillingError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 访谈的失控保护上限。
 *
 * 它不表达「问到这么多就够了」——那个判断只属于用户。它只防止循环无限增长。
 */
export const MAX_ROUNDS_GUARD = 64

/**
 * 新建一份访谈记录。
 *
 * @param {object} input
 * @param {string} input.task_id
 * @param {string} [input.requirement] - 用户最初的需求描述原话。
 * @param {number} [input.now]
 * @returns {object} 冻结的访谈记录。
 */
export function startGrilling({ task_id: taskId, requirement, now = 0 }) {
  if (typeof taskId !== 'string' || taskId === '') {
    throw new GrillingError('访谈需要 task_id', GRILLING_CODES.MALFORMED)
  }
  return Object.freeze({
    schema_version: 1,
    task_id: taskId,
    requirement: typeof requirement === 'string' ? requirement : '',
    rounds: Object.freeze([]),
    converged: false,
    confirmed_by_user: false,
    frozen_at: null,
    started_at: now,
  })
}

/**
 * 记一轮访谈。
 *
 * 一轮必须**同时**有提出的问题和用户的答复。只记问题会留下「问了但不知道答案」的悬空
 * 状态，而那种状态在后续推导里无法区分「用户说不知道」与「我们忘了问」。
 *
 * @param {object} state
 * @param {object} round
 * @param {string} [round.focus] - 这一轮想澄清什么。
 * @param {readonly object[]} round.questions - [{ id, question, answer, resolves? }]
 * @param {number} [round.now]
 * @returns {object} 新的访谈记录。
 * @throws {GrillingError}
 */
export function recordRound(state, round) {
  if (state.frozen_at !== null) {
    throw new GrillingError(
      `任务 ${state.task_id} 的需求已冻结，不能再追加访谈轮次`,
      GRILLING_CODES.ALREADY_FROZEN,
      { task: state.task_id },
    )
  }
  const questions = Array.isArray(round?.questions) ? round.questions : []
  if (questions.length === 0) {
    throw new GrillingError(
      '一轮访谈至少要有问题；没有问题的一轮不带来任何信息，只增加轮数',
      GRILLING_CODES.EMPTY_ROUND,
    )
  }
  if (state.rounds.length >= MAX_ROUNDS_GUARD) {
    throw new GrillingError(
      `访谈轮数已达失控保护上限 ${MAX_ROUNDS_GUARD}，请收敛或检查是否在重复提问`,
      GRILLING_CODES.NOT_CONVERGED,
      { task: state.task_id, rounds: state.rounds.length },
    )
  }

  const recorded = questions.map((entry, index) => {
    const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : `Q${index + 1}`
    if (typeof entry?.question !== 'string' || entry.question.trim() === '') {
      throw new GrillingError(`第 ${id} 问缺少问题原文`, GRILLING_CODES.MALFORMED, { question: id })
    }
    // 答案缺失与「用户说不知道」是两件事：前者是漏记，后者是一条真实结论。
    if (typeof entry?.answer !== 'string') {
      throw new GrillingError(
        `第 ${id} 问缺少用户答复；用户说「不知道」也是一条答复，但必须写下来`,
        GRILLING_CODES.MALFORMED,
        { question: id },
      )
    }
    return Object.freeze({
      id,
      question: entry.question,
      answer: entry.answer,
      ...(Array.isArray(entry.resolves) ? { resolves: Object.freeze([...entry.resolves]) } : {}),
    })
  })

  return Object.freeze({
    ...state,
    rounds: Object.freeze([
      ...state.rounds,
      Object.freeze({
        index: state.rounds.length + 1,
        focus: typeof round?.focus === 'string' ? round.focus : '',
        questions: Object.freeze(recorded),
        at: round?.now ?? 0,
      }),
    ]),
  })
}

/**
 * 标记模型认为问题已经问尽。
 *
 * 这一步**不结束循环**，只是提出收敛。结束仍然需要用户确认：一个理解有偏的模型会自信地
 * 认为自己问全了，所以自我评估不能作为终止依据。
 *
 * @param {object} state
 * @returns {object}
 * @throws {GrillingError} 一轮都没问过时。
 */
export function proposeConvergence(state) {
  if (state.frozen_at !== null) {
    throw new GrillingError('需求已冻结', GRILLING_CODES.ALREADY_FROZEN, { task: state.task_id })
  }
  if (state.rounds.length === 0) {
    throw new GrillingError(
      '一轮访谈都没有进行过，无法提出收敛；需求在被问过之前不可能是完整的',
      GRILLING_CODES.NOT_CONVERGED,
      { task: state.task_id },
    )
  }
  return Object.freeze({ ...state, converged: true })
}

/**
 * 记录用户确认，并冻结需求。
 *
 * `requirement` 是**需求正文**，冻结时必须有：验收标准存的是编号（`AC1`…），而编号本身不表达
 * 任何意思——没有正文，下游那些**读不到实现**的角色（设计、盲验证设计）就只能照编号猜「这条
 * 说的是什么」，而猜错是静默的：方案照样产出、计划照样冻结，只是覆盖的根本不是那条验收标准。
 * 活体上正是这样错位的（计划里的 AC1 对应的是任务书里的 AC4，真实的 AC6 一条用例都没有）。
 * 所以正文缺失在这里当场拒绝，而不是留一个空串让下游去猜。
 *
 * @param {object} state
 * @param {object} input
 * @param {string} input.confirmation - 用户确认的原话。
 * @param {readonly string[]} [input.acceptance_criteria] - 由访谈收敛出的验收标准。
 * @param {string} [input.requirement] - 需求正文；不给就用新建访谈时记下的那一份。
 * @param {number} [input.now]
 * @returns {object}
 * @throws {GrillingError}
 */
export function freezeRequirement(state, input) {
  if (state.frozen_at !== null) {
    throw new GrillingError('需求已冻结', GRILLING_CODES.ALREADY_FROZEN, { task: state.task_id })
  }
  if (state.converged === false) {
    throw new GrillingError(
      '还没有提出收敛，无法冻结需求；请先把问题问尽再提出收敛',
      GRILLING_CODES.NOT_CONVERGED,
      { task: state.task_id },
    )
  }
  if (typeof input?.confirmation !== 'string' || input.confirmation.trim() === '') {
    // 这一条是整段流程里唯一区分「模型以为懂了」与「用户确认懂了」的动作。
    throw new GrillingError(
      '冻结需求需要用户的确认原话；模型的自我评估不足以结束访谈',
      GRILLING_CODES.NOT_CONFIRMED,
      { task: state.task_id },
    )
  }
  const stated = typeof input?.requirement === 'string' && input.requirement.trim() !== ''
    ? input.requirement
    : state.requirement
  if (typeof stated !== 'string' || stated.trim() === '') {
    throw new GrillingError(
      '冻结需求需要需求正文：验收标准只存编号（AC1…），没有正文的话，'
      + '读不到实现的设计与验证角色只能猜这些编号是什么意思，而猜错不会有人发现。'
      + '请把用户最初的需求描述原话随 `requirement` 一起交上来。',
      GRILLING_CODES.MALFORMED,
      { task: state.task_id },
    )
  }
  const criteria = Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria : []
  return Object.freeze({
    ...state,
    requirement: stated,
    confirmed_by_user: true,
    acceptance_criteria: Object.freeze([...criteria]),
    confirmation: input.confirmation,
    frozen_at: input.now ?? 0,
  })
}

/**
 * 冻结需求的内容寻址身份。
 *
 * 需求此前只有一个存放处、没有身份，于是「设计推导自哪一份需求」只能靠一句自述。给了 id 之后，
 * 需求一旦变过（多一条验收标准、换一句确认原话），引用旧需求的设计**当场对不上**——这正是
 * 「设计修改后受影响的下游结果不得继续有效」里需求那一侧的一半。
 *
 * `frozen_at` 不进身份：同一份需求在不同时刻冻结两次是同一份需求。
 *
 * @param {object|undefined} state - 冻结的访谈记录。
 * @returns {string|undefined} 没有冻结的需求时返回 `undefined`（调用方据此如实说明，而不是编一个）。
 */
export function requirementId(state) {
  if (state === undefined || state === null || state.frozen_at === undefined || state.frozen_at === null) {
    return undefined
  }
  const canonical = JSON.stringify([
    state.task_id ?? null,
    [...(state.acceptance_criteria ?? [])].map(String).sort(),
    state.confirmation ?? null,
  ])
  return `requirement-${digest(canonical)}`
}

/**
 * 访谈记录是否已冻结。
 *
 * 名字里带 requirement 是为了与 contract.isFrozen 区分：两者都会被工具层引用，同名导出
 * 在合并导入时会互相覆盖，而那种覆盖是静默的。
 *
 * @param {object} state
 * @returns {boolean}
 */
export function isRequirementFrozen(state) {
  return state?.frozen_at !== null && state?.frozen_at !== undefined
}

/**
 * 盘点到目前为止访谈落下了什么，供会话据此决定下一轮问什么。
 *
 * 只报事实，不报「还缺什么」——缺什么由会话判断，那正是访谈里唯一需要认知的部分。
 *
 * @param {object} state
 * @returns {object}
 */
export function summarize(state) {
  const asked = state.rounds.flatMap((round) => round.questions)
  const open = asked.filter((entry) =>
    typeof entry.answer === 'string' && /^(不知道|不确定|待定|unknown|unsure)/iu.test(entry.answer.trim()))
  return {
    task_id: state.task_id,
    rounds: state.rounds.length,
    questions_asked: asked.length,
    unresolved: open.map((entry) => ({ id: entry.id, question: entry.question, answer: entry.answer })),
    converged: state.converged,
    confirmed_by_user: state.confirmed_by_user,
    frozen: isRequirementFrozen(state),
    acceptance_criteria: [...(state.acceptance_criteria ?? [])],
  }
}
