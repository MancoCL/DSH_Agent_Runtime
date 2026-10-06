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
import { createGacCore } from './plugin.js'
import { projectRootFromCwd } from './path-utils.js'
import { ProjectState } from './project-state.js'
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, createPromptSection } from './prompt-section.js'
import { createRoleGuard, restrictableNamesOf } from './role-guard.js'
import { TaskStore } from './task-store.js'
import { describeResolutionFailure, importDshPackage } from './resolve-dsh.js'
import { TASK_TOOL_NAME, createTaskTool } from './tool-task.js'
import { EVIDENCE_TOOL_NAME, createEvidenceTool } from './tool-evidence.js'
import { METRICS_TOOL_NAME, createMetricsTool } from './tool-metrics.js'
import { PROJECT_TOOL_NAME, createProjectTool } from './tool-project.js'
import { SCOPE_TOOL_NAME, createScopeTool } from './tool-scope.js'
import {
  WITNESS_SOURCE,
  compileWitnessSummary,
  composeWitnessRecord,
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
 * @returns {{core: object, roleGuard: object}}
 */
export function createRuntime({ rootOf, toolsFor, onEvent }) {
  const roleGuard = createRoleGuard({ toolsFor, onEvent })
  // `roleGuard` 必须**同时**交给核心：收权正常时工具不在视野里（内核返回 UNKNOWN_TOOL），而接缝
  // 缺席、或某些名字根本收不掉（作用域内注册的工具）时，门禁那一层是唯一让角色仍然成立的东西。
  const core = createGacCore({ resolveRoot: rootOf, roleGuard })
  return { core, roleGuard }
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
    ctx.tools.register(createProjectTool({ state, defineTool }))
    ctx.tools.register(createScopeTool({ core, defineTool, claimStoreFor, sessionRootFor: rootOf }))
    // `gac_task` 需要知道是哪个会话在推进任务，因为任务记录按项目而不是按会话存放。
    // adapterFor 与 executorsFor 让它不只是登记派遣，而是真的按能力路由并调用执行者。
    ctx.tools.register(createTaskTool({
      defineTool,
      taskStoreFor,
      sessionRootFor: rootOf,
      adapterFor,
      executorsFor,
      roleGuard,
      // 收口时用它核对验证报告里的证据引用：运行时没发过的号一律不认。
      evidenceFor: (root) => evidenceLogFor(root).load(),
    }))
    ctx.tools.register(createMetricsTool({
      defineTool,
      taskStoreFor,
      sessionRootFor: rootOf,
      evidenceFor: (root) => evidenceLogFor(root).load(),
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
  const { core, roleGuard } = createRuntime({
    rootOf,
    // 收权只作用于**那个 agent 自己**：拿插件根上下文的服务去收权，收的是所有人。
    toolsFor: (_sessionId, agent) => agent?.ctx?.tools,
    onEvent: (record) => report(record),
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
        // 角色工具面的名单来源：父会话的**可收集合**。子会话会 join 父会话的 preset，所以这份集合
        // 正是子会话继承面的安全子集；父会话自己那一层注册的工具（宿主的 Team 工具）不在里面，
        // 于是不会被点名——而 `restrict` 对不认识的名字会抛错、代价是整次子会话创建失败。
        namesFor: (agent) => restrictableNamesOf(agent?.ctx?.tools, agent),
        // 授权绑定：运行时代替子会话往**同一张**作用域注册表里声明，守卫那一行都不用改。
        bindings: childBindings,
        // 设计节点要用已冻结的接口契约推导方案（需求侧事实），因此按根目录取一次契约给它。
        contractFor: (taskId) => taskStoreFor(root).loadContract(taskId),
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

  const observed = { calls: 0, denials: 0 }

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
   * @param {string} sessionId
   * @param {object} event - 会话事件，载荷里只有 `turn`。
   * @returns {void}
   */
  function recordWorkspaceChanges(sessionId, event) {
    const root = rootOf(sessionId)
    if (typeof root !== 'string' || root === '') return
    if (adapterFor(root) === undefined) return

    const summary = workspaceChanges?.summary?.(sessionId, event.seq)
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

  const tools = await registerTools(ctx, {
    core,
    state,
    claimStoreFor,
    taskStoreFor,
    evidenceLogFor,
    rootOf,
    adapterFor,
    executorsFor,
    roleGuard,
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

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', (exec) => {
      observed.calls += 1
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
      try {
        recordWorkspaceChanges(sessionId, event)
      } catch (error) {
        // 观测是旁观行为：它出问题时不该让会话的事件发布跟着失败。
        report({
          event: 'witness-failed',
          session: sessionId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
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
