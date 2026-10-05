/**
 * 原生子会话执行者：把节点**真正**交给宿主的一个独立子会话。
 *
 * @module dsh-gac-runtime/child-executor
 *
 * 它补的是哪一格
 * ------------
 * `createSessionExecutor()` 只是占位：它把节点置为 `in_progress` 就返回，真正的执行落回主会话——
 * 模型自己干完再手工 `report`。后果是「独立验证」在事实层面从未成立（Builder 与 Verifier 是同
 * 一个会话，只是 prompt 不同），「并行批次」也只是协调器算出来的批次。本模块把节点交给
 * `ctx.subagents.start()` 起的一个真子会话：**独立 session identity、独立 context、独立工具面、
 * 独立结果**，结果经 `SubagentResult` 回到 `applyResult()`。
 *
 * 决定与理由记在 `docs/ADR-0001-子会话执行载体.md`；这里只重复三条最容易忘的：
 *
 *  1. **不用自造执行器。** 不建 worker pool / daemon / queue：agent 与 session 的生命周期、传输、
 *     模型调用、工具执行、取消都归宿主。
 *  2. **不用 Agent Teams 当执行基座。** 它与原生子会话是**同一个基座上的两个消费者**
 *     （`spawn_teammate` → `ctx.agentTeams.spawnTeammate` → `ctx.subagents.startContinuable`），
 *     但它的看板没有 mode / 写作用域 / 证据 / 验证计划 / 风险升级，两套任务模型必然漂移；而且它的
 *     包不在本机 profile 的 junction 集里（插件解析不到）。它只能作为「跨轮、人在环」的可选交互面。
 *  3. **深度上限是相对的，不是写死的。** 上限取「调用方深度 + 1」，因此每次派遣只允许再开一层；
 *     而调用方自己可能是子会话（例如由 Team/子 agent 驱动 GAC 时会这样）。写死 `1` 会让「调用方
 *     已经是深度 1」的场景整个用不了——活体验收实测过：宿主回 `subagent depth 2 exceeds maxDepth 1`。
 *     深度来自会话头（与宿主同一个口径：`session.header.delegationDepth` 权威且单调，
 *     `AgentOptions.subagentDepth` 只能加深），读不到就交给宿主自己的配置上限，而不是猜一个。
 *
 * 阶段 1 的边界（写下来，而不是留给别人去发现）
 * ---------------------------------------
 * 本执行者**只承载需要写文件的节点**（`write_scope` 非空），也就是 Builder。Verifier / Reviewer 仍
 * 由会话执行者承载——它们的角色工具面（模型看到的清单里就没有 `write`/`edit`）是阶段 2 的事，
 * 依赖 `SubagentStartRequest.toolFilter`。阶段 1 刻意不传 `toolFilter`：`restrict` 对不在该作用域
 * 可收集合里的名字会抛错，而子会话在创建窗口里到底认哪些名字，只有实测才知道——**先用深度上限
 * 挡住递归，再谈工具面**。
 */

/** 子会话 provider 的默认名：`dsh-subagent-spawn-in-process` 的配置默认值就是它。 */
export const CHILD_PROVIDER_DEFAULT = 'spawn'

/** 所有子会话都必须具备的能力。缺任何一个都不该把它当执行者用。 */
export const REQUIRED_CHILD_CAPABILITIES = Object.freeze([
  'outputSchema',
  'depthLimit',
  'agentOptions',
])

/**
 * 子会话必须回的产出契约。
 *
 * 结构化是刻意的：从散文里猜「它到底做成了没有」正是本仓库反复吃亏的地方。判定用 `status`，
 * `summary` 给人看，`artifacts` 是可选的产物清单（文件路径等）。
 *
 * **这是一份标准 JSON Schema，不是本仓库工具创作 DSL 的那种写法。** 两者的区别是实测踩出来的：
 * 工具产出契约里写 `{ type: 'string', required: true }`（`required` 在**属性内部**）是 DSL 的约定，
 * `defineTool` 接受它；而 `SubagentStartRequest.outputSchema` 交给的是宿主的**原始 JSON Schema 校验**，
 * 它按标准读——`required` 必须是对象层的数组。把它写成 DSL 那种，宿主的回答是
 * `unsupported JSON schema: schema.properties.status.required is not supported on type "string"`，
 * 而那次派遣会**在子会话创建之前**就被拒掉（活体验收实测：`advance` 只回一条裸 Error，节点停在
 * pending）。所以这里刻意写成标准形状，并有一条断言盯着它。
 */
export const CHILD_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
  },
})

/** 子会话可以申报的三种结论。 */
export const CHILD_VERDICTS = Object.freeze(['completed', 'failed', 'blocked'])

/**
 * 读一个 agent 的委派深度。
 *
 * 与宿主同一口径（`dsh-subagent` 的 `delegationDepthOf`，模块注释说明它就是给「不想 import 注册表
 * 的组合辅助」用的）：会话头里的 `delegationDepth` 是权威且**单调**的，`AgentOptions.subagentDepth`
 * 只能加深——一个被恢复的子会话带着全新的 options 回来，若从零重算，它就会像顶层一样继续委派。
 *
 * 读不出来时返回 undefined：**不猜**。调用方据此把上限交给宿主自己的配置（`resolveMaxDepth`），
 * 而不是拿一个写死的数字顶上去——写死 `1` 正是活体验收里那次 `depth 2 exceeds maxDepth 1` 的来源。
 *
 * @param {object|undefined} agent
 * @returns {number|undefined}
 */
export function parentDelegationDepth(agent) {
  const candidates = [agent?.session?.header?.delegationDepth, agent?.options?.subagentDepth]
  const usable = candidates.filter((value) => Number.isSafeInteger(value) && value >= 0)
  return usable.length === 0 ? undefined : Math.max(...usable)
}

/**
 * 子会话的人格段。
 *
 * 它进的是子会话**自己的**系统提示（provider 把它装成 `deployment:persona-prefix` 段），因此不能
 * 复用 `buildSystemPrompt`——那一份是给「没有写工具的进程内执行者」写的，里面明说「你没有任何写入
 * 工具」。把那段交给一个有工具的 Builder，等于让它以为不该写文件。
 *
 * @param {object} node
 * @returns {string}
 */
export function buildChildPersona(node) {
  const writes = Array.isArray(node?.write_scope) ? node.write_scope : []
  return [
    '你是 GAC 运行时派出的一个执行者，跑在自己的会话里。',
    '你有工具，也应当用工具把活儿真做完——不要只交一份说明。',
    writes.length === 0
      ? '本节点没有写范围：不得写任何文件。'
      : `只能写 [${writes.join(', ')}] 之内的路径；越界的写入会被拒绝。`,
    '做完之后按给定结构汇报：status、summary、以及（如有的）artifacts。',
  ].join('')
}

/**
 * 子会话的任务提示词。
 *
 * 子会话**没有父会话的上下文**（`spawn` 提供者的 `inheritsParentContext` 为 false），所以这份提示词
 * 必须自包含：节点契约、验收标准、写范围、期望产物、以及停止条件都要在这里讲清。刻意不塞的东西：
 * 完整聊天历史、Verifier 的私有推理、Reviewer 的私有推理、整个仓库的全文、无关的历史任务。
 *
 * @param {object} input
 * @param {object} input.node
 * @param {object} input.task
 * @param {string} input.root
 * @param {string} input.dispatchId
 * @returns {string}
 */
export function buildChildPrompt({ node, task, root, dispatchId }) {
  const writes = Array.isArray(node?.write_scope) ? node.write_scope : []
  const artifacts = Array.isArray(node?.expected_artifacts) ? node.expected_artifacts : []
  const lines = [
    `项目根目录：${root}`,
    `任务：${task.task_id}（模式 ${task.mode}）`,
    `节点：${node.id} — ${node.objective}`,
    `本次派遣标识：${dispatchId}`,
    node.depends_on.length === 0
      ? '本节点无前置依赖。'
      : `前置节点：${node.depends_on.join('、')}（均已完成）。`,
    writes.length === 0
      ? '写范围：空——本节点不得写任何文件。'
      : `写范围：只能写 [${writes.join(', ')}] 之内的路径。`,
    artifacts.length === 0 ? '期望产物：无特别要求。' : `期望产物：${artifacts.join('、')}。`,
    '停止条件：目标达成，或你确信做不下去。两者都要按结构汇报，不要留半截状态。',
    '汇报必须包含 status（completed / failed / blocked）、summary（你做了什么、看到了什么、结论'
      + '是什么、还有哪些没做），以及可选的 artifacts（你产出的文件路径）。',
  ]
  return lines.join('\n')
}

/**
 * 一个节点该不该由子会话承载。
 *
 * 阶段 1 只承载需要写文件的节点。判据是**声明的写范围**，不是能力名——写范围是计划里唯一可核对的
 * 事实，用能力名会让一个同样要写文件却没叫 `implementation` 的节点落回主会话。
 *
 * @param {object|undefined} node
 * @returns {boolean}
 */
export function needsChildSession(node) {
  return Array.isArray(node?.write_scope) && node.write_scope.length > 0
}

/**
 * 读一眼子会话接缝的可用性，用于加载报告。
 *
 * 与 `witness-seam` 同一个形态：**接缝缺席要留痕**，否则「派遣已经交给子会话了」会变成一句
 * 没有依据的话（本仓库在观测源上吃过这个亏）。
 *
 * @param {object|undefined} subagents
 * @param {string} [providerName]
 * @returns {{available: boolean, provider?: string, providers: string[], capabilities?: object, reason?: string}}
 */
export function describeChildSeam(subagents, providerName = CHILD_PROVIDER_DEFAULT) {
  if (subagents === undefined || subagents === null) {
    return { available: false, providers: [], reason: 'ctx.subagents 服务不在（本机没装配子会话运行时）' }
  }
  if (typeof subagents.list !== 'function' || typeof subagents.start !== 'function') {
    return { available: false, providers: [], reason: 'ctx.subagents 没有 start()/list()，接缝形状不符' }
  }
  let providers = []
  try {
    providers = subagents.list()
  } catch (error) {
    return {
      available: false,
      providers: [],
      reason: `读 provider 列表失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const provider = providers.includes(providerName) ? providerName : providers[0]
  if (provider === undefined) {
    return { available: false, providers, reason: '没有任何子会话 provider 注册' }
  }
  const capabilities = typeof subagents.getProvider === 'function'
    ? subagents.getProvider(provider)?.capabilities
    : undefined
  const missing = REQUIRED_CHILD_CAPABILITIES.filter((name) => capabilities?.[name] !== true)
  if (missing.length > 0) {
    return {
      available: false,
      providers,
      provider,
      capabilities,
      reason: `provider ${provider} 缺少能力：${missing.join('、')}`,
    }
  }
  return { available: true, provider, providers, capabilities }
}

/**
 * 造一个原生子会话执行者。
 *
 * @param {object} deps
 * @param {() => object|undefined} deps.subagentsFor - 取 `ctx.subagents`（注入而非 import：这条
 *   接缝可能不在，缺席时要能优雅降级，而不是让插件加载失败）。
 * @param {string} [deps.providerName]
 * @param {number} [deps.maxDepth]
 * @returns {object} 与 `lib/executor.js` 里其它执行者同形的对象。多读一个 `agent` 字段：子会话需要
 *   一个**父 agent** 才能建起来，而 `sessionId` 换不出 agent——不去猜，由调用方把它交进来。
 */
export function createChildExecutor({
  subagentsFor,
  providerName = CHILD_PROVIDER_DEFAULT,
} = {}) {
  return {
    name: `child:${providerName}`,
    supports: (node) => needsChildSession(node),
    async run({ node, task, root, dispatchId, agent, signal }) {
      const seam = describeChildSeam(subagentsFor?.(), providerName)
      if (!seam.available) {
        // **显式降级**，不是静默落回：这条消息会进模型视野，也是「这一轮其实是主会话自己干」的唯一
        // 依据。早先会话执行者只写「需要写入 [...]，必须由带工具的会话执行」，读的人无从知道
        // 子会话接缝本该在。
        const writes = Array.isArray(node.write_scope) ? node.write_scope : []
        return {
          status: 'in_progress',
          summary: `节点 ${node.id} 需要写入 [${writes.join(', ')}]，但原生子会话不可用`
            + `（${seam.reason}）。本次派遣已登记，降级为由上层会话执行并把结果回报回来。`,
          reason: seam.reason,
        }
      }
      if (agent === undefined || agent === null) {
        // 子会话必须有父 agent。拿不到就如实降级——**不要**拿别的会话的 agent 顶替，那会把子会话挂到
        // 一条不属于它的血缘上，之后连「这个结果是谁给的」都追不回来。
        return {
          status: 'in_progress',
          summary: `节点 ${node.id} 需要写入，但本次调用没有可用的父 agent，无法建子会话。`
            + '本次派遣已登记，降级为由上层会话执行并把结果回报回来。',
          reason: 'no parent agent',
        }
      }

      const subagents = subagentsFor()
      // 每次派遣只允许再开一层：上限 = 调用方深度 + 1。调用方深度读不出来时交 `undefined`，
      // 让宿主用它自己的配置上限——不拿一个写死的数字顶上去（写死 1 会让深度 1 的调用方整个用不了）。
      const depth = parentDelegationDepth(agent)
      const run = await subagents.start(seam.provider, {
        label: `${task.task_id}/${node.id}`,
        prompt: [{ type: 'text', text: buildChildPrompt({ node, task, root, dispatchId }) }],
        parent: agent,
        signal,
        persona: buildChildPersona(node),
        outputSchema: CHILD_OUTPUT_SCHEMA,
        ...(depth === undefined ? {} : { maxDepth: depth + 1 }),
      })

      try {
        const result = await run.result
        const structured = result?.structured
        const stopReason = result?.stopReason
        if (structured === undefined || structured === null || typeof structured !== 'object') {
          // 没有结构化产出就无法判定成败。这不是「大概成了」——按失败处理，并要求重新派遣。
          return {
            status: 'failed',
            summary: `子会话 ${run.id} 没有按契约回结构化产出`
              + `（stopReason: ${JSON.stringify(stopReason) ?? 'unknown'}）。`
              + `${result?.diagnostic === undefined ? '' : `诊断：${result.diagnostic}`}`,
          }
        }
        const verdict = CHILD_VERDICTS.includes(structured.status) ? structured.status : undefined
        if (verdict === undefined) {
          return {
            status: 'failed',
            summary: `子会话 ${run.id} 回的 status 不在契约内：`
              + `${JSON.stringify(structured.status) ?? 'undefined'}。`,
          }
        }
        const artifacts = Array.isArray(structured.artifacts) ? structured.artifacts : []
        return {
          status: verdict,
          summary: `${structured.summary}`
            + `（子会话 ${run.id}；stopReason: ${JSON.stringify(stopReason) ?? 'unknown'}`
            + `${artifacts.length === 0 ? '' : `；产物：${artifacts.join('、')}`}）`,
          // `artifact` 落到任务记录的 `result_ref`：它是一个**指针**，不是结论。指出这次结果是哪个
          // 子会话给的——将来要复核「是谁写的」，得从这个 id 追回去。
          artifact: `child-session:${run.id}`,
        }
      } finally {
        // 无论成败都要收：宿主把子会话的收尾交给我们，留着它就是留一个不再需要却仍活着的会话。
        try {
          await run.dispose?.()
        } catch {
          // 收尾失败不该改变本次派遣的结论——它已经发生了。
        }
      }
    },
  }
}
