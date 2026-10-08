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
 *  - PTC 的外层传输（`run_code`）→ 放行，因为它自己不碰文件；它派发的**内层子调用**会各自
 *    到达这里、按自己的名字受管（`write` 查作用域、`pwsh` 按 shell 拒绝）。拒绝外层等于让内层
 *    根本没有机会被检查——那是「PTC 在作用域下整体不可用」，不是更严的守卫（适配计划 §7.4）。
 *  - GAC 派出的子会话 → 按**语义角色**判定（`lib/role-tools.js`）：`verification_design` 只留
 *    推理，连 `read`/`grep`/`glob`/`pwsh` 都不许。这一条排在「有没有声明作用域」之前，因为只读
 *    角色的写范围恰恰是空的——「空范围」是「不许写」的理由，不是「无人管辖」。
 *  - 协调者（主会话）→ 工程在适配器里声明 `authority.coordinator_write: "protected"` 时，它
 *    不得直接改 `protected_paths` 之下的文件。这一条也排在「有没有声明作用域」之前：协调者通常
 *    根本没有声明作用域，而它要拦的正是「主会话顺手把实现写了」——那会让「实现由一个独立子会话
 *    完成」这句话失去依据。需要破例时它必须显式声明一次带理由的豁免（见 `gac_scope` 的 `override`），
 *    豁免是一次性的、并且进审计。
 *
 * 拒绝会携带一个稳定的 `code` 并指出已声明的作用域，这样模型才能自我纠正。一个模型
 * 无法据以行动的拒绝会变成重试循环，其代价超过它所阻止的那次写入。
 */

import { containedIn } from './claims.js'
import { relativize } from './path-utils.js'
import { SessionScopeRegistry } from './session-scope.js'
import { CALL_KINDS, classifyCall, roleRevokedToolNames } from './tool-targets.js'
import { ROLE_CODES, roleDenyFor, roleDenyReason } from './role-tools.js'

/** 每次拒绝都携带的结构化错误码。 */
export const GAC_CODES = Object.freeze({
  WRITE_SCOPE_DENIED: 'GAC_WRITE_SCOPE_DENIED',
  UNGUARDABLE_WRITE_DENIED: 'GAC_UNGUARDABLE_WRITE_DENIED',
  SHELL_DENIED_UNDER_SCOPE: 'GAC_SHELL_DENIED_UNDER_SCOPE',
  READ_ONLY_ROLE_DENIED: 'GAC_READ_ONLY_ROLE_DENIED',
  // 协调者写保护：主会话不得直接改产品与测试代码。它与 WRITE_SCOPE_DENIED 是两件事——
  // 后者问「你被授权写哪儿」，前者问「这件事该不该由你写」。
  COORDINATOR_WRITE_DENIED: 'GAC_COORDINATOR_WRITE_DENIED',
  // 语义角色那一层的两个码与 `lib/role-tools.js` 共用同一个来源：同一件事不该有两种说法。
  ROLE_TOOL_DENIED: ROLE_CODES.ROLE_TOOL_DENIED,
  CHILD_DELEGATION_DENIED: ROLE_CODES.CHILD_DELEGATION_DENIED,
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
 * @param {object} [options.roleGuard] - 只读角色的收权器（`lib/role-guard.js`）。它提供的是
 *   **兜底**：收权正常时工具根本不在视野里（内核返回 `UNKNOWN_TOOL`），守卫这一层只有在那条
 *   接缝缺席、或工具视野读不出来时才用得上——而那时它是唯一让角色仍然成立的东西。
 * @param {(sessionId: string) => object|string|undefined} [options.childRoleFor] - 子会话的角色登记
 *   （`lib/child-binding.js` 的 `roleOf`）。返回 `undefined` 表示这个会话不是 GAC 派出的子会话，
 *   于是角色这一层不管它。返回登记条目时按**语义角色**判定工具面：`verification_design` 子会话
 *   连 `read`/`shell` 都不许（见 `lib/role-tools.js`）；条目里的治理身份会进拒因，因此返回条目
 *   比返回裸角色名更好，裸名字也收（退化成「只知道角色」）。
 * @param {(agent: object, sessionId: string) => {protected_paths: readonly string[]}|undefined} [options.coordinatorWriteFor]
 *   这个会话是不是协调者、以及协调者不得直接改哪些路径。返回 `undefined` 表示这一层不管它
 *   （非协调者、或工程没声明 `authority.coordinator_write: "protected"`）。**判据必须包含
 *   「它是不是子会话」**：协调者这一层要拦的是主会话顺手写实现，而子会话本来就该写文件。
 * @returns {{
 *   registry: SessionScopeRegistry,
 *   preExecute: (exec: unknown) => {kind: 'allow'} | {kind: 'deny', reason: string, info: object},
 *   declareScope: (input: object) => object,
 *   clearScope: (sessionId: string) => boolean,
 *   grantOverride: (input: object) => object,
 *   clearOverride: (sessionId: string) => boolean,
 *   overrideFor: (sessionId: string) => object|undefined,
 *   inspect: (sessionId: string) => object
 * }}
 */
export function createGacCore(options = {}) {
  const registry = options.registry ?? new SessionScopeRegistry({ foldCase: options.foldCase })
  const logger = options.logger ?? silentLogger
  const resolveRoot = options.resolveRoot
  const roleGuard = options.roleGuard
  const childRoleFor = options.childRoleFor
  const coordinatorWriteFor = options.coordinatorWriteFor

  /**
   * 协调者的一次性写保护豁免，以会话 id 为键。
   *
   * 刻意**只有一次**：豁免是一句「这一次我必须自己动手」的声明，而不是一个可以一直开着的开关。
   * 一个开着不放的豁免，等于把「主会话不写实现」这条约束变成模型自己说了算——它只要在开头声明
   * 一次，之后想写什么写什么，而审计里只留下一条「已豁免」。
   *
   * 放在内存里、不落盘：与写作用域一样，进程重启就该丢掉。
   *
   * @type {Map<string, {session_id: string, reason: string, granted_at: number}>}
   */
  const overrides = new Map()

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

    // 只读角色的收权（适配计划 §4.2 的补强手段、E2E-6）。它排在「有没有声明作用域」之前，
    // 因为这一条要管的恰恰是**没有声明作用域**的会话——只读节点声明了空的写范围，通常也就
    // 没有 gac_scope 声明，而那正是收权存在的理由。
    //
    // 正常路径上这一层不会触发：收权把工具从视野里拿掉了，内核在更早的地方就返回
    // `UNKNOWN_TOOL`。它在这里的作用是「拿不到收权接缝时的兜底」，判据与收权共用同一张表，
    // 因此两者不会漂移。
    const revocation = roleGuard?.active?.(sessionId)
    if (revocation !== undefined
      && roleRevokedToolNames([name], { includeShell: revocation.include_shell === true }).length > 0) {
      logger.debug('gac: 拒绝只读角色使用写入类工具', { session: sessionId, tool: name })
      return deny(
        GAC_CODES.READ_ONLY_ROLE_DENIED,
        `GAC: 会话 ${sessionId} 当前在推进只读节点 `
          + `[${revocation.node_ids.join(', ')}]（任务 ${revocation.task_id}），`
          // 措辞刻意不说「不在工具面里」：收权把名字从**内核视野**里拿掉了，而模型面那一份清单用的
          // 作用域与收权落到的并不是同一个，所以这个调用确实发得出来（活体验证发现的）。说它
          // 「不在工具面里」会自相矛盾；说它「被这个只读角色禁止使用」才是事实。
          + `因此这个只读角色不得使用 "${name}"。只读角色不写产品文件；`
          + '需要写入时请先回报该节点，让任务推进到下一个可写的节点。',
      )
    }

    // 语义角色的工具面守卫（角色与写作用域是**两件事**，见 `lib/role-tools.js`）。
    //
    // 它排在写作用域之前，因为这一条要管的恰恰是**没有写范围**的会话：`verification_design`
    // 与 `verification_execution` 的 `write_scope` 都是空的，而前者必须连 `read` 都不许、
    // 后者必须能读能跑用例——两者的区别只有**角色**说得出来。写作用域为空在这里是
    // 「不许写」的一条理由，不是「无人管辖」。
    //
    // 正常路径上这一层也不是第一道：子会话创建窗口的 `toolFilter` 与 `lib/child-surface.js`
    // 的对账补收已经把工具从呈现面拿掉了。它在这里是**单调兜底**——内核的 `restrict` 结构上收不掉
    // 子会话自己那一层注册的工具（宿主的 Team 工具），也拒不了保留名 `run_code`，而这两样都只能
    // 由守卫拒；而守卫是单调的：它能拒绝，却没有任何守卫能强行放行另一个守卫已经拒掉的调用。
    //
    // 登记可以是条目（带治理身份，拒因才说得清是哪一次派遣）或裸角色名。两种都收：裸名字退化成
    // 「只知道角色」，若**只**认条目，那么接线上少包一层就会让 `role` 读成 `undefined`——那会落到
    // 最保守的那一档，把每个子会话的 `read` 一起拒掉，方向是 fail-closed 但理由完全错了。
    const rawRole = childRoleFor?.(sessionId)
    const roleEntry = typeof rawRole === 'string' ? { role: rawRole } : rawRole
    if (roleEntry !== undefined) {
      const denial = roleDenyFor({ role: roleEntry.role, name, write_scope: roleEntry.write_scope })
      if (denial !== undefined) {
        logger.debug('gac: 拒绝子会话按语义角色使用该工具', {
          session: sessionId,
          tool: name,
          role: roleEntry.role,
          category: denial.category,
        })
        return deny(
          denial.code,
          roleDenyReason({ role: roleEntry.role, name, category: denial.category, binding: roleEntry }),
          {
            task_id: roleEntry.task_id,
            node_id: roleEntry.node_id,
            dispatch_id: roleEntry.dispatch_id,
            attempt: roleEntry.attempt,
            child_session_id: roleEntry.child_session_id,
          },
        )
      }
    }

    // 协调者的写保护：主会话不得直接改产品代码与测试代码。
    //
    // 它排在「有没有声明作用域」之前，因为协调者通常**根本没有**声明作用域——它不推进某个节点，
    // 它推进整个任务。而这条要拦的恰恰是「主会话顺手把实现写了」：一旦它自己写了，那么「实现由
    // 一个独立子会话完成」这句话就不再有任何依据，而独立验证的整个前提也一起没了。
    //
    // 只管**结构化的写工具**，不管 shell：shell 里的重定向目标在这里根本读不出来，而协调者必须
    // 能跑 `npm test` 做最终验收。把 shell 一并拒掉会让这道门禁以「主会话什么都干不了」收场，
    // 那不是更严，那是把这道门禁逼成一个必须被关掉的东西。这条边界与写作用域那一层的 shell 边界
    // 是同一条，README 的已知限制里写着它。
    //
    // 破例只有一条路：显式声明一次带理由的豁免（`gac_scope` 的 `override`），一次性、且进审计。
    const policy = coordinatorWriteFor?.(agent, sessionId)
    if (policy !== undefined && Array.isArray(policy.protected_paths) && policy.protected_paths.length > 0) {
      const coordinatorCall = classifyCall(name, args, { nested: exec.parent !== undefined })
      if (coordinatorCall.kind === CALL_KINDS.WRITE) {
        const targets = coordinatorCall.guarded === false
          ? undefined
          : protectedTargets(
            coordinatorCall.paths.map((rawPath) => toComparable(sessionId, rawPath)),
            policy.protected_paths,
          )
        if (targets === undefined || targets.length > 0) {
          const override = overrides.get(sessionId)
          if (override === undefined) {
            logger.debug('gac: 拒绝协调者直接写受保护路径', {
              session: sessionId,
              tool: name,
              paths: targets ?? coordinatorCall.paths,
            })
            return deny(
              GAC_CODES.COORDINATOR_WRITE_DENIED,
              `GAC: 本工程的适配器声明了协调者写保护（\`authority.coordinator_write: "protected"\`），`
                + `而 "${name}" ${targets === undefined
                  ? '没有携带可读的路径参数，因此无法对照受保护路径检查'
                  : `要写 [${targets.join(', ')}]，落在受保护路径 [${policy.protected_paths.join(', ')}] 之内`}。`
                + '主会话不直接改产品与测试代码：这些改动必须由一个独立子会话完成，'
                + '否则「实现由独立执行者完成」这句话就没有依据。'
                + '请把它拆成任务节点并派遣（`gac_task` 的 `create` / `advance`）。'
                + '确实必须自己动手时，先用 `gac_scope` 声明一次带理由的豁免'
                + '（`override: true` 加 `reason`）——它只覆盖一次写入，并且会记进审计。',
              { tool: name },
            )
          }
          // 一次性：用过就没了。写失败也要重新声明——豁免说的是「这一次」。
          overrides.delete(sessionId)
          logger.debug('gac: 协调者以一次性豁免写入受保护路径', {
            session: sessionId,
            tool: name,
            reason: override.reason,
          })
        }
      }
    }

    const declaration = registry.get(sessionId)
    if (declaration === undefined) return { kind: 'allow' }

    // 拒因里要能读出「是谁的授权、哪一次派遣」。运行时绑定给子会话的声明带这几个字段，会话自报的
    // 只有前三项——取不到就不放进去（见 `deny`）。
    const identity = {
      task_id: declaration.task_id,
      node_id: declaration.node_id,
      dispatch_id: declaration.dispatch_id,
      attempt: declaration.attempt,
      child_session_id: declaration.child_session_id,
    }

    const call = classifyCall(name, args, { nested: exec.parent !== undefined })

    // PTC 的**外层传输**放行，内层子调用各自受管（适配计划 §7 边界 4）。
    //
    // 在此之前 `run_code` 落在 `unknown` 里，于是作用域一生效，PTC 整体不可用——而它派发的内层
    // 子调用根本没有机会被检查。放行外层不是放宽：传输自己不碰任何文件，真正动手的每一次子调用
    // 都会各自走到这里、按自己的名字分类（`write` 查作用域、`pwsh` 按 shell 拒绝）。这比去解析
    // `run_code` 参数里的代码文本更准——那是在猜，而子调用是内核给出的结构化事实。
    if (call.kind === CALL_KINDS.PTC) {
      logger.debug('gac: 放行 PTC 外层传输，内层子调用按自己的名字受管', {
        session: sessionId,
        tool: call.name,
      })
      return { kind: 'allow' }
    }

    if (call.kind === CALL_KINDS.SHELL) {
      logger.debug('gac: 在写作用域生效期间拒绝 shell 执行器', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.SHELL_DENIED_UNDER_SCOPE,
        `GAC: 任务 ${declaration.task_id}/${declaration.node_id} 的写作用域生效期间，`
          + `不允许 "${call.name}"：命令字符串内部的重定向或生成目标无法对照`
          + '已声明的作用域检查。请改用结构化的 write/edit 工具，让写入留在该作用域之内。',
        identity,
      )
    }

    // 运行时自己的记账工具（`gac_task`、`gac_scope`、`gac_project`）：它们写的是
    // `.dsh/gac/` 下的运行时状态，不是产品文件。放行它们不是宽容，而是必需——推进任务的
    // 那个工具若被自己执行的作用域拒掉，任务就永远推不到下一步，而模型看到的只是一句
    // 「这个工具无法检查」。（`gac_scope` 当初正是这样被自己的门禁拒过，见
    // lib/tool-targets.js 里 RUNTIME_TOOLS 的注释。）
    if (call.kind === CALL_KINDS.RUNTIME) return { kind: 'allow' }

    if (call.kind === CALL_KINDS.UNKNOWN) {
      logger.debug('gac: 在写作用域生效期间拒绝未知的可能写入的工具', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.UNGUARDABLE_WRITE_DENIED,
        `GAC: "${call.name}" 不是本运行时知道如何对照写作用域检查的工具。`
          + '在作用域生效期间它被拒绝，而不是被假定为安全。'
          + '请改用已知的写工具；若这项工作不属于本任务，就清除该作用域。',
      )
    }

    if (call.kind !== CALL_KINDS.WRITE) return { kind: 'allow' }

    if (call.guarded === false) {
      logger.debug('gac: 拒绝无法守护的写工具调用', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.UNGUARDABLE_WRITE_DENIED,
        `GAC: "${call.name}" 没有携带可读的路径参数，因此无法对照任务 `
          + `${declaration.task_id} 已声明的写作用域检查。`,
      )
    }

    for (const rawPath of call.paths) {
      const candidate = toComparable(sessionId, rawPath)
      const verdict = registry.evaluate(sessionId, candidate)
      if (verdict.governed === true && verdict.allowed === false) {
        logger.debug('gac: 拒绝越界的写入', {
          session: sessionId,
          tool: call.name,
          path: rawPath,
        })
        return deny(
          GAC_CODES.WRITE_SCOPE_DENIED,
          `GAC: 任务 ${declaration.task_id} 的节点 ${declaration.node_id} 只能写入 `
            + `[${declaration.write_scope.join(', ')}]。"${rawPath}" 在该作用域之外`
            + `（${verdict.reason ?? '没有匹配的作用域条目'}）。`,
          identity,
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
     * 给一个会话发一次性的协调者写保护豁免。
     *
     * 理由必填：一条不带理由的豁免在审计里与「没有豁免」读起来没有区别，而它恰恰是唯一
     * 绕过这道门禁的路径。空理由在这里被拒，而不是被规范化成一句占位文字。
     *
     * @param {{session_id: string, reason: string}} input
     * @returns {{session_id: string, reason: string, granted_at: number}}
     */
    grantOverride: (input) => {
      const sessionId = input?.session_id
      const reason = input?.reason
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new TypeError('plugin: 豁免需要一个会话标识')
      }
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new TypeError('plugin: 协调者写保护豁免必须写明理由')
      }
      const record = { session_id: sessionId, reason: reason.trim(), granted_at: Date.now() }
      overrides.set(sessionId, record)
      return record
    },
    /**
     * @param {string} sessionId
     * @returns {boolean}
     */
    clearOverride: (sessionId) => overrides.delete(sessionId),
    /**
     * @param {string} sessionId
     * @returns {{session_id: string, reason: string, granted_at: number}|undefined}
     */
    overrideFor: (sessionId) => overrides.get(sessionId),
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
 * 挑出真正落在受保护路径之内的那些候选路径。
 *
 * 判定用的是**有方向的包含**（`lib/claims.js` 的 `containedIn`），不是对称重叠：`lib/a.js`
 * 落在 `lib/` 之内，反过来不成立。用重叠来问「属不属于受保护的那一类」，会把一份保护扩大到
 * 它的父目录，或者恰好放过它本该拦住的路径。
 *
 * 任何一侧读不出前缀（配置被手工改坏、路径是空串）时按**落在之内**处理：这条判定的失败方向
 * 必须是拒绝。一次因为读不出来而放行的写入，比一次多余的拒绝昂贵得多——后者模型重试一次就知道
 * 该怎么办，前者不会有任何后续。
 *
 * @param {readonly string[]} paths
 * @param {readonly string[]} protectedPaths
 * @returns {string[]}
 */
function protectedTargets(paths, protectedPaths) {
  return paths.filter((candidate) => {
    try {
      return containedIn(candidate, protectedPaths)
    } catch {
      return true
    }
  })
}

/**
 * 以 DSH 工具管道所期望的形状物化一次拒绝。
 *
 * `extra` 用来把**身份**带进拒因（子会话绑定之后，读报告的人要能一眼看出是哪一次派遣被拒：
 * `child_session_id` / `task_id` / `node_id` / `dispatch_id` / `attempt`）。身份取不到时就不放进去，
 * 而不是填 `undefined` —— 一份写着「dispatch_id: undefined」的报告比没有这一格更容易读错。
 *
 * @param {string} code
 * @param {string} reason
 * @param {object} [extra]
 * @returns {{kind: 'deny', reason: string, info: object}}
 */
function deny(code, reason, extra = {}) {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'GacScopeDenied',
      code,
      reason,
      ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined)),
    },
  }
}
