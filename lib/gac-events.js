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
 * 所以本模块做的是它真正做得到的事：把 GAC 的动作**追加进工程自己的事件文件**
 * （`.dsh/gac/events/events.jsonl`，见 `lib/gac-event-log.js`），让「这次调用改了什么、登记了什么」
 * 可审计、可追溯。任务状态的权威仍然是 `.dsh/gac/tasks/` 里的记录——它按工程存放，跨会话可读。
 *
 * 两件事都做、而不是二选一，是因为它们回答的是不同的问题：「这个任务现在到哪一步了」要跨会话
 * 才答得出，而「这次调用做了什么」只有事件文件答得出。
 *
 * **曾经这些事件写进会话日志并投影成对话消息，那是一条错路。** 会话日志的事件词表由宿主构建期
 * 生成，外部插件的类型不在其中，写进去会让整份日志被持久化层拒读（用户的历史因此打不开）。详见
 * `lib/gac-event-log.js` 的模块注释与 `docs/ADR-0001-子会话执行载体.md` §13。
 *
 * 为什么载荷要先校验
 * ------------------
 * 会话日志是**追加即不可改**的。往里面写进形状不对的载荷，那份错就永久留在历史里，而后续的
 * reduce 会在一个早已无法修正的地方读到它。因此事件在 append 之前先按各自的形状校验，宁可
 * 不写，也不写一条读不回来的。
 */

import { PROJECT_TOOL_NAME } from './tool-project.js'
import { SCOPE_TOOL_NAME } from './tool-scope.js'
import { TASK_TOOL_NAME } from './tool-task.js'

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
  'gac/review-registered': Object.freeze({
    task_id: 'string',
    review_id: 'string',
    blocking_issues: 'number',
    violations: 'number',
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
  // 子会话工具面：「设计节点看不到 read」这件事**必须可查**。只在内存里成立、事后无从证明的保证，
  // 与一句自我声明没有区别。这里记 Runtime 自己观测到的呈现面（`presented_tools`）与本次摘掉的
  // 名单（`removed_tools`）——它是「盲化由 Runtime 保证」的凭据，而不是子会话的自述。
  'gac/child-surface': Object.freeze({
    child_session_id: 'string',
    role: 'string',
    mode: 'string',
    presented_tools: 'string[]',
    removed_tools: 'string[]',
    local_agent: 'boolean',
  }),
  // 收权或守卫**没能**完整装上的情形：进程外 provider 拿不到 `localAgent`、`restrict` 抛错、或
  // 收权后名字仍在子会话视图里。如实记缺口，绝不把它写成成功。
  'gac/child-surface-gap': Object.freeze({
    child_session_id: 'string',
    role: 'string',
    code: 'string',
    reason: 'string',
  }),
})

/** 事件类型名列表：测试按它逐项核对每种事件都能译出形状合法的载荷。 */
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
 * 把一次 GAC 工具调用的结果翻译成要写进会话日志的事件。
 *
 * 为什么它住在这里，而不是住在入口里
 * --------------------------------
 * 这是**判断**，不是接线：哪些调用该记、每条事件从哪儿取事实，都是可以出错、也必须被断言的东西。
 * 它原先写在 `lib/index.js` 里，于是只能靠跑一次活的 harness 才验得到——而本仓库已经吃过同类的
 * 亏（`gac_metrics` 漏了 `output`，五个工具一个都没注册上，而当时单测全绿）。搬到这里之后，
 * 它和它写出的那套事件词表在同一个文件里，翻译结果能直接拿去 `compileGacEvent` 核对。
 *
 * 只翻译**确有其事**的东西，且事实从权威处取：
 *   - 「刚才发生了什么」取自工具返回里的 `action` 与 `transitions`（工具自己说的，不必猜）。
 *   - 「它登记了什么」取自盘上的记录（计划、契约、任务、复核），因为那些文件就是事实本身。
 *
 * 刻意**不**为了事件层去把工具的输出字段撑大：工具的输出是给模型看的接口，让接口为日志的
 * 方便而膨胀，是让下游的需要塑造上游的形状。反过来，也不从「下一步该做什么」去推断「刚才
 * 发生了什么」——会话日志追加即不可改，一条写错的事件会永久留在历史里。
 *
 * @param {string|undefined} toolName
 * @param {object|undefined} result - 工具的最终结果。
 * @param {object} context
 * @param {string} context.root
 * @param {(root: string) => import('./task-store.js').TaskStore} context.storeFor
 * @param {(root: string) => object|undefined} context.adapterFor
 * @returns {{type: string, data: object}[]}
 */
export function gacEventsFrom(toolName, result, context) {
  if (result?.isError === true) return []
  const value = result?.value
  if (value === null || typeof value !== 'object') return []

  if (toolName === PROJECT_TOOL_NAME) {
    if (typeof value.mode !== 'string') return []
    return [{
      type: 'gac/mode-declared',
      data: {
        mode: value.mode,
        declared_mode: typeof value.declared_mode === 'string' ? value.declared_mode : value.mode,
        escalated: value.escalated === true,
        risk: typeof value.risk === 'string' ? value.risk : 'unknown',
      },
    }]
  }

  if (toolName === SCOPE_TOOL_NAME) {
    if (!Array.isArray(value.scope)) return []
    return [{
      type: 'gac/scope-declared',
      data: {
        scope: value.scope,
        cleared: value.scope.length === 0,
        ...(typeof value.task_id === 'string' ? { task_id: value.task_id } : {}),
        ...(typeof value.node_id === 'string' ? { node_id: value.node_id } : {}),
      },
    }]
  }

  if (toolName !== TASK_TOOL_NAME) return []
  const taskId = typeof value.task_id === 'string' ? value.task_id : undefined
  if (taskId === undefined) return []
  const store = context.storeFor(context.root)
  const events = []

  if (value.action === 'created') {
    const task = store.load(taskId)
    const adapter = context.adapterFor(context.root)
    events.push({
      type: 'gac/task-created',
      data: {
        task_id: taskId,
        mode: task?.mode ?? 'unknown',
        project_id: adapter?.project?.id ?? '',
        node_count: task === undefined ? 0 : task.nodes.size,
      },
    })
  }

  if (value.action === 'planned') {
    const plan = store.loadPlan(taskId)
    if (plan !== undefined) {
      events.push({
        type: 'gac/plan-registered',
        data: {
          task_id: taskId,
          plan_id: typeof value.plan_id === 'string' ? value.plan_id : '',
          case_count: plan.cases.length,
          criteria: [...(plan.criteria ?? [])],
        },
      })
    }
  }

  if (value.action === 'contract_frozen') {
    const contract = store.loadContract(taskId)
    if (contract !== undefined) {
      events.push({
        type: 'gac/contract-frozen',
        data: {
          task_id: taskId,
          contract_id: typeof value.plan_id === 'string' ? value.plan_id : '',
          operation_count: contract.operations.length,
        },
      })
    }
  }

  if (value.action === 'requirement_frozen') {
    const grilling = store.loadGrilling(taskId)
    if (grilling !== undefined) {
      events.push({
        type: 'gac/requirement-frozen',
        data: {
          task_id: taskId,
          rounds: grilling.rounds.length,
          criteria: [...(grilling.acceptance_criteria ?? [])],
        },
      })
    }
  }

  if (value.action === 'reviewed') {
    // 阻塞问题数取自**盘上的那份报告**，不取自返回里的字面量：报告是复核者写下的产物，
    // 而返回里的字段是为模型阅读而生的接口——两者可以不同，日志该记的是前者。
    const report = store.loadReview(taskId)
    if (report !== undefined) {
      events.push({
        type: 'gac/review-registered',
        data: {
          task_id: taskId,
          review_id: typeof value.review_id === 'string' ? value.review_id : '',
          blocking_issues: Array.isArray(report.blocking_issues) ? report.blocking_issues.length : 0,
          // 命中几条门禁取自本次调用的回报：那是「刚才发生了什么」，而报告里没有这个数。
          violations: Array.isArray(value.blockers) ? value.blockers.length : 0,
        },
      })
    }
  }

  if (value.action === 'completed') {
    events.push({ type: 'gac/task-completed', data: { task_id: taskId, status: 'completed' } })
  }

  // 逐条迁移事件。这是 transitions 存在的理由：它精确说出本次派遣了谁、谁回报了什么。
  for (const transition of Array.isArray(value.transitions) ? value.transitions : []) {
    if (transition?.kind === 'dispatched') {
      events.push({
        type: 'gac/node-dispatched',
        data: {
          task_id: taskId,
          node_id: transition.node_id,
          attempt: typeof transition.attempt === 'number' ? transition.attempt : 0,
          dispatch_id: typeof transition.dispatch_id === 'string' ? transition.dispatch_id : '',
        },
      })
    }
    if (transition?.kind === 'reported') {
      events.push({
        type: 'gac/node-reported',
        data: {
          task_id: taskId,
          node_id: transition.node_id,
          status: typeof transition.status === 'string' ? transition.status : 'unknown',
          classification:
            typeof transition.classification === 'string' ? transition.classification : 'unknown',
        },
      })
    }
  }
  return events
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
          review: undefined,
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
      case 'gac/review-registered': {
        const task = view.tasks[data.task_id]
        if (task !== undefined) {
          task.review = {
            review_id: data.review_id,
            blocking_issues: data.blocking_issues,
            violations: data.violations,
          }
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
 * 这里原先有一个 `createGacProjection`：把 GAC 事件投影成对话消息，让人在历史里看见 GAC 做了什么。
 *
 * **已删除，而且不该被重新加回来。** 它与「把事件写进会话日志」是配套的，而那套做法踩了宿主的一条
 * 硬契约：会话日志的事件词表由宿主**构建期生成**（`KNOWN_SESSION_EVENT_TYPES`），外部插件的类型
 * 按构造就不在其中，而 `Session.append()` 又没有任何途径给事件打 `ignorable` 标记——写进去的那份
 * 日志会被持久化层整份拒读（`dsh-session-persistence` 的 `validateStoredEvents`），代价是**用户
 * 再也打不开那份会话历史**。实测：本工程含 GAC 事件的会话全部中招。
 *
 * 投影本身也不再有用：审计事件现在写在工程自己的 `.dsh/gac/events/events.jsonl`（见
 * `lib/gac-event-log.js`），会话日志只保留宿主自己的事件。
 */

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
    case 'gac/review-registered':
      return `[GAC] 任务 ${data.task_id} 的独立复核已登记（${data.review_id}）：`
        + `阻塞问题 ${data.blocking_issues} 个，收口门禁命中 ${data.violations} 条。`
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
