/**
 * 语义角色的工具策略：**角色决定它能知道什么、能做什么**。
 *
 * @module dsh-gac-runtime/role-tools
 *
 * 为什么不能继续从「写范围是否为空」推导工具面
 * ------------------------------------------
 * 旧口径只有一个判据：节点的 `write_scope` 非空就是写者（保留写入工具），为空就是只读者（去掉
 * `write`/`edit`）。那一条能表达「能不能写」，表达不了「能不能读」——而 `verification_design` 与
 * `verification_execution` 的写范围**都是空的**，读取能力却必须完全相反：设计节点要在实现存在之前
 * 独立推导验证方案（看不见仓库才是它成立的条件），执行节点要读实现、跑用例、留证据。
 *
 * 用一个空数组同时表达这两种角色，代价已经真实发生过：真实 `REQ-HR-5` 里设计子会话启动时确实没被
 * 推入实现信息，但它**自己**把实现产物读了过来（`hr5-artifact.txt` 的 `Length=3`、mtime），推理里
 * 出现「3 bytes = ok\n likely」。独立性因此在事实层面不成立——而独立性正是这一整套架构要买的东西。
 *
 * 判据只有一处
 * ----------
 * 本模块给出唯一的判据：**语义角色**（`lib/coordinator.js` 的 `NODE_ROLES`）。两个地方共用它——
 * 子会话创建窗口里的 `toolFilter`，以及守卫那一层的拒绝判定——因此呈现面与拒绝面不会漂移。
 * 「信息隔离必须是结构性的，不是行为性的」：一条写着「不要读实现」的提示词，管不住一个手里有
 * `read` 的模型。
 *
 * 三件事仍然分开
 * ------------
 *  1. **角色**决定「这个节点该看到什么、该做什么」——本模块；
 *  2. **写范围**决定「授权它写哪里」，空范围是**明确不许写**，与角色无关，照样生效；
 *  3. **能力路由**决定「谁来执行」（`lib/capability-router.js`）——同一个 `verification` 能力可以出现在
 *     设计节点与执行节点上，它们的角色不同，工具面也不同。
 *
 * 失败方向
 * ------
 * 认不出的角色名一律按**最保守**的那一档处理（与设计节点同档：只留推理），而不是退到最宽的
 * Builder。角色名在编译期已由 `compileTask` 校验过，这里只是不让一个坏字段把守卫变成放行。
 */

import { nodeRoleOf } from './coordinator.js'
import { CALL_KINDS, classifyCall } from './tool-targets.js'

/** 每次拒绝都携带的结构化错误码。 */
export const ROLE_CODES = Object.freeze({
  ROLE_TOOL_DENIED: 'GAC_ROLE_TOOL_DENIED',
  CHILD_DELEGATION_DENIED: 'GAC_CHILD_DELEGATION_DENIED',
})

/**
 * 委派类工具：**再开一个执行者**。
 *
 * GAC 拥有编排权；一个子会话只执行被分配给它的那个节点。子会话自己再开一层，等于在运行时看不见的
 * 地方多出一份没人记账的工作——它的产物不进任务记录、不进证据日志、也不受写范围约束。
 *
 * `team_task_*` 是前缀匹配：那一族随宿主升级会增加，逐个点名的名单会静默过期。名单本身**不假设
 * 这些名字一定存在**——调用方还会与本会话实际的可收集合取交集（`restrict` 对不认识的名字抛错），
 * 而守卫那一层按名字判定，多认一个不存在的名字没有代价。
 */
export const DELEGATION_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
  'send_message',
])

/** 带前缀的委派族：名单随宿主升级增长，靠前缀接住。 */
const DELEGATION_PREFIXES = Object.freeze(['team_task_'])

/**
 * 派遣方的协调状态：子会话不得触碰。
 *
 * 它有自己的产出契约（`structured_output`）来回报，不需要、也不该去读或改父会话的任务记录、
 * 作用域声明与证据账本。活体验收观察过这条缺失的后果：子会话自己声明作用域、并试着回报它那一侧的
 * 派遣，它自己的产出里写着「A1 的回报被判 stale、T1 停在 blocked」，而父侧权威状态是 completed。
 * 父侧没有被污染，但「子会话能不能碰父会话的协调状态」不该靠运气。
 */
export const PARENT_COORDINATION_TOOLS = Object.freeze([
  'gac_task',
  'gac_scope',
  'gac_project',
  'gac_metrics',
  'gac_evidence',
])

/**
 * 语义角色的工具策略。
 *
 * `deny_kinds` 用的是 `lib/tool-targets.js` 的工具分类（`classifyCall` 的返回值），因此这张表与
 * 写作用域门禁读的是**同一张工具表**——运行时升级带来新工具时，它会落进已有分类，不会悄悄漏过去。
 *
 *  `implementation`       仓库读 + 写 + shell。它是唯一被允许改文件的角色。
 *  `software_design`      读仓库（要看得见现有代码与结构才谈得上设计）+ shell（跑诊断命令），
 *                         但不改文件：设计是**产物**，不是对代码的修改。
 *  `test_design`          只推理，与 `verification_design` 同档：测试架构与测试详设的预期必须从需求与
 *                         契约推导，读本次实现就等于让预期照着实现写——那样测出来的是「实现自洽」，
 *                         不是「实现正确」。工程事实（现有测试怎么跑、有哪些能力）由运行时注入。
 *  `verification_design`  只推理。需求、验收标准与冻结契约都已经在派遣提示词里，因此它**不需要**
 *                         看仓库；而「不需要」在这里就是「不允许」——那就是它保持独立的方式。
 *  `verification_execution` 读仓库 + shell（逐条执行冻结计划用例），不许改文件。
 *  `review`               读仓库与证据，不许改文件。
 *
 * 六个角色都不许委派、都不许碰派遣方的协调状态（见下面两处单独的判定）。
 *
 * **新增角色必须同时加进这张表。** 认不出的角色退到最保守的那一档（只推理），所以漏加不会静默给出
 * 写入面——但会让一个新角色**连 `read` 都没有**，于是它干不成活，而失败的样子很像模型能力问题。
 */
export const ROLE_TOOL_POLICY = Object.freeze({
  implementation: Object.freeze({
    deny_kinds: Object.freeze([]),
    note: '仓库读 + 写 + shell：唯一允许改文件的角色',
  }),
  software_design: Object.freeze({
    deny_kinds: Object.freeze([
      CALL_KINDS.WRITE,
      CALL_KINDS.PTC,
      CALL_KINDS.UNKNOWN,
    ]),
    note: '读现有工程并跑诊断，产出设计产物；设计不改代码，因此不给写入面',
  }),
  test_design: Object.freeze({
    deny_kinds: Object.freeze([
      CALL_KINDS.READ,
      CALL_KINDS.SHELL,
      CALL_KINDS.WRITE,
      CALL_KINDS.PTC,
      CALL_KINDS.UNKNOWN,
    ]),
    note: '只依据需求侧事实推导测试设计：不读本次实现，也不执行文件系统操作',
  }),
  verification_design: Object.freeze({
    deny_kinds: Object.freeze([
      CALL_KINDS.READ,
      CALL_KINDS.SHELL,
      CALL_KINDS.WRITE,
      CALL_KINDS.PTC,
      CALL_KINDS.UNKNOWN,
    ]),
    note: '只依据需求侧事实推导验证方案：不读仓库、不执行文件系统操作',
  }),
  verification_execution: Object.freeze({
    deny_kinds: Object.freeze([CALL_KINDS.WRITE]),
    note: '读仓库并逐条执行已冻结的计划用例，不许改文件',
  }),
  review: Object.freeze({
    deny_kinds: Object.freeze([CALL_KINDS.WRITE]),
    note: '读仓库与证据做独立复核，不许改文件',
  }),
})

/**
 * 认不出的角色名退到的那一档：与设计节点同档（只留推理）。
 *
 * 退到最宽的 Builder 会让一个拼错的角色名**静默拿到写入面**；退到这一档只会让那个节点干不成活，
 * 而那是可见的、会被回报的失败。
 */
const UNKNOWN_ROLE_POLICY = ROLE_TOOL_POLICY.verification_design

/**
 * 这个节点是哪个语义角色。
 *
 * 与协调器共用同一个推断（`nodeRoleOf`）：显式 `role` 优先，否则按能力推断，**永远不会**推断成
 * `verification_design` 或两个设计角色（那些角色都带着「可以先开工」的豁免）。读不出来时退到最保守的一档。
 *
 * @param {object|undefined} node
 * @returns {string}
 */
export function semanticRoleOf(node) {
  try {
    return nodeRoleOf(node)
  } catch {
    // 守卫不能因为一个坏字段就抛错——那会让这个会话的**每一次**工具调用都炸掉，而不是拒掉一次。
    return '__unknown__'
  }
}

/**
 * 这个角色对应的策略。
 *
 * @param {string|undefined} role
 * @returns {{deny_kinds: readonly string[], note: string}}
 */
export function rolePolicyFor(role) {
  return ROLE_TOOL_POLICY[role] ?? UNKNOWN_ROLE_POLICY
}

/**
 * 这个工具是不是委派类。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isDelegationTool(name) {
  if (typeof name !== 'string' || name === '') return false
  if (DELEGATION_TOOLS.includes(name)) return true
  return DELEGATION_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * 这个工具是不是派遣方的协调类。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isParentCoordinationTool(name) {
  return typeof name === 'string' && PARENT_COORDINATION_TOOLS.includes(name)
}

/**
 * 一次调用的角色判定。
 *
 * 判定顺序是有意义的：**委派**先于一切——它是编排权的问题，与这个角色能不能读文件无关，因此拒因
 * 也要说清是它；随后是派遣方协调类；最后才轮到角色自己的类别表与写范围。
 *
 * @param {object} input
 * @param {string|undefined} input.role
 * @param {string} input.name
 * @param {readonly string[]|undefined} [input.write_scope] - 空数组（或缺失）表示**不许写**，
 *   与角色无关：声明为空是明确的不许写，而不是「没声明所以随便」。
 * @returns {{code: string, category: string}|undefined} `undefined` 表示这个角色可以用这个工具。
 */
export function roleDenyFor({ role, name, write_scope: writeScope }) {
  if (typeof name !== 'string' || name === '') return undefined
  if (isDelegationTool(name)) {
    return { code: ROLE_CODES.CHILD_DELEGATION_DENIED, category: 'delegation' }
  }
  if (isParentCoordinationTool(name)) {
    return { code: ROLE_CODES.ROLE_TOOL_DENIED, category: 'parent_coordination' }
  }
  const writes = Array.isArray(writeScope) ? writeScope : []
  const { kind } = classifyCall(name, {})
  if (kind === CALL_KINDS.WRITE && writes.length === 0) {
    return { code: ROLE_CODES.ROLE_TOOL_DENIED, category: 'write_scope_empty' }
  }
  if (rolePolicyFor(role).deny_kinds.includes(kind)) {
    return { code: ROLE_CODES.ROLE_TOOL_DENIED, category: kind }
  }
  return undefined
}

/**
 * 这份「能收」的名单里，按这个节点的角色应当被收掉的名字。
 *
 * 与 `roleDenyFor` 共用同一个判据，因此**呈现面与拒绝面不会漂移**：子会话创建窗口里收掉的名字，
 * 与守卫那一层会拒的名字来自同一张表。收权只能做得掉「继承来的」工具（内核规则：一条 restriction
 * 只过滤这个作用域继承来的工具，永不过滤它自己那一层注册的），所以这里只在本会话实际可收的名单上
 * 求交集，不做任何猜测。
 *
 * @param {object|undefined} node
 * @param {readonly string[]} inheritableNames - 本会话实际可收的工具名（`restrictableNames`）。
 * @returns {string[]} 应当收掉的名字；名单不是数组时返回空数组（调用方据此退回「没有过滤」）。
 */
export function deniedToolNamesFor(node, inheritableNames) {
  if (!Array.isArray(inheritableNames)) return []
  const role = semanticRoleOf(node)
  const writeScope = Array.isArray(node?.write_scope) ? node.write_scope : []
  return inheritableNames.filter(
    (name) => roleDenyFor({ role, name, write_scope: writeScope }) !== undefined,
  )
}

/**
 * 拒因（给人读的那一段）。
 *
 * 两层的措辞共用这一个函数：子会话创建窗口里的收权只做得掉「继承来的」工具，而 agent 自己那一层
 * 注册的工具（宿主的 Team 工具、PTC 的 `run_code`）只能由守卫拒——如果两层各写一套话，同一件事会
 * 有两种说法，读报告的人得先去分辨哪个才是权威。
 *
 * 拒因里带上身份（任务／节点／派遣／子会话 id）与角色，这样一次拒绝能直接回答「是谁、哪一次派遣、
 * 什么角色、想用什么工具」。
 *
 * @param {object} input
 * @param {string|undefined} input.role
 * @param {string} input.name
 * @param {string} input.category
 * @param {object} [input.binding] - 子会话的角色登记（`lib/child-binding.js`）。
 * @returns {string}
 */
export function roleDenyReason({ role, name, category, binding }) {
  const identity = binding === undefined
    ? ''
    : `（任务 ${binding.task_id}／节点 ${binding.node_id}／派遣 ${binding.dispatch_id}`
      + `${binding.child_session_id === undefined ? '' : `／子会话 ${binding.child_session_id}`}）`
  const who = `子会话的角色是 ${role ?? 'implementation'}${identity}`

  if (category === 'delegation') {
    return `GAC: ${who}，而 "${name}" 是委派类工具：子会话只执行被分配给它的那个节点，`
      + '不得自己再开一层执行者或工作流。编排权归 GAC——需要多一个执行者时，'
      + '把这件事写进你的结构化回报，由派遣方决定。'
  }
  if (category === 'parent_coordination') {
    return `GAC: ${who}，"${name}" 操作的是**派遣方**的任务记录、作用域声明与证据账本，`
      + '子会话不得读写。回报请走结构化产出（status / summary 与该角色要求的字段）。'
  }
  if (category === 'write_scope_empty') {
    return `GAC: ${who}，本节点的写范围是**空的**，因此 "${name}" 被拒绝：`
      + '声明为空是明确的不许写，而不是「没声明所以随便」。'
  }
  return `GAC: ${who}，按语义角色策略不得使用 "${name}"（工具类别 ${category}）：`
    + `${rolePolicyFor(role).note}。`
}
