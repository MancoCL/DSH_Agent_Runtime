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
import { createRoutedExecutors, createSessionExecutor } from './executor.js'
import { createGacCore } from './plugin.js'
import { projectRootFromCwd } from './path-utils.js'
import { ProjectState } from './project-state.js'
import { TaskStore } from './task-store.js'
import { describeResolutionFailure, importDshPackage } from './resolve-dsh.js'
import { TASK_TOOL_NAME, createTaskTool } from './tool-task.js'
import { PROJECT_TOOL_NAME, createProjectTool } from './tool-project.js'
import { SCOPE_TOOL_NAME, createScopeTool } from './tool-scope.js'

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
 * @param {(sessionId: string) => string|undefined} deps.rootOf
 * @returns {Promise<{status: string, note: string, tools: string[]}>}
 */
async function registerTools(ctx, { core, state, claimStoreFor, taskStoreFor, rootOf, adapterFor, executorsFor }) {
  try {
    const toolsPackage = await importDshPackage('@deepseek-ai/dsh-tools')
    if (typeof toolsPackage?.defineTool !== 'function') {
      return {
        status: 'unavailable',
        note: describeResolutionFailure('@deepseek-ai/dsh-tools'),
        tools: [],
      }
    }
    const defineTool = toolsPackage.defineTool
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
    }))
    return {
      status: 'registered',
      note: 'execution mode, write scope and task DAG can be declared; dispatch routes and invokes',
      tools: [PROJECT_TOOL_NAME, SCOPE_TOOL_NAME, TASK_TOOL_NAME],
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

  const core = createGacCore({ resolveRoot: rootOf })
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
  // 需要落盘的节点由会话型执行者承载，它会如实登记为待会话执行，而不是伪造一份没写
  // 任何文件的成功报告。
  //
  // 按根目录取而不是全局取：模型路由是工程在适配器里声明的，不同工程可以不同。
  const executorsFor = (root) => {
    const routes = providerRoutesFor(adapterFor(root))
    const session = createSessionExecutor()
    if (Object.keys(routes).length === 0) {
      // 未声明路由时不猜模型：只提供会话执行者，让进程内执行者缺席。
      return [session]
    }
    return [
      // 名字逐字取路由的键，派遣时才能按名字找到它。
      ...createRoutedExecutors({ routes, llmFor: () => ctx.llm }),
      session,
    ]
  }

  const observed = { calls: 0, denials: 0 }
  const tools = await registerTools(ctx, {
    core,
    state,
    claimStoreFor,
    taskStoreFor,
    rootOf,
    adapterFor,
    executorsFor,
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

    report({
      event: 'plugin-loaded',
      services: { tools: ctx.tools !== undefined, sessions: ctx.sessions !== undefined },
      scope_tool: tools.status,
      scope_tool_note: tools.note,
      registered_tools: tools.tools,
      enforcement: tools.status === 'registered'
        ? 'active - a declared scope is enforced before dispatch'
        : 'guard installed but no declaration tools, so no session can be governed',
    })

    yield () => {
      report({ event: 'plugin-unloaded', observed })
    }
  }, 'gac-runtime lifecycle')
}
