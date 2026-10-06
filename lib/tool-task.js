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

import { routeTask } from './capability-router.js'
import { contractId, compileContract, freezeContract } from './contract.js'
import { composeTaskAudit } from './task-audit.js'
import { applyResult, checkCompletion, compileTask, dispatch, nextAction, reopen } from './coordinator.js'
import { createEvidenceResolver } from './evidence.js'
import {
  freezeRequirement,
  proposeConvergence,
  recordRound,
  startGrilling,
  summarize,
} from './grilling.js'
import {
  VERIFICATION_CODES,
  compileVerificationPlan,
  evaluateVerification,
  freezePlan,
  planId,
} from './verification.js'
import {
  INDEPENDENCE_QUESTIONS,
  QUALITY_DIMENSIONS,
  REVIEW_CODES,
  compileReviewReport,
  evaluateReview,
  reviewId,
} from './review.js'

/** 工具名，模型看到的就是这个。 */
export const TASK_TOOL_NAME = 'gac_task'

/** 本工具接受的动作闭集。 */
export const TASK_ACTIONS = Object.freeze([
  'create',
  'grill',
  'contract',
  'plan',
  'advance',
  'reopen',
  'review',
  'status',
  'list',
  'complete',
  // 只读的审计视图：把这条链从已落盘的产物与追加日志里派生出来，不改任何状态。
  'audit',
])

/** 需要验证计划把关的执行模式。 */
export const MODES_REQUIRING_PLAN = Object.freeze(['high_risk_task'])

/**
 * 需要独立验证的能力。承载这些能力的节点必须来自实现侧之外。
 *
 * 词表是约定的最小集：项目可以扩展能力词表，但「验证」这件事的名字必须固定，否则
 * 「哪个节点是验证节点」会随项目而变，门禁就无从施加。
 */
export const VERIFICATION_CAPABILITIES = Object.freeze(['verification', 'review'])

/**
 * 路由失败时在路由表里占用的键。
 *
 * 路由失败不是某个节点的问题，而是整张表都不可用，所以它不能借用某个节点的 id——
 * 借用会让「表坏了」看起来像「这个节点没人能做」。
 */
const ROUTE_ERROR_KEY = '__route_error__'

/**
 * 构造 `gac_task` 的编写参数。
 *
 * @param {object} deps
 * @param {(root: string) => import('./task-store.js').TaskStore|undefined} deps.taskStoreFor
 *   按项目根目录给出任务存储。任务记录按项目而不是按会话存放，所以必须先解析出根目录；
 *   解析不到时不假装有存储，而是明确告诉模型任务无法记录。
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @param {(root: string) => readonly object[]} [deps.executorsFor]
 *   给出该工程根目录上可用的执行者列表。缺省时派遣只做登记、不真的去调——这种状态
 *   必须在返回里讲明，否则「已派遣」会被读成「已在跑」。
 * @param {(root: string) => object|undefined} [deps.adapterFor]
 *   给出项目适配器，用于按 `executors` 做能力路由。
 * @returns {object} 可直接交给运行时 `defineTool` 的参数。
 */
export function taskToolOptions({
  taskStoreFor,
  sessionRootFor,
  executorsFor,
  adapterFor,
  evidenceFor,
  eventLogFor,
  roleGuard,
}) {
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

  /**
   * 解析出本次调用的项目根目录。
   *
   * 与 `storeFor` 分开是因为派遣还要用根目录去找适配器与执行者：把根目录和存储混成
   * 一个返回值，会让「有存储」这件事看起来等于「能派遣」。
   *
   * @param {object} exec
   * @returns {string}
   */
  const rootFor = (exec) => {
    const sessionId = exec?.agent?.session?.id
    const root = typeof sessionId === 'string' ? sessionRootFor?.(sessionId) : undefined
    if (typeof root !== 'string' || root === '') {
      throw new Error(
        'gac_task: 这个会话没有可解析的项目根目录，因此无法定位任务记录与执行者。',
      )
    }
    return root
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
        enum: ['create', 'grill', 'contract', 'plan', 'advance', 'reopen', 'review', 'status', 'list', 'complete', 'audit'],
        description:
          '要做的动作，省略时按 `status` 处理。'
          + '`create` 建任务（需要 plan）；'
          + '`grill` 做需求访谈（需要 grill + round/confirmation）；'
          + '`contract` 冻结接口契约（需要 interface_contract，必须在动手之前）；'
          + '`plan` 登记验证计划（高风险任务在实现之前必须做，需要 verification_plan 与 '
          + 'criteria）；'
          + '`advance` 推进一轮（可选带 report）；'
          + '`reopen` 重新打开一个节点（需要 node_id 与 reason）；'
          + '`review` 登记独立复核报告（需要 review_report；六问与五个维度都要回答）；'
          + '`status` 查看一个任务；`list` 列出全部任务；'
          + '`complete` 收口（需要 evidence，且仅在全部节点完成、验收标准全覆盖、'
          + '无阻塞评审与未决审批时才被接受）；'
          + '`audit` 只读审计：把这条链从已落盘的产物与追加日志里派生出来，报出时间线与**缺口**'
          + '（缺什么、什么没冻、哪条引用的证据号不存在），不改任何状态。',
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
      evidence: {
        type: 'object',
        // 对象型参数不接受 enum（实测 defineTool 拒绝），所以键名写进描述里约束，
        // 而不是指望 schema 拦下拼错的键。
        additionalProperties: true,
        description:
          '收口证据：{ all_criteria_covered: boolean, blocking_review_issue?: boolean, '
          + 'unresolved_approval?: boolean, verification?: { plan_id, executions: [{ case_id, '
          + 'outcome, evidence_ref }] } }。'
          + '`all_criteria_covered` 必须如实填写：它是「每条验收标准都有通过证据」这一'
          + '判断的落点，而运行时看不到验收标准本身，只能由你据实申报。高危任务的 '
          + '`verification` 必须与已登记的验证计划对得上，且每条用例都要有各自的证据。'
          + '任一阻塞项为真时收口会被拒绝。',
      },
      verification_plan: {
        type: 'object',
        additionalProperties: true,
        description:
          '验证计划，用于 `plan`。形状：{ cases: [{ id, covers: [AC id], type: '
          + '"positive"|"falsification", expect?: string, expect_failure?: string }] }。'
          + '计划必须**在实现之前**从需求推导，不得读取实现或其测试；一经登记即冻结，'
          + '不得由实现侧改写。每条验收标准都要有一个正例**和一个反例**：正例证明对的能过，'
          + '反例证明错的会被抓住——只有正例无法区分「实现正确」与「断言太弱」。反例必须'
          + '写明 expect_failure，即什么样的错误实现应当被它抓住。',
      },
      criteria: {
        type: 'array',
        items: { type: 'string' },
        description:
          '本任务的验收标准 id 列表，用于 `plan` 与 `contract`。给出后当场核对覆盖，'
          + '缺哪条会立刻报出来，而不是等到收口时才发现。',
      },
      grill_action: {
        type: 'string',
        enum: ['record', 'converge', 'confirm', 'status'],
        description:
          '`grill` 的子动作，省略时按 `status` 处理。'
          + '`status` 查看已问过什么；`record` 记一轮（需要 round）；'
          + '`converge` 表示你认为问题已经问尽；'
          + '`confirm` 记录用户的确认原话并冻结需求（需要 confirmation）。'
          + '访谈是**多轮循环**：每轮记完再决定下一轮问什么，直到问尽——'
          + '一轮就问完的需求要么本来就很简单，要么有一批决策还没被发现。',
      },
      contract_action: {
        type: 'string',
        enum: ['freeze', 'status'],
        description:
          '`contract` 的子动作，省略时按 `status` 处理。'
          + '`freeze` 冻结接口契约（需要 interface_contract）；`status` 查看是否已冻结。',
      },
      round: {
        type: 'object',
        additionalProperties: true,
        description:
          '一轮访谈，用于 `grill` 的 `record`。形状：{ focus?: string, questions: [{ id, '
          + 'question, answer, resolves? }] }。'
          + '**问题由你提，答案必须是用户的真实答复**；用户说「不知道」也是一条答复，'
          + '但必须写下来——答案缺失与「用户说不知道」是两件事。'
          + '先用 `grill` 的 `status` 看已问过什么，再决定这一轮问什么。',
      },
      confirmation: {
        type: 'string',
        description:
          '用户确认需求可以动手了的**原话**，用于 `grill` 的 `confirm`。'
          + '这一步不能由你代替：模型会自信地认为自己问全了，'
          + '所以访谈只以用户确认结束，而不以你的自我评估结束。',
      },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: '由访谈收敛出的验收标准 id 列表，用于 `grill` 的 `confirm`。',
      },
      interface_contract: {
        type: 'object',
        additionalProperties: true,
        description:
          '接口契约，用于 `contract` 的 `freeze`。形状：{ name, non_goals?: [string], '
          + 'covers?: [AC id], operations: [{ name, signature, behavior, errors?: [string], '
          + 'covers?: [AC id] }] }。'
          + '**它必须在动手之前冻结**：功能代码与测试代码要并行编写，而测试作者在写测试'
          + '时并不知道实现长什么样——两边各自发明接口，测试就会因接口对不上而失败，'
          + '那是结构性失败、不是缺陷，测出来的结果没有信息量。'
          + '`behavior` 必须写清签名之外的行为约定：只有签名时「它返回什么」仍要靠猜，'
          + '而猜出来的期望正是两边对不上的地方。',
      },
      review_action: {
        type: 'string',
        enum: ['report', 'status'],
        description:
          '`review` 的子动作，省略时按 `status` 处理——**除非带了 review_report，那时按 '
          + '`report` 处理**。`report` 登记一份独立复核报告（需要 review_report）；'
          + '`status` 查看已登记的那一份。',
      },
      review_report: {
        type: 'object',
        additionalProperties: true,
        description:
          '独立复核报告，用于 `review` 的 `report`。形状：{ summary, evidence?: [证据引用], '
          + 'blocking_issues?: [string], engineering_quality: { ... }, '
          + 'verification_independence: { ... } }。'
          + '**六问与五个维度都必须回答**：`null` 与缺键都会被拒绝——未回答不是一个答案，'
          + '它无法被核对。答案的方向由你自己如实填写：方向反了会**如实地**被记下来，'
          + '并在收口时被拒（拒绝的是收口，不是这份记录），所以不要为了过关而改口。'
          + `验证独立性六问：${describeIndependenceQuestions()}。`
          + `工程质量逐维度（没有问题的维度也要写一句结论，写「无」即可）：${describeQualityDimensions()}。`
          + '`blocking_issues` 非空即不能收口；`evidence` 里引用的号必须是运行时发过的'
          + '（用 `gac_evidence` 查），且这里只核对签发，不要求那条证据是「通过」。',
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
          // 本次推进**实际发生了什么**。事件层据此写会话日志，因此它必须精确：从 `nodes`
          // （那是「下一步该做什么」）去猜「刚才派遣了谁」，会把事件写成一件没发生的事。
          transitions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          blockers: { type: 'array', required: true, items: { type: 'string' } },
          // 契约与验证计划的身份。`plan` 与 `contract` 两个动作都返回它——早先这里没有声明，
          // 于是运行时的输出校验以 `"value.plan_id" is not a declared property` 拒绝整次调用，
          // **登记验证计划与冻结契约在真实插件里根本做不成**，而单测全绿：测试用的是透传的
          // defineTool，不做输出校验。声明了什么就必须与真正返回什么一致。
          plan_id: { type: 'string' },
          // 复核报告的身份，只有 `review` 动作返回它。与 plan_id 分开而不是复用：两者是不同
          // 产物的身份，合用一个字段会让「这份报告对应哪份计划」在返回里无从表达。
          review_id: { type: 'string' },
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
      // 省略 action 时按 status 处理，但 `grill` 与 `contract` 本身也是动作，不带参数调用
      // 应当进入它们各自的 status，而不是被当成顶层 status 而只报任务状态。
      const action = typeof args.action === 'string' && args.action !== ''
        ? args.action
        : 'status'
      // 先校验动作本身。否则一个拼错的动作会落到「找不到任务」那条分支上，把
      // 「动作不存在」误报成「任务不存在」——两个完全不同的问题，会把人引向错误的方向。
      if (!TASK_ACTIONS.includes(action)) {
        throw new Error(
          `gac_task: 未知动作 ${action}；可用动作为 ${TASK_ACTIONS.join('、')}`,
        )
      }
      const store = storeFor(exec)
      const root = rootFor(exec)
      const sessionId = exec?.agent?.session?.id

      /**
       * 按「这个任务现在有哪些只读节点在飞」重算本会话的收权。
       *
       * 判据是节点**声明的写范围为空**，不是它的能力名：写范围是计划里唯一可核对的事实，而
       * 「这个节点算不算验证节点」是语义判断（适配计划 §4.2 的补强手段、E2E-6）。
       *
       * 重算而不是增量加减，是为了让状态只有一个来源：节点的真实状态。增量式地「派遣时加、
       * 回报时减」会漏掉 reopen、失败回报、插件重载这些路径，而漏掉的后果是这个会话再也写不了
       * 文件——「把自己关在门外」的同一个形状，只是这次关的是用户。
       *
       * @param {object} current - 本次调用结束时的任务状态。
       * @returns {void}
       */
      const syncRole = (current) => {
        if (roleGuard === undefined) return
        const readOnlyNodes = [...current.nodes.values()]
          .filter((node) => node.status === 'in_progress' && node.write_scope.length === 0)
          .map((node) => node.id)
        roleGuard.sync({
          sessionId,
          taskId: current.task_id,
          readOnlyNodes,
          // 项目可以声明连 shell 一起收回；默认不收，否则验证者没法执行计划用例留证据。
          includeShell: adapterFor?.(root)?.execution?.revoke_shell_for_read_only_roles === true,
          agent: exec?.agent,
        })
      }

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
          // 时间戳由工具层给：`compileTask` 的缺省是 `0`，而「这份任务是什么时候建的」是审计要答的
          // 问题之一。活体验收的复核报告如实记过这条缺口（`created_at: 0`）。
          created_at: Date.now(),
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
            // 顺序说准：`grill` 与 `contract` 都要求任务**已经存在**（它们写的是任务的属性），
            // 所以「先 grill 再 create」在工具层面根本走不通。活体验收里那轮父会话照着自己的
            // 理解先调 grill，连吃三次「找不到任务」，于是验收标准一个都没登记。
            + '接下来按需做这两件事（它们都作用于**已存在**的任务）：`grill` 冻结需求与验收标准、'
            + '`contract` 冻结接口契约。然后：'
            + `${describeAction(next, task)}`,
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

      if (action === 'audit') {
        // 只读：把这条链从**已经落盘的东西**里派生出来（任务记录、需求、契约、计划、验证报告、
        // 复核报告、运行时签发的证据号，加上那份只追加的审计日志）。不新增存储——真相已经在盘上，
        // 再来一份「审计存储」只会得到第二份会漂移的真相源。
        const adapter = adapterFor(root)
        const audit = composeTaskAudit({
          task,
          grilling: store.loadGrilling(taskId),
          contract: store.loadContract(taskId),
          plan: store.loadPlan(taskId),
          verification: store.loadVerification(taskId),
          review: store.loadReview(taskId),
          // 事件按任务筛：日志本身只有一串事件，没有「任务视图」。
          events: (eventLogFor(root)?.load() ?? []).filter((record) => record?.data?.task_id === taskId),
          issuedEvidence: (evidenceFor?.(root) ?? []).map((record) => record.id),
          planIdOf: planId,
          contractRequired: Array.isArray(adapter?.execution?.require_contract)
            && adapter.execution.require_contract.includes(task.mode),
          reviewRequired: needsReviewGate(task, store).length > 0,
        })
        return result({
          action: 'audit',
          task_id: taskId,
          status: task.status,
          ok: audit.ok,
          gaps: audit.gaps,
          artifacts: audit.artifacts,
          nodes: audit.nodes,
          timeline: audit.timeline,
          message: audit.text,
        })
      }

      if (action === 'grill') {
        const mode = typeof args.grill_action === 'string' && args.grill_action !== ''
          ? args.grill_action
          : 'status'
        let state = store.loadGrilling(taskId) ?? startGrilling({ task_id: taskId })

        if (mode === 'status') {
          const view = summarize(state)
          return result({
            action: 'grill_status',
            task_id: taskId,
            status: task.status,
            nodes: view.unresolved.map((entry) => entry.id),
            message: describeGrilling(view),
          })
        }

        if (mode === 'confirm') {
          // 传错参数名不该静默丢数据：`criteria` 是 `plan`/`contract` 的字段名，而冻结需求用的是
          // `acceptance_criteria`。第三轮活体验收里父会话正是传了 `criteria`，于是「2 条验收标准」
          // 变成了「0 条验收标准」——冻结照常成功，计划照常登记，直到复核时才以「覆盖 0 条验收标准」
          // 的面目浮出来，而那时需求已经冻结、改不回来了。宁可当场拒绝。
          const strayCriteria = Array.isArray(args.criteria) && args.criteria.length > 0
            && !Array.isArray(args.acceptance_criteria)
          if (strayCriteria) {
            throw new Error(
              'gac_task: 冻结需求用的是 `acceptance_criteria`，你传的是 `criteria`（那是 plan / contract '
              + '的字段名）。需求一旦冻结就改不回来，所以这里不猜你的意思——请用 `acceptance_criteria` '
              + '重传验收标准。',
            )
          }
          state = freezeRequirement(state, {
            confirmation: args.confirmation,
            acceptance_criteria: Array.isArray(args.acceptance_criteria)
              ? args.acceptance_criteria
              : [],
            // 同上：需求是**什么时候**冻的，是审计问题，不能留 `0`。
            now: Date.now(),
          })
          store.saveGrilling(taskId, state)
          return result({
            action: 'requirement_frozen',
            task_id: taskId,
            status: task.status,
            message:
              `任务 ${taskId} 的需求已冻结（${state.rounds.length} 轮访谈，`
              + `${(state.acceptance_criteria ?? []).length} 条验收标准）。`
              + '下一步：用 `contract` 冻结接口契约（若本任务声明了 require_contract），'
              + '再用 `plan` 登记验证计划，然后才能派遣写代码与写测试的节点。',
          })
        }

        // record 与 converge 都要先把状态读出来，且都不能在冻结之后追加。
        if (mode === 'converge') {
          state = proposeConvergence(state)
          store.saveGrilling(taskId, state)
          return result({
            action: 'convergence_proposed',
            task_id: taskId,
            status: task.status,
            message:
              `任务 ${taskId} 已提出收敛（${state.rounds.length} 轮访谈）。`
              + '这一步不结束访谈——请把问题与答复摘要呈给用户，'
              + '取得用户的确认原话后用 `grill` 的 `confirm` 冻结需求。'
              + '模型可以判断自己问得差不多了，但那个判断本身没有外部依据。',
          })
        }

        if (mode === 'record') {
          state = recordRound(state, { ...args.round, now: Date.now() })
          store.saveGrilling(taskId, state)
          const view = summarize(state)
          return result({
            action: 'round_recorded',
            task_id: taskId,
            status: task.status,
            nodes: view.unresolved.map((entry) => entry.id),
            message:
              `已记下第 ${view.rounds} 轮（累计 ${view.questions_asked} 问）。`
              + (view.unresolved.length === 0
                ? '目前没有悬而未决的问题。'
                : `其中 ${view.unresolved.length} 条答复属于「还不知道」：`
                  + `${view.unresolved.map((entry) => entry.id).join('、')}；`
                  + '这类答复是真实结论，但也意味着这里的决策还没定。')
              + '请据此决定下一轮问什么；问尽之后用 `converge` 提出收敛。',
          })
        }
        throw new Error(`gac_task: 未知的 grill 子动作 ${mode}；可用 record、converge、confirm、status`)
      }

      if (action === 'contract') {
        // 子动作从 `contract_action` 读，而不是 `contract`：后者是参数名之外的名字，
        // 早先按它读取时永远读到 undefined，于是 freeze 分支根本到不了——契约**永远**
        // 冻不上，而返回却是一个看起来正常的 status。
        const mode = typeof args.contract_action === 'string' && args.contract_action !== ''
          ? args.contract_action
          : 'status'
        if (mode === 'status') {
          const existing = store.loadContract(taskId)
          return result({
            action: 'contract_status',
            task_id: taskId,
            status: task.status,
            ...(existing === undefined ? {} : { plan_id: contractId(existing) }),
            message: existing === undefined
              ? `任务 ${taskId} 还没有冻结接口契约。`
              : `任务 ${taskId} 的接口契约已冻结（${contractId(existing)}，名字 ${existing.name}，`
                + `${existing.operations.length} 个操作）。`,
          })
        }
        if (mode !== 'freeze') {
          throw new Error(`gac_task: 未知的 contract 子动作 ${mode}；可用 freeze、status`)
        }
        const frozen = freezeContract(
          compileContract(args.interface_contract, {
            criteria: Array.isArray(args.criteria) ? args.criteria : undefined,
            frozenAt: Date.now(),
          }),
          store.loadContract(taskId),
        )
        if (frozen.status === 'frozen') store.saveContract(taskId, frozen.contract)
        return result({
          action: frozen.status === 'frozen' ? 'contract_frozen' : 'contract_unchanged',
          task_id: taskId,
          status: task.status,
          plan_id: frozen.id,
          message:
            `任务 ${taskId} 的接口契约已冻结（${frozen.id}，${frozen.contract.operations.length} `
            + '个操作）。功能代码与测试代码现在可以并行编写：两边都只依赖这份契约，'
            + '测试从契约与验收标准推导，实现从契约与方案推导，两条信息路径分离。',
        })
      }

      if (action === 'plan') {
        const criteria = Array.isArray(args.criteria) ? args.criteria : []
        const compiled = compileVerificationPlan(args.verification_plan, { criteria, frozenAt: Date.now() })
        const frozen = freezePlan(compiled)
        const id = planId(frozen)
        if (store.hasPlan(taskId)) {
          // 幂等：同一份计划重复登记不算错误。计划不同则说明有人在实现之后改了它，
          // 而那正是「计划一经冻结不得改写」要拦的事。
          const existing = planId(store.loadPlan(taskId))
          if (existing === id) {
            return result({
              action: 'plan_unchanged',
              task_id: taskId,
              status: task.status,
              plan_id: id,
              message: `任务 ${taskId} 的验证计划未变（${id}），未改写。`,
            })
          }
          throw new Error(
            `gac_task: 任务 ${taskId} 已有验证计划（${existing}），拒绝以另一份（${id}）覆盖。`
            + '计划必须在实现之前定稿；若确实需要修订，请显式删除该计划并说明原因，'
            + '而不是在实现之后悄悄改掉它。',
          )
        }
        store.savePlan(taskId, frozen)
        return result({
          action: 'planned',
          task_id: taskId,
          status: task.status,
          plan_id: id,
          message:
            `任务 ${taskId} 的验证计划已登记并冻结（${id}），共 ${frozen.cases.length} 个用例，`
            + `覆盖 ${criteria.length} 条验收标准。实现侧不得改写它；验证阶段请逐条执行，`
            + '并为每条用例留下各自的证据。',
        })
      }

      if (action === 'review') {
        // 子动作从 `review_action` 读，与 `contract` 同一个理由：按别的名字读会永远读到
        // undefined，于是 `report` 分支根本到不了，而返回看起来像一个正常的 status。
        //
        // 但这里多一条：**带了 review_report 就按 report 处理**。少写一个子动作而拿到一份
        // 「还没有复核报告」的 status，会让模型以为报告已经登记上了——一次静默的落空比一次
        // 明确的报错更难查。
        const mode = typeof args.review_action === 'string' && args.review_action !== ''
          ? args.review_action
          : (args.review_report === undefined ? 'status' : 'report')
        if (mode === 'status') {
          const existing = store.loadReview(taskId)
          return result({
            action: 'review_status',
            task_id: taskId,
            status: task.status,
            ...(existing === undefined ? {} : { review_id: reviewId(existing) }),
            message: existing === undefined
              ? `任务 ${taskId} 还没有独立复核报告。`
              + '收口前需要登记一份：六问与五个维度都要回答，答不了的要如实说。'
              : `任务 ${taskId} 的独立复核报告已登记（${reviewId(existing)}，`
                + `阻塞问题 ${existing.blocking_issues?.length ?? 0} 个）。`,
          })
        }
        if (mode !== 'report') {
          throw new Error(`gac_task: 未知的 review 子动作 ${mode}；可用 report、status`)
        }

        const compiled = compileReviewReport(args.review_report)
        const plan = store.loadPlan(taskId)
        const stamped = Object.freeze({
          ...compiled,
          task_id: taskId,
          // 计划身份由运行时盖上去，不由复核者自己写：能被调用方指定的字段就也能被填错。
          reviewed_plan_id: plan === undefined ? undefined : planId(plan),
          reviewed_at: Date.now(),
        })
        store.saveReview(taskId, stamped)
        const verdict = evaluateReview(stamped, {
          issuedEvidence: (evidenceFor?.(root) ?? []).map((record) => record.id),
        })
        return result({
          action: 'reviewed',
          task_id: taskId,
          status: task.status,
          review_id: reviewId(stamped),
          blockers: verdict.violations.map((violation) => violation.code),
          message: verdict.ok
            ? `任务 ${taskId} 的独立复核报告已登记（${reviewId(stamped)}）：六问齐备、`
              + `五个维度都有结论，收口时不会再因此被拦。`
            : `任务 ${taskId} 的独立复核报告已如实登记（${reviewId(stamped)}），`
              + `但它自己承认了下列问题，因此**收口会被拒**：`
              + `${verdict.violations.map(describeReviewViolation).join('；')}。`
              + '请先按这些结论把活儿修好，再重新复核一次（同一任务重新登记会覆盖上一份——'
              + '复核是对已完成的活儿的一次观察，后来的观察取代先前的观察）。',
        })
      }

      if (action === 'complete') {
        const evidence = args.evidence !== null && typeof args.evidence === 'object' && !Array.isArray(args.evidence)
          ? args.evidence
          : {}
        const completion = checkCompletion(task, {
          all_criteria_covered: evidence.all_criteria_covered === true,
          blocking_review_issue: evidence.blocking_review_issue === true,
          unresolved_approval: evidence.unresolved_approval === true,
        })
        if (completion.complete === false) {
          // 收口被拒时状态一个字节都不改：半个收口比没收口更难收拾。
          return result({
            action: 'complete_refused',
            task_id: taskId,
            status: task.status,
            blockers: completion.blockers.map((blocker) => blocker.code),
            message:
              `任务 ${taskId} 尚不能收口，原因：`
              + `${completion.blockers.map(describeBlocker).join('；')}。`
              + '状态未改动。',
          })
        }

        // 验证证据这一关的触发条件是「有冻结的验证计划」或「模式要求计划」，而不是只看模式。
        //
        // 只看模式会留下一个绕行口：一个 standard_task 只要登记了计划却不声明高风险，收口时
        // 就**完全不做证据核对**——于是计划的全部价值在终点被丢掉，而表面上一切正常。这条
        // 是走一遍真实需求时踩到的：REQ-EVIDENCE-LIST 有一份 20 用例的冻结计划，却以
        // all_criteria_covered: true 直接收口，一条证据都没引用。
        //
        // 判据改成「计划在不在」之后就与「契约门禁看有没有并行写入」同一个形状：门禁守的是
        // **它所守护的那件东西是否存在**，而不是某个与它相关的风险标签。
        const plan = store.loadPlan(taskId)
        const needsVerification = plan !== undefined || MODES_REQUIRING_PLAN.includes(task.mode)
        if (needsVerification) {
          if (plan === undefined) {
            return result({
              action: 'complete_refused',
              task_id: taskId,
              status: task.status,
              blockers: [VERIFICATION_CODES.PLAN_MISSING],
              message:
                `任务 ${taskId} 是 ${task.mode}，但没有登记验证计划，因此不能收口。`
                + '请在实现之前用 action "plan" 登记一份从需求推导的计划。状态未改动。',
            })
          }
          // 验证载荷优先取调用方交上来的那一份；**没交就用运行时自己登记的那一份**——验证子会话交回
          // 结论时已经落过一份验证报告（`settleVerificationReport`），父会话不该再解释一遍。这正是
          // 真实 `REQ-HR-1` 里缺的那一步：四个节点全 completed，而收口两次被拒，缺的就是这份载荷。
          const storedVerification = store.loadVerification(taskId)
          const verificationPayload = evidence.verification
            ?? (storedVerification === undefined
              ? undefined
              : { plan_id: storedVerification.plan_id, executions: storedVerification.executions })
          const verdict = evaluateVerification(
            verificationPayload ?? {},
            plan,
            Array.isArray(plan.criteria) ? plan.criteria : [],
            // 把运行时发出过的证据交给验证层核对：模型编的引用在这里过不去。
            {
              resolveEvidence: createEvidenceResolver(evidenceFor?.(root) ?? []),
            },
          )
          // 分清两件事：**没交验证载荷**与**交的载荷对不上计划**。此前两者共用 `PLAN_MUTATED`，
          // 于是「收口时根本没带 `verification`」被报成「报告对应的不是当前计划（报告写的是
          // undefined）」——活体验收实测到这一幕：计划其实没被改写（盘上身份核对是 matches），
          // 而拒因把读的人引向「有人改过计划」，排查方向直接跑偏。误报的代价与那句老话
          // 「一句不可解析会把排查引向错误方向」是同一类。
          const reportedPlanId = verificationPayload?.plan_id
          const payloadMissing = verificationPayload === undefined || reportedPlanId === undefined
          const identity = planId(plan) === reportedPlanId
          if (verdict.ok === false || identity === false) {
            const violations = [...verdict.violations]
            if (payloadMissing) {
              violations.unshift({
                code: VERIFICATION_CODES.PAYLOAD_MISSING,
                detail: { expected: planId(plan) },
              })
            } else if (identity === false) {
              violations.unshift({
                code: VERIFICATION_CODES.PLAN_MUTATED,
                detail: { expected: planId(plan), reported: reportedPlanId },
              })
            }
            return result({
              action: 'complete_refused',
              task_id: taskId,
              status: task.status,
              blockers: violations.map((violation) => violation.code),
              message:
                `任务 ${taskId} 的验证证据不齐，不能收口：`
                + `${violations.map(describeViolation).join('；')}。状态未改动。`,
            })
          }
        }

        // 独立复核这一关排在验证证据之后：一个连验证计划都还没有的任务，先要解决的不是「复核
        // 意见怎么填」。触发条件同样按**它所守护的东西**判——计划里有承载审查能力的节点，或这个
        // 模式要求一次独立复核；单看风险标签会留下「不声明那个标签就绕过去」的口子。
        const reviewGate = needsReviewGate(task)
        if (reviewGate.required) {
          const report = store.loadReview(taskId)
          if (report === undefined) {
            return result({
              action: 'complete_refused',
              task_id: taskId,
              status: task.status,
              blockers: [REVIEW_CODES.REPORT_MISSING],
              message:
                `任务 ${taskId} 还没有独立复核报告，因此不能收口：${reviewGate.reason}。`
                + '请用 action "review" 登记六问与五个质量维度；答不了的要如实说，'
                + '而如实说出来的问题会在收口时被拦下——那是这道门禁在起作用，'
                + '不是要把答案改口改掉。状态未改动。',
            })
          }
          const reviewVerdict = evaluateReview(report, {
            issuedEvidence: (evidenceFor?.(root) ?? []).map((record) => record.id),
          })
          const reviewViolations = [...reviewVerdict.violations]
          if (plan !== undefined && report.reviewed_plan_id !== planId(plan)) {
            // 报告对应的是另一份计划：它复核的那个东西已经不是现在这个了。
            reviewViolations.unshift({
              code: VERIFICATION_CODES.PLAN_MUTATED,
              detail: { expected: planId(plan), reported: report.reviewed_plan_id },
            })
          }
          if (reviewViolations.length > 0) {
            return result({
              action: 'complete_refused',
              task_id: taskId,
              status: task.status,
              blockers: reviewViolations.map((violation) => violation.code),
              message:
                `任务 ${taskId} 的独立复核未通过，不能收口：`
                + `${reviewViolations.map(describeReviewViolation).join('；')}。状态未改动。`,
            })
          }
        }

        const completed = Object.freeze({ ...task, status: 'completed' })
        store.save(completed)
        // 全部节点都不在飞了，收权随之解除——留在那儿就是让这个会话再也写不了文件。
        syncRole(completed)
        return result({
          action: 'completed',
          task_id: taskId,
          status: 'completed',
          message: `任务 ${taskId} 已收口。`,
        })
      }

      if (action === 'reopen') {
        const reopened = reopen(task, args.node_id, args.reason)
        store.save(reopened)
        // 重新打开会作废派遣身份，节点不再「在飞」——收权按新的状态重算。
        syncRole(reopened)
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
      // 本次推进**实际发生了什么**，逐条记下。事件层要据此写进会话日志，而它必须精确：
      // 从返回里的 `nodes`（那是「下一步该做什么」）去猜「刚才派遣了谁」，会把事件写成
      // 一件没发生的事。返回里没有的信息就不编，宁可让事件层少记一条。
      const transitions = []
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
        transitions.push({
          kind: 'reported',
          node_id: args.report.node_id,
          status: args.report.status,
          classification: applied.classification,
        })
        if (applied.classification === 'accepted') {
          current = applied.task
          appliedNote = `节点 ${args.report.node_id} 已转为 ${args.report.status}。`
        } else {
          appliedNote = `结果未被接受（${applied.classification}）：${applied.detail ?? '原因未说明'}。`
        }
      }

      const next = nextAction(current)
      const runNotes = []
      if (next.action === 'dispatch') {
        // 两道门禁都只拦下**一部分**节点，其余照常派遣。整批拦下会把「先出契约与计划、
        // 再实现」压成多步串行，丢掉本来可以并行的部分。
        //
        // 计划门禁：高风险任务必须先有验证计划，才能派遣承载验证能力的节点。放在这里而不是
        // 收口处，是因为计划的意义是「在实现之前从需求推导」——实现之后再补一份，它推导的
        // 已经是实现而不是需求。
        const needsPlan = needsPlanGate(current, next.nodes, store)
        const heldPlan = next.nodes.filter((id) => needsPlan.includes(id))
        const afterPlan = next.nodes.filter((id) => !needsPlan.includes(id))

        // 契约门禁：工程适配器声明了 require_contract 时，写文件的节点必须先有冻结的契约。
        // 放在派遣之前，是因为契约的意义是「在动手之前对齐」；实现做完再补，它对齐的是已经
        // 写好的两份代码，那时不一致已经发生。
        const needsContract = needsContractGate(current, afterPlan, adapterFor, root, store)
        const heldContract = afterPlan.filter((id) => needsContract.includes(id))
        const dispatchable = afterPlan.filter((id) => !needsContract.includes(id))

        if (dispatchable.length === 0) {
          if (afterPlan.length === 0) {
            return result({
              action: 'plan_required',
              task_id: taskId,
              status: current.status,
              nodes: heldPlan,
              message:
                `任务 ${taskId} 是 ${current.mode}，在这些节点被派遣之前必须先登记验证计划：`
                + `${heldPlan.join('、')}。请先用 action "plan" 提供 cases 与 criteria`
                + '（每条验收标准都要有正例和一个写明 expect_failure 的反例），'
                + '或在实现之前完成这一步，而不是在实现之后补。',
            })
          }
          return result({
            action: 'contract_required',
            task_id: taskId,
            status: current.status,
            nodes: heldContract,
            message:
              `任务 ${taskId} 在这些节点被派遣之前必须先冻结接口契约：${heldContract.join('、')}。`
              + `原因：${describeContractTrigger(current, heldContract, adapterFor, root)}。`
              + '请先用 action "contract" 的 "freeze" 冻结接口契约。'
              + '功能代码与测试代码要并行编写，而测试作者在写测试时并不知道实现长什么样——'
              + '两边各自发明接口，测试就会因接口对不上而失败，那是结构性失败、不是缺陷，'
              + '测出来的结果没有信息量。',
          })
        }
        if (heldPlan.length > 0) {
          runNotes.push(
            `（${heldPlan.join('、')} 因缺少验证计划而暂不派遣；请先用 action "plan" 登记计划。）`,
          )
        }
        if (heldContract.length > 0) {
          runNotes.push(
            `（${heldContract.join('、')} 因接口契约尚未冻结而暂不派遣；`
            + '请先用 action "contract" 的 "freeze" 冻结契约。）',
          )
        }
        return await dispatchAndInvoke(dispatchable)
      }
      store.save(current)
      // 回报之后重算收权：只读节点报完了，写入面就该回来。这一条与派遣那一条是同一段代码，
      // 因此不存在「加上了却忘了减」的路径。
      syncRole(current)

      // 本轮没有派遣（例如在等待、或已可收口）。返回的行动就是当前判定，不必再算一次——
      // 再算一次会把一个刚刚成立的状态说成下一步该做什么。
      return result({
        action: next.action,
        task_id: taskId,
        status: current.status,
        nodes: next.nodes ?? [],
        classifications,
        transitions,
        blockers: (next.blockers ?? []).map((blocker) => blocker.code),
        message: appliedNote + runNotes.join('') + describeAction(next, current),
      })

      /**
       * 派遣给定节点、逐个调用执行者，然后返回本轮结论。
       *
       * **一次 advance 只走一波，不把整条链跑完。** 这不是省事，而是设计：每一波之间调用者
       * 还在回路里，才能看到上一波的真实产出再决定下一步。一次跑完会让「实现」与「独立
       * 验证」挤进同一次调用，验证就看不成一个独立的观察了。
       *
       * 返回的 action 是**调用者下一步该做什么**：还有就绪节点时是 `dispatch`（再调一次
       * advance 它们就会跑），等待会话型执行者时是 `await`，全部完成时是 `complete_task`。
       * 因此 `dispatch` 的意思始终是「还有活儿可以推」，而不是「刚才那批已经被派遣了」。
       *
       * 抽成局部函数是因为「契约门禁」与「计划门禁」都要在拦下一部分节点之后照常派遣其余
       * 节点；两处各写一遍派遣与调用会很快走样。
       *
       * @param {readonly string[]} nodeIds
       * @returns {Promise<object>}
       */
      async function dispatchAndInvoke(nodeIds) {
        current = dispatch(current, nodeIds)
        for (const nodeId of nodeIds) {
          const node = current.nodes.get(nodeId)
          transitions.push({
            kind: 'dispatched',
            node_id: nodeId,
            attempt: node.execution.attempt,
            dispatch_id: node.execution.active_dispatch_id,
          })
        }
        const route = routeFor(current, root, adapterFor)
        // **同一批的节点要真的同时跑，而不是排着队跑。** 这里原先是一个 `for … await` 循环：协调器
        // 明明把两个写范围不相交的节点算进同一批（`resolveReady`），执行却是「等第一个跑完再起第二个」
        // ——那是一次**实现侧的伪并行**，而不是平台限制（原生子会话的 `start()` 返回一个带 `result`
        // 的 run，本来就允许同时持有多个）。现在先同时起，再按顺序收结果：启动重叠，而任务记录的写入
        // 仍然串行，保持确定性。
        const invocations = await Promise.all(nodeIds.map((nodeId) => invokeNode({
          task: current,
          nodeId,
          root,
          route,
          executors: executorsFor?.(root) ?? [],
          sessionId,
          agent: exec?.agent,
          store,
          evidenceFor,
        })))
        for (const [index, nodeId] of nodeIds.entries()) {
          const invocation = invocations[index]
          runNotes.push(invocation.note)
          if (invocation.status !== undefined) {
            const applied = applyResult(current, {
              node_id: nodeId,
              dispatch_id: current.nodes.get(nodeId).execution.active_dispatch_id,
              status: invocation.status,
              result_ref: invocation.artifact,
            })
            classifications.push(applied.classification)
            transitions.push({
              kind: 'reported',
              node_id: nodeId,
              status: invocation.status,
              classification: applied.classification,
            })
            if (applied.classification === 'accepted') current = applied.task
          }
        }
        store.save(current)
        const settledAfter = nextAction(current)
        // 派遣之后重算收权：只读节点刚被派给这个会话，它的写入面从此刻起就不该在。
        syncRole(current)
        return result({
          action: settledAfter.action,
          task_id: taskId,
          status: current.status,
          nodes: settledAfter.nodes ?? [],
          classifications,
          transitions,
          blockers: (settledAfter.blockers ?? []).map((blocker) => blocker.code),
          message: appliedNote + runNotes.join('') + describeAction(settledAfter, current)
            + describeDispatchIds(current, transitions),
        })
      }
    },
  }
}

/**
 * 把**仍在等回报**的派遣身份讲进返回文本里。
 *
 * 为什么它必须在文本里：模型读到的是渲染后的文本，而不是结构化产出。此前 `dispatch_id` 只出现在
 * `transitions` 里，于是「回报结果时必须带上派遣时发给你的 dispatch_id」这句要求，在工具这一侧
 * 是空的——活体验证里，子 agent 只能去读 `.dsh/gac/tasks/<id>.json` 才拿到那个 id。**一条要求
 * 模型回报它看不见的东西的规则，等于制造一次必然失败的回报。**
 *
 * 只列仍在 `in_progress` 的那些：进程内执行者当场就报完了，那些身份已经没用，列出来只是噪声。
 *
 * @param {object} task - 本次调用结束时的任务状态。
 * @param {readonly object[]} transitions - 本次调用累积的迁移记录。
 * @returns {string}
 */
function describeDispatchIds(task, transitions) {
  const entries = (Array.isArray(transitions) ? transitions : [])
    .filter((entry) => entry?.kind === 'dispatched'
      && typeof entry.dispatch_id === 'string' && entry.dispatch_id !== ''
      && task?.nodes?.get?.(entry.node_id)?.status === 'in_progress')
    .map((entry) => `${entry.node_id}=${entry.dispatch_id}`)
  return entries.length === 0 ? '' : `（等待回报的派遣身份：${entries.join('、')}）`
}

/**
 * 解析本次派遣可用的执行者。
 *
 * 按能力路由选执行者，且在选择之前就要求工程声明了执行者：没有声明时不要猜一个默认值，
 * 因为「谁来写代码」是工程决定，不是运行时该替它决定的事。
 *
 * @param {object} task
 * @param {string} root
 * @param {(root: string) => object|undefined} adapterFor
 * @returns {Map<string, {executor?: string, reason: string}>}
 */
function routeFor(task, root, adapterFor) {
  const adapter = adapterFor?.(root)
  const executors = adapter?.executors
  if (executors === undefined || Object.keys(executors).length === 0) {
    return new Map()
  }
  try {
    return routeTask(task, executors)
  } catch (error) {
    // 路由失败不是派遣失败：把原因留在返回里，让调用方看到「这个节点没法调度」，
    // 而不是让它看起来像执行者跑挂了。
    return new Map([[ROUTE_ERROR_KEY, { reason: error instanceof Error ? error.message : String(error) }]])
  }
}

/**
 * 真的调用一个节点的执行者，并把结果翻译成可迁移的状态。
 *
 * 「没有可用执行者」与「执行者说不出来」都如实返回，绝不伪造成完成：一次没跑起来的
 * 派遣，其结果是未知的，而未知既不是通过也不是失败。
 *
 * @param {object} input
 * @returns {Promise<{note: string, status?: string, artifact?: string}>}
 */
async function invokeNode({ task, nodeId, root, route, executors, sessionId, agent, store, evidenceFor }) {
  const node = task.nodes.get(nodeId)
  const dispatchId = node.execution.active_dispatch_id

  // route 是一张 Map：节点 id → 路由结果。早先这里把整张 Map 当成单个路由结果读
  // `.executor`，于是每次都读不到，所有节点都被报成「没有可承载的执行者」——而真实
  // 原因是取值方式错了。取值方式与构造方式是同一个契约，必须一致。
  if (route.has(ROUTE_ERROR_KEY)) {
    return {
      note: `节点 ${nodeId} 未能路由到执行者：${route.get(ROUTE_ERROR_KEY).reason} `,
    }
  }
  const routed = route.get(nodeId)
  if (routed === undefined || routed.executor === undefined) {
    return {
      note: `节点 ${nodeId} 未派遣：工程适配器没有可承载 `
        + `[${node.required_capabilities.join(', ')}] 的执行者。`
        + `${routed?.reason ?? '请在 .dsh/gac/project.json 的 executors 里声明。'} `,
    }
  }

  const executor = executors.find((candidate) => candidate.name === routed.executor)
    ?? executors.find((candidate) => candidate.supports(node))
  if (executor === undefined || executor.supports(node) === false) {
    // 路由选中的执行者承载不了这个节点（典型情形：节点要写文件，而进程内执行者没有
    // 写工具）。如实登记为「待会话执行」，而不是伪造一份没写任何文件的成功报告。
    return {
      note: `节点 ${nodeId} 已派遣给 ${routed.executor}，但它不能承载该节点`
        + `${node.write_scope.length === 0 ? '' : `（需要写入 [${node.write_scope.join(', ')}]）`}，`
        + '改用带工具的会话后请用 report 回报结果。 ',
    }
  }

  // 执行者抛错**不能**让整次 advance 变成一条裸 Error：那样节点会停在 pending、没有 dispatch_id、
  // 也没有失败记录，读的人无从知道「派遣试图发生过」。活体验收实测过这一幕（子会话的产出契约被
  // 宿主拒绝时，`advance` 只回一条 `Error: unsupported JSON schema: ...`，节点停在 pending）。
  // 执行者抛错就是**执行失败**，按失败登记，把原因留在返回里。
  let outcome
  try {
    outcome = await executor.run({
      node,
      task,
      root,
      dispatchId,
      sessionId,
      // 子会话需要一个**父 agent** 才能建起来（`SubagentStartRequest.parent`），而 `sessionId` 换不出
      // agent。交给执行者，而不是让它自己去猜一个——猜错会把子会话挂到不属于它的血缘上。
      agent,
      // 验收标准来自**需求侧**（冻结的访谈记录优先），而不是节点自己编：设计节点要用它推导方案，
      // 而方案要按它逐条覆盖（覆盖不足会被编译器拒）。派发时就把权威那一份交过去。
      criteria: acceptanceCriteriaFor(store, task),
      signal: new AbortController().signal,
    })
  } catch (error) {
    return {
      note: `节点 ${nodeId} 的执行者 ${executor.name} 抛错：`
        + `${error instanceof Error ? error.message : String(error)} `,
      status: 'failed',
    }
  }

  if (outcome.status === 'in_progress') {
    return { note: `节点 ${nodeId}：${outcome.summary} ` }
  }
  if (outcome.status === 'blocked') {
    return {
      note: `节点 ${nodeId} 未能执行：${outcome.summary} `,
      status: 'blocked',
    }
  }
  // 语义产物落盘：按角色分派（设计 → 冻结计划；验证执行 → 登记验证报告；复核 → 登记复核报告）。
  //
  // **校验失败就把节点判成失败**，而不是「完成了但产物无效」：交不出合法产物，就是没做完。
  const settled = settleSemanticArtifacts({ task, node, outcome, store, evidenceFor, root })
  return {
    // 执行者给的可追溯信息（例如子会话 id 与产物清单）要进**返回文本**：模型看不到结构化产出，而
    // 「这次是谁干的」正是它之后要据以行动的东西。没有 `detail` 的执行者（进程内、会话型）行为不变。
    //
    // 措辞按结论分开：失败节点在返回里被写成「执行完成」是同一类误导——读的人第一句就得到相反的
    // 结论。活体验收里那句「节点 T1 由 child:spawn 执行完成。 T1 失败…」正是这样自相矛盾的。
    note: `节点 ${nodeId} 由 ${executor.name}`
      + `${settled.status === 'completed' ? '执行完成' : `执行结束（结论 ${settled.status}）`}。`
      + `${outcome.detail === undefined ? '' : `${outcome.detail}。`}`
      + `${settled.note === undefined ? '' : `${settled.note} `}`,
    status: settled.status,
    artifact: outcome.artifact,
  }
}

/**
 * 按角色把子会话交回来的语义产物落盘。
 *
 * 这一层是「子会话负责产生认知结果、运行时负责校验与持久化」的落点：执行者只运输（`semantic`），
 * 校验与落盘在这里，因为只有这里同时握着任务存储、门禁与证据日志。
 *
 * @param {object} input
 * @param {object} input.task
 * @param {object} input.node
 * @param {object} input.outcome
 * @param {import('./task-store.js').TaskStore} input.store
 * @param {(root: string) => readonly object[]|undefined} [input.evidenceFor]
 * @param {string} [input.root]
 * @returns {{status: string, note?: string}}
 */
function settleSemanticArtifacts({ task, node, outcome, store, evidenceFor, root }) {
  const role = outcome?.semantic?.role
  if (role === 'verification_design') return settleDesignPlan({ task, node, outcome, store })
  if (role === 'verification_execution') {
    return settleVerificationReport({ task, node, outcome, store, evidenceFor, root })
  }
  if (role === 'review') return settleReviewReport({ task, outcome, store, evidenceFor, root })
  return { status: outcome.status }
}

/**
 * 把验证执行节点交回来的逐条结论登记成一份**验证报告**。
 *
 * 证据引用由运行时解析：子会话报的是 `self:<n>`（它本会话第 n 次工具调用），运行时拿那个序号去
 * **自己签发的**证据日志里取出真实号。这样做的理由在 ADR §12 里定过：既不把 `gac_evidence` 这种
 * 父会话协调工具重新暴露给子会话，也不必给子会话注入一份它自己还没产生的清单——它数得清自己调用了
 * 几次，而「这个号是不是运行时发过的」只有运行时知道。
 *
 * 解析不出来就**不登记**：这条用例缺证据，收口门禁会拒。伪造一份引用放过去，比拒绝更糟。
 *
 * @param {object} input
 * @returns {{status: string, note?: string}}
 */
function settleVerificationReport({ task, node, outcome, store, evidenceFor, root }) {
  if (outcome.status !== 'completed') return { status: outcome.status }
  const payload = outcome.semantic?.payload
  const plan = store.loadPlan(task.task_id)
  if (plan === undefined) {
    return { status: 'failed', note: '本任务还没有冻结的验证计划，无法登记验证报告。' }
  }
  const sessionId = outcome.semantic?.child_session_id
  const issued = typeof evidenceFor === 'function' && typeof root === 'string'
    ? (evidenceFor(root) ?? [])
    : []
  const ownEvidence = issued.filter((record) => record.session_id === sessionId)

  const executions = []
  const unresolved = []
  for (const entry of Array.isArray(payload?.executions) ? payload.executions : []) {
    const resolved = resolveEvidenceRef(entry?.evidence_ref, ownEvidence)
    if (resolved === undefined) {
      unresolved.push(`${entry?.case_id ?? '(未命名用例)'}（引用 ${JSON.stringify(entry?.evidence_ref)}）`)
      continue
    }
    executions.push({
      case_id: entry?.case_id,
      outcome: entry?.outcome,
      evidence_ref: resolved,
    })
  }
  if (unresolved.length > 0) {
    return {
      status: 'failed',
      note: `这些用例的证据引用解析不到运行时签发过的号：${unresolved.join('、')}。`
        + '`self:<n>` 里的 n 必须是你本会话第 n 次工具调用的序号（从 1 开始）。',
    }
  }

  const report = { plan_id: payload?.plan_id, executions }
  // **身份先核对**：报告对应的必须是当前那份冻结计划。收口门禁也查这一条，但晚一步——在这里查，
  // 节点会当场判失败并说清缺什么，而不是等到收口时才被拒（活体验收里那次「报告写的是 undefined」
  // 就是这样一路滑到收口的）。
  const expectedPlanId = planId(plan)
  if (report.plan_id !== expectedPlanId) {
    return {
      status: 'failed',
      note: `验证报告对不上当前计划：期望 ${expectedPlanId}，报告写的是 `
        + `${JSON.stringify(report.plan_id)}。计划 id 在派发时已经交给你，照抄即可。`,
    }
  }
  // 与收口门禁**共用同一套校验**：这条报告在这里被拒，收口时也会被拒——两处不会各自漂移。
  const verdict = evaluateVerification(report, plan, acceptanceCriteriaFor(store, task), {
    resolveEvidence: createEvidenceResolver(issued),
  })
  if (verdict.ok === false) {
    return {
      status: 'failed',
      note: `验证报告被拒：${verdict.violations.map(describeViolation).join('；')}。`,
    }
  }
  const stamped = Object.freeze({
    ...report,
    schema_version: 1,
    source_session_id: sessionId,
    verified_at: Date.now(),
  })
  store.saveVerification(task.task_id, stamped)
  return { status: 'completed', note: `已登记验证报告（${executions.length} 条用例，计划 ${report.plan_id}）。` }
}

/**
 * 把复核节点交回来的报告登记成一份**复核报告**。
 *
 * 登记只做 `compileReviewReport`（未作答会被拒），方向自反与阻塞问题留给收口门禁——与 `gac_task`
 * 的 `review` 动作同一套语义：一份如实记录「验证方法有洞」的报告是有价值的事实，拒绝记录它只会
 * 让人把洞藏起来。
 *
 * `reviewed_plan_id` 由**运行时**盖：那是「登记这一刻的冻结计划是哪个」这一可观察事实，
 * 不该让复核者自报（能观察的事实不交给自报，见适配计划 §23）。
 *
 * @param {object} input
 * @returns {{status: string, note?: string}}
 */
function settleReviewReport({ task, outcome, store, evidenceFor, root }) {
  if (outcome.status !== 'completed') return { status: outcome.status }
  try {
    const payload = reviewReportFields(outcome.semantic?.payload)
    // **复核的引用也要解析 `self:<n>`**：提示词给复核者的写法与验证者同源（它同样看不到运行时
    // 签发的号），而收口门禁会拿 `evidence` 里的字符串逐字比对运行时发过的号。第三轮活体验收就是
    // 断在这道缝上：复核者照提示词交了 `self:<n>`，门禁判它「不是运行时发出过的证据号」，于是
    // 收口被挡——而运行时给出的唯一补救办法是「父会话用 action=review 按 ev 号重新登记」，
    // 那恰恰是这次验收要证明「不必发生」的事。解析不出来就**原样保留**：让门禁如实拒它，
    // 而不是把一份猜出来的号放过去。
    const sessionId = outcome.semantic?.child_session_id
    const issued = typeof evidenceFor === 'function' && typeof root === 'string'
      ? (evidenceFor(root) ?? [])
      : []
    const ownEvidence = issued.filter((record) => record.session_id === sessionId)
    if (Array.isArray(payload.evidence)) {
      payload.evidence = payload.evidence.map((entry) => resolveEvidenceRef(entry, ownEvidence) ?? entry)
    }
    const compiled = compileReviewReport(payload)
    const plan = store.loadPlan(task.task_id)
    const stamped = Object.freeze({
      ...compiled,
      task_id: task.task_id,
      reviewed_plan_id: plan === undefined ? undefined : planId(plan),
      reviewed_at: Date.now(),
      source_session_id: outcome.semantic?.child_session_id,
    })
    store.saveReview(task.task_id, stamped)
    return { status: 'completed', note: `已登记独立复核报告（六问与五维齐备）。` }
  } catch (error) {
    return {
      status: 'failed',
      note: `复核报告被拒：${error instanceof Error ? error.message : String(error)}。`,
    }
  }
}

/**
 * 从子会话的产出里挑出**复核报告自己的字段**。
 *
 * 子会话的产出契约带 `status`（那是**传输层**的结论：执行者用它决定节点状态），而
 * `compileReviewReport` 的字段表里没有它——两个契约各有各的职责，运行时**不能把超集直接丢给
 * 编译器**。高风险流程第二轮活体验收就是这样断的：复核节点把六问五维全答了、81 次只读调用全做完了，
 * 报告却因为多带一个 `status` 被判 MALFORMED，整份被拒、节点判 failed、收口被挡。
 *
 * 只挑白名单，不逐个剔除：这样将来产出契约再加字段，也不会又一次把编译器撞掉。
 *
 * @param {unknown} payload
 * @returns {object}
 */
function reviewReportFields(payload) {
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  const picked = {}
  for (const key of ['summary', 'evidence', 'blocking_issues', 'engineering_quality', 'verification_independence']) {
    if (source[key] !== undefined) picked[key] = source[key]
  }
  return picked
}

/**
 * 把一条证据引用解析成运行时真正签发过的号。
 *
 * 认两种写法：`self:<n>`（本会话第 n 次工具调用）与直接的 `ev-<n>`（子会话若真知道号就照用，
 * 但收口门禁仍会核对它是不是运行时发过的）。解析不出来返回 `undefined`——**不猜**。
 *
 * @param {unknown} ref
 * @param {readonly object[]} ownEvidence - 该子会话产生的证据记录，按签发顺序。
 * @returns {string|undefined}
 */
function resolveEvidenceRef(ref, ownEvidence) {
  if (typeof ref !== 'string') return undefined
  const trimmed = ref.trim()
  // 允许 `self:<n>#明细`：复核报告的引用形式就是「证据号#明细」，明细是复核者自己写的说明，
  // 必须原样保留（把它丢掉等于改写复核者的结论）。
  const selfMatch = /^self:(\d+)(#.*)?$/u.exec(trimmed)
  if (selfMatch !== null) {
    const index = Number(selfMatch[1])
    if (!Number.isSafeInteger(index) || index < 1) return undefined
    const id = ownEvidence[index - 1]?.id
    if (id === undefined) return undefined
    return `${id}${selfMatch[2] ?? ''}`
  }
  return trimmed === '' ? undefined : trimmed
}

/**
 * 这个任务的验收标准，取自**需求侧**。
 *
 * 冻结的访谈记录（`grilling`）是需求侧那一份：验收标准是需求的属性，不是计划或节点的属性。没有访谈
 * 记录时退回任务记录上的同名字段（早期任务这么存过），两者都没有就是空数组——设计节点会如实看到
 * 「本任务没有登记验收标准」这个缺口，而不是拿到一份编出来的标准。
 *
 * @param {import('./task-store.js').TaskStore} store
 * @param {object} task
 * @returns {string[]}
 */
function acceptanceCriteriaFor(store, task) {
  const grilling = store?.loadGrilling?.(task.task_id)
  const fromRequirement = Array.isArray(grilling?.acceptance_criteria) ? grilling.acceptance_criteria : []
  if (fromRequirement.length > 0) return fromRequirement
  return Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : []
}

/**
 * 把设计节点交回来的验证方案编译、冻结并落盘。
 *
 * 三种结果：没带方案（原样返回）、方案合法（落盘并在返回文本里报出计划 id）、方案被拒（节点判失败，
 * 理由来自编译器/冻结器，而不是另编一句话）。与 `gac_task plan` 共用同一套校验，所以两条入口不会
 * 各自漂移出一套「什么样的计划算合格」。
 *
 * @param {object} input
 * @param {object} input.task
 * @param {object} input.node
 * @param {object} input.outcome - 执行者的返回。
 * @param {import('./task-store.js').TaskStore} input.store
 * @returns {{status: string, note?: string}}
 */
function settleDesignPlan({ task, node, outcome, store }) {
  const payload = outcome?.semantic
  if (payload === undefined || payload.role !== 'verification_design') {
    return { status: outcome.status }
  }
  if (outcome.status !== 'completed') return { status: outcome.status }

  try {
    const criteria = acceptanceCriteriaFor(store, task)
    const frozen = freezePlan(compileVerificationPlan(payload.payload?.plan, {
      criteria,
      frozenAt: Date.now(),
    }))
    const id = planId(frozen)
    if (store.hasPlan(task.task_id)) {
      const existing = planId(store.loadPlan(task.task_id))
      if (existing !== id) {
        return {
          status: 'failed',
          note: `设计节点交回的方案与已冻结的 ${existing} 不同（这份是 ${id}）——`
            + '计划一经冻结不得改写，请检查是否有人在实现之后重新设计了它。',
        }
      }
      return { status: 'completed', note: `验证计划未变（${id}）。` }
    }
    store.savePlan(task.task_id, frozen)
    return {
      status: 'completed',
      note: `已由设计节点冻结验证计划 ${id}（${frozen.cases.length} 个用例，`
        + `覆盖 ${(frozen.criteria ?? criteria).length} 条验收标准）。`,
    }
  } catch (error) {
    return {
      status: 'failed',
      note: `设计节点交回的验证方案被拒：${error instanceof Error ? error.message : String(error)}。`,
    }
  }
}

/**
 * 一个节点是否会写文件。
 *
 * 判据是它声明的写范围，而不是它的能力名或目标描述：写范围是这份计划里唯一可核对的
 * 事实，而「这个节点算不算实现节点」是语义判断。
 *
 * @param {object} node
 * @returns {boolean}
 */
function isWritingNode(node) {
  return Array.isArray(node?.write_scope) && node.write_scope.length > 0
}

/**
 * 找出这一批里因为接口契约尚未冻结而必须先停下的节点。
 *
 * 两个触发条件，缺一不可：
 *
 * 1. **同一批里有 ≥2 个写文件的节点。** 这是**通用规则，不来自任何工程的声明**，因为
 *    「两个作者同时写代码、各自发明接口」这件事本身就是接口会分叉的原因，而它是否需要
 *    一份约定，与这次改动风险高不高无关。这条规则是走一遍真实需求时暴露出来的：本仓库的
 *    适配器只对 `high_risk_task` 要求契约，于是「并行写功能代码 + 写测试代码」——
 *    契约存在的**全部理由**——恰好不在门禁覆盖内，两个节点连契约都没有就并行开工了。
 *    用风险档位当判据是选错了轴：决定要不要契约的是**任务的形状**（有没有并行写入），
 *    不是它的风险级别。
 *
 * 2. **适配器声明该模式要求契约。** 这是工程侧可以加严的部分：单写者的高风险改动也可能
 *    需要先把接口写下来。
 *
 * 判据是「同一批里有几个写文件的节点」，因此它对「两个节点其实互不相干」会误报。这个方向
 * 是刻意选的：误报的代价是多写一份最小契约，漏报的代价是两条分支对着不存在的约定干活。
 *
 * @param {object} task
 * @param {readonly string[]} nodeIds - 本次准备派遣的节点。
 * @param {(root: string) => object|undefined} adapterFor
 * @param {string} root
 * @param {import('./task-store.js').TaskStore} store
 * @returns {string[]}
 */
function needsContractGate(task, nodeIds, adapterFor, root, store) {
  if (store.hasContract(task.task_id)) return []
  const writers = nodeIds.filter((id) => isWritingNode(task.nodes.get(id)))
  const parallelWriters = writers.length >= 2

  const policy = adapterFor?.(root)?.execution?.require_contract
  const modes = Array.isArray(policy) ? policy : policy?.modes
  const modeRequires = Array.isArray(modes) && modes.includes(task.mode)

  if (!parallelWriters && !modeRequires) return []
  // 并行写入时把**每一个**写者都拦下：只拦其中一个，另一个仍会照着尚未存在的约定开工。
  return writers
}

/**
 * 讲清这次为什么要求契约。
 *
 * 两个触发条件对调用方意味着不同的事：一个是「你这里有并行写入」，另一个是「你的工程
 * 声明了这类改动要契约」。混成一句话会让调用方以为工程配置错了，或者反过来以为并行没关系。
 *
 * @param {object} task
 * @param {readonly string[]} writers
 * @param {(root: string) => object|undefined} adapterFor
 * @param {string} root
 * @returns {string}
 */
function describeContractTrigger(task, writers, adapterFor, root) {
  const policy = adapterFor?.(root)?.execution?.require_contract
  const modes = Array.isArray(policy) ? policy : policy?.modes
  const modeRequires = Array.isArray(modes) && modes.includes(task.mode)
  const parts = []
  if (writers.length >= 2) {
    parts.push(`同一批里有 ${writers.length} 个节点要写文件（${writers.join('、')}），`
      + '它们会并行开工，各自发明接口就会分叉')
  }
  if (modeRequires) parts.push(`工程适配器声明了 ${task.mode} 要求契约`)
  return parts.join('；') || '需要契约'
}

/**
 * 一个节点是否承载独立验证。
 *
 * @param {object} node
 * @returns {boolean}
 */
function isVerificationNode(node) {
  return node.required_capabilities.some((capability) =>
    VERIFICATION_CAPABILITIES.includes(capability))
}

/**
 * 找出这一批里因为缺验证计划而必须先停下的节点。
 *
 * 只针对本次要派遣的节点判定，且只针对承载验证能力的那些：实现节点不需要计划就能开工，
 * 而计划本身也不需要实现存在。
 *
 * **显式声明为 `verification_design` 的节点豁免这道门禁**：它**就是计划的作者**，要求「先有计划
 * 才能设计计划」会把高风险流程锁死（活体验收里那轮就是父会话先替它写好计划，语义是倒置的）。
 * 豁免只认**显式角色**——缺省推断永远不会给出 `verification_design`（见 `lib/coordinator.js` 的
 * `nodeRoleOf`），所以一个没声明角色的验证节点仍然被这道门禁挡住，不会悄悄绕过。
 *
 * @param {object} task
 * @param {readonly string[]} nodeIds - 本次准备派遣的节点。
 * @param {import('./task-store.js').TaskStore} store
 * @returns {string[]}
 */
function needsPlanGate(task, nodeIds, store) {
  if (!MODES_REQUIRING_PLAN.includes(task.mode)) return []
  if (store.hasPlan(task.task_id)) return []
  return nodeIds.filter((id) => {
    const node = task.nodes.get(id)
    if (node === undefined || !isVerificationNode(node)) return false
    return node.role !== 'verification_design'
  })
}

/**
 * 一个节点是否承载独立复核。
 *
 * 与「验证节点」分开：验证是执行计划里的用例，复核是回答「这次验证可不可信」。两者常常由同一个
 * 执行者承载，但门禁守的是不同的产物，所以判据不能合并。
 *
 * @param {object} node
 * @returns {boolean}
 */
function isReviewNode(node) {
  return node.required_capabilities.includes('review')
}

/**
 * 这次收口是否必须已经有一份独立复核报告。
 *
 * 两个触发条件，与契约门禁同一个形状：**计划里有审查节点**（通用规则），或**模式要求独立复核**
 * （工程侧声明）。用风险标签当判据会留下一个绕行口——不声明那个标签就绕过去了。
 *
 * @param {object} task
 * @returns {{required: boolean, reason: string}}
 */
function needsReviewGate(task) {
  const reviewNodes = [...task.nodes.values()].filter(isReviewNode).map((node) => node.id)
  if (reviewNodes.length > 0) {
    return { required: true, reason: `计划里有承载审查能力的节点：${reviewNodes.join('、')}` }
  }
  if (MODES_REQUIRING_PLAN.includes(task.mode)) {
    return { required: true, reason: `任务模式 ${task.mode} 要求一次独立复核` }
  }
  return { required: false, reason: '' }
}

/**
 * 把六问讲成模型能直接照填的样子。
 *
 * 由 {@link INDEPENDENCE_QUESTIONS} 生成而不是手写第二份：问题清单有两份副本时，漂移的那一份
 * 正是模型读到的那一份，而它读到的方向错了，答案就跟着错。
 *
 * @returns {string}
 */
function describeIndependenceQuestions() {
  return INDEPENDENCE_QUESTIONS
    .map((question) => (question.kind === 'boolean'
      ? `${question.key}（${question.ask} 可信的验证答 ${question.expected}）`
      : `${question.key}（${question.ask} 可信的验证给空数组）`))
    .join('；')
}

/**
 * 把五个质量维度讲成模型能直接照填的样子。
 *
 * @returns {string}
 */
function describeQualityDimensions() {
  return QUALITY_DIMENSIONS.map((dimension) => `${dimension.key}（${dimension.ask}）`).join('；')
}

/**
 * 把一条复核缺口讲成人能照做的事。
 *
 * 与验证缺口分开：复核的缺口几乎都是「复核者自己申报的」，因此措辞要让人看清这一点——它报的
 * 是**已经记录在案的事实**，改口是改不掉的，能做的是把活儿修好。
 *
 * @param {object} violation
 * @returns {string}
 */
function describeReviewViolation(violation) {
  const detail = violation.detail ?? {}
  switch (violation.code) {
    case REVIEW_CODES.REPORT_MISSING:
      return '还没有独立复核报告'
    case REVIEW_CODES.INDEPENDENCE_UNANSWERED:
      return `验证独立性六问还有没回答的：${(detail.questions ?? []).join('、')}`
    case REVIEW_CODES.INDEPENDENCE_FAILED:
      if (Array.isArray(detail.criteria) && detail.criteria.length > 0) {
        return `复核自己申报了未被覆盖的验收标准：${detail.criteria.join('、')}`
      }
      return `复核自己申报了「${detail.ask ?? detail.question}」`
        + `——${detail.why ?? '方向与一次可信的验证相反'}`
    case REVIEW_CODES.QUALITY_MISSING:
      return `工程质量维度还没有结论：${(detail.dimensions ?? []).join('、')}`
    case REVIEW_CODES.BLOCKING_ISSUES:
      return `复核留下了 ${(detail.issues ?? []).length} 个阻塞问题：`
        + `${(detail.issues ?? []).join('；')}`
    case REVIEW_CODES.EVIDENCE_UNVERIFIED:
      return `这些引用不是运行时发出过的证据号：${(detail.refs ?? []).join(', ')}`
    default:
      // 复核这一关也会报出计划身份不符（那一码属于验证层），交给它自己那句话讲。
      return describeViolation(violation)
  }
}

/**
 * 把访谈现状讲成一句可照做的事。
 *
 * @param {object} view - `summarize` 的结果。
 * @returns {string}
 */
function describeGrilling(view) {
  if (view.frozen) {
    return `需求已冻结（${view.rounds} 轮访谈，${view.acceptance_criteria.length} 条验收标准）。`
  }
  if (view.rounds === 0) {
    return '还没有进行过访谈。请先提出第一轮问题（一次问完，问得具体到能据此写断言），'
      + '把用户的答复原样记下来。'
  }
  const base = `已进行 ${view.rounds} 轮、累计 ${view.questions_asked} 问`
  if (view.converged) {
    return `${base}，已提出收敛。请把问题与答复摘要呈给用户，取得用户的确认原话后用 `
      + '`confirm` 冻结需求。'
  }
  return `${base}${view.unresolved.length === 0
    ? '，目前没有悬而未决的问题'
    : `，其中 ${view.unresolved.length} 条答复属于「还不知道」`}。`
    + '请据此决定下一轮问什么；问尽之后用 `converge` 提出收敛。'
}

/**
 * 把一条验证缺口讲成人能看懂的话，并指名到具体 AC 或用例。
 *
 * 一句「覆盖率不足」既不能被修复也不能被复核，所以缺口一律带着名字出现。
 *
 * @param {object} violation
 * @returns {string}
 */
function describeViolation(violation) {
  const detail = violation.detail ?? {}
  switch (violation.code) {
    case VERIFICATION_CODES.AC_UNCOVERED:
      return detail.uncovered?.length > 0
        ? `没有用例覆盖的验收标准：${detail.uncovered.join(', ')}`
        : `没有正例证明可过的验收标准：${(detail.without_positive ?? []).join(', ')}`
    case VERIFICATION_CODES.FALSIFICATION_MISSING:
      return `缺少反例的验收标准：${(detail.criteria ?? []).join(', ')}`
    case VERIFICATION_CODES.EVIDENCE_MISSING:
      return `缺少已执行证据的用例：${(detail.cases ?? []).join(', ')}`
    case VERIFICATION_CODES.EVIDENCE_UNVERIFIED:
      return `这些引用不是运行时发出过的可用证据：`
        + `${(detail.rejected ?? []).map((entry) => `${entry.case_id} 引用 ${entry.evidence_ref}（${entry.reason}）`).join('；')}`
    case VERIFICATION_CODES.EVIDENCE_POOLED:
      return `同一份证据被多条用例共用，不构成独立证据：`
        + `${(detail.pooled ?? []).map((entry) => `${entry.evidence_ref}（${entry.cases.join('、')}）`).join('；')}`
    case VERIFICATION_CODES.CASE_UNKNOWN:
      return `报告里出现计划外的用例：${detail.case_id}`
    case VERIFICATION_CODES.PLAN_MUTATED:
      return `报告对应的不是当前计划（期望 ${detail.expected}，报告写的是 ${detail.reported}）`
    case VERIFICATION_CODES.PAYLOAD_MISSING:
      return `收口时没有交验证载荷：缺 evidence.verification，或它没带 plan_id`
        + `（当前计划是 ${detail.expected}）。每条用例都要给出各自的执行结论与证据引用`
    default:
      return violation.code
  }
}

/**
 * 把一条收口阻塞项讲成人能看懂的话。
 *
 * 返回结构化 code 便于程序分支，但收口被拒时最需要的是「还差什么」，所以这里给出
 * 一句可照做的话，而不是把 code 直接抛给模型。
 *
 * @param {object} blocker
 * @returns {string}
 */
function describeBlocker(blocker) {
  switch (blocker.code) {
    case 'node_not_completed':
      return `节点 ${blocker.node} 仍处于 ${blocker.status}`
    case 'criteria_uncovered':
      return '仍有验收标准没有通过证据（evidence.all_criteria_covered 为 false）'
    case 'blocking_review_issue':
      return '仍有未关闭的阻塞评审问题'
    case 'unresolved_approval':
      return '仍有未决审批'
    default:
      return blocker.code
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
    transitions: [],
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
export function createTaskTool({
  taskStoreFor,
  sessionRootFor,
  executorsFor,
  adapterFor,
  evidenceFor,
  eventLogFor,
  roleGuard,
  defineTool,
}) {
  return defineTool(taskToolOptions({
    taskStoreFor,
    sessionRootFor,
    executorsFor,
    adapterFor,
    evidenceFor,
    eventLogFor,
    roleGuard,
  }))
}
