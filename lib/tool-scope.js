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
 *
 * 这里为什么还有 `override`
 * --------------------------
 * 工程可以在适配器里声明协调者写保护（`authority.coordinator_write: "protected"`），
 * 于是主会话不能直接改产品与测试代码。一条**没有出口**的禁令会以两种方式收场：要么被关掉，
 * 要么被绕过——而绕过的那条路一旦不是显式的，就没有任何东西能说明它发生过。所以出口在这里，
 * 而且只有这一个：声明一次带理由的豁免，它**只覆盖一次写入**，并且写进审计。理由是必填的，
 * 因为一条不带理由的豁免在事后读起来与「没有豁免」没有区别。
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
 * @param {(record: object) => void} [deps.onEvent]
 *   豁免的签发与撤回要进审计：它是唯一能绕过协调者写保护的那条路，只在内存里成立的话，
 *   事后没有任何东西能说明「谁在什么时候、以什么理由自己开了这道门」。
 * @returns {object} 可直接交给运行时 `defineTool` 的选项。
 */
export function scopeToolOptions({ core, claimStoreFor, sessionRootFor, onEvent }) {
  return {
    name: SCOPE_TOOL_NAME,
    description:
      '声明本次任务允许修改的精确路径集合，这样越界写入'
      + '会在发生之前就被拒绝，而不是事后才被发现。'
      + '在编辑文件之前调用它，在转向任务的其他部分时再调用一次。'
      + '作用域是一份严格的清单：`src/mod.c` 只允许那一个文件，`src/` 允许整棵'
      + '子树，而 `mod.c` 只允许 ./mod.c（绝不是 src/mod.c）。路径匹配'
      + '不区分大小写，所以大小写不同的路径是同一个文件。'
      + '声明同时会**认领**这些路径，把它们对其他会话占住：如果另一个存活会话已经'
      + '持有重叠的作用域，这次声明会被拒绝并指明持有者，于是两个'
      + '写者永远不会在同一文件上相撞。再次声明会替换你自己的作用域；它绝不'
      + '与之合并。'
      + '作用域生效期间，shell 命令被完全拒绝（它造成的文件影响无法被'
      + '检查），无法识别的工具被拒绝，作用域之外的写入也被拒绝。'
      + '空作用域意味着任何写入都不被允许。不带参数即可查看当前作用域。'
      + '若本工程的适配器声明了协调者写保护，主会话直接改产品与测试代码会被拒绝；'
      + '`override: true` 加 `reason` 可以声明一次豁免，它只覆盖一次写入。',
    parameters: {
      // 每个参数都是可选的，所以谁都不带 `required` 标记：运行时的创作 DSL
      // 接受 `required: true` 或该键的缺失，并直接拒绝 `required: false`。
      // 省略它「正是」声明一个参数可选的方式。
      scope: {
        type: 'array',
        description:
          '本次任务可以写入的路径。目录子树用结尾的 "/" 表示。'
          + '与 task_id 一同省略，则只查看当前作用域。',
        items: { type: 'string' },
      },
      task_id: {
        type: 'string',
        description: '这个作用域所属的任务标识。声明时必填。',
      },
      node_id: {
        type: 'string',
        description: '这个作用域所属的任务节点标识。默认为任务标识。',
      },
      clear: {
        type: 'boolean',
        description: '释放作用域，让这个会话回到无管辖状态。',
      },
      override: {
        type: 'boolean',
        description:
          '声明一次协调者写保护豁免：本次之后的一次受保护路径写入会被放行。'
          + '必须同时给出 reason。它只覆盖一次写入，用掉就没了。',
      },
      reason: {
        type: 'string',
        description: '声明豁免的理由，必填——一条不带理由的豁免事后读起来与没有豁免一样。',
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
          // `claim` 是本次声明取得的写占用（占用声明的 dispatch_id）。它**必须在这里声明**：
          // 输出校验按 `additionalProperties: false` 逐字段核对，而声明与状态两个分支在占用存储
          // 可用时都会返回它——漏掉它的后果是**整次调用被判非法输出**（活体验收实测：作用域其实
          // 生效了，而模型收到的是 `tool "gac_scope" returned invalid output: "value.claim" is not
          // a declared property`，于是声明看起来失败了，而且生效期间连自己的作用域都查不了）。
          // 这类缺陷单测抓不到，因为单测用的是透传的 defineTool、不做输出校验；现在由
          // `test/tool-output.test.js` 按声明逐字段核对。
          claim: { type: 'string' },
          // 豁免的状态也要在这里声明。输出校验按 `additionalProperties: false` 逐字段核对，
          // 漏掉它的后果与当初漏掉 `claim` 一模一样：**整次调用被判非法输出**，于是
          // 「豁免到底签没签上」这件事在模型看来是失败的。
          override: { type: 'boolean' },
          override_reason: { type: 'string' },
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
        throw new Error('gac_scope 需要一个拥有它的智能体会话')
      }
      const root = sessionRootFor?.(sessionId)
      const claimStore = root === undefined ? undefined : claimStoreFor?.(root)

      if (args.clear === true) {
        // 只为持有该占用的那个会话释放。持有者会话是显式传入的，这样一个占用
        // 就绝不会被别人代为释放 —— 一次伪造的释放正是这样把一位存活写者的
        // 守卫丢掉的。
        const released = claimStore?.release(sessionId, sessionId) ?? false
        const wasGoverned = core.clearScope(sessionId)
        // 释放作用域同时收回豁免：两者都是「这个会话现在被授权做什么」的一部分，
        // 留着一个没人记得的豁免，等于给协调者写保护留了一道不显眼的门。
        core.clearOverride(sessionId)
        return {
          governed: false,
          scope: [],
          override: false,
          summary: wasGoverned
            ? `写作用域已释放${released ? '，其写占用声明也已撤回' : ''}。`
              + '这个会话处于无管辖状态，所以不再检查任何写入。'
            : '这个会话没有声明过写作用域。',
        }
      }

      if (args.override === true) {
        if (typeof args.reason !== 'string' || args.reason.trim() === '') {
          throw new Error(
            'gac_scope: 声明协调者写保护豁免时必须写明 `reason`。'
            + '一条不带理由的豁免事后读起来与没有豁免没有区别，而它是唯一能绕过'
            + '这道门禁的路径。',
          )
        }
        const granted = core.grantOverride({ session_id: sessionId, reason: args.reason })
        onEvent?.({
          event: 'coordinator-override',
          root,
          session_id: sessionId,
          reason: granted.reason,
          granted: true,
        })
        return {
          governed: core.inspect(sessionId).governed,
          scope: core.inspect(sessionId).declaration?.write_scope ?? [],
          override: true,
          override_reason: granted.reason,
          summary:
            `已为这个会话签发一次协调者写保护豁免：${granted.reason}。`
            + '它**只覆盖一次**受保护路径的写入，用掉就没了；'
            + '需要再写就再声明一次。这条记录已经写进审计。',
        }
      }

      const declaring = args.task_id !== undefined || Array.isArray(args.scope)
      if (!declaring) {
        const view = core.inspect(sessionId)
        const scope = view.declaration?.write_scope ?? []
        const held = claimStore?.get(sessionId)
        const override = core.overrideFor(sessionId)
        return {
          governed: view.governed,
          ...(view.governed
            ? { task_id: view.declaration.task_id, node_id: view.declaration.node_id }
            : {}),
          scope,
          ...(held === undefined ? {} : { claim: held.dispatch_id }),
          // 这一项**总是**给出来，哪怕没有豁免：一个被省略的字段与一个「没有」在模型眼里
          // 读起来不一样，而这里要回答的正是「我现在能不能写受保护路径」。
          override: override !== undefined,
          ...(override === undefined ? {} : { override_reason: override.reason }),
          summary: view.governed
            ? `任务 ${view.declaration.task_id} 节点 ${view.declaration.node_id} 可以写入 `
              + `[${scope.join(', ') || '无'}]。`
              + '在这个作用域生效期间，shell 命令和未知工具会被拒绝。'
            : '没有声明写作用域，所以不检查任何写入。'
              + (override === undefined
                ? ''
                : ` 另有一份尚未使用的协调者写保护豁免：${override.reason}。`),
        }
      }

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        throw new Error('gac_scope: 声明作用域时 `task_id` 为必填')
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
            `gac_scope: 这次声明被拒绝。${describeConflict(attempt.conflict)} `
            + '请把作用域收窄到没有其他写者持有的路径，或者等那个任务释放'
            + '这些路径。你当前的作用域没有改变。',
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
          ? `任务 ${declaration.task_id} 声明了一个**空**的写作用域：从现在起任何写入都会被`
            + '拒绝，shell 命令和未知工具也一样。请声明本次任务拥有的'
            + '路径，或者释放作用域。'
          : `任务 ${declaration.task_id} 节点 ${declaration.node_id} 现在可以写入 `
            + `[${scope.join(', ')}]。这份清单之外的写入会在执行前被拒绝，`
            + 'shell 命令和无法识别的工具也一样。')
          + (claimed
            ? ' 这些路径已被认领：另一个存活会话声明重叠的作用域'
              + '会被拒绝。'
            : ' 注意：没有记录任何写占用声明，因为这个会话没有可解析出的工程'
              + '根目录，所以另一个会话声明重叠的作用域时**不会**被阻止。'),
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
 * @param {(record: object) => void} [deps.onEvent]
 * @returns {object}
 */
export function createScopeTool({ core, defineTool, claimStoreFor, sessionRootFor, onEvent }) {
  return defineTool(scopeToolOptions({ core, claimStoreFor, sessionRootFor, onEvent }))
}
