/**
 * 工程适配器：通用运行时绝不能硬编码的那些「按工程而异」的事实。
 *
 * @module dsh-gac-runtime/project
 *
 * 架构大纲（§14、§15、§50）把工程标识、能力词汇表、高风险路径与工程规则挡在
 * 运行时之外、放进工程之内。本模块就是那道接缝，而且它刻意做得无聊：读一个
 * JSON 文件，拿一个封闭集合校验它，再交回一个冻结对象。本文件里不出现任何
 * 工程名、路径或能力词 —— `test/project.test.js` 断言的正是这一点，因为
 * 「工程事实泄漏进运行时」正是这一整层存在所要防住的失败模式。
 *
 * 唯一有意思的函数是 resolveExecutionMode
 * ---------------------------------------------------
 * 架构大纲（§5、§6）说执行模式是运行时无法做出的*语义*判断，所以由模型声明
 * —— 但声明绝不能自我认证，否则「从最低的充分级别起步」就变成了「声称自己
 * 处在最低级别」。因此模式由模型声明，然后与代码唯一能检查的东西交叉核对：
 * 是否有任何目标路径落在工程声明的高风险路径中。
 *
 * 注意这个函数**不**做什么：它从不解析需求文本去找关键词。前身运行时在自己
 * 的策略里禁止了朴素文本扫描（一条 `text_gate_rule`），而拿关键词去匹配意图，
 * 恰恰是那种看似合理、却在它没预料到的措辞上失败即放行的守卫。
 */

import { createWriteScope } from './write-scope.js'

/** 执行模式，成本最低的充分流程级别排在最前。 */
export const EXECUTION_MODES = Object.freeze([
  'read_only',
  'direct_edit',
  'standard_task',
  'high_risk_task',
])

/** 声明目标：执行模式可能从其中之一升级而来。 */
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high'])

/** 必须**不**出现在正式任务记录中的模式（架构大纲 §5.1、§5.2）。 */
export const NON_TASK_MODES = Object.freeze(['read_only', 'direct_edit'])

/**
 * 风险级别所映射到的模式。这张表的存在，正是「模式只需一次决策而不是两次」
 * 的全部理由：风险解析器与模式选择器读的是同一批行。
 */
const RISK_TO_MODE = Object.freeze({
  low: 'direct_edit',
  medium: 'standard_task',
  high: 'high_risk_task',
})

/** 结构化错误码，让调用方依据错误码而不是消息文本分支。 */
export const PROJECT_CODES = Object.freeze({
  MISSING: 'GAC_PROJECT_ADAPTER_MISSING',
  INVALID: 'GAC_PROJECT_ADAPTER_INVALID',
  ESCALATION_REQUIRED: 'GAC_PROCESS_ESCALATION_REQUIRED',
  UNKNOWN_MODE: 'GAC_UNKNOWN_EXECUTION_MODE',
  UNKNOWN_CAPABILITY: 'GAC_UNKNOWN_CAPABILITY',
})

/**
 * 适配器格式错误或缺失时抛出。它携带稳定的 `code`，让协调器无需解析消息
 * 即可分支。
 */
export class ProjectAdapterError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'ProjectAdapterError'
    this.code = code
  }
}

/**
 * 校验并冻结一个原始适配器对象。
 *
 * 未知的顶层键会被拒绝而不是忽略：`risk.high_risk_paths` 里一个被静默丢弃
 * 的拼写错误，会在文件看起来仍然配置完好的情况下让升级守卫失效 —— 对策略
 * 文件而言这是最糟糕的失败。
 *
 * @param {unknown} raw - 已解析的 JSON。
 * @param {string} source - 对象来源的路径，用于错误消息。
 * @returns {Readonly<object>} 冻结后的适配器。
 * @throws {ProjectAdapterError}
 */
export function validateProjectAdapter(raw, source = '<memory>') {
  const fail = (detail) => {
    throw new ProjectAdapterError(
      `project adapter at ${source} is invalid: ${detail}`,
      PROJECT_CODES.INVALID,
    )
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('top level must be a JSON object')
  }

  const allowedKeys = new Set([
    'schema_version',
    'project',
    'capabilities',
    'executors',
    'risk',
    'authority',
    'engineering',
    'memory',
    'checkpoint',
  ])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`unknown top-level key "${key}"`)
  }

  const project = raw.project
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    fail('"project" must be an object')
  }
  if (typeof project.id !== 'string' || project.id.trim() === '') {
    fail('"project.id" must be a non-empty string')
  }

  const capabilities = raw.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string' || c === '')) {
    fail('"capabilities" must be an array of non-empty strings')
  }

  const executors = raw.executors ?? {}
  if (executors === null || typeof executors !== 'object' || Array.isArray(executors)) {
    fail('"executors" must be an object mapping capability to executor list')
  }
  for (const [capability, names] of Object.entries(executors)) {
    if (!capabilities.includes(capability)) {
      fail(`"executors" names capability "${capability}" which is not in "capabilities"`)
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n === '')) {
      fail(`"executors.${capability}" must be an array of non-empty strings`)
    }
  }

  const risk = raw.risk ?? {}
  if (risk === null || typeof risk !== 'object' || Array.isArray(risk)) {
    fail('"risk" must be an object')
  }
  const highRiskPaths = risk.high_risk_paths ?? []
  if (!Array.isArray(highRiskPaths) || highRiskPaths.some((p) => typeof p !== 'string' || p === '')) {
    fail('"risk.high_risk_paths" must be an array of non-empty strings')
  }
  if (risk.default_level !== undefined && !RISK_LEVELS.includes(risk.default_level)) {
    fail(`"risk.default_level" must be one of ${RISK_LEVELS.join(', ')}`)
  }

  const memory = raw.memory ?? {}
  if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
    fail('"memory" must be an object')
  }
  const allowedMemoryScopes = ['current_project', 'global_reusable', 'foreign_project', 'unknown']
  const allowScopes = memory.allow ?? ['current_project', 'global_reusable']
  if (!Array.isArray(allowScopes) || allowScopes.some((s) => !allowedMemoryScopes.includes(s))) {
    fail(`"memory.allow" entries must be within ${allowedMemoryScopes.join(', ')}`)
  }

  return Object.freeze({
    schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : 1,
    project: Object.freeze({ id: project.id, title: project.title ?? project.id }),
    capabilities: Object.freeze([...capabilities]),
    executors: Object.freeze(
      Object.fromEntries(
        Object.entries(executors).map(([k, v]) => [k, Object.freeze([...v])]),
      ),
    ),
    risk: Object.freeze({
      high_risk_paths: Object.freeze([...highRiskPaths]),
      default_level: risk.default_level ?? 'low',
    }),
    engineering: Object.freeze({ ...(raw.engineering ?? {}) }),
    memory: Object.freeze({
      allow: Object.freeze([...allowScopes]),
      deny_as_project_fact: Object.freeze([...(memory.deny_as_project_fact ?? ['foreign_project', 'unknown'])]),
    }),
    authority: Object.freeze({ ...(raw.authority ?? {}) }),
    checkpoint: Object.freeze({ ...(raw.checkpoint ?? {}) }),
  })
}

/**
 * 从一个已读取的 JSON 字符串加载工程适配器。
 *
 * 它与文件系统访问分离，一来模块保持可测试，二来 `ctx.fs` 的读取由调用方
 * （lib/index.js）负责 —— 运行时不得再长出第二条通往磁盘的路径。
 *
 * @param {string} text - 原始 JSON 文本。
 * @param {string} [source]
 * @returns {Readonly<object>}
 * @throws {ProjectAdapterError}
 */
export function loadProjectAdapterFromText(text, source = '<memory>') {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ProjectAdapterError(
      `project adapter at ${source} is not valid JSON: ${detail}`,
      PROJECT_CODES.INVALID,
    )
  }
  return validateProjectAdapter(parsed, source)
}

/**
 * 一个候选路径是否落在工程声明的高风险路径中？
 *
 * 匹配复用写作用域的匹配器，而不是重新实现一遍路径比较，这样 `SRC/BOOT.C`
 * 与 `src/boot.c` 才不会在升级守卫和写守卫之间得出不同结论。
 *
 * @param {string} candidate - 待测试的路径。
 * @param {readonly string[]} highRiskPaths - 工程声明的模式。
 * @param {{foldCase?: boolean}} [options]
 * @returns {boolean}
 */
export function isHighRiskPath(candidate, highRiskPaths, options = {}) {
  if (!Array.isArray(highRiskPaths) || highRiskPaths.length === 0) return false
  return createWriteScope(highRiskPaths, options).allows(candidate)
}

/**
 * 依据工程定义的风险，解析已声明的执行模式。
 *
 * @param {object} input
 * @param {string} input.declared_mode - 模型声明的模式。
 * @param {string} [input.reason] - 模型给出的依据。
 * @param {readonly string[]} [input.target_paths] - 本次工作将会触及的路径。
 * @param {Readonly<object>} input.adapter - 已校验的工程适配器。
 * @param {boolean} [input.irreversible] - 调用方观测到的不可逆性。
 * @param {boolean} [input.ambiguous] - 调用方观测到的需求歧义。
 * @param {{foldCase?: boolean}} [options]
 * @returns {{
 *   mode: string,
 *   declared_mode: string,
 *   escalated: boolean,
 *   escalated_from?: string,
 *   risk: string,
 *   reason: string,
 *   code?: string
 * }}
 * @throws {ProjectAdapterError} 当声明的模式未知时。
 */
export function resolveExecutionMode(input, options = {}) {
  const { declared_mode: declaredMode, adapter } = input
  if (adapter === undefined) {
    throw new ProjectAdapterError('resolveExecutionMode requires a validated adapter', PROJECT_CODES.INVALID)
  }
  if (!EXECUTION_MODES.includes(declaredMode)) {
    throw new ProjectAdapterError(
      `unknown execution mode "${declaredMode}"; expected one of ${EXECUTION_MODES.join(', ')}`,
      PROJECT_CODES.UNKNOWN_MODE,
    )
  }

  const targets = input.target_paths ?? []
  const offending = targets.filter((path) =>
    isHighRiskPath(path, adapter.risk.high_risk_paths, options))

  // 只要命中高风险路径，就强制升到最高档，不论声明的是什么。这就是架构大纲
  // §5/§6 的守卫：由语义影响决定，文件数量永远不决定。
  if (offending.length > 0 && declaredMode !== 'high_risk_task') {
    return {
      mode: 'high_risk_task',
      declared_mode: declaredMode,
      escalated: true,
      escalated_from: declaredMode,
      risk: 'high',
      reason:
        `declared ${declaredMode}, but ${offending.length} target path(s) fall in a `
        + `project-declared high-risk path: ${offending.join(', ')}`,
      code: PROJECT_CODES.ESCALATION_REQUIRED,
    }
  }

  const risk = modeToRisk(declaredMode)

  // 不可逆与歧义只被记录，不自动升级：当改动很小且可逆时，模型用廉价流程
  // 处理一个有歧义的需求是合理的。把这一事实摆到台面上，既让决策保持可审计，
  // 又不至于让代码凭空发明一条工程从未声明过的策略。
  const flags = []
  if (input.irreversible === true) flags.push('IRREVERSIBLE')
  if (input.ambiguous === true) flags.push('AMBIGUOUS')

  const suffix = flags.length > 0 ? ` [${flags.join('+')}]` : ''
  return {
    mode: declaredMode,
    declared_mode: declaredMode,
    escalated: false,
    risk,
    reason: `${input.reason ?? 'no basis recorded'}${suffix}`,
  }
}

/**
 * 一个模式所隐含的风险级别。它是 {@link modeForRisk} 的逆函数，由同一张表
 * 定义，因此两者永远不会互相矛盾。
 *
 * @param {string} mode
 * @returns {string}
 */
export function modeToRisk(mode) {
  for (const [risk, mapped] of Object.entries(RISK_TO_MODE)) {
    if (mapped === mode) return risk
  }
  throw new ProjectAdapterError(`unknown execution mode "${mode}"`, PROJECT_CODES.UNKNOWN_MODE)
}

/**
 * 一个风险级别所映射到的模式。之所以导出，是为了让协调器与面向模型的提示词
 * 读同一张表而不是两张。
 *
 * @param {string} risk
 * @returns {string}
 */
export function modeForRisk(risk) {
  const mode = RISK_TO_MODE[risk]
  if (mode === undefined) {
    throw new ProjectAdapterError(
      `unknown risk level "${risk}"; expected one of ${RISK_LEVELS.join(', ')}`,
      PROJECT_CODES.INVALID,
    )
  }
  return mode
}

/**
 * 按流程权重给两个模式排序。用于升级检查
 * （`escalated_from` 必须严格低于 `mode`）。
 *
 * @param {string} mode
 * @returns {number}
 */
export function modeRank(mode) {
  const index = EXECUTION_MODES.indexOf(mode)
  if (index === -1) {
    throw new ProjectAdapterError(`unknown execution mode "${mode}"`, PROJECT_CODES.UNKNOWN_MODE)
  }
  return index
}
