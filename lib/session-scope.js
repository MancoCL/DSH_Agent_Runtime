/**
 * 按会话声明的写作用域。
 *
 * @module dsh-gac-runtime/session-scope
 *
 * 这是在完整协调器出现之前、让写作用域门禁可用的那座桥。它为每个存活会话保存
 * 其当前任务节点声明的写作用域 —— 仅此而已。它是运行时对某个授权决定的记忆，
 * 而绝不是该决定本身：
 *
 *  - *作用域*来自被声明的节点（架构大纲 §20、§21 里的 `authority.write`）。
 *    本模块从不自行发明一个作用域。
 *  - 没有条目的会话是未受治理（UNGOVERNED），而不是默认放行。守卫必须把
 *    「无声明」理解为「没有 GAC 授权可执行」，这与「可以写到任何地方」不同。
 *
 * 目前刻意只放在内存里。进程重启会丢掉每一个作用域，而这是正确的失败走向：
 * 存活超过其会话的陈旧作用域会继续执行一份无人持有的授权。持久化的任务状态
 * 随协调器一起到来（适配计划 Phase 2-3），届时会在从会话事件日志恢复时
 * 重新声明作用域。
 *
 * 保持不依赖 `ctx`，以便单元测试；lib/plugin.js 负责接线。
 */

import { createWriteScope } from './write-scope.js'

/**
 * @typedef {object} ScopeDeclaration
 * @property {string} session_id
 * @property {string} task_id
 * @property {string} node_id
 * @property {readonly string[]} write_scope
 * @property {string} [root]
 * @property {number} declared_at
 * @property {string} [dispatch_id] - 由运行时绑定（子会话）时带上：拒因要能指出是哪一次派遣。
 * @property {number} [attempt] - 同上。绑定与释放都以它为界，避免旧 attempt 动摇新 attempt。
 * @property {string} [child_session_id] - 同上：这份声明是**运行时替**这个子会话下的，不是它自报的。
 * @property {string} [parent_session_id] - 同上。
 * @property {string} [role] - 语义角色（`implementation` / `verification_execution` / …）。
 * @property {'runtime'|'session'} [origin] - 谁下的这份声明。`runtime` 表示派遣者绑定，执行者自报是
 *   `session`；两者在守卫里走同一条判定，但读报告的人要分得清「谁给的授权」。
 */

/**
 * 已声明写作用域的注册表，以会话 id 为键。
 */
export class SessionScopeRegistry {
  /**
   * @param {{foldCase?: boolean, now?: () => number}} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, ScopeDeclaration & {matcher: ReturnType<typeof createWriteScope>}>} */
    this.entries = new Map()
    this.foldCase = options.foldCase !== false
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 为一个会话声明写作用域。
   *
   * 重新声明会替换先前的作用域，任务正是借此从一个节点走到下一个节点。
   * 替换是有意为之，必须是协调器的一次显式动作，而不是隐式合并：合并两个
   * 节点的作用域会在任务推进过程中悄悄扩大授权。
   *
   * @param {object} input
   * @param {string} input.session_id
   * @param {string} input.task_id
   * @param {string} input.node_id
   * @param {readonly string[]} input.write_scope
   * @param {string} [input.root]
   * @returns {ScopeDeclaration}
   * @throws {TypeError} 当声明格式不合法时。
   */
  declare(input) {
    const { session_id: sessionId, task_id: taskId, node_id: nodeId, write_scope: writeScope } = input
    for (const [label, value] of [
      ['session_id', sessionId],
      ['task_id', taskId],
      ['node_id', nodeId],
    ]) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`session-scope: ${label} 必须是非空字符串`)
      }
    }
    if (!Array.isArray(writeScope)) {
      throw new TypeError('session-scope: write_scope 必须是路径字符串数组')
    }

    const matcher = createWriteScope(writeScope, {
      foldCase: this.foldCase,
      ...(input.root === undefined ? {} : { rootPrefix: input.root }),
    })
    const declaration = {
      session_id: sessionId,
      task_id: taskId,
      node_id: nodeId,
      write_scope: Object.freeze([...writeScope]),
      ...(input.root === undefined ? {} : { root: input.root }),
      // 运行时绑定（子会话）带上的身份。全部可选：会话自报的 `gac_scope` 声明照旧只有前三项，
      // 两种来源在守卫里走同一条判定，差别只在「谁给的授权」。
      ...(typeof input.dispatch_id === 'string' ? { dispatch_id: input.dispatch_id } : {}),
      ...(Number.isSafeInteger(input.attempt) ? { attempt: input.attempt } : {}),
      ...(typeof input.child_session_id === 'string' ? { child_session_id: input.child_session_id } : {}),
      ...(typeof input.parent_session_id === 'string' ? { parent_session_id: input.parent_session_id } : {}),
      ...(typeof input.role === 'string' ? { role: input.role } : {}),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      declared_at: this.now(),
    }
    this.entries.set(sessionId, { ...declaration, matcher })
    return declaration
  }

  /**
   * 治理某个会话的那份声明；未受治理时为 `undefined`。
   *
   * @param {string} sessionId
   * @returns {ScopeDeclaration|undefined}
   */
  get(sessionId) {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    const { matcher: _matcher, ...declaration } = entry
    return declaration
  }

  /**
   * 用一个会话已声明的作用域评估某个路径。
   *
   * @param {string} sessionId
   * @param {string} candidate
   * @returns {{governed: false}
   *   | {governed: true, allowed: boolean, candidate: string, reason?: string, task_id: string, node_id: string}}
   */
  evaluate(sessionId, candidate) {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return { governed: false }
    const verdict = entry.matcher.explain(candidate)
    return {
      governed: true,
      allowed: verdict.allowed,
      candidate: verdict.candidate,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      task_id: entry.task_id,
      node_id: entry.node_id,
    }
  }

  /**
   * 丢弃某个会话的作用域，例如在其任务关闭时。
   *
   * @param {string} sessionId
   * @returns {boolean} 是否移除了一个条目。
   */
  clear(sessionId) {
    return this.entries.delete(sessionId)
  }

  /**
   * 列出持有作用域的存活会话 id。仅用于诊断。
   *
   * @returns {string[]}
   */
  sessions() {
    return [...this.entries.keys()]
  }
}
