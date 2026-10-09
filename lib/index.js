/**
 * DSH 插件入口——围绕 GAC 核心的 harness 形态外壳。
 *
 * @module dsh-gac-runtime
 *
 * 为什么本文件很薄
 * ---------------------
 * 每一个决策都位于一个依赖注入的模块里，以便做单元测试（lib/plugin.js 及其下级模块，
 * 由 test/ 覆盖）。本文件只在 DSH 的 Cordis 表面与那些模块之间做翻译。而翻译恰恰是
 * harness 升级出错时最会藏身的地方，正因如此，它被保持得足够小，可以一口气读完。
 *
 * 它注册了什么
 * -----------------
 *  1. 拦截本身：`tools/pre-execute`，以 prepend 方式注册，好让 GAC 在逐调用的授权
 *     审核器运行之前就做出决定。`prepend: true` 很重要——一个审核器若批准了写作用域
 *     门禁本会拒绝的调用，就会白白花掉 token，产出一个随后被丢弃的决定。
 *
 *     `ctx.tools.guard()` 是另一个候选接缝，已被否决：守卫只收到执行本身，因此无法
 *     获得取消信号，而 `tools/pre-execute` 提供了本运行时所需的带类型
 *     {allow|deny|ask|cancel} 词汇。一个接缝，而不是两个。
 *
 *  2. 作用域来源：`gac_scope` 工具。若没有声明作用域的方式，这道门禁永远无法触发，
 *     它的行为也就始终得不到验证。协调器将复用这同一个接缝，而不会引入第二条让
 *     作用域诞生的途径。
 *
 * 降级是显式的
 * -----------------------
 * 如果 `gac_scope` 工具无法注册（从链接安装的形态下运行时的编写辅助函数不可达），
 * 守卫仍然会被安装，加载报告会说明该工具缺失。一个因为可选 import 失败就悄悄丢掉
 * 一半行为的插件，比一个如实报告此事的插件更糟。
 */

import { appendFileSync } from 'node:fs'

import { ClaimStore } from './claim-store.js'
import { EvidenceLog } from './evidence-store.js'
import { gacEventsFrom } from './gac-events.js'
import { GacEventLog } from './gac-event-log.js'
import { createRoutedExecutors, createSessionExecutor } from './executor.js'
import { createChildBindings } from './child-binding.js'
import { createChildExecutor, describeChildSeam } from './child-executor.js'
import { SURFACE_CODES, createChildSurface } from './child-surface.js'
import { createGacCore } from './plugin.js'
import { projectRootFromCwd } from './path-utils.js'
import { ProjectState } from './project-state.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, createPromptSection } from './prompt-section.js'
import { checkCapabilities } from './capabilities.js'
import { createRoleGuard, restrictableNamesOf } from './role-guard.js'
import { TaskStore } from './task-store.js'
import { describeResolutionFailure, importDshPackage } from './resolve-dsh.js'
import { TASK_TOOL_NAME, createTaskTool } from './tool-task.js'
import { EVIDENCE_TOOL_NAME, createEvidenceTool } from './tool-evidence.js'
import { METRICS_TOOL_NAME, createMetricsTool } from './tool-metrics.js'
import { PROJECT_TOOL_NAME, createProjectTool } from './tool-project.js'
import { OperationStore } from './operation-store.js'
import { SCOPE_TOOL_NAME, createScopeTool } from './tool-scope.js'
import {
  WITNESS_SOURCE,
  compileWitnessSummary,
  composeWitnessRecord,
  readWitnessSummary,
  resolveGoverningSession,
} from './workspace-witness.js'

/** Cordis 插件名，供加载器诊断使用。 */
export const name = 'gac-runtime'

/**
 * 本插件激活前必须存在的服务，如实枚举。若声明得更少，插件就会加载进一种组合中，
 * 而它的守卫在其中悄悄看不到它必须据以决策的东西。
 */
export const inject = ['tools', 'sessions']

/**
 * JSONL 加载/执行报告的绝对路径。
 *
 * 用文件而不是日志行，因为本阶段的要点是证明插件到底有没有加载：写在 profile 自己的
 * 数据目录里的标记会留存下来，而 web 服务的 harness 内部的 console 输出不可靠可见，
 * 还可能破坏传输通道。
 *
 * @returns {string}
 */
function reportPath() {
  const home = process.env.DSH_HOME
    ?? (process.env.USERPROFILE ?? process.env.HOME ?? '.')
  const separator = home.includes('\\') ? '\\' : '/'
  return `${home}${separator}gac-runtime-report.jsonl`
}

/**
 * 向报告追加一条记录。永不抛错：一个能让它所诊断的插件失败的诊断，比没有诊断更糟。
 *
 * @param {object} record
 * @returns {void}
 */
function report(record) {
  try {
    appendFileSync(reportPath(), `${JSON.stringify({ time: Date.now(), ...record })}\n`, 'utf8')
  } catch {
    // 有意忽略——见上面的 JSDoc。
  }
}

/**
 * 造出核心与只读角色收权器，并把它们接在一起。
 *
 * 单独抽出来是为了让**这条接线**能被断言：这两件东西曾经各自都在，却没有连上——`createGacCore`
 * 没拿到 `roleGuard`，于是收权降级到 `guard-only` 时兜底那一层根本不存在，`write` 照写不误。
 * 914 条单测全绿，因为没有任何一条走到这条接线上；暴露它的是一次真实加载后的活体实测（子 agent
 * 跑了两次本该被拦的写入，两次都成功，而插件报告里只有 `role-revocation-failed` + `role-restricted`）。
 *
 * @param {object} deps
 * @param {(sessionId: string) => string|undefined} deps.rootOf
 * @param {(sessionId: string, agent: object|undefined) => object|undefined} [deps.toolsFor]
 * @param {(record: object) => void} [deps.onEvent]
 * @param {(sessionId: string) => object|undefined} [deps.childRoleFor] - 问「这个会话是 GAC 派的哪个
 *   语义角色」。核心的门禁在**每次工具调用**时问它，因此可以晚于这里接线（见 `apply` 里的
 *   `childRoleOf`）。
 * @returns {{core: object, roleGuard: object}}
 */
export function createRuntime({ rootOf, toolsFor, onEvent, childRoleFor, coordinatorWriteFor }) {
  const roleGuard = createRoleGuard({ toolsFor, onEvent })
  // `roleGuard` 必须**同时**交给核心：收权正常时工具不在视野里（内核返回 UNKNOWN_TOOL），而接缝
  // 缺席、或某些名字根本收不掉（作用域内注册的工具）时，门禁那一层是唯一让角色仍然成立的东西。
  // `childRoleFor` 是同一件事的延伸：角色不只决定「写不写」，也决定「看不看得到」——只读角色收权
  // 只管写入面，`verification_design` 要连 `read`/`grep` 一起拒，那只能由这一层做。
  // `coordinatorWriteFor` 是另一条轴：子会话按角色判定，主会话按工程声明的受保护路径判定。
  const core = createGacCore({ resolveRoot: rootOf, roleGuard, childRoleFor, coordinatorWriteFor })
  return { core, roleGuard }
}

/**
 * 一个会话是不是「协调者」，以及本工程要不要拦它。
 *
 * 两件事分开回答，因为它们的失败后果不同：
 *
 * - **是不是协调者**取宿主会话头（`parentSession` / `origin: 'subagent'`），与系统提示段落里那处
 *   判据同一份。这里不能改用「有没有绑定」来判：只读子会话按设计不绑作用域，而它显然不是协调者
 *   ——用它当判据会让一个只读子会话被当成主会话，然后按主会话的规则去拦（方向虽然仍是拒绝，
 *   理由却完全错了）。
 * - **要不要拦**只看适配器声明。工程没写 `coordinator_write: "protected"` 时返回 `undefined`，
 *   这一层就完全不管：默认不改变任何已有工程的行为。
 *
 * 返回 `{ protected_paths }` 表示「拦」，返回 `undefined` 表示「这一层不管」。
 *
 * @param {object} input
 * @param {object|undefined} input.authority - 适配器的 `authority` 节。
 * @param {object|undefined} input.agent - 发起这次调用的 agent。
 * @returns {{protected_paths: readonly string[]}|undefined}
 */
export function coordinatorWritePolicy({ authority, agent }) {
  const header = agent?.session?.header
  if (header?.parentSession !== undefined || header?.origin === 'subagent') return undefined
  if (authority?.coordinator_write !== 'protected') return undefined
  return { protected_paths: authority.protected_paths ?? [] }
}

/**
 * 注册面向模型的 GAC 工具，或说明为何无法注册。
 *
 * 之所以放在 `apply` 之外，是因为传给 `ctx.effect` 的 Cordis effect 体是一个生成器，
 * 而不是 async 函数：在其中 `await` 是语法错误。因此异步工作先发生，再把它的结果
 * 交给 effect。
 *
 * 注册在设计上就是全有或全无。一个能声明执行模式却无法声明写作用域（或反过来）的
 * 会话，会在看起来执行了一套策略的同时只执行一半，这比完全不执行更糟。
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.core
 * @param {import('./project-state.js').ProjectState} deps.state
 * @param {(root: string) => object|undefined} deps.claimStoreFor
 * @param {(root: string) => import('./task-store.js').TaskStore|undefined} deps.taskStoreFor
 * @param {(root: string) => import('./evidence-store.js').EvidenceLog} deps.evidenceLogFor
 * @param {(sessionId: string) => string|undefined} deps.rootOf
 * @param {(root: string) => object|undefined} deps.adapterFor
 * @param {(root: string) => readonly object[]|undefined} deps.executorsFor
 * @param {object|undefined} deps.roleGuard
 * @param {(record: object) => void} [deps.onScopeEvent] - `gac_scope` 的豁免签发/撤回要进审计。
 *   豁免是唯一能绕过协调者写保护的路径，只在内存里成立的话，事后没有任何东西能说明
 *   「谁在什么时候、以什么理由自己开了这道门」。
 * @param {(options: object) => object} [deps.defineTool] - 只给测试用的接缝：真路径从
 *   `@deepseek-ai/dsh-tools` 解析它，而那条路径在没有 DSH 的机器上走不通，于是这个函数在测试里
 *   从来执行不到**注册**这一段——一个没被读到的参数（`roleGuard`）曾因此逃过整套测试，直到一次
 *   真实加载把五个工具全丢了才发现（加载报告里 `scope_tool: failed`、`registered_tools: []`）。
 * @returns {Promise<{status: string, note: string, tools: string[]}>}
 */
export async function registerTools(ctx, {
  core,
  state,
  claimStoreFor,
  taskStoreFor,
  evidenceLogFor,
  rootOf,
  adapterFor,
  executorsFor,
  roleGuard,
  capabilitiesFor,
  observationAvailableFor,
  eventLogFor,
  onScopeEvent,
  operationsFor,
  askFor,
  defineTool: injectedDefineTool,
}) {
  try {
    const toolsPackage = injectedDefineTool === undefined
      ? await importDshPackage('@deepseek-ai/dsh-tools')
      : undefined
    const defineTool = injectedDefineTool ?? toolsPackage?.defineTool
    if (typeof defineTool !== 'function') {
      return {
        status: 'unavailable',
        note: describeResolutionFailure('@deepseek-ai/dsh-tools'),
        tools: [],
      }
    }
    ctx.tools.register(createProjectTool({ state, defineTool, operationsFor, askFor }))
    ctx.tools.register(createScopeTool({
      core,
      defineTool,
      claimStoreFor,
      sessionRootFor: rootOf,
      onEvent: onScopeEvent,
    }))
    // `gac_task` 需要知道是哪个会话在推进任务，因为任务记录按项目而不是按会话存放。
    // adapterFor 与 executorsFor 让它不只是登记派遣，而是真的按能力路由并调用执行者。
    ctx.tools.register(createTaskTool({
      defineTool,
      taskStoreFor,
      sessionRootFor: rootOf,
      adapterFor,
      executorsFor,
      roleGuard,
      operationsFor,
      // 收口时用它核对验证报告里的证据引用：运行时没发过的号一律不认。
      evidenceFor: (root) => evidenceLogFor(root).load(),
      // 审计视图要读那份只追加的 GAC 事件日志（`audit` 动作的时间线来源）。**必须从外面传进来**：
      // `gacEventLogFor` 定义在 `apply` 里，而这个函数是另一个作用域——直接引用会在**真正调用时**
      // 抛 `gacEventLogFor is not defined`（活体踩到过：`audit` 动作在真实插件里根本走不通，
      // 而单测全绿，因为它们传的是假的 `eventLogFor`）。
      eventLogFor,
      // 收口门禁要问「本工程声明需要的能力，环境到底给不给」——这是那张契约表的执行点。
      capabilitiesFor,
    }))
    ctx.tools.register(createMetricsTool({
      defineTool,
      taskStoreFor,
      sessionRootFor: rootOf,
      evidenceFor: (root) => evidenceLogFor(root).load(),
      // 指标要能说「观测源此刻在不在」：不然「0 轮观测」会被读成「没有越界改动」。
      observationAvailableFor,
    }))
    // 证据列表工具：收口门禁要求引用「运行时发出过的证据号」，而在此之前没有任何东西能让
    // 模型知道有哪些号——规则要求引用真号，真号却无从得知。这个工具就是那个缺口。
    ctx.tools.register(createEvidenceTool({
      defineTool,
      sessionRootFor: rootOf,
      evidenceFor: (root) => evidenceLogFor(root).load(),
    }))
    return {
      status: 'registered',
      note: '可以声明执行模式、写作用域、任务 DAG、证据清单与带证据的指标；派遣会真正路由并调用',
      tools: [PROJECT_TOOL_NAME, SCOPE_TOOL_NAME, TASK_TOOL_NAME, METRICS_TOOL_NAME, EVIDENCE_TOOL_NAME],
    }
  } catch (error) {
    return {
      status: 'failed',
      note: error instanceof Error ? error.message : String(error),
      tools: [],
    }
  }
}

/**
 * 每个执行者的模型路由。
 *
 * 键是**执行者名字**，即适配器 `executors` 里列出的那些名字（如 `builder`、`verifier`），
 * 值是该执行者使用的模型。按执行者名而不是按能力名作键，理由很直接：能力路由返回的就是
 * 一个名字，而这个名字要能在可用执行者里找到对应的那一个。早先按能力名作键、并把执行者
 * 命名为 `能力名:provider/model`，于是 `executors.find(name === 'builder')` 永远找不到，
 * 每次都会落到「谁 supports 就谁上」的兜底分支——声明的路由被静默忽略，而看起来一切正常。
 *
 * 键是名字而不是能力，也让「同一个能力下两个执行者用不同模型」成为可表达的，那正是独立性
 * 需要的东西（大纲 §46 要求框架不绑定模型）。
 *
 * 缺省为空：模型选择属于部署决定，运行时不替工程猜一个。没有路由时不实例化进程内执行者，
 * 只留下会话型执行者——不猜模型比猜错模型好。
 *
 * @param {object} adapter - 项目适配器。
 * @returns {Record<string, {provider: string, model: string}>}
 */
function providerRoutesFor(adapter) {
  const declared = adapter?.execution?.provider_routes
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    return declared
  }
  return {}
}

/**
 * 一个语义角色这次该跑在哪个模型上（原生子会话路径）。
 *
 * 两套键空间各管一条路径，**不混用**：`provider_routes` 的键是执行者名（进程内执行者按名字路由），
 * 而原生子会话路径上只有一个执行者覆盖全部节点，能区分它们的只有**角色**。所以这里是
 * `execution.role_routes`：先按角色精确匹配，再退到 `*`（所有角色的缺省），都没有就返回
 * `undefined` —— 那表示**继承父会话**，而不是「清空路由」。
 *
 * @param {object|undefined} adapter
 * @param {string} role
 * @returns {object|undefined}
 */
export function roleRouteFor(adapter, role) {
  const declared = adapter?.execution?.role_routes
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return undefined
  const exact = declared[role]
  if (exact !== undefined) return exact
  return declared['*']
}


/**
 * 安装 GAC 写作用域闸门及其声明工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  // 由一个地方解析会话的工程根目录，这样作用域匹配器、适配器查找和诊断视图
  // 就永远不会对工程在哪里产生分歧。
  const rootOf = (sessionId) => {
    try {
      return projectRootFromCwd(ctx.sessions?.get?.(sessionId)?.header?.cwd)
    } catch {
      return undefined
    }
  }

  // 核心与收权器必须**一起**造、一起接（见 createRuntime 的注释）：它们曾经各自都在却没有连上，
  // 于是收权降级到 guard-only 时兜底那一层根本不存在，`write` 照写不误——914 条单测全绿。
  //
  // `childRoleOf` 先放一个空实现、等两张表建好再改绑真身：门禁只在**工具调用时**执行，那时
  // `apply` 早已跑完，因此不存在读到空实现的窗口；而这样可以让核心在 `childBindings`（它需要
  // `core.registry`）之前就造出来，不必为了接线把两者的构造顺序绕成一团。
  let childRoleOf = () => undefined
  // 协调者写保护同样先放一个空实现、等 `adapterFor` 建好再改绑真身。这里的「先空后绑」比
  // `childRoleOf` 那一处更必要：`adapterFor` 依赖 `state`，而 `state` 依赖 `core.registry`——
  // 真的要在构造期取到它，就得把三者的构造顺序绕成一团，而门禁只在**工具调用时**执行。
  let coordinatorWriteOf = () => undefined
  const { core, roleGuard } = createRuntime({
    rootOf,
    // 收权只作用于**那个 agent 自己**：拿插件根上下文的服务去收权，收的是所有人。
    toolsFor: (_sessionId, agent) => agent?.ctx?.tools,
    onEvent: (record) => report(record),
    // 语义角色判定：`bindings` 覆盖**每一个** GAC 子会话（含只读节点，见 `declareRole`），所以它是
    // 这一问的唯一来源；`child-surface` 的 `roleOf` 只覆盖拿到 `localAgent` 的那些，作为兜底。
    childRoleFor: (sessionId) => childRoleOf(sessionId),
    coordinatorWriteFor: (agent, sessionId) => coordinatorWriteOf(agent, sessionId),
  })
  // 子会话的授权绑定。**它写的就是核心那张作用域注册表**（`core.registry`），不另造一张表：
  // 判定逻辑在守卫里已经齐了，缺的只是「运行时代替子会话声明一次」。
  const childBindings = createChildBindings({ registry: core.registry })
  const state = new ProjectState({ resolveRoot: rootOf })

  // 每个工程根目录一个占用声明存储，按需创建并在会话之间共享，因为它所防止的冲突
  // 发生在彼此毫无所知的会话之间。存活状态来自活的会话注册表，这样一个已经离去的
  // 会话的占用声明就会停止阻塞写入者；当该注册表不可用时，存储会保留占用声明，
  // 而不是把它们猜成已死。
  const claimStores = new Map()
  const claimStoreFor = (root) => {
    let store = claimStores.get(root)
    if (store === undefined) {
      store = new ClaimStore({
        root,
        liveSessions: () => {
          try {
            const sessions = ctx.sessions?.list?.()
            return Array.isArray(sessions) ? sessions.map((session) => session?.id) : undefined
          } catch {
            return undefined
          }
        },
      })
      claimStores.set(root, store)
    }
    return store
  }

  // 每个工程根目录一个任务存储。任务按项目存放而非按会话：同一个需求的多个节点会由
  // 不同执行者推进，若按会话存放，接力时就读不到前一段的状态。
  const taskStores = new Map()
  const taskStoreFor = (root) => {
    let store = taskStores.get(root)
    if (store === undefined) {
      store = new TaskStore({ root })
      taskStores.set(root, store)
    }
    return store
  }

  // 项目适配器按根目录缓存，路由与执行者都要读它。
  const adapterFor = (root) => {
    const loaded = state.loadAdapter(root)
    return loaded.status === 'loaded' ? loaded.adapter : undefined
  }

  // 协调者写保护的真身：**主会话**不得直接改工程声明的受保护路径。
  const operationStores = new Map()
  const operationsFor = (root) => {
    if (!root) return undefined
    if (!operationStores.has(root)) operationStores.set(root, new OperationStore({ root, claims: claimStoreFor(root), activeTasks: () => taskStoreFor(root).list() }))
    return operationStores.get(root)
  }
  const askFor = (exec) => {
    const questions = ctx.get?.('userQuestions') ?? ctx.userQuestions
    if (!questions?.ask) return undefined
    return async (record) => {
      const id = `upgrade-${record.operation_id}-${record.revision}`
      const reply = await questions.ask({ agent: exec.agent, signal: exec.signal, wait: exec.call?.id ? { callId: exec.call.id } : undefined, questions: [{ id, question: `是否从 direct_edit 升级为 ${record.suggested_mode}？`, detail: `${record.assessment.behavior_summary}\n依据：${JSON.stringify([...record.assessment.core_impacts, ...record.assessment.complexity_reasons])}\n范围：${record.assessment.target_paths.join('、')}\n新增工作：${record.suggested_mode === 'high_risk_task' ? '四类设计、设计批准、独立实施、验证与复核' : '独立实施和验证'}`, options: [{ label: '同意升级' }, { label: '拒绝升级' }] }] })
      return { ...reply.answers?.find((answer) => answer.id === id), answer_ref: id }
    }
  }
  coordinatorWriteOf = (agent, sessionId) => {
    const root = rootOf(sessionId)
    if (root === undefined) return undefined
    const adapter = adapterFor(root)
    const policy = coordinatorWritePolicy({ authority: adapter?.authority, agent })
    if (agent?.session?.header?.parentSession !== undefined || agent?.session?.header?.origin === 'subagent' || !adapter) return policy
    const operation = operationsFor(root).current(sessionId)
    const active = taskStoreFor(root).list().some((task) => task.owner_session_id === sessionId && task.status !== 'completed')
    if (!active && operation && !['active_standard', 'active_high_risk'].includes(operation.status)) return { protected_paths: [], operation }
    return policy
  }

  // 本次可用的执行者。进程内执行者只能承载「只回传报告」的节点，因为它没有写入工具；
  // 需要落盘的节点由**原生子会话执行者**承载（工程在适配器里打开 `execution.native_child_dispatch`
  // 时），否则由会话型执行者承载并如实登记为待会话执行——而不是伪造一份没写任何文件的成功报告。
  //
  // 按根目录取而不是全局取：模型路由是工程在适配器里声明的，不同工程可以不同。
  const executorsFor = (root) => {
    const routes = providerRoutesFor(adapterFor(root))
    const session = createSessionExecutor()
    const child = adapterFor(root)?.execution?.native_child_dispatch === true
      // 子会话执行者排在**最前**：路由选中的名字往往只是适配器声明的执行者名（例如 `builder`），
      // 在运行时的执行者数组里找不到，于是 `invokeNode` 退到「第一个 supports(node) 的执行者」。
      // 要写文件的节点必须由它接住，否则就退回主会话——那正是这一阶段要结束的状态。
      // 接缝缺席时它自己会返回显式降级（不是静默落回），所以放在最前是安全的。
      ? [createChildExecutor({
        subagentsFor: () => ctx.get?.('subagents'),
        // 第 1 层名单来源：父会话的**可收集合**。子会话会 join 父会话的 preset，所以这份集合是子会话
        // 继承面的安全子集；但它**不是**子会话可收集合的全体——父会话自己那层注册的工具对子会话而言
        // 是祖先贡献，可收却不在父会话名单里。那部分（以及内核保留名 `run_code`）由第 2 层接住，
        // 见下面的 `surface`。
        namesFor: (agent) => restrictableNamesOf(agent?.ctx?.tools, agent),
        // 第 2 层：`start()` 之后以子会话**自己的**真实视图对账补收 + 装单调守卫。拿不到
        // `localAgent`（进程外 provider）时它记一条 `child-surface-unavailable`，不假装收过。
        surface: surfaceFor(root),
        // 授权绑定：运行时代替子会话往**同一张**作用域注册表里声明，守卫那一行都不用改。
        bindings: childBindings,
        // 设计节点要用已冻结的接口契约推导方案（需求侧事实），因此按根目录取一次契约给它。
        contractFor: (taskId) => taskStoreFor(root).loadContract(taskId),
        // 验证执行节点要执行**已冻结的计划**，所以把计划原样交给它（连同计划 id）。
        planFor: (taskId) => taskStoreFor(root).loadPlan(taskId),
        // 原生子会话的模型路由：按**语义角色**取（`execution.role_routes`，`*` 是所有角色的缺省）。
        // 没有声明就返回 undefined，子会话继承父会话——**不传空对象**（那会把父会话的模型也清掉）。
        routeFor: (role) => roleRouteFor(adapterFor(root), role),
      })]
      : []
    if (Object.keys(routes).length === 0) {
      // 未声明路由时不猜模型：只提供会话执行者，让进程内执行者缺席。
      return [...child, session]
    }
    return [
      ...child,
      // 名字逐字取路由的键，派遣时才能按名字找到它。
      ...createRoutedExecutors({ routes, llmFor: () => ctx.llm }),
      session,
    ]
  }

  // 每个工程根目录一个证据日志。只追加、由运行时发号：能被调用方指定的号就也能被编造。
  const evidenceLogs = new Map()
  const evidenceLogFor = (root) => {
    let log = evidenceLogs.get(root)
    if (log === undefined) {
      log = new EvidenceLog({ root })
      evidenceLogs.set(root, log)
    }
    return log
  }

  // 每个工程根目录一个 GAC 事件日志。**注意它写的是工程自己的目录，不是会话日志**——写进会话
  // 日志会让那份会话再也读不出来（见 `lib/gac-event-log.js` 的模块注释）。
  const gacEventLogs = new Map()
  const gacEventLogFor = (root) => {
    let log = gacEventLogs.get(root)
    if (log === undefined) {
      log = new GacEventLog({ root })
      gacEventLogs.set(root, log)
    }
    return log
  }

  // 把子会话工具面的登记结果译成审计事件。**这件事本身就是收口要求**：「设计节点看不到 read」
  // 若只在内存里成立，事后就没有任何东西能证明它——那与子会话自己说「我没读实现」没有区别。
  // 译不进形状的事件不写（`compileGacEvent` 会拒），所以这里只译两种：完整登记与缺口。
  const surfaceEventFor = (record) => {
    const role = record?.role ?? 'implementation'
    if (record?.code === SURFACE_CODES.SURFACE_RECORDED) {
      return {
        type: 'gac/child-surface',
        data: {
          child_session_id: record.child_session_id,
          role,
          mode: record.mode,
          presented_tools: Array.isArray(record.presented_tools) ? record.presented_tools : [],
          removed_tools: Array.isArray(record.removed_tools) ? record.removed_tools : [],
          local_agent: record.local_agent === true,
        },
      }
    }
    if (record?.code === SURFACE_CODES.SURFACE_LIFTED) return undefined
    if (typeof record?.code !== 'string') return undefined
    return {
      type: 'gac/child-surface-gap',
      data: {
        child_session_id: typeof record.child_session_id === 'string' ? record.child_session_id : '',
        role,
        code: record.code,
        reason: typeof record.reason === 'string' && record.reason !== ''
          ? record.reason
          : typeof record.note === 'string' ? record.note : '',
      },
    }
  }

  // 每个工程根目录一个子会话工具面登记处。它按**子会话自己的**视图对账补收，并装上单调守卫——
  // 创建窗口的 `toolFilter` 结构上点不到子会话自己那层注册的工具（宿主的 Team 工具），也点不到
  // 内核按名字保留的 `run_code`，那两样只能在这里接住。
  const childSurfaces = new Map()
  const surfaceFor = (root) => {
    let surface = childSurfaces.get(root)
    if (surface === undefined) {
      surface = createChildSurface({
        onEvent: (record) => {
          const event = surfaceEventFor(record)
          if (event === undefined) return
          try {
            gacEventLogFor(root).record({
              session_id: event.data.child_session_id,
              tool: 'subagent',
              events: [event],
            })
          } catch (error) {
            // 审计写不进去不该改变派遣的结论（它已经发生了），但也不能静默——落进加载报告。
            report({
              event: 'child-surface-record-failed',
              root,
              code: record?.code,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
        },
      })
      childSurfaces.set(root, surface)
    }
    return surface
  }

  // 语义角色判定的真身：`bindings` 覆盖每一个 GAC 子会话（含只读节点），`surface` 覆盖拿到
  // `localAgent` 的那些。两者都查——只读设计节点正是「没有写作用域绑定、却必须有角色」的那一档。
  //
  // 返回的是**登记条目**而不是裸角色名：门禁除了拿它判工具面，还要把 `task_id` / `node_id` /
  // `dispatch_id` / `child_session_id` 写进拒因，模型才知道是哪一次派遣被拒。裸名字会让
  // `roleEntry.role` 读成 `undefined`，于是**每个**子会话都按最保守的那一档判定（`read` 全被拒）
  // ——这条正是靠「返回条目」而不是靠单测兜住的，所以注释写在这里。
  childRoleOf = (sessionId) => {
    const bound = childBindings.roleOf(sessionId)
    if (bound !== undefined) return bound
    const root = rootOf(sessionId)
    if (typeof root !== 'string' || root === '') return undefined
    const record = surfaceFor(root).inspect(sessionId)
    if (record === undefined) return undefined
    // `task_id` / `node_id` 取自这份记录带着的那份写作用域绑定：拒因要说得出「哪次任务、哪个节点」，
    // 而这条退回路径（角色登记拿不到时）只有绑定里有它们。
    const writeBinding = record.binding ?? {}
    return {
      child_session_id: record.child_session_id,
      task_id: writeBinding.task_id,
      node_id: writeBinding.node_id,
      role: record.role,
      write_scope: record.write_scope,
    }
  }

  const observed = { calls: 0, denials: 0 }

  /**
   * 「调用方没给摘要」的哨兵值。
   *
   * 不能拿 `undefined` 兼任这个含义：那样「等过了、还是空」会被当成「没读」，于是又去读一次——
   * 等待本身就无法验证了。实测踩到过：一条回归测试对「去掉等待」这个突变不敏感。
   */
  const SUMMARY_NOT_PROVIDED = Symbol('gac.witness.summary-not-provided')

  /**
   * 收到一轮工作区变更：读那一轮的摘要，然后记账。
   *
   * **读摘要不能只读一次。** 生产者先 `session.append("workspace/changes", …)`、**再**把摘要按
   * `event.seq` 存进自己的记录表，而 `append` 会**同步**发布本事件——也就是说这个函数正跑在
   * 「事件已存在、摘要还没存」的那一瞬间。真实事故：会话日志里 seq 8560 的 `workspace/changes`
   * 确实存在，而加载报告对**同一个 seq** 记的是 `witness-summary-missing`——不是没有变更，是读得
   * 太早。所以先同步试一次（宿主若在存完摘要之后才发布，就走这条快路），没有再**让出几步**重读
   * （推理与失败模式见 `readWitnessSummary`）。
   *
   * @param {string} sessionId
   * @param {object} event - 会话事件，载荷里只有 `turn`。
   * @returns {void}
   */
  function observeWorkspaceChanges(sessionId, event) {
    const read = () => workspaceChanges?.summary?.(sessionId, event.seq)

    let first
    try {
      first = read()
    } catch {
      first = undefined
    }
    if (first !== undefined) {
      settleWorkspaceChanges(sessionId, event, first)
      return
    }

    void readWitnessSummary({ read }).then((found) => {
      settleWorkspaceChanges(sessionId, event, found?.summary)
    })
  }

  /**
   * 把读到的摘要交出去判定；读不到就如实记缺失。
   *
   * 观测是旁观行为：它出问题时不该让会话的事件发布跟着失败，只该在加载报告里留痕。
   *
   * @param {string} sessionId
   * @param {object} event
   * @param {unknown} summary
   * @returns {void}
   */
  function settleWorkspaceChanges(sessionId, event, summary) {
    try {
      recordWorkspaceChanges(sessionId, event, summary)
    } catch (error) {
      report({
        event: 'witness-failed',
        session: sessionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 把一轮工作区变更记成一条证据，并把报告出口写出去。
   *
   * 判断全在纯模块里（`composeWitnessRecord`），这里只做连接：取服务、判根、落证据、写报告。
   * 决定留在宿主形状里是上一次的教训——那种代码只能在活的 harness 里验，而它恰恰最不该带着
   * 未验证的判断上线。
   *
   * 顺序上先判「这个工程纳不纳管」，再取那一轮的摘要：未纳管的工程不该在报告里留下
   * 「摘要取不到」的噪声，那会把真正取不到摘要的那一次淹掉。
   *
   * **「调用方给了空」与「调用方没给」必须分开。** 前者是「等过了、还是没有」，那就该如实记缺失，
   * 不能再偷偷读一次——那一读会让「等了几步」这件事变得无法验证（回归测试会因此对「去掉等待」
   * 这个改动不敏感，实测踩到过）。
   *
   * @param {string} sessionId
   * @param {object} event - 会话事件，载荷里只有 `turn`。
   * @param {unknown} [provided] - 已经等过的摘要；**缺省**时自己读一次。
   * @returns {void}
   */
  function recordWorkspaceChanges(sessionId, event, provided = SUMMARY_NOT_PROVIDED) {
    const root = rootOf(sessionId)
    if (typeof root !== 'string' || root === '') return
    if (adapterFor(root) === undefined) return

    const summary = provided === SUMMARY_NOT_PROVIDED
      ? workspaceChanges?.summary?.(sessionId, event.seq)
      : provided
    if (summary === undefined) {
      // 取不到摘要不记证据：把「宿主没给」当成「这一轮什么都没改」，恰好是会放过越界的方向。
      report({ event: 'witness-summary-missing', session: sessionId, seq: event.seq })
      return
    }

    const session = ctx.sessions?.get?.(sessionId)
    const governing = resolveGoverningSession(sessionId, {
      headerFor: (id) => ctx.sessions?.get?.(id)?.header,
      scopeFor: (id) => core.registry.get(id),
    })
    const composed = composeWitnessRecord(compileWitnessSummary(summary), {
      // 借用先代会话已声明的写作用域：子会话对同一个工程的改动属于同一次任务。
      scope: governing.scope?.write_scope,
      root,
      cwd: session?.header?.cwd ?? summary.cwd,
      // **谁在治理这次改动**：没找到任何声明时不写这个字段——「没有治理会话」是真实情形
      // （未受治理的改动），写一个空值或写成自己都会让事后复核误以为当时有治理。
      ...(governing.scope === undefined ? {} : { governingSessionId: governing.session_id }),
      // 任务与节点取自**被借用的那份声明**：写作用域的声明里带着 task_id / node_id（无论是
      // `gac_scope` 声明的还是运行时给子会话绑定的），因此这里不必再猜。
      ...(typeof governing.scope?.task_id === 'string' ? { taskId: governing.scope.task_id } : {}),
      ...(typeof governing.scope?.node_id === 'string' ? { nodeId: governing.scope.node_id } : {}),
    })
    for (const entry of composed.reports) report({ ...entry, session: sessionId })
    evidenceLogFor(root).record({
      session_id: sessionId,
      tool: WITNESS_SOURCE,
      source: WITNESS_SOURCE,
      is_error: false,
      value: composed.facts,
      workspace: composed.facts,
    })
  }

  // 生产能力核对（**契约的执行点**）：占位实现先放在这里，因为工具注册在 `registerTools` 里、
  // 而发生在这个 `apply` 里——注册时拿到的是这个包装函数，真正被调用时才读 holder。真实的接缝状态
  // （`childSeam` / `seamAvailable`）要到下面才算得出来，所以不能直接引用。
  //
  // 为什么不让 `registerTools` 自己去问 `ctx.get`：那样每个工具都得知道「哪个接缝算哪项能力」，
  // 而这张映射表只有一处（`lib/capabilities.js`）。参数化也让它像 `roleGuard` 一样**必须被接线**——
  // 一个没被读到的参数曾经逃过整套测试（见 `registerTools` 的注释），所以接线本身有测试钉着。
  let capabilityStatus = () => Object.freeze({ ok: true, required: [], missing: [] })

  /**
   * 生产能力核对（在 `apply` 的 effect 里被替换成真实实现）。
   *
   * @param {string} root
   * @returns {Readonly<{ok: boolean, required: string[], missing: object[]}>}
   */
  function capabilityStatusFor(root) {
    return capabilityStatus(root)
  }

  // 指标要能说出「观测源此刻在不在」——否则「0 轮观测」与「真的没有越界改动」在读数上分不开，
  // 而 0 恰好是想要的那个数。默认返回 `undefined`（**不宣称在场**）：万一赋值没跑到，报告宁可说
  // 「未被告知」，也不该在这一点上显得笃定。
  let observationAvailable = () => undefined

  /**
   * 观测源是否在场（在 effect 里被替换成真实实现）。
   *
   * @returns {boolean|undefined}
   */
  function observationAvailableFor() {
    return observationAvailable()
  }

  const tools = await registerTools(ctx, {
    core,
    state,
    operationsFor,
    askFor,
    claimStoreFor,
    taskStoreFor,
    evidenceLogFor,
    rootOf,
    adapterFor,
    executorsFor,
    roleGuard,
    capabilitiesFor: capabilityStatusFor,
    observationAvailableFor,
    // 审计视图的时间线来源。定义在 `apply` 里（`gacEventLogFor`），而注册在 `registerTools` 里，
    // 所以必须当参数传过去——不然 `audit` 动作会在真实插件里抛「未定义」。
    eventLogFor: gacEventLogFor,
    // 豁免的签发要进 GAC 自己的审计日志（`.dsh/gac/events/`），**不是**会话日志：写进会话日志
    // 会让那份会话再也读不出来（见 lib/gac-event-log.js 的模块注释）。
    onScopeEvent: (record) => {
      const root = record?.root
      if (typeof root !== 'string' || root === '') return
      try {
        gacEventLogFor(root).record({
          session_id: record.session_id,
          tool: SCOPE_TOOL_NAME,
          events: [{
            type: 'gac/coordinator-override',
            data: {
              session_id: record.session_id,
              reason: typeof record.reason === 'string' ? record.reason : '',
              granted: record.granted === true,
            },
          }],
        })
      } catch (error) {
        // 审计写不进去不该让这次调用失败（豁免已经签发），但也不能静默——落进加载报告。
        report({
          event: 'scope-audit-failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })

  // 系统提示段落：把「此刻声明了什么」放进模型视野（文本与保命性质见 lib/prompt-section.js）。
  //
  // 用 `ctx.inject` 而不是把 `systemPrompt` 加进本插件的 `inject` 列表，是因为**门禁不依赖
  // 提示服务，只有提示文本依赖它**。若写成硬依赖，一个没有该服务的组合会让整个插件连同写
  // 作用域闸门一起不加载——少一段提示换来少一道强制，那是拿安全去换可读性。这也是它注册在
  // apply 里、而不是放进下面那个 effect 生成器里的原因：inject 的回调随插件 fiber 一起销毁。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section(createPromptSection({
      modeFor: (sessionId) => state.modeFor(sessionId),
      scopeFor: (sessionId) => core.registry.get(sessionId),
      adapterFor: (sessionId) => {
        const root = rootOf(sessionId)
        return root === undefined ? undefined : adapterFor(root)
      },
      // 子会话的判据取**宿主会话头**（`parentSession` / `origin: 'subagent'`），不是取绑定：
      // 只读的子会话按设计不绑作用域，可它同样需要那套「你的授权不是你自己声明的」的话。
      childFor: (_sessionId, agent) => {
        const header = agent?.session?.header
        return header?.parentSession !== undefined || header?.origin === 'subagent'
      },
      // 段落读状态失败时只会变成空串（装配必须拿到字符串），这里留下的是唯一痕迹。
      onError: (error) => report({
        event: 'prompt-section-failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    }))
    report({
      event: 'prompt-section-registered',
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      interpolate: false,
    })
  })

  // 工作区观测的事件源（适配计划 §3.3）：把「这一轮实际改了哪些文件」记成一条证据。
  //
  // 依赖用 `ctx.inject` 而不是写进本插件的 `inject` 列表：`workspaceChanges` 由另一个插件
  // （`@deepseek-ai/dsh-workspace-changes`）提供，而本机 profile 目前**没有装配**它——事件
  // 类型 `workspace/changes` 是已知类型，但没有任何东西会追加它。写进 `inject` 会让整个插件
  // （连同写作用域闸门）不加载，那是拿一道强制执行去换一个可选的观测源，方向反了。
  //
  // 缺席时这一层是**惰性**的：照常加载、照常订阅，只是没有事件到达。
  let workspaceChanges
  ctx.inject(['workspaceChanges'], (workspaceCtx) => {
    workspaceChanges = workspaceCtx.workspaceChanges
  })

  // 这条诊断必须写在 inject **之外**，而且是实测逼出来的：`ctx.inject` 的回调在服务缺席时
  // 根本不会执行，于是把它放在回调里，恰恰会在它最该出现的时候——服务缺席、这一层是惰性的
  // ——一条也留不下。实测踩到过：加载报告里 210 条 plugin-loaded、0 条 witness-seam，而当时
  // 这个源正是不在的。`ctx.get` 在服务没提供时返回 undefined，因此它问得出真相。
  let seamAvailable = false
  try {
    seamAvailable = typeof ctx.get?.('workspaceChanges')?.summary === 'function'
  } catch {
    // 反射层在受限组合里可能拒绝这个查询：那就按「不在」报告，而不是让加载失败。
    seamAvailable = false
  }
  report({
    event: 'witness-seam',
    available: seamAvailable,
    note: '工作区观测的事件源；缺席时这一层照常加载但不会收到任何事件',
  })

  // 子会话接缝的可用性。与 `witness-seam` 同一个形态：**接缝缺席要留痕**。这一条尤其要紧——
  // `execution.native_child_dispatch` 打开后，需要写文件的节点本该交给一个真子会话；如果接缝其实
  // 不在，节点会退回主会话执行，而「派遣已经交给子会话了」就成了一句没有依据的话（本仓库在观测源
  // 上吃过这个亏）。同样写在 inject 之外：`ctx.get` 在服务缺席时返回 undefined，问得出真相。
  const readSubagentsService = () => {
    try {
      return ctx.get?.('subagents')
    } catch {
      // 反射层在受限组合里可能拒绝这个查询：那就按「不在」报告，而不是让加载失败。
      return undefined
    }
  }
  const childSeam = describeChildSeam(readSubagentsService())
  report({
    event: 'child-dispatch-seam',
    available: childSeam.available,
    provider: childSeam.provider,
    providers: childSeam.providers,
    ...(childSeam.reason === undefined ? {} : { reason: childSeam.reason }),
    note: '原生子会话（GAC 的节点执行载体）；缺席时需要写文件的节点会退回主会话执行',
  })

  // **生产能力契约的执行点。** README 里那张表在此之前没有任何代码消费，而只写在文档里的契约会与
  // 代码漂移（本仓库在 `checkpoint` 那条上已经吃过一次）。这里把三件事接起来：
  //  1. 项目在适配器里声明它需要哪些能力（`execution.required_capabilities`）；
  //  2. 用**真实接缝状态**逐项核对，缺项写进加载报告（每个工程只报一次，不刷屏）；
  //  3. 高风险任务收口时，缺项未获显式豁免就拒绝收口（`lib/tool-task.js` 的那道门禁）。
  //
  // 核对发生在**第一次用到那个工程时**，不是插件加载时：加载那一刻还没有会话，拿不到工程根。
  // 环境本身的状态（两个接缝）在加载时就报了（`witness-seam` / `child-dispatch-seam`），
  // 因此「环境缺什么」在任何时刻都能从报告里读到，这里报的是「**这个工程**缺什么」。
  // 每个工程只报一次「能力核对」的结果：这段代码在每次工具调用时都会被问，不记忆就会把报告刷满。
  const capabilityChecked = new Set()
  // 指标那边要的是**环境事实**（源在不在），与「这个工程声明了什么」无关，所以单独给它一个真值。
  observationAvailable = () => seamAvailable
  capabilityStatus = (root) => {
    const adapter = adapterFor(root)
    const requirements = adapter?.execution?.required_capabilities ?? []
    const status = checkCapabilities(requirements, {
      childDispatch: childSeam.available,
      workspaceObservation: seamAvailable,
    })
    if (typeof root === 'string' && root !== '' && requirements.length > 0 && !capabilityChecked.has(root)) {
      capabilityChecked.add(root)
      report({
        event: 'capability-check',
        root,
        required: [...status.required],
        missing: status.missing.map((gap) => gap.id),
        ok: status.ok,
        note: status.ok
          ? '本工程声明需要的生产能力都在场'
          : '有声明需要的能力不在场；高风险任务收口时缺项未获显式豁免会被拒绝',
      })
    }
    return status
  }

  // **生产能力契约的执行点。** README 里那张表在此之前没有任何代码消费，而只写在文档里的契约会与
  // 代码漂移（本仓库在 `checkpoint` 那条上已经吃过一次）。这里把三件事接起来：
  //  1. 项目在适配器里声明它需要哪些能力（`execution.required_capabilities`）；
  //  2. 用**真实接缝状态**逐项核对，缺项写进加载报告（每个工程只报一次，不刷屏）；
  //  3. 高风险任务收口时，缺项未获显式豁免就拒绝收口（`lib/tool-task.js` 的那道门禁）。
  //
  // 核对发生在**第一次用到那个工程时**，不是插件加载时：加载那一刻还没有会话，拿不到工程根。
  // 环境本身的状态（两个接缝）在加载时就报了（`witness-seam` / `child-dispatch-seam`），
  // 因此「环境缺什么」在任何时刻都能从报告里读到，这里报的是「**这个工程**缺什么」。
  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', (exec) => {
      observed.calls += 1
      // 生产能力核对：**第一次用到某个工程时**做一次（按工程记忆，不刷屏）。放在这里而不是只在收口
      // 时做，是因为环境问题应当在它发生的那一刻就可见——等到一次高风险收口失败才知道，太晚。
      // 核对失败绝不影响门禁判定：那是诊断，不是强制执行。
      try {
        const sessionId = exec?.agent?.session?.id
        const root = typeof sessionId === 'string' ? rootOf(sessionId) : undefined
        if (root !== undefined) capabilityStatusFor(root)
      } catch {
        // 诊断自己出问题时保持沉默：门禁该怎么判还怎么判。
      }
      const decision = core.preExecute(exec)
      if (decision.kind === 'deny') {
        observed.denials += 1
        report({
          event: 'guard-denied',
          tool: exec?.name,
          session: exec?.agent?.session?.id,
          code: decision.info?.code,
          reason: decision.reason,
        })
      }
      return decision
    }, { prepend: true })

    // 无论是否发生升级，执行模式的声明都会被记录，因为升级路径是一个值得事后
    // 审计的策略决定。
    yield ctx.on('tools/result', (exec) => {
      if (exec?.name !== PROJECT_TOOL_NAME) return
      const sessionId = exec?.agent?.session?.id
      const mode = state.modeFor(sessionId)
      if (mode === undefined) return
      report({
        event: 'mode-declared',
        session: sessionId,
        mode: mode.mode,
        declared_mode: mode.declared_mode,
        escalated: mode.escalated,
        risk: mode.risk,
        unchecked: mode.unchecked === true,
      })
    })

    // 证据采集：把每次工具调用的最终结果如实记下，供验证层核对引用。
    //
    // 采集条件是**这个工程已纳管**（有适配器），而不是「本会话已声明过什么」。
    //
    // 早先按会话判定（声明了写作用域或执行模式），结果是采集会在插件重载后**静默停止**：
    // 那两种声明都是内存里的状态，重载即丢失，而采集器照旧安静地什么都不记。于是模型继续
    // 干活、以为证据在落盘，直到收口时才被「运行时没有发出过这个证据号」拒绝，而那时没有任何
    // 线索指向真正的原因。实测踩到过：重载后连跑两轮测试，日志条数一条没涨。
    //
    // 工程是否纳管是**盘上的事实**（.dsh/gac/project.json 在不在），因此它跨重载稳定。
    // 代价是纳管工程里的每次工具调用都落一条盘——这个代价是可接受的：证据日志本就该是这个
    // 工程的审计轨迹，而按会话判定的那点「干净」换来的是一个查不出来的静默失效。
    yield ctx.on('tools/result', (exec, result) => {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string') return
      const root = rootOf(sessionId)
      if (typeof root !== 'string' || root === '') return
      // 未纳管的工程不采集：没有适配器就没有 GAC，也就没有要核对的收口。
      if (adapterFor(root) === undefined) return
      // 采集本身不能影响工具结果：它只是旁观者，出问题时也只是一个旁观者出问题。
      try {
        evidenceLogFor(root).record({
          session_id: sessionId,
          tool: exec?.name,
          arguments: exec?.arguments,
          value: result?.isError === true ? undefined : result?.value,
          is_error: result?.isError === true,
          error_code: result?.isError === true ? result?.error?.info?.code : undefined,
        })
      } catch (error) {
        report({
          event: 'evidence-capture-failed',
          session: sessionId,
          tool: exec?.name,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })

    // GAC 事件：写进**工程自己**的追加文件，绝不写进会话日志。
    //
    // 这里是本次事故的修复点。原实现是 `session.append('gac/…', …)`，理由是「让 GAC 事件出现在
    // 对话历史里」——漏掉了读回日志的人未必装着这个插件，而会话日志的事件词表是宿主**构建期生成**
    // 的、`append` 又没有任何途径打 `ignorable` 标记。持久化层于是拒读整份日志
    // （`dsh-session-persistence` 的 `validateStoredEvents`），代价是**那份会话再也打不开**：
    // 实测本工程含 GAC 事件的会话全部中招，界面上就是「子智能体历史全部显示不出来，点进去报错」。
    // 审计信息写在工程自己的目录里，既不依赖宿主词表，也不影响任何会话的可读性。
    //
    // 追加仍是**旁观行为**：出问题也不能影响工具结果或 GAC 的判断，因此整体包在 try 里。
    yield ctx.on('tools/result', (exec, result) => {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string') return
      let pending
      let root
      try {
        root = rootOf(sessionId)
        if (typeof root !== 'string' || root === '') return
        pending = gacEventsFrom(exec?.name, result, {
          root,
          storeFor: taskStoreFor,
          adapterFor,
        })
      } catch (error) {
        report({
          event: 'gac-event-build-failed',
          session: sessionId,
          tool: exec?.name,
          reason: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (pending.length === 0) return
      try {
        gacEventLogFor(root).record({
          session_id: sessionId,
          tool: exec?.name,
          events: pending,
        })
      } catch (error) {
        report({
          event: 'gac-event-record-failed',
          session: sessionId,
          tool: exec?.name,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    })

    // 工作区观测：每一轮结束后的变更集记成一条证据。
    //
    // 订阅的是**会话事件**而不是工具调用：这一轮实际改了哪些文件由宿主在回合结束时算好，
    // 工具调用层面看不见——一次 `pwsh` 里的重定向目标、一次代码生成器写出的文件，在参数里
    // 都读不出来。这正是适配计划 §3.3 让原 `witness.py` 整体退役、改订阅现成观测源的理由。
    //
    // 只做事后观测，绝不阻断任何工具调用：越界改动在发现时已经发生，此时拒绝那次调用既拦不住
    // 它，还会把「事后可查」变成「事后不可查」。发现走证据、加载报告、指标三个出口。
    //
    // 刻意**不**把发现追加进会话事件日志：本监听器正跑在会话事件的发布路径上，在那里再
    // `append` 会撞上重入保护（契约把这一条写进了 non_goals）。
    yield ctx.on('session/event', (session, event) => {
      if (event?.type !== 'workspace/changes') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      observeWorkspaceChanges(sessionId, event)
    })

    // 这里刻意**没有**消息投影注册。会话日志只保留宿主自己的事件类型；把插件自有事件投影进
    // 对话历史的做法已经撤掉，理由是它同时踩了两条：外部插件的类型永远不在宿主的构建期词表里，
    // 而且该类型一旦写进日志就会让整份日志被拒读（详见 `lib/gac-event-log.js` 的模块注释）。
    // 审计事件的读者是 `gac_evidence`、工程自己的 events.jsonl 与加载报告。

    report({
      event: 'plugin-loaded',
      services: { tools: ctx.tools !== undefined, sessions: ctx.sessions !== undefined },
      scope_tool: tools.status,
      scope_tool_note: tools.note,
      registered_tools: tools.tools,
      enforcement: tools.status === 'registered'
        ? '生效中 —— 已声明的写作用域会在派遣前强制执行'
        : '门禁已装载，但没有声明工具，因此没有会话可被管辖',
    })

    yield () => {
      // 收权必须先撤：留着它等于让那个会话永远失去写入工具——「把自己关在门外」的同一个形状，
      // 只是这次关的是用户，而且是在插件重载之后。
      const lifted = roleGuard.liftAll()
      report({ event: 'plugin-unloaded', observed, role_revocations_lifted: lifted })
    }
  }, 'gac-runtime lifecycle')
}
