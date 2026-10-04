/**
 * GAC 事件：把运行时做了什么写进会话自己的事件日志。
 *
 * @module dsh-gac-runtime/gac-events
 *
 * 这一层加的是**可见性与审计**，不是新的权威状态
 * ------------------------------------------------
 * 大纲 §38–§39 想要的是「Current State = reduce(Session Events)」，不再维护「可变状态 + 历史
 * 状态」混合 JSON。实测下来这条**对任务状态不成立**：
 *
 *   - 会话是会话作用域的（`ctx.sessions` 自述为内存中的会话存储，持久化由另一个插件挂在每个
 *     会话的写句柄上），而**任务是工程作用域的**：同一个需求的多个节点会由不同执行者、在不同
 *     会话里推进。这正是任务记录当初按工程存放的原因。
 *   - 因此一个跨会话的任务，其历史分散在多个会话日志里，而**没有任何工程级的事件流或索引**
 *     能把它聚起来。
 *
 * 所以本模块做的是它真正做得到的事：把 GAC 的动作**追加进会话事件日志**，让「这个会话里发生
 * 过什么」在会话自己的持久化与重放路径上可见、可审计、可被投影成对话消息。任务状态的权威仍然
 * 是 `.dsh/gac/tasks/` 里的记录——它按工程存放，跨会话可读。
 *
 * 两件事都做、而不是二选一，是因为它们回答的是不同的问题：「这个任务现在到哪一步了」要跨会话
 * 才答得出，而「这个会话里都干了些什么」只有会话日志答得出。
 *
 * 为什么载荷要先校验
 * ------------------
 * 会话日志是**追加即不可改**的。往里面写进形状不对的载荷，那份错就永久留在历史里，而后续的
 * reduce 会在一个早已无法修正的地方读到它。因此事件在 append 之前先按各自的形状校验，宁可
 * 不写，也不写一条读不回来的。
 */

/** 结构化错误码。 */
export const GAC_EVENT_CODES = Object.freeze({
  MALFORMED: 'GAC_EVENT_MALFORMED',
  UNKNOWN_TYPE: 'GAC_EVENT_UNKNOWN_TYPE',
})

/**
 * 结构化事件错误。
 */
export class GacEventError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'GacEventError'
    this.code = code
    this.detail = detail
  }
}

/**
 * GAC 事件的闭集，以及每个事件的载荷形状。
 *
 * 形状用「字段名 → 期望类型」表示，校验只认这几种基本类型：会话日志只要求载荷可 JSON 序列化，
 * 因此校验的意义在于**形状正确**，而不是复刻一套类型系统。
 */
export const GAC_EVENT_SHAPES = Object.freeze({
  'gac/mode-declared': Object.freeze({
    task_id: 'string?',
    mode: 'string',
    declared_mode: 'string',
    escalated: 'boolean',
    risk: 'string',
  }),
  'gac/scope-declared': Object.freeze({
    task_id: 'string?',
    node_id: 'string?',
    scope: 'string[]',
    cleared: 'boolean?',
  }),
  'gac/task-created': Object.freeze({
    task_id: 'string',
    mode: 'string',
    project_id: 'string',
    node_count: 'number',
  }),
  'gac/requirement-frozen': Object.freeze({
    task_id: 'string',
    rounds: 'number',
    criteria: 'string[]',
  }),
  'gac/contract-frozen': Object.freeze({
    task_id: 'string',
    contract_id: 'string',
    operation_count: 'number',
  }),
  'gac/plan-registered': Object.freeze({
    task_id: 'string',
    plan_id: 'string',
    case_count: 'number',
    criteria: 'string[]',
  }),
  'gac/node-dispatched': Object.freeze({
    task_id: 'string',
    node_id: 'string',
    attempt: 'number',
    dispatch_id: 'string',
  }),
  'gac/node-reported': Object.freeze({
    task_id: 'string',
    node_id: 'string',
    status: 'string',
    classification: 'string',
  }),
  'gac/task-completed': Object.freeze({
    task_id: 'string',
    status: 'string',
  }),
  'gac/evidence-recorded': Object.freeze({
    evidence_id: 'string',
    tool: 'string',
    usable: 'boolean',
  }),
})

/** 事件类型名列表，供注册投影时逐项遍历。 */
export const GAC_EVENT_TYPES = Object.freeze(Object.keys(GAC_EVENT_SHAPES))

/**
 * 按声明的形状校验一个字段。
 *
 * @param {string} type
 * @param {string} field
 * @param {string} spec
 * @param {unknown} value
 */
function checkField(type, field, spec, value) {
  const optional = spec.endsWith('?')
  const kind = optional ? spec.slice(0, -1) : spec
  if (value === undefined) {
    if (!optional) {
      throw new GacEventError(
        `事件 ${type} 缺少字段 ${field}`,
        GAC_EVENT_CODES.MALFORMED,
        { type, field },
      )
    }
    return
  }
  const ok = kind === 'string[]'
    ? Array.isArray(value) && value.every((item) => typeof item === 'string')
    : kind === 'string' ? typeof value === 'string'
      : kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : kind === 'boolean' ? typeof value === 'boolean'
          : false
  if (!ok) {
    throw new GacEventError(
      `事件 ${type} 的字段 ${field} 应当是 ${kind}，收到 ${JSON.stringify(value)}`,
      GAC_EVENT_CODES.MALFORMED,
      { type, field },
    )
  }
}

/**
 * 校验并冻结一个事件的载荷。
 *
 * 不认识的字段一律拒绝，而不是放过：放过的字段会被写进不可改的历史，而它究竟是有意的扩展
 * 还是拼错了名字，事后无法分辨。
 *
 * @param {string} type
 * @param {object} data
 * @returns {Readonly<object>}
 * @throws {GacEventError}
 */
export function compileGacEvent(type, data) {
  const shape = GAC_EVENT_SHAPES[type]
  if (shape === undefined) {
    throw new GacEventError(
      `不是 GAC 事件类型：${type}`,
      GAC_EVENT_CODES.UNKNOWN_TYPE,
      { type },
    )
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new GacEventError(`事件 ${type} 的载荷必须是对象`, GAC_EVENT_CODES.MALFORMED, { type })
  }
  for (const [field, spec] of Object.entries(shape)) {
    checkField(type, field, spec, data[field])
  }
  const extra = Object.keys(data).filter((field) => !Object.hasOwn(shape, field))
  if (extra.length > 0) {
    throw new GacEventError(
      `事件 ${type} 带有未声明的字段：${extra.join(', ')}`,
      GAC_EVENT_CODES.MALFORMED,
      { type, extra },
    )
  }
  return Object.freeze({ ...data })
}

/**
 * 把一个会话事件日志里的 GAC 事件归约成一份视图。
 *
 * 这就是「重启后 reduce 出同一状态」的落点：同样的日志必然得出同样的结果，因为这里没有任何
 * 依赖当前时刻、依赖顺序之外的输入。
 *
 * 它归约的是**本会话**发生过的 GAC 动作。跨会话的任务状态不在这里——见模块开头的说明。
 *
 * @param {readonly Readonly<object>[]} events - 会话事件，形状为 { type, seq, time, data }。
 * @returns {object}
 */
export function reduceGacEvents(events) {
  const view = {
    mode: undefined,
    scopes: [],
    tasks: {},
    evidence: { count: 0, unusable: 0 },
    last_seq: undefined,
  }
  for (const event of events ?? []) {
    const type = event?.type
    if (typeof type !== 'string' || !type.startsWith('gac/')) continue
    const data = event.data ?? {}
    view.last_seq = event.seq
    switch (type) {
      case 'gac/mode-declared':
        view.mode = {
          mode: data.mode,
          declared_mode: data.declared_mode,
          escalated: data.escalated,
          risk: data.risk,
        }
        break
      case 'gac/scope-declared':
        // 清除声明也记一条：作用域是会话内的状态，只记声明不记清除，重放出来就会以为
        // 一个早已解除的作用域还在生效。
        view.scopes = data.cleared === true
          ? view.scopes.filter((entry) => entry.task_id !== data.task_id || entry.node_id !== data.node_id)
          : [...view.scopes, { task_id: data.task_id, node_id: data.node_id, scope: [...data.scope] }]
        break
      case 'gac/task-created':
        view.tasks[data.task_id] = {
          task_id: data.task_id,
          mode: data.mode,
          project_id: data.project_id,
          node_count: data.node_count,
          requirement: undefined,
          contract_id: undefined,
          plan_id: undefined,
          criteria: [],
          nodes: {},
          status: 'created',
        }
        break
      case 'gac/requirement-frozen': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) {
          task.requirement = { rounds: data.rounds, criteria: [...data.criteria] }
        }
        break
      }
      case 'gac/contract-frozen': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) {
          task.contract_id = data.contract_id
          task.contract_operations = data.operation_count
        }
        break
      }
      case 'gac/plan-registered': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) {
          task.plan_id = data.plan_id
          task.plan_cases = data.case_count
          task.criteria = [...data.criteria]
        }
        break
      }
      case 'gac/node-dispatched': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) {
          task.nodes[data.node_id] = {
            ...(task.nodes[data.node_id] ?? {}),
            node_id: data.node_id,
            attempt: data.attempt,
            dispatch_id: data.dispatch_id,
            status: 'in_progress',
          }
        }
        break
      }
      case 'gac/node-reported': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) {
          task.nodes[data.node_id] = {
            ...(task.nodes[data.node_id] ?? {}),
            node_id: data.node_id,
            status: data.status,
            classification: data.classification,
          }
        }
        break
      }
      case 'gac/task-completed': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) task.status = data.status
        break
      }
      case 'gac/evidence-recorded':
        view.evidence.count += 1
        if (data.usable === false) view.evidence.unusable += 1
        break
      default:
        // 未知的 gac/ 事件：忽略而不是抛错。日志里可能有比本版本更新的事件，
        // 让旧版本读不动新日志，会把升级变成一次数据丢失。
        break
    }
  }
  return view
}

/**
 * 造一个把 GAC 事件投影成对话消息的定义。
 *
 * 投影让 GAC 的动作出现在对话历史里，因此模型与用户都能看见「这个会话里 GAC 做了什么」，
 * 而不必去读日志文件。
 *
 * 消息形状必须完整
 * ----------------
 * `deriveEventMessage` 对投影返回的消息**不做任何校验**，直接交给 `deriveMessages()`。因此
 * 少写字段不会当场报错，而是让一个形状不全的消息流进对话——实测确认过这一点（源码里
 * `if (projected !== void 0) return projected;` 之后没有任何检查）。
 *
 * `MessageBase` 要求 `id` 与 `source`：
 *   - `id` 必须**跨次派生稳定**，否则同一条事件每次派生出的消息都是新身份，而消费方按 id
 *     索引时会认不出来。这里由事件序号推出，因此同一份日志必然得出同一个 id。
 *   - `source` 取自平台提供的词表。
 *
 * 一处必须说清的失真
 * ------------------
 * 平台的 `MessageSourceMap` 只有 user / model / tool / system-prompt 四种来源，**没有「运行时
 * 自己」这一格**。而投影产出的消息只能落在其中一种上，于是 GAC 的事件必然被归到别人名下。
 * 这里选 user，并在文本前缀 `[GAC]`，让它在对话里一眼可辨不是用户说的话。这是失真，不是
 * 等价物：把运行时的事件记成用户的话，读历史的人会以为那是用户说的。
 *
 * @param {string} type - GAC 事件类型。
 * @returns {{type: string, project: (event: object) => Map<number, object>}}
 */
export function createGacProjection(type) {
  if (!GAC_EVENT_TYPES.includes(type)) {
    throw new GacEventError(`不是 GAC 事件类型：${type}`, GAC_EVENT_CODES.UNKNOWN_TYPE, { type })
  }
  return {
    type,
    /**
     * @param {object} event
     * @returns {Map<number, object>}
     */
    project(event) {
      const text = describeGacEvent(event.type, event.data ?? {})
      // 讲不出话的事件不产出消息，而不是产出一条空消息：空消息会在对话里留下一段
      // 无法解释的空白。
      if (text === undefined) return new Map()
      return new Map([[event.seq, {
        id: `gac-msg-${event.seq}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      }]])
    },
  }
}

/**
 * 把一个事件讲成一句人能读的话。
 *
 * @param {string} type
 * @param {object} data
 * @returns {string|undefined}
 */
function describeGacEvent(type, data) {
  switch (type) {
    case 'gac/mode-declared':
      return `[GAC] 执行模式声明为 ${data.mode}（风险 ${data.risk}）`
        + `${data.escalated === true ? `，由 ${data.declared_mode} 升级而来` : ''}。`
    case 'gac/scope-declared':
      return data.cleared === true
        ? `[GAC] 写作用域已解除${data.task_id === undefined ? '' : `（任务 ${data.task_id}）`}。`
        : `[GAC] 写作用域已声明：${(data.scope ?? []).join(', ')}`
          + `${data.task_id === undefined ? '' : `（任务 ${data.task_id}）`}。`
    case 'gac/task-created':
      return `[GAC] 任务 ${data.task_id} 已建立（模式 ${data.mode}，${data.node_count} 个节点）。`
    case 'gac/requirement-frozen':
      return `[GAC] 任务 ${data.task_id} 的需求已冻结：${data.rounds} 轮访谈，`
        + `${(data.criteria ?? []).length} 条验收标准。`
    case 'gac/contract-frozen':
      return `[GAC] 任务 ${data.task_id} 的接口契约已冻结（${data.contract_id}，`
        + `${data.operation_count} 个操作）。`
    case 'gac/plan-registered':
      return `[GAC] 任务 ${data.task_id} 的验证计划已登记（${data.plan_id}，`
        + `${data.case_count} 个用例）。`
    case 'gac/node-dispatched':
      return `[GAC] 任务 ${data.task_id} 派遣节点 ${data.node_id}（第 ${data.attempt} 次尝试）。`
    case 'gac/node-reported':
      return `[GAC] 任务 ${data.task_id} 的节点 ${data.node_id} 回报为 ${data.status}`
        + `${data.classification === undefined ? '' : `（${data.classification}）`}。`
    case 'gac/task-completed':
      return `[GAC] 任务 ${data.task_id} 已收口。`
    case 'gac/evidence-recorded':
      return `[GAC] 记下一条证据 ${data.evidence_id}（${data.tool}）`
        + `${data.usable === false ? '，它不能充当通过凭据' : ''}。`
    default:
      return undefined
  }
}
