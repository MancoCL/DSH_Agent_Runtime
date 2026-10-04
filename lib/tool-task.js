/**
 * `gac_task` 工具：从真实会话驱动任务 DAG。
 *
 * @module dsh-gac-runtime/tool-task
 *
 * 这是把前面四个原语串成一条流程的那一步：执行模式决定要不要建任务，写范围与写声明
 * 管住谁能改哪些文件，协调器决定下一步做什么、结果能不能改状态，本工具负责把这几件
 * 事接上 DSH 的工具调用。
 *
 * 为什么「报告完成」必须带执行身份
 * --------------------------------
 * 协调器的核心保证是执行者不宣告完成——状态由显式迁移表推进，而迁移只在结果与当前
 * 执行对得上时才发生。落到工具层就是：报告结果必须带上 `dispatch_id`，也就是派遣时
 * 发给你的那个标识。没有它，模型只要说一句「做完了」，工具就会替它推进状态，
 * 那条保证在接口上就漏掉了。
 *
 * 为什么把下一次派遣合并进 `advance`
 * ----------------------------------
 * 派遣、报告、再派遣是同一个循环的三段，拆成三个工具会让模型有机会只做其中一段
 * （报告了却不派遣，或派遣了两次）。合并之后「推进一次」只有一种形状，也就没有
 * 「漏掉下一步」这种状态。
 */

import { applyResult, compileTask, dispatch, nextAction, reopen } from './coordinator.js'

/** 工具名，模型看到的就是这个。 */
export const TASK_TOOL_NAME = 'gac_task'

/** 本工具接受的动作闭集。 */
export const TASK_ACTIONS = Object.freeze(['create', 'advance', 'reopen', 'status', 'list'])

/**
 * 构造 `gac_task` 的编写参数。
 *
 * @param {object} deps
 * @param {(root: string) => import('./task-store.js').TaskStore|undefined} deps.taskStoreFor
 *   按项目根目录给出任务存储。任务记录按项目而不是按会话存放，所以必须先解析出根目录；
 *   解析不到时不假装有存储，而是明确告诉模型任务无法记录。
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @returns {object} 可直接交给运行时 `defineTool` 的参数。
 */
export function taskToolOptions({ taskStoreFor, sessionRootFor }) {
  /**
   * 为一次调用解析出该项目根上的任务存储。
   *
   * @param {object} exec
   * @returns {import('./task-store.js').TaskStore}
   */
  const storeFor = (exec) => {
    const sessionId = exec?.agent?.session?.id
    const root = typeof sessionId === 'string' ? sessionRootFor?.(sessionId) : undefined
    const store = root === undefined ? undefined : taskStoreFor?.(root)
    if (store === undefined) {
      throw new Error(
        'gac_task: 这个会话没有可解析的项目根目录，因此无法定位任务记录。'
        + '任务按项目存放，请在项目工作目录内的会话中使用本工具。',
      )
    }
    return store
  }

  return {
    name: TASK_TOOL_NAME,
    description:
      '创建并推进一张任务 DAG。用它来记录一个需要多步才能交付的需求：先 `create` '
      + '一份计划（节点、依赖、每个节点需要的能力、每个节点允许写哪些路径），然后用 '
      + '`advance` 反复推进——它会告诉你下一步该派遣哪些节点，并在你回报结果后决定状态'
      + '能不能变。'
      + '规则：**你不能宣告完成**。回报结果时必须带上派遣时发给你的 `dispatch_id`；'
      + '对不上的结果会被判为过期且不改变任何状态，因为上一次派遣的迟到结果不该改写当前'
      + '状态。已完成的节点是终态，迟到的结果动不了它，要重新打开必须用 `reopen` 并写明'
      + '原因。'
      + '`advance` 返回的 action 只有几种：`dispatch`（按 nodes 派遣，然后回报结果）、'
      + '`await`（等你自己派出的执行容器返回，这是内部等待，不是阻塞）、`blocked`（外部'
      + '条件不可用）、`repair`（节点失败，需修复后重派）、`complete_task`（可以收口了）、'
      + '`done`（任务已收口）。'
      + '并行不是由意愿决定的：两个节点会进同一批，仅当它们的依赖都已满足、写范围不相交、'
      + '且不共享独占资源；未进批的节点会给出原因。'
      + 'mode 用执行模式的分级：`standard_task`（普通 bugfix／feature，会有一个独立验证'
      + '节点）或 `high_risk_task`（安全、持久化、公共契约一类，另加验证计划与独立复核）。',
    parameters: {
      // 所有参数皆可选：运行时 DSL 不接受 `required: false`，省略该键才是「可选」。
      action: {
        type: 'string',
        enum: ['create', 'advance', 'reopen', 'status', 'list'],
        description:
          '要做的动作。`create` 建任务（需要 plan），`advance` 推进一轮（可选带 report），'
          + '`reopen` 重新打开一个节点（需要 node_id 与 reason），`status` 查看一个任务，'
          + '`list` 列出全部任务。省略时按 `status` 处理。',
      },
      task_id: {
        type: 'string',
        description: '任务标识。除 `list` 外都需要。',
      },
      mode: {
        type: 'string',
        description: '执行模式，用于 `create`。默认为 `standard_task`。',
      },
      plan: {
        type: 'object',
        // 运行时的 DSL 要求对象型参数显式声明 additionalProperties，否则 defineTool
        // 直接抛错、工具根本注册不上。
        additionalProperties: true,
        description:
          '任务计划，用于 `create`。形状：{ nodes: [{ id, objective, '
          + 'required_capabilities: [...], write_scope: [...], depends_on?: [...], '
          + 'resources?: [...], expected_artifacts?: [...] }] }。'
          + '`required_capabilities` 与 `write_scope` 都必须显式给出；没有能力意味着无法'
          + '路由，没有写范围意味着无法约束。验证类节点应给空的 write_scope。',
      },
      report: {
        type: 'object',
        additionalProperties: true,
        description:
          '结果回报，用于 `advance`。形状：{ node_id, dispatch_id, status: '
          + '"completed"|"failed"|"blocked", result_ref?, files_changed?, blocked_by? }。'
          + '`dispatch_id` 必须是派遣时给你的那个；`blocked_by` 为 { code, detail, '
          + 'attempts }，其中 attempts 记录已试过的办法——没试过不算阻塞。',
      },
      node_id: {
        type: 'string',
        description: '节点标识，用于 `reopen`。',
      },
      reason: {
        type: 'string',
        description: '重新打开节点的原因，用于 `reopen`，必填。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          task_id: { type: 'string' },
          status: { type: 'string' },
          nodes: { type: 'array', required: true, items: { type: 'string' } },
          message: { type: 'string', required: true },
          tasks: { type: 'array', required: true, items: { type: 'string' } },
          classifications: { type: 'array', required: true, items: { type: 'string' } },
          blockers: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    /**
     * @param {object} args
     * @param {{agent?: {session?: {id?: string}}}} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'status'
      // 先校验动作本身。否则一个拼错的动作会落到「找不到任务」那条分支上，把
      // 「动作不存在」误报成「任务不存在」——两个完全不同的问题，会把人引向错误的方向。
      if (!TASK_ACTIONS.includes(action)) {
        throw new Error(
          `gac_task: 未知动作 ${action}；可用动作为 ${TASK_ACTIONS.join('、')}`,
        )
      }
      const store = storeFor(exec)

      if (action === 'list') {
        const ids = store.list()
        const stray = store.unreadable.length
        return result({
          action,
          tasks: ids,
          message: ids.length === 0
            ? '当前项目还没有任务记录。'
            : `任务记录：${ids.join(', ')}。`
              + (stray > 0 ? ` 另有 ${stray} 个读不出来的文件，需要人工查看。` : ''),
        })
      }

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        throw new Error(`gac_task: 动作 ${action} 需要 task_id`)
      }
      const taskId = args.task_id

      if (action === 'create') {
        if (args.plan === null || typeof args.plan !== 'object' || Array.isArray(args.plan)) {
          throw new Error('gac_task: 动作 create 需要 plan 对象')
        }
        const task = compileTask({
          task_id: taskId,
          mode: typeof args.mode === 'string' && args.mode !== '' ? args.mode : 'standard_task',
          nodes: args.plan.nodes,
        })
        store.save(task, { create: true })
        const next = nextAction(task)
        return result({
          action: 'created',
          task_id: taskId,
          status: task.status,
          nodes: next.nodes ?? [],
          message:
            `任务 ${taskId} 已建立（模式 ${task.mode}，${task.nodes.size} 个节点）。`
            + `下一步：${describeAction(next, task)}`,
        })
      }

      const task = store.load(taskId)
      if (task === undefined) {
        throw new Error(
          `gac_task: 找不到任务 ${taskId}。若它从未建立，请先用 action "create" 建任务；`
          + '同 ID 拒绝覆盖，不要用已存在任务的 ID 另建新目标。',
        )
      }

      if (action === 'status') {
        const next = nextAction(task)
        return result({
          action: 'status',
          task_id: taskId,
          status: task.status,
          nodes: [...task.nodes.values()].map((node) => `${node.id}:${node.status}`),
          message:
            `任务 ${taskId}（模式 ${task.mode}，状态 ${task.status}）：`
            + `${[...task.nodes.values()].map((node) => `${node.id}=${node.status}`).join('，')}。`
            + `下一步：${describeAction(next, task)}`,
        })
      }

      if (action === 'reopen') {
        const reopened = reopen(task, args.node_id, args.reason)
        store.save(reopened)
        const next = nextAction(reopened)
        return result({
          action: 'reopened',
          task_id: taskId,
          status: reopened.status,
          nodes: [args.node_id],
          message:
            `节点 ${args.node_id} 已重新打开（原因：${args.reason}），其执行身份已作废，`
            + `下一次派遣会铸造新的。下一步：${describeAction(next, reopened)}`,
        })
      }

      if (action !== 'advance') {
        throw new Error(`gac_task: 未知动作 ${action}`)
      }
      // 先应用结果，再决定下一步——顺序反了会让「刚报告完成」的节点被重复派遣。
      let current = task
      const classifications = []
      let appliedNote = ''
      if (args.report !== null && typeof args.report === 'object' && !Array.isArray(args.report)) {
        const applied = applyResult(current, {
          node_id: args.report.node_id,
          dispatch_id: args.report.dispatch_id,
          status: args.report.status,
          result_ref: args.report.result_ref,
          files_changed: args.report.files_changed,
          blocked_by: args.report.blocked_by,
        })
        classifications.push(applied.classification)
        if (applied.classification === 'accepted') {
          current = applied.task
          appliedNote = `节点 ${args.report.node_id} 已转为 ${args.report.status}。`
        } else {
          appliedNote = `结果未被接受（${applied.classification}）：${applied.detail ?? '原因未说明'}。`
        }
      }

      const next = nextAction(current)
      if (next.action === 'dispatch') {
        current = dispatch(current, next.nodes)
      }
      store.save(current)

      return result({
        action: next.action,
        task_id: taskId,
        status: current.status,
        nodes: next.nodes ?? [],
        classifications,
        blockers: (next.blockers ?? []).map((blocker) => blocker.code),
        message: appliedNote + describeAction(next, current),
      })
    },
  }
}

/**
 * 组装统一形状的返回，避免每条分支各写一遍。
 *
 * @param {object} value
 * @returns {object}
 */
function result(value) {
  return {
    nodes: [],
    tasks: [],
    classifications: [],
    blockers: [],
    ...value,
  }
}

/**
 * 把下一步行动讲成一句可照做的事。
 *
 * 派遣时把节点、能力、写范围一并列出：模型据此派遣执行者，不需要回头再查一次计划，
 * 也就少一次「查错了计划」的机会。
 *
 * @param {object} next - {@link nextAction} 的结果。
 * @param {object} task
 * @returns {string}
 */
function describeAction(next, task) {
  switch (next.action) {
    case 'dispatch':
      return `派遣 ${next.nodes.map((id) => describeNode(task, id)).join('；')}，`
        + '各自完成后用 advance 回报结果并附上 dispatch_id。'
    case 'await':
      return `等待自己派出的 ${next.nodes.join('、')} 返回；这属于内部等待，不是外部阻塞。`
    case 'blocked':
      return `${next.nodes.join('、')} 处于阻塞；只有外部条件确实不可用才应保持这一状态，`
        + '并需在 blocked_by.attempts 里写明已试过的办法。'
    case 'repair':      return `${next.nodes.join('、')} 失败，需要修复后重新派遣（可选择先 reopen 说明原因）。`
    case 'complete_task':
      return '全部节点已完成，可以收口并汇报需求实施结果。'
    case 'done':
      return '任务已收口，无需继续推进。'
    default:
      return `${next.action}${next.reason === undefined ? '' : `：${next.reason}`}`
  }
}

/**
 * 描述一个节点，连同它的派遣依据。
 *
 * @param {object} task
 * @param {string} id
 * @returns {string}
 */
function describeNode(task, id) {
  const node = task.nodes.get(id)
  const scope = node.write_scope.length === 0
    ? '只回传报告、不写文件'
    : `可写 [${node.write_scope.join(', ')}]`
  return `${id}（${node.objective}；需要 ${node.required_capabilities.join('+')}；${scope}）`
}

/**
 * 构造可直接注册的 `gac_task` 工具定义。
 *
 * @param {object} deps
 * @param {(root: string) => import('./task-store.js').TaskStore|undefined} deps.taskStoreFor
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @param {(options: object) => object} deps.defineTool
 * @returns {object}
 */
export function createTaskTool({ taskStoreFor, sessionRootFor, defineTool }) {
  return defineTool(taskToolOptions({ taskStoreFor, sessionRootFor }))
}
