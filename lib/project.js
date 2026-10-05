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
/**
 * 模式到风险的正向映射。**必须覆盖 EXECUTION_MODES 的每一项。**
 *
 * 早先只有 `RISK_TO_MODE` 一张表，`modeToRisk` 靠遍历它反查风险。那张表里没有 `read_only`
 * （因为一个风险只能映射到一个「最低充分模式」，`low` 已经被 `direct_edit` 占了），于是
 * `read_only` 通过了 `EXECUTION_MODES` 的白名单检查、却在紧接着的反查里抛错——**目录里
 * 排在最前、最常用的那个模式根本声明不了**。正向表与反向表是两件事：前者要全，后者只取
 * 每档风险的起点，用一张表兼职两者时，缺口就长在最常用的那一项上。
 */
const MODE_TO_RISK = Object.freeze({
  read_only: 'low',
  direct_edit: 'low',
  standard_task: 'medium',
  high_risk_task: 'high',
})

/** 每一档风险对应的**起点**模式（不是该档唯一的模式）。 */
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
      `位于 ${source} 的工程适配器无效：${detail}`,
      PROJECT_CODES.INVALID,
    )
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('顶层必须是一个 JSON 对象')
  }

  const allowedKeys = new Set([
    'schema_version',
    'project',
    'capabilities',
    'executors',
    'execution',
    'risk',
    'authority',
    'engineering',
    'memory',
    'checkpoint',
  ])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`未知的顶层键 "${key}"`)
  }

  const project = raw.project
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    fail('"project" 必须是一个对象')
  }
  if (typeof project.id !== 'string' || project.id.trim() === '') {
    fail('"project.id" 必须是非空字符串')
  }

  const capabilities = raw.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string' || c === '')) {
    fail('"capabilities" 必须是非空字符串数组')
  }

  const executors = raw.executors ?? {}
  if (executors === null || typeof executors !== 'object' || Array.isArray(executors)) {
    fail('"executors" 必须是把能力映射到执行者列表的对象')
  }
  for (const [capability, names] of Object.entries(executors)) {
    if (!capabilities.includes(capability)) {
      fail(`"executors" 命名了能力 "${capability}"，但它不在 "capabilities" 里`)
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n === '')) {
      fail(`"executors.${capability}" 必须是非空字符串数组`)
    }
  }

  // `execution` 是本仓库运行时真正读取的一节（`lib/index.js` 读 provider_routes、`lib/tool-task.js`
  // 读 require_contract）。早先校验器不接受这个键，于是这两处读的字段**永远不可能存在**：
  // 适配器里写了会被判为未知顶层键而整体拒绝，不写则读到 undefined。校验器不认识的字段，
  // 运行时也不该去读——两处必须同时存在，否则读到的永远是空。
  const execution = raw.execution ?? {}
  if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) {
    fail('"execution" 必须是一个对象')
  }
  const allowedExecutionKeys = new Set([
    'provider_routes',
    'require_contract',
    'revoke_shell_for_read_only_roles',
    'native_child_dispatch',
  ])
  for (const key of Object.keys(execution)) {
    if (!allowedExecutionKeys.has(key)) fail(`未知的 "execution" 键 "${key}"`)
  }
  const providerRoutes = execution.provider_routes ?? {}
  if (providerRoutes === null || typeof providerRoutes !== 'object' || Array.isArray(providerRoutes)) {
    fail('"execution.provider_routes" 必须是把执行者名字映射到路由的对象')
  }
  for (const [name, route] of Object.entries(providerRoutes)) {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) {
      fail(`"execution.provider_routes.${name}" 必须是一个对象`)
    }
    for (const field of ['provider', 'model', 'reasoning_effort']) {
      if (route[field] !== undefined && (typeof route[field] !== 'string' || route[field] === '')) {
        fail(`"execution.provider_routes.${name}.${field}" 必须是非空字符串`)
      }
    }
  }
  // require_contract 接受两种写法：模式名数组，或 { modes: [...] }。前者是常见情形，
  // 后者留出后续加别的开关的余地。
  const requireContract = execution.require_contract
  if (requireContract !== undefined && requireContract !== null) {
    const modes = Array.isArray(requireContract) ? requireContract : requireContract.modes
    if (!Array.isArray(modes) || modes.some((mode) => !EXECUTION_MODES.includes(mode))) {
      fail(
        `"execution.require_contract" 必须是取自 ${EXECUTION_MODES.join(', ')} 的执行模式列表`
        + `（或 { modes: [...] }）`,
      )
    }
  }

  // 只读角色要不要连 shell 一起收回。默认**不收**：验证者要逐条执行计划用例才能留下证据，而
  // 执行用例靠 shell；收掉它等于让「每条用例都要有独立证据」的收口门禁永远过不去。项目声明
  // true 时，越界的 shell 写入就只剩事后观测（适配计划 §7 边界 1）。
  const revokeShell = execution.revoke_shell_for_read_only_roles
  if (revokeShell !== undefined && typeof revokeShell !== 'boolean') {
    fail('"execution.revoke_shell_for_read_only_roles" 必须是 true 或 false')
  }

  // 原生子会话派遣的开关，**默认关**。开启后，需要写文件的节点会交给 `ctx.subagents` 起的真子会话
  // （见 docs/ADR-0001-子会话执行载体.md）；关着时行为与从前完全一致（节点置 in_progress，等待
  // 上层会话执行）。默认关的理由是它能改变「谁在写文件」，而这件事必须先在真实会话里验过再默认开。
  const nativeChildDispatch = execution.native_child_dispatch
  if (nativeChildDispatch !== undefined && typeof nativeChildDispatch !== 'boolean') {
    fail('"execution.native_child_dispatch" 必须是 true 或 false')
  }

  const risk = raw.risk ?? {}
  if (risk === null || typeof risk !== 'object' || Array.isArray(risk)) {
    fail('"risk" 必须是一个对象')
  }
  const highRiskPaths = risk.high_risk_paths ?? []
  if (!Array.isArray(highRiskPaths) || highRiskPaths.some((p) => typeof p !== 'string' || p === '')) {
    fail('"risk.high_risk_paths" 必须是非空字符串数组')
  }
  if (risk.default_level !== undefined && !RISK_LEVELS.includes(risk.default_level)) {
    fail(`"risk.default_level" 必须是 ${RISK_LEVELS.join(', ')} 之一`)
  }

  const memory = raw.memory ?? {}
  if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
    fail('"memory" 必须是一个对象')
  }
  const allowedMemoryScopes = ['current_project', 'global_reusable', 'foreign_project', 'unknown']
  const allowScopes = memory.allow ?? ['current_project', 'global_reusable']
  if (!Array.isArray(allowScopes) || allowScopes.some((s) => !allowedMemoryScopes.includes(s))) {
    fail(`"memory.allow" 的条目必须在 ${allowedMemoryScopes.join(', ')} 之内`)
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
    execution: Object.freeze({
      provider_routes: Object.freeze(
        Object.fromEntries(
          Object.entries(providerRoutes).map(([name, route]) => [name, Object.freeze({ ...route })]),
        ),
      ),
      // 归一成一个模式名数组：消费方只关心「哪些模式要求契约」，不该同时理解两种写法。
      require_contract: Object.freeze(
        requireContract === undefined || requireContract === null
          ? []
          : [...(Array.isArray(requireContract) ? requireContract : requireContract.modes)],
      ),
      // 归一成布尔量：消费方读到的永远是 true / false，而不是 undefined 与「没写」的分别。
      revoke_shell_for_read_only_roles: revokeShell === true,
      native_child_dispatch: nativeChildDispatch === true,
    }),
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
      `位于 ${source} 的工程适配器不是合法 JSON：${detail}`,
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
    throw new ProjectAdapterError('resolveExecutionMode 需要一个已校验的适配器', PROJECT_CODES.INVALID)
  }
  if (!EXECUTION_MODES.includes(declaredMode)) {
    throw new ProjectAdapterError(
      `未知的执行模式 "${declaredMode}"；期望的是 ${EXECUTION_MODES.join(', ')} 之一`,
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
        `声明了 ${declaredMode}，但有 ${offending.length} 个目标路径落在工程声明的`
        + `高风险路径中：${offending.join(', ')}`,
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
    reason: `${input.reason ?? '未记录依据'}${suffix}`,
  }
}

/**
 * 一个模式所隐含的风险级别。
 *
 * 读正向表而不是反查反向表：反查会漏掉与别人共享同一档风险的模式，而漏掉的那一项恰恰是
 * 目录里最常用的那个。
 *
 * @param {string} mode
 * @returns {string}
 */
export function modeToRisk(mode) {
  const risk = MODE_TO_RISK[mode]
  if (risk === undefined) {
    throw new ProjectAdapterError(`未知的执行模式 "${mode}"`, PROJECT_CODES.UNKNOWN_MODE)
  }
  return risk
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
      `未知的风险级别 "${risk}"；期望的是 ${RISK_LEVELS.join(', ')} 之一`,
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
    throw new ProjectAdapterError(`未知的执行模式 "${mode}"`, PROJECT_CODES.UNKNOWN_MODE)
  }
  return index
}
