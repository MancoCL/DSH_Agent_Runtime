/**
 * GAC 运行时核心。
 *
 * @module dsh-gac-runtime/plugin
 *
 * 插件中一切可测试的部分都位于这里，其依赖以注入方式提供；`lib/index.js` 是提供
 * 真实依赖的 DSH 形态外壳。之所以做这个拆分，是为了让*拒绝决策*——整个架构所依赖的
 * 那唯一一个行为——能在单元测试中被断言，而不是只能靠运行一个活的 harness 并祈祷
 * 它出现来观察。
 *
 * 本文件负责什么
 * ---------------------------------
 * 架构大纲 §22 要求在每个工具调用前放一个守卫：
 *
 *     工具调用 → 执行前守卫 → 权限检查 → 写作用域检查
 *              → 审批检查 → 执行
 *
 * 并要求越界写入必须在执行之前就被拒绝，而不是事后才被观察到（§25）。本模块实现的
 * 就是这一道门禁。
 *
 * 这道门禁对每一种未知情况都失败即拒绝（保守方向），而这正是设计
 * -------------------------------------------------------------
 *  - 会话没有声明作用域  → 无人管辖，因此 GAC 不干预。去强制执行一个从未被声明过的
 *    作用域，会让插件在 GAC 管理之外的工作中不可用。
 *  - 写入行为未知的工具 → 在作用域生效期间拒绝。运行时升级时新出现的工具，绝不能
 *    悄悄获得在已声明作用域之外写入的权力。
 *  - shell 执行器 → 在作用域生效期间拒绝，因为命令字符串内部的重定向目标在这里
 *    根本无法检查。拒绝是唯一诚实的选项；另一种做法是声称这个接缝根本无法提供的
 *    保证（适配计划 §7，边界 1）。
 *
 * 拒绝会携带一个稳定的 `code` 并指出已声明的作用域，这样模型才能自我纠正。一个模型
 * 无法据以行动的拒绝会变成重试循环，其代价超过它所阻止的那次写入。
 */

import { relativize } from './path-utils.js'
import { SessionScopeRegistry } from './session-scope.js'
import { CALL_KINDS, classifyCall } from './tool-targets.js'

/** 每次拒绝都携带的结构化错误码。 */
export const GAC_CODES = Object.freeze({
  WRITE_SCOPE_DENIED: 'GAC_WRITE_SCOPE_DENIED',
  UNGUARDABLE_WRITE_DENIED: 'GAC_UNGUARDABLE_WRITE_DENIED',
  SHELL_DENIED_UNDER_SCOPE: 'GAC_SHELL_DENIED_UNDER_SCOPE',
})

/**
 * 默认日志器。静默，因为插件在 harness 内部往 stdout 写会破坏它自己所运行的
 * 传输通道。
 *
 * @type {{debug: (message: string, detail?: object) => void}}
 */
const silentLogger = Object.freeze({ debug: () => {} })

/**
 * 构建 GAC 核心。
 *
 * @param {object} [options]
 * @param {SessionScopeRegistry} [options.registry]
 * @param {{debug: (message: string, detail?: object) => void}} [options.logger]
 * @param {(sessionId: string) => string|undefined} [options.resolveRoot]
 *   为某个会话提供工程根目录，用于让一个绝对路径候选能与一个相对路径的已声明
 *   作用域相比较。若缺失，候选就按书写原样比较，此时拒绝仍是安全的结果。
 * @param {boolean} [options.foldCase]
 * @returns {{
 *   registry: SessionScopeRegistry,
 *   preExecute: (exec: unknown) => {kind: 'allow'} | {kind: 'deny', reason: string, info: object},
 *   declareScope: (input: object) => object,
 *   clearScope: (sessionId: string) => boolean,
 *   inspect: (sessionId: string) => object
 * }}
 */
export function createGacCore(options = {}) {
  const registry = options.registry ?? new SessionScopeRegistry({ foldCase: options.foldCase })
  const logger = options.logger ?? silentLogger
  const resolveRoot = options.resolveRoot

  /**
   * 在根目录已知时，把一个候选规范化为相对于作用域的形式。
   *
   * @param {string} sessionId
   * @param {string} candidate
   * @returns {string}
   */
  const toComparable = (sessionId, candidate) => {
    const root = resolveRoot?.(sessionId)
    if (root === undefined) return candidate
    return relativize(candidate, root, { foldCase: options.foldCase })
  }

  /**
   * 针对一次工具调用的执行前决策。
   *
   * 形状与 DSH 的 `PreToolDecision` 一致：`{kind:'allow'}` 让管道继续，
   * `{kind:'deny', reason, info}` 在派发前中止它。
   *
   * @param {unknown} exec - 一个 DSH `ToolExecution`。
   * @returns {{kind: 'allow'} | {kind: 'deny', reason: string, info: {name: string, code: string, reason: string}}}
   */
  const preExecute = (exec) => {
    if (exec === null || typeof exec !== 'object') return { kind: 'allow' }
    const { agent, name, arguments: args } = /** @type {any} */ (exec)

    // 没有 agent 就没有可查找的会话，而全局守卫绝不能在它无法归属的
    // 工作上触发。
    const sessionId = agent?.session?.id ?? agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'allow' }

    const declaration = registry.get(sessionId)
    if (declaration === undefined) return { kind: 'allow' }

    const call = classifyCall(name, args)

    if (call.kind === CALL_KINDS.SHELL) {
      logger.debug('gac: denying shell executor under an active write scope', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.SHELL_DENIED_UNDER_SCOPE,
        `GAC: "${call.name}" is not permitted while a write scope is active for task `
          + `${declaration.task_id}/${declaration.node_id}: a redirection or generator `
          + 'target inside a command string cannot be checked against the declared scope. '
          + 'Use the structured write/edit tools so the write stays inside the scope.',
      )
    }

    if (call.kind === CALL_KINDS.UNKNOWN) {
      logger.debug('gac: denying unknown write-capable tool under an active write scope', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.UNGUARDABLE_WRITE_DENIED,
        `GAC: "${call.name}" is not a tool this runtime knows how to check against a write `
          + 'scope. It is refused while a scope is active rather than assumed safe. '
          + 'Use a known write tool, or clear the scope if this work is not part of the task.',
      )
    }

    if (call.kind !== CALL_KINDS.WRITE) return { kind: 'allow' }

    if (call.guarded === false) {
      logger.debug('gac: denying unguardable write tool call', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.UNGUARDABLE_WRITE_DENIED,
        `GAC: "${call.name}" carried no readable path argument, so it cannot be checked `
          + `against the declared write scope for task ${declaration.task_id}.`,
      )
    }

    for (const rawPath of call.paths) {
      const candidate = toComparable(sessionId, rawPath)
      const verdict = registry.evaluate(sessionId, candidate)
      if (verdict.governed === true && verdict.allowed === false) {
        logger.debug('gac: denied out-of-scope write', {
          session: sessionId,
          tool: call.name,
          path: rawPath,
        })
        return deny(
          GAC_CODES.WRITE_SCOPE_DENIED,
          `GAC: task ${declaration.task_id} node ${declaration.node_id} may write `
            + `[${declaration.write_scope.join(', ')}]. "${rawPath}" is outside that `
            + `scope (${verdict.reason ?? 'no matching scope entry'}).`,
        )
      }
    }

    return { kind: 'allow' }
  }

  return {
    registry,
    preExecute,
    /**
     * 声明一个会话的写作用域。薄透传，让调用方永远不必直接触及注册表，
     * 从而让声明保持为唯一的入口点。
     *
     * @param {object} input
     * @returns {object}
     */
    declareScope: (input) => registry.declare(input),
    /**
     * @param {string} sessionId
     * @returns {boolean}
     */
    clearScope: (sessionId) => registry.clear(sessionId),
    /**
     * 诊断视图：查看某个会话的管辖情况。
     *
     * @param {string} sessionId
     * @returns {object}
     */
    inspect: (sessionId) => ({
      session_id: sessionId,
      governed: registry.get(sessionId) !== undefined,
      declaration: registry.get(sessionId) ?? null,
    }),
  }
}

/**
 * 以 DSH 工具管道所期望的形状物化一次拒绝。
 *
 * @param {string} code
 * @param {string} reason
 * @returns {{kind: 'deny', reason: string, info: {name: string, code: string, reason: string}}}
 */
function deny(code, reason) {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'GacScopeDenied',
      code,
      reason,
    },
  }
}
