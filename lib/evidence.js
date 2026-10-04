/**
 * 证据：来自运行时的工具观测，而不是 Agent 的自报。
 *
 * @module dsh-gac-runtime/evidence
 *
 * 为什么证据必须由运行时发号
 * --------------------------
 * 在此之前，验证报告里的 `evidence_ref` 只是模型写下的一个字符串。写下 `ev-1` 与真正跑过
 * 一条命令，在数据上完全一样——于是「每条用例都有证据」这句话可以靠编造满足。运行时订阅
 * `tools/result` 之后，每条证据都对应一次**真实发生过的工具调用**，引用由运行时发放：模型
 * 引用一个运行时没发过的号，就无法通过。
 *
 * 这是 §41「证据来自运行时而非 Agent 自报」的全部要点。它不提升模型的能力，只是让「我说
 * 我验过了」不再等于「验过了」。
 *
 * 证据是**观测**，不是结论
 * ------------------------
 * 一条证据记录的是「哪个工具、什么参数、退出了几、产出了什么」，它本身不下判断。把判断写进
 * 证据里，就等于让观测替结论背书。
 *
 * 引用带明细
 * ----------
 * 一次命令常常同时支撑多条用例：跑一遍测试套件，里面的每个用例各自成立。所以引用是
 * `证据号#明细`——同一个证据号配**不同明细**是合法的（同一份产出里不同的部分），配**相同
 * 明细**则是把同一个观测当成两条独立证据（取证摊薄）。
 */

/** 结构化错误码。 */
export const EVIDENCE_CODES = Object.freeze({
  MALFORMED: 'GAC_EVIDENCE_MALFORMED',
  UNKNOWN: 'GAC_EVIDENCE_UNKNOWN',
  NOT_PASSING: 'GAC_EVIDENCE_NOT_PASSING',
})

/**
 * 结构化证据错误。
 */
export class EvidenceError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
    this.detail = detail
  }
}

/** 摘要的计算只用前若干字节：产出可能有几兆，而证据要能长期留存。 */
export const DIGEST_INPUT_CAP = 64 * 1024

/**
 * FNV-1a 摘要，输出 8 位十六进制。
 *
 * 用途是比对「两次观测是不是同一份产出」，不是防篡改；需要防篡改时该用密码学哈希，而这里的
 * 对手是「无意间把同一份产出当成两份」，不是刻意伪造。
 *
 * @param {string} text
 * @returns {string}
 */
export function digest(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 把任意值折成一个稳定的字符串，用于摘要。
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // 循环引用等情形：退回到 String，只求稳定，不求可读。
    return String(value)
  }
}

/**
 * 从工具产出里读出可核对的执行事实。
 *
 * **只在确实是对象时读字段**：各工具的输出形状不同，凭猜测读形状会在别的工具上读出错误
 * 结论。读不到就不写这一项——缺失是诚实的，猜出来的是假的。
 *
 * @param {unknown} value
 * @returns {{exit_code?: number|null, signal?: string, timed_out?: boolean}}
 */
export function inspectToolValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const facts = {}
  const exit = value.exitCode
  if (typeof exit === 'number' || exit === null) facts.exit_code = exit
  if (typeof value.signal === 'string') facts.signal = value.signal
  if (typeof value.timedOut === 'boolean') facts.timed_out = value.timedOut
  return facts
}

/**
 * 校验并冻结一条证据。
 *
 * `id` 由存放方按发生顺序发放，不由调用方指定：能被指定的号就也能被编造。
 *
 * @param {object} raw
 * @param {object} deps
 * @param {string} deps.id - 运行时发放的证据号。
 * @param {number} [deps.at]
 * @returns {Readonly<object>}
 * @throws {EvidenceError}
 */
export function compileEvidence(raw, deps) {
  if (typeof deps?.id !== 'string' || deps.id === '') {
    throw new EvidenceError('证据号必须由运行时发放', EVIDENCE_CODES.MALFORMED)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvidenceError('证据必须是一个对象', EVIDENCE_CODES.MALFORMED)
  }
  if (typeof raw.tool !== 'string' || raw.tool === '') {
    throw new EvidenceError('证据必须记下是哪个工具', EVIDENCE_CODES.MALFORMED)
  }

  const output = canonical(raw.value)
  const facts = inspectToolValue(raw.value)
  return Object.freeze({
    schema_version: 1,
    id: deps.id,
    at: deps.at ?? 0,
    session_id: typeof raw.session_id === 'string' ? raw.session_id : '',
    tool: raw.tool,
    // 参数只留摘要：命令与路径可能很长，而证据要能长期留存。
    arguments_digest: digest(canonical(raw.arguments)),
    arguments_preview: canonical(raw.arguments).slice(0, 512),
    is_error: raw.is_error === true,
    ...(typeof raw.error_code === 'string' ? { error_code: raw.error_code } : {}),
    ...facts,
    output_digest: digest(output.slice(0, DIGEST_INPUT_CAP)),
    output_bytes: output.length,
    output_truncated: output.length > DIGEST_INPUT_CAP,
    output_preview: output.slice(0, 512),
  })
}

/**
 * 解析一条证据引用。
 *
 * 形如 `ev-3` 或 `ev-3#AC1`。没有明细时明细为空串——它与任何非空明细都不同，因此把
 * 「整份产出」与「产出里的某一段」区分开，而不是当成同一个东西。
 *
 * @param {unknown} ref
 * @returns {{evidence_id: string, detail: string}|undefined}
 */
export function parseEvidenceRef(ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  const index = ref.indexOf('#')
  if (index === -1) return { evidence_id: ref, detail: '' }
  return { evidence_id: ref.slice(0, index), detail: ref.slice(index + 1) }
}

/**
 * 把证据号与明细合成一条引用。
 *
 * @param {string} evidenceId
 * @param {string} [detail]
 * @returns {string}
 */
export function formatEvidenceRef(evidenceId, detail = '') {
  return detail === '' ? evidenceId : `${evidenceId}#${detail}`
}

/**
 * 一条证据能不能充当「某事通过了」的凭据。
 *
 * 两条硬性条件：工具调用本身没有报错，且命令若退出了，退出码必须是 0。**退出码非零的命令
 * 不能证明任何东西通过**——这是可核对的事实，不是判断。
 *
 * @param {Readonly<object>|undefined} record
 * @returns {{usable: boolean, reason?: string}}
 */
export function isPassingEvidence(record) {
  if (record === undefined) return { usable: false, reason: '运行时没有发出过这个证据号' }
  if (record.is_error === true) {
    return { usable: false, reason: `该次调用报错${record.error_code === undefined ? '' : `（${record.error_code}）`}` }
  }
  if (typeof record.exit_code === 'number' && record.exit_code !== 0) {
    return { usable: false, reason: `该命令退出码为 ${record.exit_code}` }
  }
  return { usable: true }
}

/**
 * 在一份证据集合里按号查找。
 *
 * @param {readonly Readonly<object>[]} records
 * @param {string} evidenceId
 * @returns {Readonly<object>|undefined}
 */
export function findEvidence(records, evidenceId) {
  return records.find((record) => record.id === evidenceId)
}

/**
 * 生成一个可注入的引用解析器，供验证层核对引用。
 *
 * 返回的函数对每条引用给出「是否可用」与原因，而验证层只负责把原因讲出来——判断与解释分
 * 开，是为了让「为什么不算」这件事只有一个定义处。
 *
 * @param {readonly Readonly<object>[]} records
 * @returns {(ref: string) => {usable: boolean, reason?: string, record?: Readonly<object>}}
 */
export function createEvidenceResolver(records) {
  return (ref) => {
    const parsed = parseEvidenceRef(ref)
    if (parsed === undefined) return { usable: false, reason: '引用为空' }
    const record = findEvidence(records, parsed.evidence_id)
    const verdict = isPassingEvidence(record)
    return verdict.usable ? { ...verdict, record } : verdict
  }
}
