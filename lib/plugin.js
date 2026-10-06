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
 *
 * 拒绝会携带一个稳定的 `code` 并指出已声明的作用域，这样模型才能自我纠正。一个模型
 * 无法据以行动的拒绝会变成重试循环，其代价超过它所阻止的那次写入。
 */

import { relativize } from './path-utils.js'
import { SessionScopeRegistry } from './session-scope.js'
import { CALL_KINDS, classifyCall, roleRevokedToolNames } from './tool-targets.js'

/** 每次拒绝都携带的结构化错误码。 */
export const GAC_CODES = Object.freeze({
  WRITE_SCOPE_DENIED: 'GAC_WRITE_SCOPE_DENIED',
  UNGUARDABLE_WRITE_DENIED: 'GAC_UNGUARDABLE_WRITE_DENIED',
  SHELL_DENIED_UNDER_SCOPE: 'GAC_SHELL_DENIED_UNDER_SCOPE',
  READ_ONLY_ROLE_DENIED: 'GAC_READ_ONLY_ROLE_DENIED',
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
  const roleGuard = options.roleGuard

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
