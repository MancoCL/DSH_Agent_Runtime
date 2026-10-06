/**
 * 生产能力的**机器可校验**形态。
 *
 * 为什么要有这个模块：README 的「生产能力契约」是一张表，而**只写在文档里的契约会与代码漂移**——
 * 本仓库在 `checkpoint` 那条上已经吃过一次（`AGENTS.md` §5 自己承认它「没有代码消费」）。这里把那
 * 张表变成三件可执行的事：
 *
 *  1. **项目声明**它需要哪些能力（适配器的 `execution.required_capabilities`）；
 *  2. 插件**加载时逐项核对真实环境**，缺项写进加载报告（可见，而不是等出事才发现）；
 *  3. **高风险任务收口时**，缺项未获显式豁免就拒绝收口。
 *
 * 第 3 条为什么是「拒绝结论」而不是「拒绝工具」：观测缺席时，「没有越界写入」这句话**没有依据**，
 * 缺的是结论的凭据，不是工具的能力。所以拒的是收口这个动作，而且留一条**显式、留痕、可审计**的
 * 豁免——一个永远收不了口的高风险模式就是「把自己关在门外」的同一个形状，本仓库在 `gac_scope`
 * 上已经踩过一次。
 *
 * 判「能力在不在」看的是**已加载树**（接缝给不给、事件来不来），不看 profile 的 `package.json`：
 * 这两者会给出相反答案，本仓库两条都踩过（`workspace-changes` 与 `ptc-runtime` 都不在 profile 自己
 * 的依赖里，却都因为某个 bundle 的 patch 插入了那一行而一直在场）。
 */

/** 能力标识的闭集。项目的声明只能取这里面的值——拼错的名字必须被拒，而不是被静默忽略。 */
export const CAPABILITIES = Object.freeze({
  NATIVE_CHILD_DISPATCH: 'native_child_dispatch',
  WORKSPACE_OBSERVATION: 'workspace_observation',
  ROLE_ISOLATION: 'role_isolation',
  WRITE_CLAIMS: 'write_claims',
  EVIDENCE_LOG: 'evidence_log',
  SEMANTIC_ARTIFACTS: 'semantic_artifacts',
})

/** 全部能力标识，按声明顺序。 */
export const CAPABILITY_IDS = Object.freeze(Object.values(CAPABILITIES))

/**
 * 每项能力：它是什么、缺了它意味着什么、由哪个接缝决定。
 *
 * `probe` 取值 `always` 的几项是**本插件自己的机制**：插件加载即具备。把它们列进来不是因为它们
 * 可能缺席，而是因为项目应当能显式声明「我依赖它」——声明之后，将来若真的被摘掉，加载时的核对会
 * 直接报出来，而不是等一次真实事故。
 */
export const CAPABILITY_SPECS = Object.freeze({
  [CAPABILITIES.NATIVE_CHILD_DISPATCH]: {
    description: '原生子会话执行',
    absent: '节点退回主会话执行，「独立验证」在事实层面不成立',
    probe: 'childDispatch',
  },
  [CAPABILITIES.WORKSPACE_OBSERVATION]: {
    description: '工作区观测（纵深防御层）',
    absent: 'shell / 生成器 / 外部进程的落盘没有任何事后记录，「没有越界写入」无从成立',
    probe: 'workspaceObservation',
  },
  [CAPABILITIES.ROLE_ISOLATION]: {
    description: '角色工具面隔离',
    absent: '只读角色可能拿到写入面',
    probe: 'always',
  },
  [CAPABILITIES.WRITE_CLAIMS]: {
    description: '写占用声明',
    absent: '两个写入者可能同时写同一个文件',
    probe: 'always',
  },
  [CAPABILITIES.EVIDENCE_LOG]: {
    description: '证据（运行时签发）',
    absent: '「每条用例都有证据」可以靠编造满足',
    probe: 'always',
  },
  [CAPABILITIES.SEMANTIC_ARTIFACTS]: {
    description: '语义产物由运行时登记',
    absent: '收口要父会话手工补写，产物与结论可能对不上',
    probe: 'always',
  },
})

/** 收口时要求「环境可观测」的模式。高风险模式是唯一需要独立验证与证据的那一类。 */
export const MODES_REQUIRING_CAPABILITIES = Object.freeze(['high_risk_task'])

/** 收口因能力缺项被拒时的错误码。 */
export const CAPABILITY_CODES = Object.freeze({
  UNKNOWN_CAPABILITY: 'GAC_UNKNOWN_CAPABILITY',
  COMPLETION_CAPABILITY_MISSING: 'GAC_COMPLETION_CAPABILITY_MISSING',
})

/** 能力声明或核对失败。 */
export class CapabilityError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 校验一份能力声明（供适配器校验用）。
 *
 * 未知的标识一律拒绝：放过它等于让「我声明了但没人核对」变成常态，而那正是本模块要消灭的东西。
 *
 * @param {unknown} value
 * @returns {string[]} 去重后的能力标识，保持声明顺序。
 * @throws {CapabilityError}
 */
export function validateRequirements(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new CapabilityError(
      '"execution.required_capabilities" 必须是一个能力标识数组',
      CAPABILITY_CODES.UNKNOWN_CAPABILITY,
    )
  }
  const found = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      throw new CapabilityError(
        `"execution.required_capabilities" 里有一项不是非空字符串：${JSON.stringify(entry)}`,
        CAPABILITY_CODES.UNKNOWN_CAPABILITY,
      )
    }
    if (!CAPABILITY_IDS.includes(entry)) {
      throw new CapabilityError(
        `未知的能力标识 "${entry}"；可用的是 ${CAPABILITY_IDS.join('、')}`,
        CAPABILITY_CODES.UNKNOWN_CAPABILITY,
        { id: entry, known: CAPABILITY_IDS },
      )
    }
    if (!found.includes(entry)) found.push(entry)
  }
  return found
}

/**
 * 逐项核对：声明需要的能力，在**真实环境**里到底在不在。
 *
 * @param {readonly string[]} requirements - 已经过 {@link validateRequirements} 的声明。
 * @param {object} [environment] - 接缝的真实状态。
 * @param {boolean} [environment.childDispatch] - 原生子会话接缝是否可用。
 * @param {boolean} [environment.workspaceObservation] - 工作区观测接缝是否可用。
 * @returns {Readonly<{ok: boolean, required: string[], missing: object[]}>}
 */
export function checkCapabilities(requirements, environment = {}) {
  const required = Array.isArray(requirements) ? [...requirements] : []
  const missing = []
  for (const id of required) {
    const spec = CAPABILITY_SPECS[id]
    if (spec === undefined) {
      missing.push({
        id,
        description: id,
        absent: '这个标识不在能力的闭集里，因此无从核对',
        probe: 'unknown',
      })
      continue
    }
    const met = spec.probe === 'always' ? true : environment[spec.probe] === true
    if (!met) {
      missing.push({ id, description: spec.description, absent: spec.absent, probe: spec.probe })
    }
  }
  return Object.freeze({ ok: missing.length === 0, required, missing: Object.freeze(missing) })
}

/**
 * 收口门禁：高风险模式在能力缺项时拒绝收口，除非调用方给出**显式豁免**。
 *
 * @param {object} input
 * @param {string} input.mode - 任务的执行模式。
 * @param {readonly object[]} input.missing - {@link checkCapabilities} 的 `missing`。
 * @param {unknown} [input.ack] - 调用方给出的豁免理由（非空字符串才算）。
 * @returns {Readonly<{required: boolean, refuse: boolean, acknowledged: boolean, missing: object[], reason?: string}>}
 *   `required` 表示这个模式是否受这条门禁管辖；`refuse` 表示是否应当拒绝。
 */
export function evaluateCompletionGate({ mode, missing, ack } = {}) {
  const gaps = Array.isArray(missing) ? [...missing] : []
  const governed = MODES_REQUIRING_CAPABILITIES.includes(mode)
  const acknowledged = typeof ack === 'string' && ack.trim() !== ''
  if (!governed || gaps.length === 0) {
    return Object.freeze({ required: governed, refuse: false, acknowledged: false, missing: gaps })
  }
  if (acknowledged) {
    return Object.freeze({
      required: true,
      refuse: false,
      acknowledged: true,
      missing: gaps,
      reason: ack.trim(),
    })
  }
  return Object.freeze({
    required: true,
    refuse: true,
    acknowledged: false,
    missing: gaps,
    reason: `缺少 ${gaps.map((gap) => gap.description).join('、')}`,
  })
}
