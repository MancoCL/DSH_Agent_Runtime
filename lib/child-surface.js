/**
 * 子会话工具面的**对账与守卫**：按子会话自己的真实视图补收，并对收不掉的那一层装单调守卫。
 *
 * @module dsh-gac-runtime/child-surface
 *
 * 为什么创建窗口里的 `toolFilter` 还不够
 * ----------------------------------
 * 派遣方在 `ctx.subagents.start()` 里给的 `toolFilter` 走的是子会话创建窗口，**在 `start()` resolve
 * 之前就已执行**（`dsh-subagent` 的 `applyChildComposition`），因此它在呈现层面没有竞态——这是它
 * 不可替代的价值。但它有两个结构性边界，都不是配置问题：
 *
 *  1. **它只能收「继承来的」工具。** 内核的 `restrict` 只过滤作用域从全局层与祖先层继承来的工具，
 *     **永远不过滤它自己那一层注册的**（`@deepseek-ai/dsh-tools/lib/index.js:2943-2955` 明说这是
 *     刻意的：委派运行时要把子会话的 `structured_output` 注册进它自己的层，一份「点名子会话可用
 *     能力的过滤器」不能顺手把它用来作答的机件也剥掉）。宿主的 Team 工具（`spawn_teammate`、
 *     `team_task_*`、`send_message`）就是这样落进子会话自己的层的——创建期收不掉。
 *  2. **派遣方算不出完整名单。** GAC 此前把**父会话**的可收集合传给 `roleToolFilterFor`
 *     （`lib/index.js` 的 `namesFor`），而子会话的可收集合是父会话的**超集**：父会话自己那一层注册的
 *     工具，对子会话而言是**祖先**贡献，因此是可以被收掉的，只是父会话的名单里没有它们。
 *     活体验收因此观察到子会话仍然拿得到 `subagent`——旧文档把它归因成「收不掉」，**归因不准：
 *     不是收不掉，是没点名**。
 *
 * 所以这里做两件事，都发生在 `start()` 之后、以子会话的**真实视图**为准：
 *
 *  - **对账补收**：读 `tools.view(agent).restrictableNames`（子会话视角的权威可收集合），把角色
 *    禁止而创建期漏掉的工具补进一次 `restrict`；
 *  - **单调守卫**：`tools.guard()` 注册到子会话自己的层上，拒掉 `restrict` 结构上拒不了的调用
 *    （自己那层的工具，以及内核**按名字保留**、`restrict` 点名就抛错的 PTC 传输 `run_code`）。
 *
 * 守卫是「单调」的：任何守卫都能拒绝，但没有守卫能强行放行另一个守卫已经拒掉的调用——因此这一层
 * 与全局的 `tools/pre-execute` 门禁是**叠加**关系，不是互相覆盖。
 *
 * 拿不到 `localAgent` 时如实记录，不假装收过
 * ------------------------------------
 * 进程内 provider 的 `SubagentRun.localAgent` 是这一层的唯一入口（`SubagentRunInfo` 专门快照了
 * 「start 落定时它是否在场」）。进程外 provider 没有它，于是对账与守卫都装不上——此时**只能**如实
 * 记一条 `child-surface-unavailable`，剩下创建期工具面、平台深度上限与 GAC 自己的审计日志三层。
 * 绝不为了「看起来完整」而自建一个 Subagent Runtime，也绝不宣称委派已被完全封堵。
 */

import { classifyCall, CALL_KINDS } from './tool-targets.js'
import { roleDenyFor, roleDenyReason } from './role-tools.js'

/** 每次对账与守卫都携带的结构化错误码。 */
export const SURFACE_CODES = Object.freeze({
  SURFACE_RECORDED: 'child-surface',
  SURFACE_UNAVAILABLE: 'child-surface-unavailable',
  SURFACE_RESTRICT_FAILED: 'child-surface-restrict-failed',
  SURFACE_UNVERIFIED: 'child-surface-unverified',
  SURFACE_LIFTED: 'child-surface-lifted',
})

/**
 * 把 `view()` 里的容器统一读成字符串数组。
 *
 * 内核 `view(scope)` 返回的是 `{visible: Map, knownNames: Set, restrictableNames: Set}`，但
 * `role-guard.js` 里同一件事已经因为容器形态吃过一次亏，这里不假设形态：Map、Set、数组都认。
 *
 * @param {unknown} container
 * @returns {string[]}
 */
function namesOf(container) {
  if (container === undefined || container === null) return []
  if (Array.isArray(container)) return container.filter((name) => typeof name === 'string')
  if (container instanceof Map) return [...container.keys()].filter((name) => typeof name === 'string')
  if (container instanceof Set) return [...container].filter((name) => typeof name === 'string')
  return []
}

/**
 * 子会话工具面的登记处。
 *
 * @param {object} input
 * @param {(childSessionId: string, agent: object|undefined) => object|undefined} [input.toolsFor]
 *   取子会话的工具容器。默认走 `agent.ctx.tools`——**不要**退到派遣方的容器：那不是这个子会话的
 *   作用域，`restrict` 会落到错误的层上（E2E-6 留下的那个疑问正长在这个位置上）。
 * @param {(event: object) => void} [input.onEvent] 审计出口。
 * @returns {object} `{bind, unbind, roleOf, inspect, inspectAll, size}`
 */
export function createChildSurface({ toolsFor, onEvent } = {}) {
  /** @type {Map<string, object>} */
  const records = new Map()
  const emit = typeof onEvent === 'function' ? onEvent : () => {}

  const toolsForChild = typeof toolsFor === 'function'
    ? toolsFor
    : (_childSessionId, agent) => agent?.ctx?.tools

  /**
   * 登记一个子会话的角色，并按它的真实视图补收 + 装守卫。
   *
   * @param {object} input
   * @param {string} input.child_session_id
   * @param {string|undefined} input.role
   * @param {readonly string[]|undefined} input.write_scope
   * @param {object} [input.binding] 子会话的角色/作用域登记（用于拒因里的身份）。
   * @param {object} [input.agent] 子会话的 agent（`SubagentRun.localAgent`）。
   * @returns {object|undefined} 登记记录；`child_session_id` 缺失时返回 `undefined`。
   */
  function bind({ child_session_id: childSessionId, role, write_scope: writeScope, binding, agent }) {
    if (typeof childSessionId !== 'string' || childSessionId === '') return undefined
    const tools = toolsForChild(childSessionId, agent)
    const writes = Array.isArray(writeScope) ? [...writeScope] : []

    // 没有工具容器：进程外 provider，或 start 落定时 localAgent 不在场。
    if (tools === undefined || tools === null) {
      const record = {
        child_session_id: childSessionId,
        role,
        write_scope: writes,
        binding,
        mode: 'unavailable',
        presented: [],
        removed: [],
        restrictable: [],
        reason: 'start 落定时拿不到子会话的 localAgent（进程外 provider）',
        dispose: () => {},
      }
      records.set(childSessionId, record)
      emit({
        code: SURFACE_CODES.SURFACE_UNAVAILABLE,
        child_session_id: childSessionId,
        role: role ?? 'implementation',
        reason: record.reason,
      })
      return record
    }

    const before = tools.view?.(agent) ?? {}
    const visibleBefore = namesOf(before.visible)
    const restrictable = namesOf(before.restrictableNames)

    /** 这个名字在这个角色下该不该被拒。 */
    const denialFor = (name) => roleDenyFor({ role, name, write_scope: writes })

    // ① 对账补收：可收集合里、角色禁止、且不是 PTC 保留名的，补进一次 restrict。
    const toRestrict = visibleBefore.filter((name) => {
      if (denialFor(name) === undefined) return false
      if (!restrictable.includes(name)) return false
      // `run_code` 是内核保留名：`restrict` 点名它直接抛错，代价是整次收权归零。它只能走守卫。
      return classifyCall(name, {}).kind !== CALL_KINDS.PTC
    })

    let disposeRestrict
    let mode = 'restricted'
    let restrictFailure
    if (toRestrict.length > 0) {
      try {
        disposeRestrict = tools.restrict?.({ deny: toRestrict })
      } catch (error) {
        restrictFailure = error?.message ?? String(error)
        mode = 'guard-only'
      }
    }

    // ② 单调守卫：拒掉收不掉的那一层——自己那层注册的工具，以及 `run_code`。
    const disposeGuard = typeof tools.guard === 'function'
      ? tools.guard((exec) => {
          const name = exec?.name
          const denial = denialFor(name)
          if (denial === undefined) return undefined
          return roleDenyReason({ role, name, category: denial.category, binding })
        })
      : undefined
    if (disposeGuard === undefined) mode = 'guard-only'

    // ③ 收权后复查：只看「presented 里还剩什么」，而不是相信刚才那一次调用成功了。
    //    内核的 own 层豁免意味着「点过名」与「真收掉」是两件事，这里把它们分开记。
    const after = tools.view?.(agent) ?? {}
    const presented = namesOf(after.visible)
    const stillVisible = toRestrict.filter((name) => presented.includes(name))
    const verified = stillVisible.length === 0

    const record = {
      child_session_id: childSessionId,
      role,
      write_scope: writes,
      binding,
      mode: verified && mode === 'restricted' ? 'restricted' : 'guard-only',
      presented,
      removed: toRestrict.filter((name) => !presented.includes(name)),
      restrictable,
      restrict_failure: restrictFailure,
      still_visible: stillVisible,
      dispose: () => {
        try { disposeRestrict?.() } catch { /* 卸载期的清理失败不该盖住真正的问题 */ }
        try { disposeGuard?.() } catch { /* 同上 */ }
      },
    }
    records.set(childSessionId, record)

    if (restrictFailure !== undefined) {
      emit({
        code: SURFACE_CODES.SURFACE_RESTRICT_FAILED,
        child_session_id: childSessionId,
        role: role ?? 'implementation',
        names: toRestrict,
        reason: restrictFailure,
      })
    }
    if (!verified) {
      // 「没法确认」不该写成「已经收掉」——与 `role-guard.js` 的 `role-revocation-unverified` 同一条纪律。
      emit({
        code: SURFACE_CODES.SURFACE_UNVERIFIED,
        child_session_id: childSessionId,
        role: role ?? 'implementation',
        still_visible: stillVisible,
        note: '这些名字收权后仍在子会话视图里，只剩守卫一层兜着',
      })
    }
    emit({
      code: SURFACE_CODES.SURFACE_RECORDED,
      child_session_id: childSessionId,
      role: role ?? 'implementation',
      mode: record.mode,
      write_scope: writes,
      presented_tools: presented,
      removed_tools: record.removed,
      restrictable_count: restrictable.length,
      local_agent: true,
    })
    return record
  }

  /**
   * 注销一个子会话的工具面登记，并摘掉它装上的收权与守卫。
   *
   * 按 `child_session_id` 注销（子会话 id 唯一），与 `child-binding` 按 `dispatch_id` 注销是两件事：
   * 绑定要防「旧 attempt 迟到释放动摇新 attempt」，工具面属于会话本身，没有这个问题。
   *
   * @param {string} childSessionId
   * @returns {boolean}
   */
  function unbind(childSessionId) {
    const record = records.get(childSessionId)
    if (record === undefined) return false
    records.delete(childSessionId)
    try { record.dispose() } catch { /* 清理失败不改写结果 */ }
    emit({ code: SURFACE_CODES.SURFACE_LIFTED, child_session_id: childSessionId })
    return true
  }

  /**
   * 这个子会话登记的角色。全局守卫用它判定「这个会话属于哪个角色」。
   *
   * @param {string} childSessionId
   * @returns {string|undefined}
   */
  function roleOf(childSessionId) {
    return records.get(childSessionId)?.role
  }

  /**
   * 一个子会话的工具面记录（供审计与测试读取）。
   *
   * @param {string} childSessionId
   * @returns {object|undefined}
   */
  function inspect(childSessionId) {
    return records.get(childSessionId)
  }

  /** 全部登记记录。 */
  function inspectAll() {
    return [...records.values()]
  }

  return { bind, unbind, roleOf, inspect, inspectAll, size: () => records.size }
}
