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
import { createGacCore } from './plugin.js'
import { projectRootFromCwd } from './path-utils.js'
import { ProjectState } from './project-state.js'
import { describeResolutionFailure, importDshPackage } from './resolve-dsh.js'
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
async function registerTools(ctx, { core, state, claimStoreFor, rootOf }) {
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
    return {
      status: 'registered',
      note: 'execution mode and write scope can be declared; scope and its claim are enforced',
      tools: [PROJECT_TOOL_NAME, SCOPE_TOOL_NAME],
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

  const observed = { calls: 0, denials: 0 }
  const tools = await registerTools(ctx, { core, state, claimStoreFor, rootOf })

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
