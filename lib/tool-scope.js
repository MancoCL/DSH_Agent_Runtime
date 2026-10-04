/**
 * `gac_scope` 工具：声明并查看某个会话的写作用域。
 *
 * @module dsh-gac-runtime/tool-scope
 *
 * 这个工具为什么存在
 * --------------------
 * 写作用域门禁的真实性，只取决于它的作用域来源。在协调器能够从任务 DAG
 * 推导出一个作用域之前，总得有什么东西能声明它，否则这道门禁永远无法触发，
 * 它的行为也就始终得不到证明。
 *
 * 这个工具就是那个来源，而且它刻意是*唯一*的来源：协调器之后会复用同一个
 * 接缝，于是守卫永远不会知道作用域还有第二种产生方式。
 *
 * 声明同时也是取得写占用声明的方式
 * -------------------------------------------
 * 声明就是会话说出「这些路径是我的」的那一刻 —— 而那恰恰是能够检测出跨会话
 * 冲突的时刻。所以占用是在这里取得的，而不是通过一次模型可能会忘记的独立
 * 调用：一份必须被记住的保护，终有一天会被跳过。冲突的声明会被拒绝，而拒绝
 * 会指明持有者。
 *
 * 描述是机制的一部分，而不是文档
 * ----------------------------------------------------------
 * 模型看不懂的守卫会产生重试循环：它尝试一次越界写入，被拒绝，接着换一种
 * 写法再试。所以工具文本平实地陈述强制执行的后果 —— 作用域恰好覆盖所声明的
 * 那些路径；作用域生效期间 shell 命令被直接拒绝；空作用域意味着什么都不许写。
 * 把运行时真正执行的边界说出来，模型才能在这条边界之内做计划，而不是靠撞上去
 * 才发现它。
 *
 * 这些选项由 {@link scopeToolOptions} 构造而不是内联，是为了让运行时的编写
 * 辅助函数能在测试中作用到它们身上，而不需要一套活的 harness —— 参数 DSL 由
 * 那个辅助函数校验，而不是由本模块校验，所以其中的错误只有真的跑一遍才找得到。
 */

import { describeConflict } from './claims.js'

/** 模型看到的工具名。 */
export const SCOPE_TOOL_NAME = 'gac_scope'

/**
 * 构造 `gac_scope` 工具的编写选项。
 *
 * @param {object} deps
 * @param {object} deps.core - 一个 `createGacCore` 的结果。
 * @param {(root: string) => object|undefined} [deps.claimStoreFor]
 *   为某个工程根目录提供持久化的占用声明存储。以注入方式提供，好让本模块不沾
 *   宿主会话服务。当它缺席或什么也不返回时，不会取得任何占用，并且工具会如实
 *   说明这一点，而不是暗示一份它并未提供的保护。
 * @param {(sessionId: string) => string|undefined} [deps.sessionRootFor]
 *   解析一个会话的工程根目录，占用正是以它为键。
 * @returns {object} 可直接交给运行时 `defineTool` 的选项。
 */
export function scopeToolOptions({ core, claimStoreFor, sessionRootFor }) {
  return {
    name: SCOPE_TOOL_NAME,
    description:
      'Declare the exact set of paths this task is allowed to modify, so out-of-scope writes '
      + 'are refused before they happen rather than discovered afterwards. '
      + 'Call it before editing files, and again when moving to a different part of the task. '
      + 'The scope is a strict list: `src/mod.c` permits that one file, `src/` permits that whole '
      + 'subtree, and `mod.c` permits only ./mod.c (never src/mod.c). Path matching is '
      + 'case-insensitive, so a differently-cased path is the same file. '
      + 'Declaring also CLAIMS those paths against other sessions: if another live session already '
      + 'holds an overlapping scope, the declaration is refused and names the holder, so two '
      + 'writers never collide on one file. Declaring again replaces your own scope; it never '
      + 'merges with it. '
      + 'While a scope is active, a shell command is refused entirely (its file effects cannot be '
      + 'checked), an unrecognised tool is refused, and a write outside the scope is refused. '
      + 'An empty scope permits no writes at all. Inspect the current scope with no arguments.',
    parameters: {
      // 每个参数都是可选的，所以谁都不带 `required` 标记：运行时的创作 DSL
      // 接受 `required: true` 或该键的缺失，并直接拒绝 `required: false`。
      // 省略它「正是」声明一个参数可选的方式。
      scope: {
        type: 'array',
        description:
          'Paths this task may write. Use a trailing "/" for a directory subtree. '
          + 'Omit together with task_id to only inspect the current scope.',
        items: { type: 'string' },
      },
      task_id: {
        type: 'string',
        description: 'Task identifier this scope belongs to. Required when declaring.',
      },
      node_id: {
        type: 'string',
        description: 'Task node identifier this scope belongs to. Defaults to the task id.',
      },
      clear: {
        type: 'boolean',
        description: 'Release the scope and return this session to ungoverned.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          governed: { type: 'boolean', required: true },
          task_id: { type: 'string' },
          node_id: { type: 'string' },
          scope: { type: 'array', required: true, items: { type: 'string' } },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    /**
     * 声明、查看或释放调用方会话的写作用域。
     *
     * 刻意声明为 `async`：DSH 的执行契约是一个 promise，所以这里同步抛出会在
     * 管道里表现为一次未处理的拒绝（unhandled rejection），而不是一条模型能读
     * 到并据以行动的工具错误。
     *
     * @param {object} args
     * @param {{agent?: {session?: {id?: string}}}} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('gac_scope requires an owning agent session')
      }
      const root = sessionRootFor?.(sessionId)
      const claimStore = root === undefined ? undefined : claimStoreFor?.(root)

      if (args.clear === true) {
        // 只为持有该占用的那个会话释放。持有者会话是显式传入的，这样一个占用
        // 就绝不会被别人代为释放 —— 一次伪造的释放正是这样把一位存活写者的
        // 守卫丢掉的。
        const released = claimStore?.release(sessionId, sessionId) ?? false
        const wasGoverned = core.clearScope(sessionId)
        return {
          governed: false,
          scope: [],
          summary: wasGoverned
            ? `Write scope released${released ? ' and its write claim withdrawn' : ''}. This `
              + 'session is ungoverned, so no write is checked.'
            : 'No write scope was declared for this session.',
        }
      }

      const declaring = args.task_id !== undefined || Array.isArray(args.scope)
      if (!declaring) {
        const view = core.inspect(sessionId)
        const scope = view.declaration?.write_scope ?? []
        const held = claimStore?.get(sessionId)
        return {
          governed: view.governed,
          ...(view.governed
            ? { task_id: view.declaration.task_id, node_id: view.declaration.node_id }
            : {}),
          scope,
          ...(held === undefined ? {} : { claim: held.dispatch_id }),
          summary: view.governed
            ? `Task ${view.declaration.task_id} node ${view.declaration.node_id} may write `
              + `[${scope.join(', ') || 'nothing'}]. Shell commands and unknown tools are refused `
              + 'while this scope is active.'
            : 'No write scope is declared, so no write is being checked.',
        }
      }

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        throw new Error('gac_scope: `task_id` is required when declaring a scope')
      }
      const scope = Array.isArray(args.scope) ? args.scope : []
      const nodeId = typeof args.node_id === 'string' && args.node_id !== ''
        ? args.node_id
        : args.task_id

      // 在记录作用域之前先取得占用。如果另一个存活会话持有重叠的路径，这次
      // 声明就绝不能产生任何效果：先记录、后拒绝，会让该会话被一个它并不拥有
      // 的作用域所管辖。
      if (claimStore !== undefined) {
        const attempt = claimStore.acquire({
          session_id: sessionId,
          task_id: args.task_id,
          node_id: nodeId,
          write_scope: scope,
        })
        if (attempt.acquired === false) {
          throw new Error(
            `gac_scope: this declaration was refused. ${describeConflict(attempt.conflict)} `
            + 'Narrow the scope to paths no other writer holds, or wait for that task to release '
            + 'them. Your current scope is unchanged.',
          )
        }
      }

      const declaration = core.declareScope({
        session_id: sessionId,
        task_id: args.task_id,
        node_id: nodeId,
        write_scope: scope,
      })

      const claimed = claimStore !== undefined
      return {
        governed: true,
        task_id: declaration.task_id,
        node_id: declaration.node_id,
        scope: [...declaration.write_scope],
        ...(claimed ? { claim: claimStore.get(sessionId)?.dispatch_id } : {}),
        summary: (scope.length === 0
          ? `Task ${declaration.task_id} declared an EMPTY write scope: every write is now `
            + 'refused, as are shell commands and unknown tools. Declare the paths this task '
            + 'owns, or clear the scope.'
          : `Task ${declaration.task_id} node ${declaration.node_id} may now write `
            + `[${scope.join(', ')}]. Writes outside this list are refused before execution, `
            + 'as are shell commands and unrecognised tools.')
          + (claimed
            ? ' These paths are claimed: another live session declaring an overlapping scope '
              + 'will be refused.'
            : ' NOTE: no write claim was recorded because this session has no resolvable project '
              + 'root, so another session is NOT prevented from declaring an overlapping scope.'),
      }
    },
  }
}

/**
 * 构造一个可直接注册的 `gac_scope` ToolDefinition。
 *
 * @param {object} deps
 * @param {object} deps.core - 一个 `createGacCore` 的结果。
 * @param {(options: object) => object} deps.defineTool - 运行时的创作辅助函数。
 * @param {(root: string) => object|undefined} [deps.claimStoreFor]
 * @param {(sessionId: string) => string|undefined} [deps.sessionRootFor]
 * @returns {object}
 */
export function createScopeTool({ core, defineTool, claimStoreFor, sessionRootFor }) {
  return defineTool(scopeToolOptions({ core, claimStoreFor, sessionRootFor }))
}
