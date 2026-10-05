/**
 * 只读角色的收权：把「这次干活的人不该写产品文件」变成一件**做不到的事**。
 *
 * @module dsh-gac-runtime/role-guard
 *
 * 它补的是哪一格（适配计划 §4.2 的补强手段、§9 的 E2E-6）
 * ------------------------------------------------------
 * 写作用域门禁守的是**已经声明过作用域**的会话。一个只读节点（`write_scope` 为空）在模型没有
 * 声明作用域时完全不受管——于是「验证者不该写产品代码」在此之前只是一句期望，没有任何东西让它
 * 成立。本模块在节点被派遣时，把该角色的写入面**从它自己那一格工具视野里收回**：调用一个已被
 * 收回的工具，内核返回的是 `UNKNOWN_TOOL`，也就是「这个工具不存在」，而不是一次被拒绝的调用。
 *
 * 判据是**声明的写范围**，不是能力名
 * --------------------------------
 * 「只读角色」在这里的含义是「这个节点声明了空的 `write_scope`」。写范围是计划里唯一可核对的
 * 事实；而「这个节点算不算验证节点」是语义判断。用能力名当判据会让一个叫 `reviewer` 的节点
 * 恰好躲过收权，而它同样是只读的。
 *
 * 两处刻意的不彻底（写下来，而不是留给别人去发现）
 * ---------------------------------------------
 *  1. **`shell` 默认不收回。** 验证者要逐条执行计划用例才能留下证据，而执行用例靠 shell；收掉它
 *     等于拿掉验证者的能力（见 `lib/tool-targets.js` 里 `roleRevokedToolNames` 的第 2 条）。
 *     项目可以在适配器里声明连 shell 一起收回。
 *  2. **收权是「工具看不见」，不是「写入被拦」。** 它建立在 DSH 的 `tools.restrict` 之上；那个
 *     服务缺席时本模块退化成**守卫兜底**（门禁按同一张表拒绝），并在加载报告里留下痕迹——一条
 *     静默失效的收权比没有收权更糟，因为它会让人以为角色已经安全了。
 *
 * 收回必须能撤销，而且撤销必须可靠
 * ------------------------------
 * 收权若撤不掉，会话就再也写不了文件——那是「把自己关在门外」的同一个形状，只是这次关的是用户。
 * 因此：每次状态变化都重算一次（而不是逐个事件地加减），插件卸载时全部撤销，而且**任何一次
 * `restrict` 抛错都被吞掉并如实报告**，绝不让收权失败演变成工具调用失败。
 */

import { roleRevokedToolNames } from './tool-targets.js'

/**
 * 一个角色当前被收掉了什么。
 *
 * @typedef {object} RoleRevocation
 * @property {string} session_id
 * @property {string} task_id
 * @property {readonly string[]} node_ids - 触发收权的只读节点（可能不止一个）。
 * @property {readonly string[]} revoked - 被收回的工具名。
 * @property {readonly string[]} shadowed - 看得见却收不掉的工具名（作用域内注册的）；守卫兜底
 *   仍然会拒绝它们，但这一步没能把它们从视野里拿掉。
 * @property {boolean} include_shell
 * @property {'restricted'|'guard-only'} mode - `restricted` 表示工具视野里已经拿掉；
 *   `guard-only` 表示拿不掉，只能靠守卫拒绝。
 * @property {() => void} [dispose] - 撤销这次收权。
 */

/**
 * 造一个按会话记账的收权器。
 *
 * @param {object} deps
 * @param {(sessionId: string, agent: object|undefined) => object|undefined} [deps.toolsFor]
 *   给出**该 agent 自己的**工具服务（`agent.ctx.tools`）。收权只作用于这一个 agent：拿插件根
 *   上下文的服务去收权，收的是所有人。
 * @param {(record: object) => void} [deps.onEvent] - 诊断出口，永不抛错。
 * @returns {object}
 */
export function createRoleGuard({ toolsFor, onEvent } = {}) {
  /** @type {Map<string, RoleRevocation>} */
  const active = new Map()

  const report = (record) => {
    try {
      onEvent?.(record)
    } catch {
      // 诊断绝不影响收权本身。
    }
  }

  /**
   * 撤销一个会话当前的收权。
   *
   * @param {string} sessionId
   * @returns {boolean} 是否真的撤销了一次。
   */
  const lift = (sessionId) => {
    const record = active.get(sessionId)
    if (record === undefined) return false
    active.delete(sessionId)
    try {
      record.dispose?.()
    } catch (error) {
      // 撤销失败意味着那个 agent 的工具视野仍被收着。如实报告，而不是假装已经放开。
      report({
        event: 'role-revocation-lift-failed',
        session: sessionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return true
  }

  /**
   * 按「现在有哪些只读节点在飞」重算这个会话的收权。
   *
   * 重算而不是增量加减，是为了让状态只有一个来源：节点的真实状态。增量式地「派遣时加、回报时减」
   * 会漏掉 `reopen`、失败回报、插件重载这些路径，而漏掉的后果是这个会话再也写不了文件。
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.taskId
   * @param {readonly string[]} input.readOnlyNodes - 当前在飞的、声明了空写范围的节点。
   * @param {boolean} [input.includeShell] - 项目是否要求连 shell 一起收回。
   * @param {object} [input.agent] - 派遣这个节点的那次调用所属的 agent。
   * @returns {RoleRevocation|undefined} 收权后的记录；不需要收权时返回 undefined。
   */
  const sync = ({ sessionId, taskId, readOnlyNodes, includeShell = false, agent }) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    if (!Array.isArray(readOnlyNodes) || readOnlyNodes.length === 0) {
      lift(sessionId)
      return undefined
    }

    const tools = toolsFor?.(sessionId, agent)
    // **两个视野**：`schemas()` 不给 scope 时是全局注册表的视野，给了 scope 是这个 agent 的视野。
    // 二者的差别是实测逼出来的——宿主把 Team 那几个工具（`spawn_teammate`、`subagent`…）注册进
    // agent 自己的层，而全局注册表里没有它们；`restrict` 对「全局注册表不认识的名字」会直接抛错
    // （原文：names unknown global tools "spawn_teammate", …）。于是名单里混进一个名字，整次收权
    // 就失败、退化成兜底。收权要的是「能收的都收掉」，而不是「有一个收不掉就一个都不收」。
    const globalNames = readVisibleNames(tools)
    const visibleNames = readVisibleNames(tools, agent)
    const retractable = globalNames === undefined
      ? undefined
      : roleRevokedToolNames(globalNames, { includeShell })
    // 看得见、却收不掉的（作用域内注册的那些）：留给守卫兜底，并如实报出来——一条静默收不掉的
    // 工具，会让「只读角色拿不到写入面」这句话变成一句没有依据的话。
    const shadowed = visibleNames === undefined || retractable === undefined
      ? []
      : roleRevokedToolNames(visibleNames, { includeShell })
        .filter((name) => !retractable.includes(name))
    const canRestrict = retractable !== undefined && typeof tools?.restrict === 'function'

    let mode = canRestrict ? 'restricted' : 'guard-only'
    let dispose
    if (canRestrict && retractable.length > 0) {
      try {
        dispose = tools.restrict({ deny: retractable })
      } catch (error) {
        report({
          event: 'role-revocation-failed',
          session: sessionId,
          reason: error instanceof Error ? error.message : String(error),
        })
        // 收权失败就退到兜底；**兜底那一层必须真的在**（见 lib/index.js 的 `createRuntime`）。
        mode = 'guard-only'
      }
    }
    // 报出真正收掉了什么、以及什么收不掉：`mode: 'guard-only'` 与 `revoked: []` 同时出现，就是
    // 「这次收权没生效、只剩守卫」的唯一痕迹。
    return record(sessionId, {
      taskId,
      readOnlyNodes,
      revoked: mode === 'restricted' ? retractable : [],
      shadowed,
      includeShell,
      mode,
      dispose,
    })
  }

  /**
   * 记下一次收权，并把上一次的撤销掉。
   *
   * @param {string} sessionId
   * @param {object} input
   * @returns {RoleRevocation}
   */
  function record(sessionId, { taskId, readOnlyNodes, revoked, shadowed = [], includeShell, mode, dispose }) {
    lift(sessionId)
    const entry = Object.freeze({
      session_id: sessionId,
      task_id: taskId,
      node_ids: Object.freeze([...readOnlyNodes]),
      revoked: Object.freeze([...revoked]),
      // 看得见却收不掉的（作用域内注册的工具）：守卫仍会拒绝它们，但**必须留下痕迹**——否则
      // 「只读角色拿不到写入面」这句话就没有依据。
      shadowed: Object.freeze([...shadowed]),
      include_shell: includeShell,
      mode,
      ...(dispose === undefined ? {} : { dispose }),
    })
    active.set(sessionId, entry)
    report({
      event: 'role-restricted',
      session: sessionId,
      task: taskId,
      nodes: entry.node_ids,
      revoked: entry.revoked,
      shadowed: entry.shadowed,
      mode,
    })
    return entry
  }

  return {
    sync,
    lift,
    /**
     * 某个会话当前是否处于收权状态。
     *
     * @param {string} sessionId
     * @returns {RoleRevocation|undefined}
     */
    active: (sessionId) => active.get(sessionId),
    /**
     * 撤销全部收权。插件卸载时调用：留着它等于让一个会话永远失去写入工具。
     *
     * @returns {number} 撤销了几个。
     */
    liftAll: () => {
      const sessions = [...active.keys()]
      for (const sessionId of sessions) lift(sessionId)
      return sessions.length
    },
    /**
     * 诊断视图。
     *
     * @returns {object[]}
     */
    inspect: () => [...active.values()].map(({ dispose: _dispose, ...rest }) => rest),
  }
}

/**
 * 读出某个视野里的工具名。
 *
 * 走 `tools.schemas(scope)` 而不是拿一份静态名单：`restrict` 对**未注册的名字会抛错**，而哪些
 * 工具在这个宿主里注册了只有它自己知道。**不给 scope 时读到的是全局注册表的视野**，给了 scope
 * 则是那个 agent 的视野——两者不相等（作用域内注册的工具只在后者里），而收权必须用前者（见
 * `sync` 里那段注释）。读不出来时返回 undefined，让调用方退到守卫兜底。
 *
 * @param {object|undefined} tools
 * @param {object} [agent] - 省略它就读全局视野。
 * @returns {string[]|undefined}
 */
function readVisibleNames(tools, agent) {
  if (typeof tools?.schemas !== 'function') return undefined
  try {
    const schemas = agent === undefined ? tools.schemas() : tools.schemas(agent)
    if (!Array.isArray(schemas)) return undefined
    return schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string')
  } catch {
    return undefined
  }
}
