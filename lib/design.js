/**
 * 设计包：把「需求侧事实」翻译成「可以照着实现、也可以照着验证的结构」的那一份产物。
 *
 * 为什么需要它
 * ----------
 * 在此之前，GAC 里从需求到实现的唯一中间产物是**接口契约**与**验证计划**：契约对齐「接口长什么样」，
 * 计划规定「怎么证明它对了」。两者都很好，但都不回答「这个东西由哪几部分组成、各部分之间怎么说话、
 * 哪一块先做」——那段推理此前没有落点，于是它要么不存在，要么只存在于某个 Agent 的推理过程里，
 * 既不可审计，也无法在下游被引用。设计包补的就是这一段。
 *
 * 它**不是**第二套 Runtime
 * ---------------------
 * 设计包只是一份**有身份、可冻结、可校验**的记录，复用仓库里已经定过的三条机制，不新增任何机制：
 *
 * 1. **内容寻址**（`designId` / `artifact-<hash>`）：身份从内容算出来，改写即换身份。于是「下游依据的
 *    是哪一版设计」成为一个可以被发现的事实，而不是一句需要相信的声明。这与 `contractId`、`planId`
 *    同一形状。
 * 2. **冻结语义**（`freezeDesign`）：同一份内容重复提交是 `unchanged`，换一份内容覆盖是拒绝——要改就
 *    显式删除重建并说明原因。这与 `freezeContract` 同一形状，因此下游不会遇到「两份契约两套规矩」。
 * 3. **确定性校验**（`evaluateDesignPackage`）：能机器判的只有「结构齐不齐、引用对不对、内容有没有被
 *    改过」。**判不了的绝不假装判**——「详设有没有引入架构未声明的组件」「测试是否真的独立」这类问题
 *    需要语义理解，交给独立设计复核，而不是塞进一个看起来很像门禁的启发式。
 *
 * 四份产物与两个角色
 * ----------------
 * `software_architecture` / `software_detail` 由 `software_design` 角色产出，
 * `test_architecture` / `test_detail` 由 `test_design` 角色产出（见 `DESIGN_ROLE_ARTIFACTS`）。
 * 阶段（architecture / detail）**不新增节点字段**：它由产物名本身决定（`DESIGN_ARTIFACT_STAGE`），
 * 而「这个节点产出哪一份」由节点已有的 `expected_artifacts` 声明——已有的字段够用就不要加新的。
 *
 * @module design
 */

import { digest } from './evidence.js'

/** 机器可分支的设计层错误码。 */
export const DESIGN_CODES = Object.freeze({
  MALFORMED: 'GAC_DESIGN_MALFORMED',
  ALREADY_FROZEN: 'GAC_DESIGN_ALREADY_FROZEN',
  INCOMPLETE: 'GAC_DESIGN_INCOMPLETE',
  UNKNOWN_ARTIFACT: 'GAC_DESIGN_ARTIFACT_UNKNOWN',
  ROLE_ARTIFACT_MISMATCH: 'GAC_DESIGN_ROLE_ARTIFACT_MISMATCH',
  ARTIFACT_MISMATCH: 'GAC_DESIGN_ARTIFACT_MISMATCH',
  TRACEABILITY_GAP: 'GAC_DESIGN_TRACEABILITY_GAP',
  REQUIREMENT_MISMATCH: 'GAC_DESIGN_REQUIREMENT_MISMATCH',
  UNRESOLVED_ISSUES: 'GAC_DESIGN_UNRESOLVED_ISSUES',
  INCONSISTENT: 'GAC_DESIGN_INCONSISTENT',
  NOT_APPROVED: 'GAC_DESIGN_NOT_APPROVED',
  STALE_APPROVAL: 'GAC_DESIGN_STALE_APPROVAL',
})

/**
 * 结构化设计层错误，携带稳定 `code`。
 */
export class DesignError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'DesignError'
    this.code = code
    this.detail = detail
  }
}

/** 四份设计产物的闭集，顺序即展示顺序。 */
export const DESIGN_ARTIFACTS = Object.freeze([
  'software_architecture',
  'software_detail',
  'test_architecture',
  'test_detail',
])

/** 产物名 → 阶段。阶段是产物的属性，因此不需要在节点上再声明一次。 */
export const DESIGN_ARTIFACT_STAGE = Object.freeze({
  software_architecture: 'architecture',
  software_detail: 'detail',
  test_architecture: 'architecture',
  test_detail: 'detail',
})

/**
 * 语义角色 → 它有权产出的产物。
 *
 * 这条表是「软件设计专家不去写测试架构、测试设计专家不去写软件详设」的判据：两个角色都不写文件，
 * 它们的**唯一**产出就是这里点名的那些产物，所以越界产出必须被拒——不然「角色」又退化成一个标签。
 */
export const DESIGN_ROLE_ARTIFACTS = Object.freeze({
  software_design: Object.freeze(['software_architecture', 'software_detail']),
  test_design: Object.freeze(['test_architecture', 'test_detail']),
})

/**
 * 角色 + 阶段 → 产物名；认不出来返回 `undefined`（调用方据此如实报错，而不是猜一个）。
 *
 * @param {string} role
 * @param {string} stage
 * @returns {string|undefined}
 */
export function artifactKeyForRole(role, stage) {
  const keys = DESIGN_ROLE_ARTIFACTS[role]
  if (!Array.isArray(keys)) return undefined
  return keys.find((key) => DESIGN_ARTIFACT_STAGE[key] === stage)
}

/**
 * 一个角色能不能产出某份产物。
 *
 * @param {string} role
 * @param {string} artifact
 * @returns {boolean}
 */
export function roleMayAuthorArtifact(role, artifact) {
  const keys = DESIGN_ROLE_ARTIFACTS[role]
  return Array.isArray(keys) && keys.includes(artifact)
}

/**
 * 一个复核节点复核的是设计还是实现。
 *
 * 判据只有一条：这个节点在 `expected_artifacts` 里点名了设计产物。理由是复核节点**没有别的**
 * 可核对的声明——它跟设计节点不同，设计节点的角色就写明了它交什么。而 `expected_artifacts` 是
 * 计划里已经存在、且派遣前就能核对的事实。
 *
 * 缺省返回 `implementation`：一份复核默认针对刚写出来的代码。这个缺省**不是无害的**——它会把一份
 * 漏声明的设计复核登记成实现复核，因此 `lib/review.js` 的 `subject` 是闭集、提示词里会明确要求填，
 * 而这里的返回值会被写进提示词，让复核者不必猜。
 *
 * @param {object|undefined} node
 * @returns {'implementation'|'design'}
 */
export function reviewSubjectOf(node) {
  const declared = Array.isArray(node?.expected_artifacts) ? node.expected_artifacts : []
  return declared.some((name) => DESIGN_ARTIFACTS.includes(name) || name === 'design_package')
    ? 'design'
    : 'implementation'
}

/**
 * 编译一份设计产物。
 *
 * 产物正文只在这里存一份：`ref` 与 `hash` 都从正文算出，因此「正文被改过」是**可以当场发现**的
 * （`evaluateDesignPackage` 会重算一遍），不需要另存一份校验和去和谁对齐。
 *
 * @param {object} raw
 * @param {string} raw.artifact - 四份产物之一。
 * @param {string} raw.content - 正文。
 * @param {readonly object[]} [raw.traceability] - 这份产物支撑了哪些验收标准（`{criteria, where}`）。
 * @param {object} [options]
 * @param {string} [options.childSessionId] - 产出它的子会话，由运行时盖章而不是自报。
 * @param {number} [options.createdAt]
 * @returns {Readonly<object>}
 * @throws {DesignError} 携带 {@link DESIGN_CODES}。
 */
export function compileDesignArtifact(raw, options = {}) {
  const fail = (message, code, detail) => {
    throw new DesignError(message, code, detail)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('设计产物必须是一个对象', DESIGN_CODES.MALFORMED)
  }
  if (typeof raw.artifact !== 'string' || !DESIGN_ARTIFACTS.includes(raw.artifact)) {
    fail(`设计产物名不在闭集内：${JSON.stringify(raw.artifact)}`, DESIGN_CODES.UNKNOWN_ARTIFACT, {
      artifact: raw.artifact,
    })
  }
  if (typeof raw.content !== 'string' || raw.content.trim() === '') {
    fail(`设计产物 ${raw.artifact} 没有正文`, DESIGN_CODES.MALFORMED, { artifact: raw.artifact })
  }
  const traceability = []
  for (const entry of Array.isArray(raw.traceability) ? raw.traceability : []) {
    if (typeof entry?.criteria !== 'string' || entry.criteria === '') {
      fail(`设计产物 ${raw.artifact} 的追溯项缺少 criteria`, DESIGN_CODES.MALFORMED, {
        artifact: raw.artifact,
      })
    }
    if (typeof entry?.where !== 'string' || entry.where === '') {
      fail(`设计产物 ${raw.artifact} 的追溯项 ${entry.criteria} 没有写明落在哪里（where）`, DESIGN_CODES.MALFORMED, {
        artifact: raw.artifact,
        criteria: entry.criteria,
      })
    }
    traceability.push(Object.freeze({ criteria: entry.criteria, where: entry.where }))
  }

  const hash = digest(raw.content)
  return Object.freeze({
    schema_version: 1,
    artifact: raw.artifact,
    stage: DESIGN_ARTIFACT_STAGE[raw.artifact],
    ref: `artifact-${hash}`,
    hash,
    content: raw.content,
    traceability: Object.freeze(traceability),
    author_child_session_id:
      typeof options.childSessionId === 'string' && options.childSessionId !== ''
        ? options.childSessionId
        : null,
    created_at: options.createdAt ?? 0,
  })
}

/**
 * 把一份产物的正文重新算一遍，核对它报的 `ref`/`hash` 是不是从这份正文来的。
 *
 * @param {object} artifact
 * @returns {boolean}
 */
function artifactIntact(artifact) {
  if (artifact === null || typeof artifact !== 'object') return false
  if (typeof artifact.content !== 'string') return false
  const hash = digest(artifact.content)
  return artifact.hash === hash && artifact.ref === `artifact-${hash}`
}

/**
 * 编译一份设计包。
 *
 * 校验一次做完，与 `compileTask` 同一个理由：一份缺了详设、或追溯不到验收标准的设计包，越早拒绝
 * 越便宜——放到实现之后才发现「设计其实没覆盖这条验收标准」，那时代码已经写完了。
 *
 * @param {object} raw
 * @param {string} raw.task_id
 * @param {string} raw.requirement_ref - 需求侧引用（冻结的访谈记录或需求标识）。
 * @param {string} [raw.interface_contract_ref] - 已冻结契约的 id（`contract-…`）。
 * @param {object} raw.artifacts - 四份产物，键取自 {@link DESIGN_ARTIFACTS}。
 * @param {readonly object[]} [raw.requirement_traceability] - 验收标准 → 产物（`{criteria, artifact}`）。
 * @param {readonly object[]} [raw.unresolved_issues] - 未解决的问题，每条必须给出理由。
 * @param {object} [options]
 * @param {readonly string[]} [options.criteria] - 本任务的验收标准；给了就当场核对覆盖。
 * @param {string} [options.contractId] - 本任务当前冻结契约的 id；给了就核对引用一致。
 * @param {string} [options.requirementId] - 本任务当前需求的 id；给了就核对设计推导自这一份需求。
 * @param {number} [options.frozenAt]
 * @returns {Readonly<object>}
 * @throws {DesignError} 携带 {@link DESIGN_CODES}。
 */
export function compileDesignPackage(raw, options = {}) {
  const fail = (message, code, detail) => {
    throw new DesignError(message, code, detail)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('设计包必须是一个对象', DESIGN_CODES.MALFORMED)
  }
  if (typeof raw.task_id !== 'string' || raw.task_id === '') {
    fail('设计包缺少 task_id', DESIGN_CODES.MALFORMED)
  }
  if (typeof raw.requirement_ref !== 'string' || raw.requirement_ref === '') {
    fail('设计包缺少 requirement_ref——设计必须指明它推导自哪一份需求', DESIGN_CODES.MALFORMED, {
      task: raw.task_id,
    })
  }
  if (raw.interface_contract_ref !== undefined && raw.interface_contract_ref !== null
    && (typeof raw.interface_contract_ref !== 'string' || raw.interface_contract_ref === '')) {
    fail('设计包的 interface_contract_ref 必须是非空字符串或省略', DESIGN_CODES.MALFORMED, {
      task: raw.task_id,
    })
  }
  // 需求换了版本、设计却还挂在旧版上，下游照旧版做出来的东西就没人能证明它符合新需求。
  // 这条核对是**引用级**的（内容寻址的 id 不等就是不等），不掺任何语义判断。
  if (typeof options.requirementId === 'string' && options.requirementId !== ''
    && raw.requirement_ref !== options.requirementId) {
    fail(
      `设计包推导自需求 ${raw.requirement_ref}，而本任务当前的需求是 ${options.requirementId}——`
      + '需求已经变过，这份设计不再是它的推导结果。',
      DESIGN_CODES.REQUIREMENT_MISMATCH,
      { task: raw.task_id, expected: options.requirementId, actual: raw.requirement_ref },
    )
  }

  const source = raw.artifacts !== null && typeof raw.artifacts === 'object' ? raw.artifacts : {}
  const missing = DESIGN_ARTIFACTS.filter((key) => source[key] === undefined || source[key] === null)
  if (missing.length > 0) {
    fail(
      `设计包缺少 ${missing.length} 份产物：${missing.join('、')}。`
      + '四份齐了才算一份设计——缺详设的架构推不出可以照着写的接口，缺架构的详设没有可以对照的边界。',
      DESIGN_CODES.INCOMPLETE,
      { task: raw.task_id, missing },
    )
  }
  const artifacts = {}
  for (const key of DESIGN_ARTIFACTS) {
    const artifact = source[key]
    if (artifact?.artifact !== key) {
      fail(`设计包的 ${key} 位上放的是 ${JSON.stringify(artifact?.artifact)}`, DESIGN_CODES.MALFORMED, {
        task: raw.task_id,
        expected: key,
      })
    }
    if (!artifactIntact(artifact)) {
      fail(
        `设计产物 ${key} 的正文与它报的引用对不上（${artifact.ref}）：正文被改过，`
        + '或者引用不是从这份正文算出来的。',
        DESIGN_CODES.ARTIFACT_MISMATCH,
        { task: raw.task_id, artifact: key },
      )
    }
    artifacts[key] = artifact
  }

  const traceability = []
  for (const entry of Array.isArray(raw.requirement_traceability) ? raw.requirement_traceability : []) {
    if (typeof entry?.criteria !== 'string' || entry.criteria === '') {
      fail('设计包的追溯项缺少 criteria', DESIGN_CODES.MALFORMED, { task: raw.task_id })
    }
    if (typeof entry?.artifact !== 'string' || !DESIGN_ARTIFACTS.includes(entry.artifact)) {
      fail(
        `设计包的追溯项 ${entry.criteria} 指向了不存在的产物 ${JSON.stringify(entry.artifact)}`,
        DESIGN_CODES.UNKNOWN_ARTIFACT,
        { task: raw.task_id, criteria: entry.criteria, artifact: entry.artifact },
      )
    }
    traceability.push(Object.freeze({ criteria: entry.criteria, artifact: entry.artifact }))
  }

  // 覆盖核对：给了验收标准就必须每一条都有归属。这是「设计是不是真从需求来的」唯一可机器判的部分，
  // 而它恰好是最要紧的部分——一条没有归属的验收标准，实现与验证都会漏掉它，且谁都不会察觉。
  const criteria = Array.isArray(options.criteria) ? options.criteria : undefined
  if (criteria !== undefined) {
    const covered = new Set(traceability.map((entry) => entry.criteria))
    const uncovered = criteria.filter((id) => !covered.has(id))
    if (uncovered.length > 0) {
      fail(
        `这些验收标准在设计里找不到归属：${uncovered.join('、')}。`
        + '设计必须逐条回答「这条验收标准由哪一部分负责」，否则实现与验证都会漏掉它。',
        DESIGN_CODES.TRACEABILITY_GAP,
        { task: raw.task_id, uncovered },
      )
    }
  }

  const unresolved = []
  for (const entry of Array.isArray(raw.unresolved_issues) ? raw.unresolved_issues : []) {
    const issue = typeof entry?.issue === 'string' ? entry.issue : ''
    const reason = typeof entry?.reason === 'string' ? entry.reason : ''
    if (issue === '' || reason === '') {
      fail(
        `未解决的问题必须写明是什么、以及为什么可以先不解决：${JSON.stringify(entry)}`,
        DESIGN_CODES.UNRESOLVED_ISSUES,
        { task: raw.task_id },
      )
    }
    unresolved.push(Object.freeze({ issue, reason }))
  }

  const interfaceContractRef = typeof raw.interface_contract_ref === 'string'
    ? raw.interface_contract_ref
    : null
  const conflicts = consistencyConflicts({ artifacts, interfaceContractRef, contractId: options.contractId })

  return Object.freeze({
    schema_version: 1,
    task_id: raw.task_id,
    requirement_ref: raw.requirement_ref,
    interface_contract_ref: interfaceContractRef,
    artifacts: Object.freeze(artifacts),
    requirement_traceability: Object.freeze(traceability),
    consistency_result: Object.freeze({
      ok: conflicts.length === 0,
      conflicts: Object.freeze(conflicts),
    }),
    unresolved_issues: Object.freeze(unresolved),
    frozen_at: options.frozenAt ?? 0,
  })
}

/**
 * 架构与详设之间的**确定性**一致性核对。
 *
 * 这里只放能被结构判定的东西。判不了的不进来：一条判不准的规则会比没有规则更糟——它会给一份
 * 其实不成立的设计盖上一个「已核对」的章。语义层面的一致性（详设有没有引入架构未声明的组件、
 * 测试设计是否真的独立于实现）交给独立设计复核。
 *
 * 现在能判的两条：
 * 1. 设计引用的契约必须**就是**本任务当前冻结的那一份（引用串了版，下游两边对不上）。
 * 2. 详设不得丢掉架构承诺过的验收标准（架构说「这部分负责 AC-3」，详设却完全不提，那就是漏了）。
 *
 * @param {object} input
 * @returns {string[]}
 */
function consistencyConflicts({ artifacts, interfaceContractRef, contractId }) {
  const conflicts = []
  if (typeof contractId === 'string' && contractId !== '' && interfaceContractRef !== contractId) {
    conflicts.push(
      `设计引用的是契约 ${JSON.stringify(interfaceContractRef)}，而本任务冻结的是 ${contractId}`,
    )
  }
  for (const [architecture, detail] of [
    ['software_architecture', 'software_detail'],
    ['test_architecture', 'test_detail'],
  ]) {
    const promised = new Set((artifacts[architecture]?.traceability ?? []).map((entry) => entry.criteria))
    const delivered = new Set((artifacts[detail]?.traceability ?? []).map((entry) => entry.criteria))
    for (const criteria of promised) {
      if (!delivered.has(criteria)) {
        conflicts.push(`${architecture} 承诺了 ${criteria}，而 ${detail} 里找不到它`)
      }
    }
  }
  return conflicts
}

/**
 * 设计包的内容寻址身份。
 *
 * `frozen_at` **不进身份**：同一份内容在不同时刻冻结两次，是同一份设计，不该因此变成两个版本。
 * 反过来，正文或追溯关系变一个字，身份就变——这正是「下游依据的是哪一版」可以被发现的原因。
 *
 * @param {Readonly<object>} pkg
 * @returns {string}
 */
export function designId(pkg) {
  const canonical = JSON.stringify([
    pkg?.task_id,
    pkg?.requirement_ref,
    pkg?.interface_contract_ref ?? null,
    DESIGN_ARTIFACTS.map((key) => [key, pkg?.artifacts?.[key]?.ref ?? null]),
    [...(pkg?.requirement_traceability ?? [])]
      .map((entry) => [entry.criteria, entry.artifact])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [...(pkg?.unresolved_issues ?? [])]
      .map((entry) => [entry.issue, entry.reason])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ])
  return `design-${digest(canonical)}`
}

/**
 * 两份设计包是否指向同一份设计。
 *
 * @param {Readonly<object>|undefined} left
 * @param {Readonly<object>|undefined} right
 * @returns {boolean}
 */
export function sameDesign(left, right) {
  if (left === undefined || right === undefined) return left === right
  return designId(left) === designId(right)
}

/**
 * 冻结一份设计包。
 *
 * 与 `freezeContract` 同一语义：没有旧的就冻结；同一份内容重复提交是 `unchanged`；换一份内容来覆盖
 * 是拒绝，要改必须显式删除重建并说明原因。拒绝覆盖不是洁癖——静默覆盖会让下游依据的那一版**悄悄
 * 变成另一版**，而下游的结论还挂在旧版上，且没有任何记录显示这件事发生过。
 *
 * @param {Readonly<object>} proposed
 * @param {Readonly<object>|undefined} existing
 * @returns {{status: 'frozen'|'unchanged', design?: Readonly<object>, id?: string}}
 * @throws {DesignError} 已冻结且内容不同。
 */
export function freezeDesign(proposed, existing) {
  const id = designId(proposed)
  if (existing === undefined || existing === null) {
    return { status: 'frozen', design: proposed, id }
  }
  const existingId = designId(existing)
  if (existingId === id) return { status: 'unchanged' }
  throw new DesignError(
    `设计已冻结（${existingId}），拒绝以另一份（${id}）覆盖。`
    + '若要修订，请显式删除它并说明原因——静默覆盖会让下游依据的那一版悄悄变成另一版，'
    + '而下游的结论仍挂在旧版上。',
    DESIGN_CODES.ALREADY_FROZEN,
    { expected: existingId, proposed: id },
  )
}

/**
 * 一份设计包是否具备冻结后的形状。
 *
 * @param {unknown} pkg
 * @returns {boolean}
 */
export function isFrozenDesign(pkg) {
  return pkg !== null && typeof pkg === 'object' && pkg.schema_version === 1
    && pkg.artifacts !== null && typeof pkg.artifacts === 'object'
}

/**
 * 校验一份设计包，返回**逐条**的违规，而不是一个布尔。
 *
 * 返回违规清单而不是抛错，是因为调用方要的不止「行不行」：门禁要把「缺什么」讲给模型听，审计要把
 * 「哪一条不成立」记下来。抛错只留得下一句话。
 *
 * @param {unknown} pkg
 * @param {object} [options]
 * @param {readonly string[]} [options.criteria]
 * @param {string} [options.contractId]
 * @param {string} [options.requirementId]
 * @returns {{ok: boolean, violations: object[], design_id: string|undefined}}
 */
export function evaluateDesignPackage(pkg, options = {}) {
  const violations = []
  if (!isFrozenDesign(pkg)) {
    return {
      ok: false,
      violations: [{ code: DESIGN_CODES.MALFORMED, detail: {} }],
      design_id: undefined,
    }
  }
  const missing = DESIGN_ARTIFACTS.filter((key) => pkg.artifacts[key] === undefined || pkg.artifacts[key] === null)
  if (missing.length > 0) {
    violations.push({ code: DESIGN_CODES.INCOMPLETE, detail: { missing } })
  }
  for (const key of DESIGN_ARTIFACTS) {
    const artifact = pkg.artifacts[key]
    if (artifact !== undefined && artifact !== null && !artifactIntact(artifact)) {
      violations.push({ code: DESIGN_CODES.ARTIFACT_MISMATCH, detail: { artifact: key } })
    }
  }
  const criteria = Array.isArray(options.criteria) ? options.criteria : undefined
  if (criteria !== undefined) {
    const covered = new Set((pkg.requirement_traceability ?? []).map((entry) => entry.criteria))
    const uncovered = criteria.filter((id) => !covered.has(id))
    if (uncovered.length > 0) {
      violations.push({ code: DESIGN_CODES.TRACEABILITY_GAP, detail: { uncovered } })
    }
  }
  if (typeof options.requirementId === 'string' && options.requirementId !== ''
    && pkg.requirement_ref !== options.requirementId) {
    violations.push({
      code: DESIGN_CODES.REQUIREMENT_MISMATCH,
      detail: { expected: options.requirementId, actual: pkg.requirement_ref ?? null },
    })
  }
  const unjustified = (pkg.unresolved_issues ?? [])
    .filter((entry) => typeof entry?.reason !== 'string' || entry.reason === '')
    .map((entry) => entry?.issue ?? '(未命名)')
  if (unjustified.length > 0) {
    violations.push({ code: DESIGN_CODES.UNRESOLVED_ISSUES, detail: { issues: unjustified } })
  }
  if (pkg.consistency_result?.ok === false) {
    violations.push({
      code: DESIGN_CODES.INCONSISTENT,
      detail: { conflicts: [...(pkg.consistency_result.conflicts ?? [])] },
    })
  }
  return { ok: violations.length === 0, violations, design_id: designId(pkg) }
}

/**
 * 主 Agent 对一份设计包的三种裁决。
 *
 * `escalated` 与 `revision_requested` 分开而不是合成一种「不批准」：前者是「这件事我不能定，要问
 * 用户」，后者是「专家改一版」。混成一种会让「还差一次修改」与「缺一个用户决策」在记录上无法区分，
 * 而它们下一步该做什么完全不同。
 */
export const DESIGN_DECISIONS = Object.freeze(['approved', 'revision_requested', 'escalated'])

/**
 * 校验并冻结一次设计裁决。
 *
 * 为什么裁决必须是一份**独立记录**而不是设计包上的一个字段：设计包一经冻结就拒绝覆盖（那是它的
 * 价值），而裁决会变——先请求修订、改完再批准。把会变的东西塞进不变的产物里，只有两条出路：要么
 * 破坏冻结语义，要么让「批准」变成一次无法记录的旁白。
 *
 * `reason` 三种裁决都必填：一次没有理由的批准与一次「看起来正常的 status」是同一个形状——它什么
 * 也没说，却让门禁看起来已经满足了。
 *
 * @param {unknown} raw - 形状 `{decision, reason?}`。
 * @param {object} [options]
 * @param {string} options.designId - 被裁决的那份设计包的身份，**由运行时给**。
 * @param {string} [options.sessionId] - 签发这次裁决的会话（主会话）。
 * @param {number} [options.at]
 * @returns {Readonly<object>}
 * @throws {DesignError}
 */
export function compileDesignApproval(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DesignError('设计裁决必须是一个对象', DESIGN_CODES.MALFORMED)
  }
  if (!DESIGN_DECISIONS.includes(raw.decision)) {
    throw new DesignError(
      `设计裁决只能是 ${DESIGN_DECISIONS.join('、')} 之一，收到 ${JSON.stringify(raw.decision)}`,
      DESIGN_CODES.MALFORMED,
      { decision: raw.decision ?? null },
    )
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') {
    throw new DesignError(
      '设计裁决必须写明 reason：批准要有批准的理由，请求修订要有具体改什么，'
      + '升级给用户要有为什么这件事不能由你定',
      DESIGN_CODES.MALFORMED,
      { decision: raw.decision },
    )
  }
  if (typeof options.designId !== 'string' || options.designId === '') {
    // 裁决必须挂在**某一份**设计上：不挂的批准会跟着设计一起漂到下一版去。
    throw new DesignError('设计裁决必须指名它裁决的是哪一份设计包', DESIGN_CODES.MALFORMED)
  }
  return Object.freeze({
    schema_version: 1,
    design_id: options.designId,
    decision: raw.decision,
    reason: raw.reason,
    decided_by_session_id: typeof options.sessionId === 'string' ? options.sessionId : null,
    decided_at: options.at ?? 0,
  })
}

/**
 * 核对一份设计裁决现在还算不算数。
 *
 * 两条判据缺一不可：**裁决必须存在**，且它**裁决的正是当前这一份**设计。第二条是这个函数存在的
 * 全部理由——设计被修订后身份就变了，而旧裁决仍然躺在盘上、字段齐全、看起来完全正常。不比对身份，
 * 「改完设计再直接开工」就是一条不需要任何人批准的路。
 *
 * @param {Readonly<object>|undefined} approval
 * @param {Readonly<object>|undefined} design
 * @returns {{ok: boolean, violations: object[]}}
 */
export function evaluateDesignApproval(approval, design) {
  if (approval === undefined || approval === null) {
    return {
      ok: false,
      violations: [{ code: DESIGN_CODES.NOT_APPROVED, detail: { reason: '还没有人对这份设计作出裁决' } }],
    }
  }
  if (design !== undefined && design !== null && approval.design_id !== designId(design)) {
    return {
      ok: false,
      violations: [{
        code: DESIGN_CODES.STALE_APPROVAL,
        detail: { approved: approval.design_id, current: designId(design) },
      }],
    }
  }
  if (approval.decision !== 'approved') {
    return {
      ok: false,
      violations: [{
        code: DESIGN_CODES.NOT_APPROVED,
        detail: { decision: approval.decision, reason: approval.reason ?? '' },
      }],
    }
  }
  return { ok: true, violations: [] }
}

/**
 * 深冻结一份设计包（含产物正文与追溯表）。
 *
 * 与 `deepFreezeContract` 分开而不是合成一个「冻结任意对象」的工具：这里要冻的是**已知形状**，
 * 一个通用深冻结会连调用方随手挂上去的调试字段一起冻住，而那种字段不该有资格进入契约。
 *
 * @param {object} pkg
 * @returns {Readonly<object>}
 */
export function deepFreezeDesign(pkg) {
  for (const key of DESIGN_ARTIFACTS) {
    const artifact = pkg?.artifacts?.[key]
    if (artifact !== undefined && artifact !== null) Object.freeze(artifact)
  }
  if (Array.isArray(pkg?.requirement_traceability)) Object.freeze(pkg.requirement_traceability)
  if (Array.isArray(pkg?.unresolved_issues)) Object.freeze(pkg.unresolved_issues)
  if (pkg?.consistency_result !== undefined) {
    if (Array.isArray(pkg.consistency_result.conflicts)) Object.freeze(pkg.consistency_result.conflicts)
    Object.freeze(pkg.consistency_result)
  }
  return Object.freeze(pkg)
}
