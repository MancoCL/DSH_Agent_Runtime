/**
 * 证据：来自运行时的观测，而不是 Agent 的自报。
 *
 * @module dsh-gac-runtime/evidence
 *
 * 两种来源，两种事实
 * ------------------
 * 一条证据要么来自一次**工具调用的结果**（哪个工具、什么参数、退出码几、产出了什么），要么
 * 来自一轮**工作区变更观测**（这一轮实际改了哪些文件、其中哪些落在已声明的写范围之外）。前者
 * 记的是意图与执行，后者记的是结果——工具调用的参数里看不出一次命令藏着的重定向目标，也看不出
 * 代码生成器写出的文件。两者都需要，因为它们各能看见对方看不见的东西。
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
})

/**
 * 证据的来源：一次工具调用的结果，或一轮工作区变更观测。
 *
 * 来源是一个**闭集**，且只在这里定义一次：`lib/workspace-witness.js` 按契约把
 * {@link WORKSPACE_SOURCE} 再导出为 `WITNESS_SOURCE`。定义两个字符串会漂移，而漂移的后果是
 * 工作区观测在指标与渲染里被当成一次普通工具调用。
 */
export const TOOL_RESULT_SOURCE = 'tool-result'

/** 工作区变更观测的来源标识。 */
export const WORKSPACE_SOURCE = 'workspace-changes'

/** 来源闭集。 */
const EVIDENCE_SOURCES = Object.freeze([TOOL_RESULT_SOURCE, WORKSPACE_SOURCE])

/**
 * 工作区观测载荷允许出现的键，以及各自要求的类型。
 *
 * 未声明的键一律拒绝，而不是放过：放过的字段会被只追加的日志永久留下，而它究竟是有意的扩展
 * 还是拼错了名字，事后无法分辨。
 */
const WORKSPACE_FIELDS = Object.freeze({
  turn: 'number',
  listed: 'number',
  total: 'number',
  truncated: 'boolean',
  coverage: 'coverage',
  // **清单而不只是计数**：收口门禁要核对的是「哪些文件被判在范围内」，而只有 `in_scope_count`
  // 时那份判断无法复核——计数为 1 与「判对了那一个」是两件事。
  in_scope: 'strings',
  in_scope_count: 'number',
  out_of_scope: 'strings',
  outside_project: 'strings',
  // **谁在治理这次改动。** 子会话自己没有声明写作用域时，判定会借用先代的作用域；那时
  // 「这份观测是按谁的范围判的」是必须留下来的事实，否则事后无法复核这次归属。
  governing_session_id: 'string',
  // 这次改动属于哪个任务、哪个节点。工具体系里会话与任务不是一对一（一次任务会派生多个子会话），
  // 不写下来，事后就只能靠时间与路径去猜。
  task_id: 'string',
  node_id: 'string',
  files_digest: 'string',
})

/** `coverage` 的闭集。覆盖要么完整，要么被宿主截断过。 */
const COVERAGE_VALUES = Object.freeze(['complete', 'partial'])

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
 * 校验并冻结一条工作区观测载荷。
 *
 * 只在给出 `workspace` 时调用。每一个键都按声明的类型核对，缺的键不补——缺失是诚实的，补一个
 * 0 是编的。
 *
 * @param {unknown} raw
 * @returns {Readonly<object>}
 * @throws {EvidenceError}
 */
function compileWorkspace(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvidenceError(
      `工作区观测载荷必须是一个对象，收到的是 ${Array.isArray(raw) ? '数组' : typeof raw}`,
      EVIDENCE_CODES.MALFORMED,
    )
  }
  for (const [field, kind] of Object.entries(WORKSPACE_FIELDS)) {
    const value = raw[field]
    if (value === undefined) continue
    const ok = kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : kind === 'boolean' ? typeof value === 'boolean'
        : kind === 'strings' ? Array.isArray(value) && value.every((item) => typeof item === 'string')
          : kind === 'coverage' ? COVERAGE_VALUES.includes(value)
            : typeof value === 'string'
    if (!ok) {
      throw new EvidenceError(
        `工作区观测的字段 ${field} 应当是 ${kind}，收到 ${JSON.stringify(value)}`,
        EVIDENCE_CODES.MALFORMED,
        { field },
      )
    }
  }
  const extra = Object.keys(raw).filter((field) => !Object.hasOwn(WORKSPACE_FIELDS, field))
  if (extra.length > 0) {
    throw new EvidenceError(
      `工作区观测带有未声明的字段：${extra.join(', ')}`,
      EVIDENCE_CODES.MALFORMED,
      { extra },
    )
  }
  return Object.freeze({ ...raw })
}

/**
 * 校验并冻结一条证据。
 *
 * `id` 由存放方按发生顺序发放，不由调用方指定：能被指定的号就也能被编造。
 *
 * `source` 与 `workspace` 是工作区观测的入口（适配计划 §3.3）：一条证据要么来自一次工具调用，
 * 要么来自一轮工作区变更。两者的区别不是标签，而是「后半段还能读什么字段」——越界归属只在
 * 工作区观测里有。
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
  const source = raw.source === undefined ? TOOL_RESULT_SOURCE : raw.source
  if (typeof source !== 'string' || !EVIDENCE_SOURCES.includes(source)) {
    throw new EvidenceError(
      `证据的来源必须是 ${EVIDENCE_SOURCES.join(' 或 ')}，收到 ${JSON.stringify(raw.source)}`,
      EVIDENCE_CODES.MALFORMED,
    )
  }
  const workspace = raw.workspace === undefined ? undefined : compileWorkspace(raw.workspace)

  const output = canonical(raw.value)
  const facts = inspectToolValue(raw.value)
  // 从实际命令文本解析逐条结果，模型不能自行提供这张表。
  const stdoutValue = raw.value?.stdout ?? raw.value?.output
  const stdout = typeof stdoutValue === 'string' ? stdoutValue : stdoutValue?.text
  const caseResults = typeof stdout === 'string' ? Object.fromEntries(stdout.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^\s*(not ok|ok)\s+\d+\s+-\s+(.+)$/u.exec(line)
    return match ? [[`tap:${index + 1}`, { name: match[2], outcome: match[1] === 'ok' ? 'passed' : 'failed' }]] : []
  })) : {}
  return Object.freeze({
    // 版本随形状一起走：工作区观测的字段是在这一版加进来的，因此携带 source 的记录按这一版
    // 校验。把版本改回旧值并不能关掉已生效的校验——门禁按记录里出现的字段判定。
    schema_version: 2,
    id: deps.id,
    at: deps.at ?? 0,
    session_id: typeof raw.session_id === 'string' ? raw.session_id : '',
    tool: raw.tool,
    source,
    // 参数只留摘要：命令与路径可能很长，而证据要能长期留存。
    arguments_digest: digest(canonical(raw.arguments)),
    arguments_preview: canonical(raw.arguments).slice(0, 512),
    is_error: raw.is_error === true,
    ...(typeof raw.error_code === 'string' ? { error_code: raw.error_code } : {}),
    ...(workspace === undefined ? {} : { workspace }),
    ...facts,
    output_digest: digest(output.slice(0, DIGEST_INPUT_CAP)),
    output_bytes: output.length,
    output_truncated: output.length > DIGEST_INPUT_CAP,
    output_preview: output.slice(0, 512),
    ...(Object.keys(caseResults).length ? { case_results: Object.freeze(caseResults) } : {}),
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
 * 三条硬性条件：工具调用本身没有报错，命令若退出了，退出码必须是 0，且这一轮工作区观测没有
 * 发现越界改动。**退出码非零的命令不能证明任何东西通过**——这是可核对的事实，不是判断。
 *
 * 越界那一条同样是事实而不是判断：一次改动写出了已声明范围之外的产品文件，那么「它跑过了」
 * 证明不了这次改动是合规的。它不改变工具调用的成败，改变的是这条证据能不能被引用来支持一个
 * 「通过」的结论。
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
  const outOfScope = Array.isArray(record.workspace?.out_of_scope) ? record.workspace.out_of_scope : []
  if (outOfScope.length > 0) {
    return {
      usable: false,
      reason: `这一轮有 ${outOfScope.length} 个越界改动（落在已声明的写范围之外）`,
    }
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
    if (verdict.usable && parsed.detail?.startsWith('tap:') && record?.case_results?.[parsed.detail]?.outcome !== 'passed') return { usable: false, reason: '逐项引用没有实际通过结果' }
    return verdict.usable ? { ...verdict, record } : verdict
  }
}
