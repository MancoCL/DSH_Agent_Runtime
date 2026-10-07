/**
 * 子会话权限绑定：**授权由派遣者绑定，不由执行者自报**。
 *
 * @module dsh-gac-runtime/child-binding
 *
 * 为什么需要它
 * ------------
 * 阶段 2 把 `gac_*` 从子会话的工具面里收掉（子会话不该碰父会话的协调状态），却没有补上运行时那一侧的
 * 绑定。全仓库 `declareScope` 只从 `lib/tool-scope.js`（也就是 `gac_scope` 工具）调用，而守卫在
 * 「这个会话没有声明」时是 `{kind: 'allow'}`——于是**严格写作用域管不到子会话的写入**：子会话写
 * `b.txt` 与写 `a.txt` 一样畅通，约束它的只有 persona 的措辞。活体验收里那个越界 `write` 能落地，
 * 就是这条缺口。
 *
 * 为什么不另造一张表
 * ----------------
 * 判定逻辑（PTC 外层放行、shell 整体拒绝、运行时工具放行、未知工具失败即拒、按路径查作用域）
 * 已经在 `lib/plugin.js` 的守卫里，且以**会话**为键读 `SessionScopeRegistry`。所以正确的收口不是
 * 在守卫旁边再挂一张表，而是**运行时代替子会话调一次 `registry.declare`**：子会话拿到的是它自己
 * 那份作用域，守卫一行都不用改，两条来源（运行时绑定 / 会话自报）走同一条判定。
 * 差别只在 `origin` 与随后带上拒因的身份字段——读报告的人要能分清「谁给的授权」。
 *
 * 一条必须写下来的策略：只绑写者
 * ----------------------------
 * 「生效中的写作用域会整体拒绝 shell」。因此**只给 `write_scope` 非空的节点绑**：把空 scope 绑给
 * 验证者，会顺手把它的 shell 拿走，而独立验证要靠 shell 逐条执行计划用例——那是把验证者的能力拿掉，
 * 不是收窄它的权限。只读角色的写入面由工具面（没有 `write`/`edit`）与只读角色守卫负责。
 *
 * 角色与写作用域分开记（`declareRole`）
 * ----------------------------------
 * 空写范围意味着「不许写」，不意味着「没有身份」。守卫需要知道一个子会话是哪个**语义角色**，才能把
 * `verification_design` 子会话的 `read`/`shell` 一并拒掉——否则一个没有写范围的只读子会话在守卫
 * 眼里和没有身份的会话一样，只能放行。因此写作用域绑定（`bind`/`get`，只绑写者）与角色登记
 * （`declareRole`/`roleOf`，**空写范围也登记**）是两张表，各自按 `dispatch_id` 释放。
 *
 * 生命周期
 * --------
 * 与派遣一致：起会话后立刻绑、子会话结束（完成/失败/抛错）立刻放。释放以 `dispatch_id` 为界：
 * 一个迟到的释放（旧 attempt 的收尾）不得动摇新 attempt 的绑定。
 */

/**
 * 一个子会话的绑定，以及围绕它的登记表。
 *
 * @param {object} options
 * @param {object} options.registry - `SessionScopeRegistry`：真正的判定权仍在那张表里。
 * @returns {object}
 */
export function createChildBindings({ registry }) {
  if (typeof registry?.declare !== 'function') {
    throw new TypeError('child-binding: 需要一个 SessionScopeRegistry')
  }
  /** @type {Map<string, object>} */
  const bySession = new Map()
  /** @type {Map<string, string>} */
  const dispatchIndex = new Map()
  /**
   * 角色登记：**只读节点也要登记**。
   *
   * 写作用域只绑写者（见模块注释），但守卫那一层要知道「这个子会话是哪个角色」——否则一个没有写
   * 范围的 `verification_design` 子会话在守卫眼里和没有身份的会话一样，只能放行，而它本该连 `read`
   * 都不许。因此角色与写作用域分开记：写作用域决定「授权写哪里」，角色决定「它该看到什么、做什么」。
   *
   * @type {Map<string, object>}
   */
  const roleBySession = new Map()
  /** @type {Map<string, string>} 派遣标识 → 子会话 id，只用于按派遣释放角色登记。 */
  const roleDispatchIndex = new Map()

  /**
   * 登记一个子会话的授权。空写范围不登记（见模块注释）。
   *
   * @param {object} input
   * @param {string} input.child_session_id
   * @param {string} [input.parent_session_id]
   * @param {string} input.task_id
   * @param {string} input.node_id
   * @param {string} input.dispatch_id
   * @param {number} [input.attempt]
   * @param {string} [input.role]
   * @param {readonly string[]} input.write_scope
   * @returns {object|undefined} 登记下来的绑定；不需要绑时 `undefined`。
   */
  function bind(input) {
    const writeScope = Array.isArray(input?.write_scope) ? input.write_scope : []
    // 只读节点不绑：绑上去只会把 shell 一起拒掉，而验证者要用 shell 执行用例。
    if (writeScope.length === 0) return undefined

    const entry = Object.freeze({
      child_session_id: input.child_session_id,
      parent_session_id: input.parent_session_id,
      task_id: input.task_id,
      node_id: input.node_id,
      dispatch_id: input.dispatch_id,
      attempt: input.attempt,
      role: input.role,
      write_scope: Object.freeze([...writeScope]),
    })

    registry.declare({
      session_id: entry.child_session_id,
      task_id: entry.task_id,
      node_id: entry.node_id,
      write_scope: entry.write_scope,
      dispatch_id: entry.dispatch_id,
      attempt: entry.attempt,
      child_session_id: entry.child_session_id,
      parent_session_id: entry.parent_session_id,
      role: entry.role,
      origin: 'runtime',
    })

    // 同一个子会话被重新绑定（例如重试复用了会话 id）：旧 dispatch 的索引要让位，否则一次迟到的
    // 释放会按旧 dispatch 找到同一个会话、把新的绑定清掉。
    const previous = bySession.get(entry.child_session_id)
    if (previous !== undefined) dispatchIndex.delete(previous.dispatch_id)
    bySession.set(entry.child_session_id, entry)
    dispatchIndex.set(entry.dispatch_id, entry.child_session_id)
    return entry
  }

  /**
   * 登记一个子会话的**角色**（与写作用域分开）。
   *
   * 与 `bind` 的差别只有一条：空写范围也登记。写作用域为空意味着「不许写」，不意味着「没有身份」——
   * 守卫需要靠这条身份把 `verification_design` 子会话的 `read`/`shell` 也拒掉。
   *
   * 释放按 `dispatch_id` 为界，与 `bind` 同一条纪律：迟到的释放不得动摇新 attempt 的角色登记。
   *
   * @param {object} input
   * @param {string} input.child_session_id
   * @param {string} [input.role]
   * @param {readonly string[]} [input.write_scope]
   * @param {string} [input.dispatch_id]
   * @returns {object|undefined} 登记下来的角色；`child_session_id` 缺失时 `undefined`。
   */
  function declareRole(input) {
    const sessionId = input?.child_session_id
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const entry = Object.freeze({
      child_session_id: sessionId,
      role: input.role,
      write_scope: Object.freeze(Array.isArray(input.write_scope) ? [...input.write_scope] : []),
      dispatch_id: input.dispatch_id,
    })
    const previous = roleBySession.get(sessionId)
    if (previous !== undefined) roleDispatchIndex.delete(previous.dispatch_id)
    roleBySession.set(sessionId, entry)
    roleDispatchIndex.set(entry.dispatch_id, sessionId)
    return entry
  }

  /**
   * 读一个子会话登记的角色。
   *
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  function roleOf(sessionId) {
    return roleBySession.get(sessionId)
  }

  /**
   * 按 `dispatch_id` 释放角色登记。
   *
   * 只读子会话没有写作用域绑定，因此 `release` 对它是空操作——角色的收尾必须自己走这一条，否则
   * 「派遣结束了，会话 id 却还挂在角色表里」会一直留在内存里，也会让守卫对一个已经结束的会话继续判定。
   *
   * @param {string} dispatchId
   * @returns {boolean}
   */
  function releaseRole(dispatchId) {
    const sessionId = roleDispatchIndex.get(dispatchId)
    if (sessionId === undefined) return false
    roleDispatchIndex.delete(dispatchId)
    const current = roleBySession.get(sessionId)
    if (current === undefined || current.dispatch_id !== dispatchId) return false
    roleBySession.delete(sessionId)
    return true
  }

  /**
   * 读一个会话当前的绑定。
   *
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  function get(sessionId) {
    return bySession.get(sessionId)
  }

  /**
   * 按 `dispatch_id` 释放绑定。
   *
   * 迟到的释放（旧 attempt 收尾）不得动摇新 attempt：只有当那个会话当前的绑定**就是**这次 dispatch
   * 时才清。返回 `false` 表示「这次释放什么也没动」。
   *
   * @param {string} dispatchId
   * @returns {boolean}
   */
  function release(dispatchId) {
    const sessionId = dispatchIndex.get(dispatchId)
    if (sessionId === undefined) return false
    dispatchIndex.delete(dispatchId)
    const current = bySession.get(sessionId)
    if (current === undefined || current.dispatch_id !== dispatchId) return false
    bySession.delete(sessionId)
    registry.clear(sessionId)
    return true
  }

  /**
   * 按会话释放（子会话还没登记完就崩时用得上）。
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  function releaseSession(sessionId) {
    const current = bySession.get(sessionId)
    const role = roleBySession.get(sessionId)
    if (current === undefined && role === undefined) return false
    if (current !== undefined) {
      bySession.delete(sessionId)
      dispatchIndex.delete(current.dispatch_id)
      registry.clear(sessionId)
    }
    if (role !== undefined) {
      roleBySession.delete(sessionId)
      roleDispatchIndex.delete(role.dispatch_id)
    }
    return true
  }

  /**
   * 诊断视图。
   *
   * @returns {object[]}
   */
  function inspect() {
    return [...bySession.values()]
  }

  /**
   * 角色登记的诊断视图。
   *
   * @returns {object[]}
   */
  function inspectRoles() {
    return [...roleBySession.values()]
  }

  return {
    bind,
    get,
    release,
    releaseSession,
    inspect,
    declareRole,
    roleOf,
    releaseRole,
    inspectRoles,
  }
}
