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

import { CALL_KINDS, classifyCall, roleRevokedToolNames } from './tool-targets.js'

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
    // 交给 `restrict` 的名单有一个**唯一正确的来源**：`tools.view(agent).restrictableNames`。这不是
    // 偏好，是内核写明的两条规则逼出来的，两条都是活体实测才看清的：
    //
    //  1. 一条 restriction 只过滤这个作用域**继承**来的工具（全局层与祖先层），**永不过滤它自己那一
    //     层注册的**。内核的注释解释了为什么：委派运行时把子 Agent 的结构化输出工具注册进它的**自己
    //     那一层**，而「按能力过滤子 Agent」这件事不能把它回话用的机械一并剥掉。这条豁免的口径是
    //     「不是我自己的」，不是「全局层」——一旦预设把模型面工具挪到 agent 层，它们就变成**祖先层
    //     的贡献**，于是用「全局层」当口径的过滤器会静默地什么也拦不住。本项目的第一次尝试正是踩
    //     在了这里：拿 `schemas()`（不给 scope）当全局视野，结果 `write`/`edit` 被判成「收不掉」，
    //     而它们其实是可收的。
    //  2. `restrict` **按名字拒绝 `run_code`**（原文：cannot name reserved PTC mode presentation
    //     transport "run_code"; restrict end-capability tools instead），所以 PTC 传输只能由守卫
    //     兜底拒绝，不能进名单。
    //
    // 收不掉的那些（作用域自己那一层注册的，以及 `run_code`）如实记进 `shadowed`：守卫仍然会拒绝
    // 它们，但「没收掉」这件事必须可见——一条静默收不掉的工具会让「只读角色拿不到写入面」变成一句
    // 没有依据的话。
    const views = readScopeViews(tools, agent)
    const visibleNames = views?.visible
    const retractable = views?.restrictable === undefined
      ? undefined
      : roleRevokedToolNames(views.restrictable, { includeShell })
        .filter((name) => classifyCall(name, {}).kind !== CALL_KINDS.PTC)
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
 * 读出一个作用域的工具视野：可见的，以及**可以交给 `restrict` 的**。
 *
 * 首选 `tools.view(agent)`：内核把这份派生视野一次算好并公开出来（`visible` / `knownNames` /
 * `restrictableNames`），而 `restrict` 自己校验用的就是 `restrictableNames`——用同一个来源，
 * 收权与内核的接受条件就不会漂移。
 *
 * 拿不到 `view` 的老宿主退到两个 `schemas()` 视野取交集：它只知道「全局层」那一部分，因此多半
 * 会少收一些（多出来的部分记成 `shadowed` 交给守卫）。**不要**拿一份静态名单去猜：`restrict`
 * 对名单里任何一个它不认识的名字都会抛错，而抛错的代价是整次收权归零。
 *
 * @param {object|undefined} tools
 * @param {object|undefined} agent
 * @returns {{visible?: string[], restrictable?: string[]}|undefined}
 */
function readScopeViews(tools, agent) {
  if (typeof tools?.view === 'function') {
    try {
      const view = tools.view(agent)
      const visible = namesOf(view?.visible)
      const restrictable = namesOf(view?.restrictableNames)
      if (visible !== undefined && restrictable !== undefined) return { visible, restrictable }
    } catch {
      // 落到下面的兜底：宿主换了实现也不该让收权整条失效。
    }
  }
  const globalNames = readVisibleNames(tools)
  const agentNames = readVisibleNames(tools, agent)
  if (globalNames === undefined || agentNames === undefined) return undefined
  return {
    visible: agentNames,
    restrictable: agentNames.filter((name) => globalNames.includes(name)),
  }
}

/**
 * 把内核视野里的名字集合取成一个数组。
 *
 * `visible` 是 `Map`、`restrictableNames` 是 `Set`；两种都认，另外也认数组（免得内核换个容器
 * 类型就让收权整条失效）。
 *
 * @param {unknown} value
 * @returns {string[]|undefined}
 */
function namesOf(value) {
  if (value instanceof Map) return [...value.keys()].filter((name) => typeof name === 'string')
  if (value instanceof Set) return [...value].filter((name) => typeof name === 'string')
  if (Array.isArray(value)) return value.filter((name) => typeof name === 'string')
  return undefined
}

/**
 * 读出某个视野里的工具名（兜底路径用）。
 *
 * 走 `tools.schemas(scope)` 而不是拿一份静态名单：`restrict` 对**未注册的名字会抛错**，而哪些
 * 工具在这个宿主里注册了只有它自己知道。**不给 scope 时读到的是调用方上下文自己的视野**——它
 * 不等于「全局层」，这一点是实测纠正的（见 `sync` 里那段注释）。读不出来时返回 undefined，让
 * 调用方退到守卫兜底。
 *
 * @param {object|undefined} tools
 * @param {object} [agent] - 省略它就读调用方上下文的视野。
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
