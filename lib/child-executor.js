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
const CHILD_PROVIDER_DEFAULT = 'spawn'

/** 所有子会话都必须具备的能力。缺任何一个都不该把它当执行者用。 */
const REQUIRED_CHILD_CAPABILITIES = Object.freeze([
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
const CHILD_VERDICTS = Object.freeze(['completed', 'failed', 'blocked'])

/**
 * 不该出现在**任何**子会话里的工具：委派类与父会话的协调类。
 *
 * 为什么要有这一条——活体验收观察到的：子会话里也有 `gac_*` 工具（插件是宿主级的），于是它会自己
 * 声明作用域、并试着回报它那一侧的派遣；它自己的产出里写着「A1 的回报被判 stale、T1 停在 blocked」，
 * 而父侧权威状态是 completed。父侧没有被污染，但「子会话能不能碰父会话的协调状态」不该靠运气。
 *
 * 名单里的名字都是**继承面**上的工具（preset 层与全局层），因此点名是安全的；调用方还会再与本会话
 * 实际的可收集合取交集，绝不把不存在或有歧义的名字塞进去——`restrict` 对不认识的名字会抛错，代价是
 * 整次子会话创建失败。
 */
const CHILD_COORDINATION_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'workflow',
  'gac_task',
  'gac_scope',
  'gac_project',
  'gac_metrics',
  'gac_evidence',
])

/** 只读角色（写范围为空）不该持有的写入工具。 */
const CHILD_WRITE_TOOLS = Object.freeze(['write', 'edit'])

/**
 * 按角色算出子会话的工具过滤。
 *
 * 判据仍是**声明的写范围**：要写文件的节点（Builder）保留写入工具，只要它别去委派、别去碰派遣方的
 * 协调状态；写范围为空的节点（Verifier / Reviewer）连写入工具一并去掉——这正是「模型看到的清单里
 * 根本没有 write」的形态，比「模型看得到、调用被拒」更进一步。
 *
 * @param {object|undefined} node
 * @param {readonly string[]|undefined} inheritableNames - 父会话的可收集合；undefined 表示读不出来。
 * @returns {{deny: string[]}|undefined} 没有可点名者、或读不出可收集合时返回 undefined（调用方会把
 *   「角色工具面没生效」如实记进结果，而不是假装设上了）。
 */
export function roleToolFilterFor(node, inheritableNames) {
  if (!Array.isArray(inheritableNames)) return undefined
  const wanted = needsChildSession(node)
    ? [...CHILD_COORDINATION_TOOLS]
    : [...CHILD_COORDINATION_TOOLS, ...CHILD_WRITE_TOOLS]
  const deny = wanted.filter((name) => inheritableNames.includes(name))
  return deny.length === 0 ? undefined : { deny }
}

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
 * @param {(agent: object) => string[]|undefined} [deps.namesFor] - 读父会话的可收集合，用于算角色
 *   工具面。省略或读不出来时**不设**工具面，并把这件事记进结果。
 * @returns {object} 与 `lib/executor.js` 里其它执行者同形的对象。多读一个 `agent` 字段：子会话需要
 *   一个**父 agent** 才能建起来，而 `sessionId` 换不出 agent——不去猜，由调用方把它交进来。
 */
export function createChildExecutor({
  subagentsFor,
  providerName = CHILD_PROVIDER_DEFAULT,
  namesFor,
  bindings,
} = {}) {
  return {
    name: `child:${providerName}`,
    // 阶段 2 起承载**所有**节点：写文件的（Builder）与只读的（Verifier / Reviewer）都该跑在独立会话里
    // ——「独立验证」的实质是独立 session identity / 独立上下文 / 独立工具面，而不是换个 prompt。
    supports: () => true,
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
      const request = {
        label: `${task.task_id}/${node.id}`,
        prompt: [{ type: 'text', text: buildChildPrompt({ node, task, root, dispatchId }) }],
        parent: agent,
        signal,
        persona: buildChildPersona(node),
        outputSchema: CHILD_OUTPUT_SCHEMA,
        ...(depth === undefined ? {} : { maxDepth: depth + 1 }),
      }
      // 角色工具面：只点名列在**父会话可收集合**里的名字。子会话会 join 父会话的 preset，所以那份
      // 集合正是子会话继承面的安全子集；父会话自己那一层注册的工具（宿主的 Team 工具）不在里面，
      // 也就点不到——`restrict` 对不认识的名字会抛错，代价是整次子会话创建失败。
      const toolFilter = roleToolFilterFor(node, namesFor?.(agent))
      let run
      let filterNote = ''
      try {
        run = await subagents.start(seam.provider, toolFilter === undefined
          ? request
          : { ...request, toolFilter })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 工具面被宿主拒绝时**不放弃这次派遣**：退到无过滤重试，并把「这一层没生效」如实写进结果。
        // 静默降级是最坏的形态——读的人会以为模型面里已经没有写入工具了，而 pre-execute 守卫其实
        // 是唯一的防线。
        if (toolFilter === undefined || !/unknown global tool/iu.test(message)) throw error
        run = await subagents.start(seam.provider, request)
        filterNote = `⚠ 角色工具面未生效（${message}）——已按无过滤重试，这一层只剩 pre-execute 守卫`
      }

      // **授权由派遣者绑定，不由执行者自报。** 子会话拿到的那一刻就该是「它自己那份作用域」，
      // 而不是靠 persona 里那句「只能写 [...]」的措辞——措辞不是权限。绑在 `start()` 返回之后、
      // await 结果之前：`start()` 一返回子会话就可能在跑，而它的第一个工具调用至少要等一次模型往返，
      // 所以实际窗口可忽略；但契约上不存在「首个工具调用之前」的钩子，这一点如实记在 ADR 里，
      // 不假装它是硬保证。只读节点不绑（空写范围：绑上去会把 shell 一起拒掉，而验证者要用它跑用例）。
      const binding = bindings?.bind({
        child_session_id: run.id,
        parent_session_id: agent?.session?.id,
        task_id: task.task_id,
        node_id: node.id,
        dispatch_id: dispatchId,
        attempt: node.execution?.attempt,
        role: node.role,
        write_scope: Array.isArray(node.write_scope) ? node.write_scope : [],
      })
      const boundNote = binding === undefined ? '' : `；已绑定写作用域 [${binding.write_scope.join(', ')}]`

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
        const detail = `子会话 ${run.id}`
          + `${artifacts.length === 0 ? '' : `；产物：${artifacts.join('、')}`}`
          + `${boundNote}`
          + `${filterNote === '' ? '' : `；${filterNote}`}`
        return {
          status: verdict,
          summary: `${structured.summary}`
            + `（子会话 ${run.id}；stopReason: ${JSON.stringify(stopReason) ?? 'unknown'}`
            + `${artifacts.length === 0 ? '' : `；产物：${artifacts.join('、')}`}）`,
          // 返回文本里要能看见**子会话 id**：可追溯性此前只活在任务记录的 `result_ref` 与证据日志里，
          // 模型看不到。`detail` 就是给渲染用的那一行。
          detail,
          // `artifact` 落到任务记录的 `result_ref`：它是一个**指针**，不是结论。指出这次结果是哪个
          // 子会话给的——将来要复核「是谁写的」，得从这个 id 追回去。
          artifact: `child-session:${run.id}`,
        }
      } finally {
        // 授权随派遣一起结束。按 `dispatch_id` 释放：一个迟到的释放（旧 attempt 的收尾）不得动摇
        // 新 attempt 的绑定——这正是「重试之后子会话 B 的 scope 不能被 A 的清掉」那条。
        bindings?.release(dispatchId)
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
