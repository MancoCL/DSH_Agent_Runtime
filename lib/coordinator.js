/**
 * 确定性协调器：任务 DAG、就绪判定与状态迁移。
 *
 * @module dsh-gac-runtime/coordinator
 *
 * 本模块承担架构大纲 §16 要求的「Coordinator 应主要由固定代码实现」。它是**纯逻辑**：
 * 不做 I/O、不认识 DSH、不调用模型。持久化与派发留给上层，因此这里每个决定都可以
 * 单元测试，也可以在没有运行时的机器上复现。
 *
 * 三条不可让步的规则
 * ------------------
 * 1. **执行者不宣告完成。** Agent 只报告结果；状态迁移由这里按显式迁移表决定
 *    （§44）。`applyResult` 不认识「我说做完了」这种输入，只认识结构化结果。
 * 2. **终态不因迟到结果改变。** `completed` 与 `superseded` 是终态，迟到的成功结果
 *    改不动它们；重新打开必须走显式 `reopen` 并写明原因（§44）。
 * 3. **并行由事实决定，不由意愿决定。** 两个节点能同批执行，必须同时满足：
 *    无依赖关系、写范围不相交、不共享独占资源（§18、§45）。「看起来独立」不算。
 *
 * 就绪判定为何要连写范围一起看
 * ----------------------------
 * 大纲 §45 把并发拆成三层：DAG 依赖管逻辑顺序，工作流并行管执行并发，写声明管跨会话
 * 物理碰撞。前两层在这里。第三层的跨会话部分在 lib/claim-store.js，但**同一任务内部**
 * 的两个节点撞同一批文件属于本层的问题：它们同属一个会话，不会互相抢声明。所以并行
 * 判定必须在本地就把写范围算清楚，否则同一任务的两个节点会同时改一个文件而不被任何
 * 一层拦住。
 *
 * 为什么失败节点的修复要换新执行身份
 * ----------------------------------
 * 每次派遣有唯一 attempt；重试与修复都产生新身份，不复用旧标识（大纲§「执行身份」）。
 * 复用身份会让一份迟到的旧结果看起来像当前执行的结果，从而篡改状态——这正是
 * attempt 单调递增要防的事。
 *
 * 写范围比较复用 lib/claims.js 的前缀语义，而不是在本模块里写第二份：两份实现一旦
 * 漂移，「调度时算作不相交」与「写声明时算作冲突」就会互相矛盾。
 */

import { findScopeOverlap } from './claims.js'

/** 节点状态。`completed` 为终态。 */
export const NODE_STATUSES = Object.freeze([
  'pending',
  'ready',
  'in_progress',
  'completed',
  'failed',
  'blocked',
])

/** 任务状态。`completed` 与 `superseded` 为终态。 */
export const TASK_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'approval_required',
  'failed',
  'superseded',
])

/**
 * 显式迁移表。`source→target` 不在表内即为非法迁移。
 *
 * `completed` 与 `superseded` 不出现在任何 source 位置，这让「终态不可被动摇」成为
 * 表结构本身的性质，而不是散落在各处的 if 判断。
 */
export const VALID_NODE_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['ready', 'blocked', 'failed']),
  ready: Object.freeze(['in_progress', 'pending', 'blocked', 'failed']),
  in_progress: Object.freeze(['completed', 'failed', 'blocked', 'pending']),
  blocked: Object.freeze(['pending', 'ready', 'failed']),
  failed: Object.freeze(['pending']),
  completed: Object.freeze([]),
})

/** 任务级迁移表，同样把终态钉死。 */
export const VALID_TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['in_progress', 'blocked', 'approval_required', 'superseded', 'failed']),
  in_progress: Object.freeze([
    'completed',
    'blocked',
    'approval_required',
    'failed',
    'superseded',
  ]),
  blocked: Object.freeze(['in_progress', 'failed', 'superseded', 'approval_required']),
  approval_required: Object.freeze(['in_progress', 'blocked', 'failed', 'superseded']),
  failed: Object.freeze(['in_progress', 'superseded']),
  completed: Object.freeze([]),
  superseded: Object.freeze([]),
})

/** 机器可分支的结构化错误码（大纲要求按 code 分支，而不是解析中文消息）。 */
export const COORDINATOR_CODES = Object.freeze({
  INVALID_DAG: 'GAC_INVALID_DAG',
  CYCLE: 'GAC_DAG_CYCLE',
  UNKNOWN_NODE: 'GAC_UNKNOWN_NODE',
  INVALID_TRANSITION: 'GAC_INVALID_TRANSITION',
  NO_WRITE_SCOPE: 'GAC_NODE_WRITE_SCOPE_MISSING',
  EMPTY_CAPABILITIES: 'GAC_NODE_CAPABILITIES_MISSING',
  STALE_RESULT: 'GAC_STALE_RESULT',
})

/**
 * 结构化协调器错误，携带稳定 `code`。
 */
export class CoordinatorError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'CoordinatorError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 把一条声明式计划编译成一份经过校验的任务。
 *
 * 校验在这里一次性做完，而不是散在后续每一步：一份有环、或节点能力为空、或写范围
 * 未声明的计划，越早拒绝越便宜——放到派遣时才发现，前面几步已经改过文件了。
 *
 * @param {object} plan
 * @param {string} plan.task_id
 * @param {string} plan.mode - 执行模式，取自执行风险判定。
 * @param {readonly object[]} plan.nodes
 * @returns {object} 冻结的任务对象。
 * @throws {CoordinatorError} 携带 {@link COORDINATOR_CODES}。
 */
export function compileTask(plan) {
  const fail = (message, code, detail) => {
    throw new CoordinatorError(message, code, detail)
  }

  if (typeof plan?.task_id !== 'string' || plan.task_id === '') {
    fail('任务缺少 task_id', COORDINATOR_CODES.INVALID_DAG)
  }
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    fail('任务至少需要一个节点', COORDINATOR_CODES.INVALID_DAG)
  }

  const nodes = new Map()
  for (const raw of plan.nodes) {
    for (const field of ['id', 'objective']) {
      if (typeof raw?.[field] !== 'string' || raw[field] === '') {
        fail(`节点缺少 ${field}`, COORDINATOR_CODES.INVALID_DAG, { node: raw?.id })
      }
    }
    if (nodes.has(raw.id)) {
      fail(`节点 id 重复：${raw.id}`, COORDINATOR_CODES.INVALID_DAG, { node: raw.id })
    }
    // 能力为空意味着「谁都能做」，那等于没有路由依据；大纲要求非空且取自项目词表。
    if (!Array.isArray(raw.required_capabilities) || raw.required_capabilities.length === 0) {
      fail(`节点 ${raw.id} 未声明 required_capabilities`, COORDINATOR_CODES.EMPTY_CAPABILITIES, {
        node: raw.id,
      })
    }
    // 写范围未声明与「声明为空」是两件事：前者是漏写，后者是明确不许写。
    if (!Array.isArray(raw.write_scope)) {
      fail(`节点 ${raw.id} 未声明 write_scope`, COORDINATOR_CODES.NO_WRITE_SCOPE, { node: raw.id })
    }
    nodes.set(raw.id, {
      id: raw.id,
      objective: raw.objective,
      depends_on: Object.freeze([...(raw.depends_on ?? [])]),
      required_capabilities: Object.freeze([...raw.required_capabilities]),
      write_scope: Object.freeze([...raw.write_scope]),
      resources: Object.freeze([...(raw.resources ?? [])]),
      expected_artifacts: Object.freeze([...(raw.expected_artifacts ?? [])]),
      status: 'pending',
      execution: Object.freeze({ attempt: 0, active_dispatch_id: null, last_result_ref: null }),
      // 计划冻结：一旦产出即不得由实现侧改写（大纲 §27）。
      frozen: raw.frozen === true,
    })
  }

  // 依赖必须存在，否则一份计划会静默地永远不满足。
  for (const node of nodes.values()) {
    for (const dependency of node.depends_on) {
      if (!nodes.has(dependency)) {
        fail(`节点 ${node.id} 依赖不存在的节点 ${dependency}`, COORDINATOR_CODES.INVALID_DAG, {
          node: node.id,
          dependency,
        })
      }
      if (dependency === node.id) {
        fail(`节点 ${node.id} 依赖自身`, COORDINATOR_CODES.CYCLE, { node: node.id })
      }
    }
  }

  const cycle = findCycle(nodes)
  if (cycle !== undefined) {
    fail(`任务 DAG 存在环：${cycle.join(' → ')}`, COORDINATOR_CODES.CYCLE, { cycle })
  }

  return Object.freeze({
    task_id: plan.task_id,
    mode: plan.mode ?? 'standard_task',
    status: 'pending',
    nodes,
    created_at: plan.created_at ?? 0,
  })
}

/**
 * 把任务序列化成可落盘的普通对象。
 *
 * 节点表是 Map，默认的 JSON 序列化会把它变成 `{}`——静默丢光全部节点。这正是
 * 需要一对显式转换函数、而不是 `JSON.stringify(task)` 的原因。
 *
 * `execution` 也在其中：丢掉它会让一个执行中的节点在恢复后 attempt 归零，于是
 * 一份迟到的旧结果会重新看起来像当前结果，而身份不复用正是为防这个。
 *
 * @param {object} task
 * @returns {object} 可 JSON 序列化的对象。
 */
export function serializeTask(task) {
  return {
    schema_version: 1,
    task_id: task.task_id,
    mode: task.mode,
    status: task.status,
    created_at: task.created_at,
    nodes: [...task.nodes.values()].map((node) => ({
      id: node.id,
      objective: node.objective,
      depends_on: [...node.depends_on],
      required_capabilities: [...node.required_capabilities],
      write_scope: [...node.write_scope],
      resources: [...node.resources],
      expected_artifacts: [...node.expected_artifacts],
      frozen: node.frozen === true,
      status: node.status,
      execution: { ...node.execution },
      ...(node.blocked_by ? { blocked_by: node.blocked_by } : {}),
      ...(node.reopen_reason === undefined ? {} : { reopen_reason: node.reopen_reason }),
    })),
  }
}

/**
 * 从落盘对象恢复任务，并重新跑一遍结构校验。
 *
 * 恢复路径必须与新建路径受同一套校验：一个手工改过的任务文件若能直接恢复，就等于
 * 有人可以绕过 `compileTask` 造出一个有环或能力为空的 DAG。所以这里借道
 * `compileTask` 重建骨架，再把保存的运行态（status、execution）贴回去——校验与恢复
 * 因此共用同一份判据，不会各自漂移。
 *
 * @param {unknown} raw
 * @param {string} [source] - 报错时指认来源文件。
 * @returns {object} 冻结的任务对象。
 * @throws {CoordinatorError} 结构非法，或运行态与状态表不自洽。
 */
export function deserializeTask(raw, source = '<memory>') {
  const fail = (message, code, detail) => {
    throw new CoordinatorError(`${source}：${message}`, code, detail)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('任务记录必须是一个对象', COORDINATOR_CODES.INVALID_DAG)
  }
  if (!Array.isArray(raw.nodes)) {
    fail('任务记录缺少 nodes 数组', COORDINATOR_CODES.INVALID_DAG)
  }

  const base = compileTask({
    task_id: raw.task_id,
    mode: raw.mode,
    created_at: raw.created_at,
    nodes: raw.nodes,
  })

  if (!TASK_STATUSES.includes(raw.status)) {
    fail(`未知任务状态 ${raw.status}`, COORDINATOR_CODES.INVALID_TRANSITION)
  }

  const nodes = new Map()
  for (const saved of raw.nodes) {
    const node = base.nodes.get(saved.id)
    if (!NODE_STATUSES.includes(saved.status)) {
      fail(`节点 ${saved.id} 的状态 ${saved.status} 不在闭集内`, COORDINATOR_CODES.INVALID_TRANSITION, {
        node: saved.id,
      })
    }
    const execution = {
      attempt: typeof saved.execution?.attempt === 'number' ? saved.execution.attempt : 0,
      active_dispatch_id: saved.execution?.active_dispatch_id ?? null,
      last_result_ref: saved.execution?.last_result_ref ?? null,
    }
    // 执行中却没有执行身份，说明这份记录被改坏了：下一份结果会因为身份对不上而被
    // 判 stale，节点将永远停在这里。宁可现在拒绝，也不要留下一个走不动的任务。
    if (saved.status === 'in_progress' && execution.active_dispatch_id === null) {
      fail(`节点 ${saved.id} 处于执行中却没有执行身份`, COORDINATOR_CODES.INVALID_TRANSITION, {
        node: saved.id,
      })
    }
    if (saved.status !== 'in_progress' && execution.active_dispatch_id !== null) {
      fail(`节点 ${saved.id} 未在执行却仍持有执行身份`, COORDINATOR_CODES.INVALID_TRANSITION, {
        node: saved.id,
      })
    }
    nodes.set(saved.id, {
      ...node,
      status: saved.status,
      execution,
      ...(saved.blocked_by ? { blocked_by: saved.blocked_by } : {}),
      ...(saved.reopen_reason === undefined ? {} : { reopen_reason: saved.reopen_reason }),
    })
  }

  return Object.freeze({
    task_id: base.task_id,
    mode: base.mode,
    status: raw.status,
    nodes,
    created_at: base.created_at,
  })
}

/**
 * 找出 DAG 中的环，供报错定位。
 *
 * @param {Map<string, object>} nodes
 * @returns {string[]|undefined} 环上的节点序列，无环时为 undefined。
 */
function findCycle(nodes) {
  const visiting = new Set()
  const done = new Set()
  const path = []

  /**
   * @param {string} id
   * @returns {boolean} 是否发现环。
   */
  const walk = (id) => {
    if (done.has(id)) return false
    if (visiting.has(id)) {
      path.push(id)
      return true
    }
    visiting.add(id)
    path.push(id)
    for (const dependency of nodes.get(id)?.depends_on ?? []) {
      if (walk(dependency)) return true
    }
    visiting.delete(id)
    path.pop()
    done.add(id)
    return false
  }

  for (const id of nodes.keys()) {
    if (walk(id)) return [...path]
  }
  return undefined
}

/**
 * 就绪判定：现在可以执行哪些节点。
 *
 * 一个节点就绪需要同时满足三件事（大纲 §18）：
 *   1. 所有依赖都已 `completed`；
 *   2. 写范围不与**本批已在执行**的节点相交；
 *   3. 不与其他就绪节点共享独占资源。
 *
 * 第 2、3 条决定了「同时就绪」与「同批执行」是两回事：返回的 `batch` 已经处理过
 * 互斥，而 `ready` 是全部满足依赖的节点，便于诊断为什么某个节点没进批。
 *
 * @param {object} task
 * @param {{isScopeOverlapping?: (a: readonly string[], b: readonly string[]) => boolean}} [options]
 * @returns {{ready: string[], batch: string[], reason: object}}
 */
export function resolveReady(task, options = {}) {
  const overlaps = options.isScopeOverlapping ?? scopesOverlap
  const nodes = task.nodes

  const ready = []
  for (const node of nodes.values()) {
    if (node.status !== 'pending') continue
    const unmet = node.depends_on.filter((dependency) => nodes.get(dependency)?.status !== 'completed')
    if (unmet.length === 0) ready.push(node.id)
  }

  // 已在执行的节点也要占住它们的资源与写范围，否则第二批会与第一批撞车。
  const inFlight = [...nodes.values()].filter((node) => node.status === 'in_progress')
  const heldScopes = inFlight.map((node) => node.write_scope)
  const heldResources = new Set(inFlight.flatMap((node) => node.resources))

  const batch = []
  const batchScopes = []
  const batchResources = new Set()
  const reason = {}

  // 依赖更深、声明更早的节点优先，让执行顺序稳定可复现——同一份计划两次调度
  // 应当给出同一个批次，否则「确定性协调器」名不副实。
  for (const id of ready) {
    const node = nodes.get(id)
    const conflict =
      heldScopes.find((scope) => overlaps(scope, node.write_scope))
      ?? batchScopes.find((scope) => overlaps(scope, node.write_scope))
    if (conflict !== undefined) {
      reason[id] = { code: 'write_scope_conflict', conflict }
      continue
    }
    const sharedResource = node.resources.find(
      (resource) => heldResources.has(resource) || batchResources.has(resource),
    )
    if (sharedResource !== undefined) {
      reason[id] = { code: 'exclusive_resource', resource: sharedResource }
      continue
    }
    batch.push(id)
    batchScopes.push(node.write_scope)
    for (const resource of node.resources) batchResources.add(resource)
  }

  return { ready, batch, reason }
}

/**
 * 两个写范围是否相交。委派给 claims 模块，保证同一套前缀语义。
 *
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {boolean}
 */
function scopesOverlap(left, right) {
  return findScopeOverlap(left, right).conflict
}

/**
 * 把一批节点标记为已派遣，并分配新的执行身份。
 *
 * `attempt` 单调递增，`dispatch_id` 带 attempt 后缀：重试与修复不复用旧标识，
 * 这样一份迟到的旧结果在身份上就不可能被当成当前结果。
 *
 * @param {object} task
 * @param {readonly string[]} nodeIds
 * @param {(nodeId: string, attempt: number) => string} [makeDispatchId]
 * @returns {object} 新的任务对象。
 * @throws {CoordinatorError}
 */
export function dispatch(task, nodeIds, makeDispatchId) {
  const next = cloneNodes(task)
  for (const id of nodeIds) {
    const node = next.get(id)
    if (node === undefined) {
      throw new CoordinatorError(`未知节点 ${id}`, COORDINATOR_CODES.UNKNOWN_NODE, { node: id })
    }
    if (node.status !== 'pending' && node.status !== 'ready') {
      throw new CoordinatorError(
        `节点 ${id} 当前状态为 ${node.status}，不可派遣`,
        COORDINATOR_CODES.INVALID_TRANSITION,
        { node: id, from: node.status },
      )
    }
    const attempt = node.execution.attempt + 1
    const dispatchId = makeDispatchId?.(id, attempt) ?? `${task.task_id}-${id}-A${attempt}`
    next.set(id, {
      ...node,
      status: 'in_progress',
      execution: { attempt, active_dispatch_id: dispatchId, last_result_ref: null },
    })
  }
  return withTask(task, { nodes: next, status: 'in_progress' })
}

/**
 * 应用一份结果，按显式迁移表推进状态。
 *
 * 本函数**不认识**「Agent 说完成了」。它只接受结构化结果，并且：
 *
 *  - 结果携带的 `dispatch_id` 与节点当前 active 执行不一致 → `stale`，不改状态；
 *  - 非法迁移 → `rejected`，不改状态；
 *  - `completed` 是终态，迟到结果改不动它。
 *
 * @param {object} task
 * @param {object} result
 * @param {string} result.node_id
 * @param {string} result.dispatch_id
 * @param {string} result.status - `completed` / `failed` / `blocked`。
 * @param {string} [result.result_ref]
 * @param {readonly string[]} [result.files_changed]
 * @param {{code: string, detail?: string}} [result.blocked_by]
 * @returns {{task: object, classification: 'accepted'|'stale'|'rejected', code?: string, detail?: string}}
 */
export function applyResult(task, result) {
  const node = task.nodes.get(result?.node_id)
  if (node === undefined) {
    return {
      task,
      classification: 'rejected',
      code: COORDINATOR_CODES.UNKNOWN_NODE,
      detail: `未知节点 ${result?.node_id}`,
    }
  }

  // 身份对齐先于迁移合法性：一份过期的结果即便迁移合法，也不该动状态。
  if (node.execution.active_dispatch_id !== result.dispatch_id) {
    return {
      task,
      classification: 'stale',
      code: COORDINATOR_CODES.STALE_RESULT,
      detail: `结果来自 ${result.dispatch_id}，节点当前执行为 `
        + `${node.execution.active_dispatch_id ?? '（无）'}`,
    }
  }

  const target = result.status
  const allowed = VALID_NODE_TRANSITIONS[node.status] ?? []
  if (!allowed.includes(target)) {
    return {
      task,
      classification: 'rejected',
      code: COORDINATOR_CODES.INVALID_TRANSITION,
      detail: `${node.status} → ${target} 不是合法迁移`,
    }
  }

  const next = cloneNodes(task)
  next.set(node.id, {
    ...node,
    status: target,
    blocked_by: target === 'blocked' ? result.blocked_by ?? null : null,
    execution: {
      ...node.execution,
      // 收口时清空 active 执行：留着它会让下一份结果被误判为 stale。
      active_dispatch_id: null,
      last_result_ref: result.result_ref ?? null,
    },
  })

  const taskStatus = deriveTaskStatus(task.status, next)
  return {
    task: withTask(task, { nodes: next, status: taskStatus }),
    classification: 'accepted',
  }
}

/**
 * 显式重新打开一个终态或失败节点，必须写明原因。
 *
 * 迟到的结果改不动终态，所以「重新打开」是一个需要理由的动作，而不是一次意外
 * 覆盖（大纲 §44）。
 *
 * @param {object} task
 * @param {string} nodeId
 * @param {string} reason
 * @returns {object} 新的任务对象。
 * @throws {CoordinatorError}
 */
export function reopen(task, nodeId, reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new CoordinatorError('重新打开节点必须写明原因', COORDINATOR_CODES.INVALID_TRANSITION, {
      node: nodeId,
    })
  }
  const node = task.nodes.get(nodeId)
  if (node === undefined) {
    throw new CoordinatorError(`未知节点 ${nodeId}`, COORDINATOR_CODES.UNKNOWN_NODE, { node: nodeId })
  }
  const next = cloneNodes(task)
  next.set(nodeId, {
    ...node,
    status: 'pending',
    blocked_by: null,
    reopen_reason: reason,
    execution: { ...node.execution, active_dispatch_id: null },
  })
  return withTask(task, { nodes: next, status: 'in_progress' })
}

/**
 * 完成判定：任务能否收口。
 *
 * 大纲 §43 要求同时满足：全部必要节点 completed、全部 AC 有通过证据、无阻塞评审、
 * 无未决审批。本函数只判定它**能**看到的部分——节点与评审——并把 AC 证据交给调用方
 * 补齐口径，避免这里对证据格式产生第二套理解。
 *
 * @param {object} task
 * @param {object} [evidence]
 * @param {boolean} [evidence.all_criteria_covered]
 * @param {boolean} [evidence.blocking_review_issue]
 * @param {boolean} [evidence.unresolved_approval]
 * @returns {{complete: boolean, blockers: object[]}}
 */
export function checkCompletion(task, evidence = {}) {
  const blockers = []
  for (const node of task.nodes.values()) {
    if (node.status !== 'completed') {
      blockers.push({
        code: 'node_not_completed',
        node: node.id,
        status: node.status,
      })
    }
  }
  if (evidence.all_criteria_covered === false) {
    blockers.push({ code: 'criteria_uncovered' })
  }
  if (evidence.blocking_review_issue === true) {
    blockers.push({ code: 'blocking_review_issue' })
  }
  if (evidence.unresolved_approval === true) {
    blockers.push({ code: 'unresolved_approval' })
  }
  return { complete: blockers.length === 0, blockers }
}

/**
 * 下一步行动：把「该做什么」收敛成一个决定，而不是留给模型临场判断。
 *
 * @param {object} task
 * @param {object} [evidence] - 传给 {@link checkCompletion} 的证据口径。
 * @returns {{action: string, nodes?: string[], reason?: string, blockers?: object[]}}
 */
export function nextAction(task, evidence = {}) {
  // `completed` 是唯一的终态任务状态，其余都要继续推进。
  if (task.status === 'completed') {
    return { action: 'done' }
  }
  const completion = checkCompletion(task, evidence)
  if (completion.complete) {
    return { action: 'complete_task' }
  }
  const { batch } = resolveReady(task)
  if (batch.length > 0) {
    return { action: 'dispatch', nodes: batch }
  }
  const inFlight = [...task.nodes.values()].filter((node) => node.status === 'in_progress')
  if (inFlight.length > 0) {
    // 等待自己派出的执行容器不是业务阻塞，不能写进 blocked_by。
    return { action: 'await', nodes: inFlight.map((node) => node.id) }
  }
  const blocked = [...task.nodes.values()].filter((node) => node.status === 'blocked')
  if (blocked.length > 0) {
    return { action: 'blocked', nodes: blocked.map((node) => node.id) }
  }
  const failed = [...task.nodes.values()].filter((node) => node.status === 'failed')
  if (failed.length > 0) {
    return { action: 'repair', nodes: failed.map((node) => node.id) }
  }
  // 走到这里说明状态表被外部改动过，而不是出现了某种「死锁」：经由本模块的公开
  // 操作，未完成的节点只可能是 pending / failed / blocked，前者要么进了批，要么
  // 依赖未满足。所以这里不假装诊断出病因，只如实报出还差哪些节点。
  return {
    action: 'stalled',
    nodes: [...task.nodes.values()]
      .filter((node) => node.status !== 'completed')
      .map((node) => node.id),
    reason: '没有可派遣节点，且无在飞、阻塞或失败节点；任务状态与节点状态不自洽',
  }
}

/**
 * 复制节点表，让每个决定都返回新对象而不是就地修改。
 *
 * 不可变更容易推理也容易测试：调用方拿到的旧任务不会被后续步骤悄悄改掉，
 * 「谁在什么时候改了状态」因此变得可追。
 *
 * @param {object} task
 * @returns {Map<string, object>}
 */
function cloneNodes(task) {
  return new Map([...task.nodes].map(([id, node]) => [id, { ...node }]))
}

/**
 * 组装新的任务对象。
 *
 * @param {object} task
 * @param {{nodes: Map<string, object>, status: string}} change
 * @returns {object}
 */
function withTask(task, change) {
  return Object.freeze({ ...task, nodes: change.nodes, status: change.status })
}

/**
 * 由节点状态推导任务状态。
 *
 * 只在「显然」的方向上自动推进：任一节点失败则任务失败，任一节点阻塞则任务阻塞，
 * 其余一律留在 `in_progress`。任务级的 `completed` 不在这里给——它必须经过
 * {@link checkCompletion} 的完整判定，否则「所有节点做完」会被误当成「需求达成」。
 *
 * @param {string} current
 * @param {Map<string, object>} nodes
 * @returns {string}
 */
function deriveTaskStatus(current, nodes) {
  if (current === 'completed' || current === 'superseded') return current
  const statuses = [...nodes.values()].map((node) => node.status)
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('in_progress')) return 'in_progress'
  return current === 'pending' ? 'pending' : 'in_progress'
}
