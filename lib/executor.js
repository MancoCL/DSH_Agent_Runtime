/**
 * 执行者边界：把节点真正交给谁去跑。
 *
 * @module dsh-gac-runtime/executor
 *
 * 协调器只决定「该派谁、给什么约束、结果能不能改状态」，本模块负责那个洞：**真的去调**。
 * 在这之前，插件只记录状态而从不调用执行者——那样它是个账本，不是运行时。
 *
 * 两种执行者，差别是硬约束而不是偏好
 * ----------------------------------
 * 进程内的一次模型调用**没有写入工具**，所以它只能承载「只回传报告、不写文件」的节点。
 * 需要落盘的节点必须交给有工具的会话（子 Agent）。把这条写成能力判断而不是配置项，
 * 是为了让「给一个只读执行者派了写代码的活」变成选不出来，而不是跑一半失败。
 *
 * 因此 {@link createInProcessExecutor} 只接收 `write_scope` 为空的节点，并**拒绝**其余
 * 节点。拒绝是好结果：调用方会转而使用会话型执行者，而不是拿到一份看起来成功、实际上
 * 什么都没写的报告。
 *
 * 超时如实报「仍在进行」
 * ----------------------
 * 工具调用不能无限期挂着。超过期限时返回 `in_progress` 而不是伪造一个成功或失败——
 * 一次仍在跑的派遣，其结果是未知的，而未知既不是通过也不是失败。
 *
 * 提示词把约束写进去，而不是指望执行者自觉
 * ----------------------------------------
 * 节点的写范围、停止条件、产物去向都进提示词。一个不知道边界的执行者会去撞边界，然后
 * 把撞墙当成失败反馈回来，而真正的信息是它本不该往那里走。
 */

import { importDshPackage } from './resolve-dsh.js'

/** 执行者返回的状态。 */
export const EXECUTION_STATUSES = Object.freeze(['completed', 'failed', 'blocked', 'in_progress'])

/**
 * 按适配器声明的路由，造出这一批进程内执行者。
 *
 * 名字**逐字取路由的键**，不加修饰。这个约束不是风格问题：能力路由返回的是适配器
 * `executors` 里列出的名字，派遣时按名字 `find(name === routed.executor)` 找执行者。早先
 * 名字被拼成 `能力名:provider/model`，于是永远找不到，每次静默落到「谁 supports 就谁上」
 * 的兜底分支——声明的路由被忽略而表面上一切正常。这种缺陷靠观察发现不了，只能靠一条断言
 * 把「名字来自键」钉住。
 *
 * @param {object} deps
 * @param {Record<string, {provider: string, model: string}>} deps.routes - 键为执行者名字。
 * @param {() => object|undefined} deps.llmFor
 * @param {() => number} [deps.now]
 * @returns {object[]}
 */
export function createRoutedExecutors({ routes, llmFor, now }) {
  return Object.entries(routes ?? {}).map(([executorName, route]) =>
    Object.assign(createInProcessExecutor({ llmFor, route, ...(now === undefined ? {} : { now }) }), {
      name: executorName,
    }))
}

/**
 * 进程内执行者：用一次模型调用承载「只回传报告」的节点。
 *
 * @param {object} deps
 * @param {() => object|undefined} deps.llmFor - 返回 `ctx.llm`，不可用时返回 undefined。
 * @param {{provider: string, model: string}} deps.route - 该执行者固定使用的模型。
 * @param {() => number} [deps.now]
 * @returns {object} 执行者。
 */
export function createInProcessExecutor({ llmFor, route, now = () => Date.now() }) {
  return {
    name: `in-process:${route.provider}/${route.model}`,

    // 把路由暴露出来，是为了让「这次结论是哪个模型给的」可以被查证。独立性如果只能靠
    // 部署说明来相信，它就不是一件可核对的事。
    route: Object.freeze({ provider: route.provider, model: route.model }),

    /**
     * 只承载不需要写文件的节点。
     *
     * @param {object} node
     * @returns {boolean}
     */
    supports(node) {
      return Array.isArray(node.write_scope) && node.write_scope.length === 0
    },

    /**
     * 跑一个节点。
     *
     * @param {object} input
     * @param {object} input.node
     * @param {object} input.task
     * @param {string} input.root
     * @param {string} input.dispatchId
     * @param {AbortSignal} input.signal
     * @returns {Promise<{status: string, summary: string, artifact?: string, reason?: string}>}
     */
    async run({ node, task, root, dispatchId, signal }) {
      const llm = llmFor()
      if (llm === undefined) {
        return {
          status: 'blocked',
          summary: '进程内执行者不可用：运行时没有暴露 llm 服务',
          reason: 'llm service unavailable',
        }
      }

      const startedAt = now()
      let text
      try {
        text = await readAssistantText(llm.stream({
          provider: route.provider,
          model: route.model,
          system: buildSystemPrompt(),
          messages: [{ role: 'user', content: [{ type: 'text', text: buildTaskPrompt({ node, task, root, dispatchId }) }] }],
          temperature: 0,
          signal,
        }))
      } catch (error) {
        // 抛错是调用层故障，不是节点失败；如实报 blocked 并留下原因，让 repair 能区分
        // 「活干砸了」与「根本没跑起来」。
        return {
          status: 'blocked',
          summary: `进程内执行者调用失败：${error instanceof Error ? error.message : String(error)}`,
          reason: 'executor transport failure',
        }
      }

      return {
        status: 'completed',
        summary: text,
        artifact: `${dispatchId}@${startedAt}`,
      }
    },
  }
}

/**
 * 会话型执行者的占位：需要写文件的节点必须由有工具的执行者承载。
 *
 * 它**不做事**，只如实说明自己不能承载——因为进程内没有写工具，而假装能写会产出
 * 一份看起来成功、实际什么都没改的报告。真正的会话型派遣由上层用运行时的子 Agent
 * 能力发起；这里留出接缝，而不是塞一个假的实现。
 *
 * @param {object} [deps]
 * @param {string} [deps.name]
 * @returns {object}
 */
export function createSessionExecutor({ name = 'session' } = {}) {
  return {
    name,
    supports: () => true,
    async run({ node }) {
      // 理由必须说对。早先这里不分情况地写「需要写入 [...]」，于是不写文件的节点
      // （write_scope 为空，例如独立验证节点）也会被报成「需要写入 []」——一句话把节点
      // 说成了它并不是的东西。这条消息是模型判断「为什么轮到我自己动手」的唯一依据，
      // 理由说错会把它引向错误的动作：去改文件，而该节点一个文件都不该动。
      const writes = Array.isArray(node.write_scope) ? node.write_scope : []
      const reason = writes.length > 0
        ? `需要写入 [${writes.join(', ')}]，必须由带工具的会话执行`
        : '没有可承载它的进程内执行者，需要会话内执行'
      return {
        status: 'in_progress',
        summary: `节点 ${node.id} ${reason}。本次派遣已登记，等待上层发起会话并把结果回报回来。`,
      }
    },
  }
}

/**
 * 为一个节点挑选执行者。
 *
 * @param {readonly object[]} executors
 * @param {object} node
 * @returns {object|undefined}
 */
export function pickExecutor(executors, node) {
  return executors.find((executor) => executor.supports(node))
}

/**
 * 执行者的系统提示词。
 *
 * 它刻意很短：具体约束由每条任务提示词给出，这里只交代身份与「不要越界」这一条。
 * 把通用原则与具体约束混在一段长提示里，会让执行者在二者冲突时无从判断。
 *
 * @returns {string}
 */
function buildSystemPrompt() {
  return [
    '你是 GAC 运行时派出的一个执行者。你只负责所给节点的目标。',
    '严格待在给定的写范围内；你没有任何写入工具，报告就是你的全部产物。',
    '报告要能让下一个人据此判断对错：写清你检查了什么、看到了什么、结论是什么。',
    '不要复述任务描述，不要客套，也不要说「我无法」。',
  ].join('')
}

/**
 * 单个节点的任务提示词。
 *
 * @param {object} input
 * @returns {string}
 */
function buildTaskPrompt({ node, task, root, dispatchId }) {
  const lines = [
    `项目根目录：${root}`,
    `任务：${task.task_id}（模式 ${task.mode}）`,
    `节点：${node.id} — ${node.objective}`,
    `本次派遣标识：${dispatchId}`,
  ]
  lines.push(
    node.depends_on.length === 0
      ? '本节点无前置依赖。'
      : `前置节点：${node.depends_on.join('、')}（均已完成）。`,
  )
  lines.push(
    node.expected_artifacts.length === 0
      ? '预期产物：一份书面报告。'
      : `预期产物：${node.expected_artifacts.join('、')}。`,
  )
  lines.push('你只能读取与推理，不能写文件；需要落盘的结论请在报告里写清楚，由会话型执行者落盘。')
  return lines.join('\n')
}

/**
 * 读完整条模型流，拼出文本块。
 *
 * 用运行时自己的分块拼装器，而不是在本仓库重写一份：分块语义（尤其是重复
 * `block-start`、以及 `block-end` 覆盖已累积内容这类边界）属于被集成的那一方，
 * 重写一份只会让「本地测试通过、真实流拼错」这种偏差有机会存在。
 *
 * import 在函数内进行而非模块作用域：本模块要能在没有 DSH 的机器上被单元测试加载，
 * 而失败时如实报 blocked，而不是抛出一个说不清原因的加载错误。
 *
 * 只接受以 `stop` 结束的流：以 `error` 或 `aborted` 结束的流是半截话，把半截话当成
 * 结论会让一份不完整的报告看起来像一份完成的报告。
 *
 * @param {AsyncIterable<object>} stream
 * @returns {Promise<string>}
 */
async function readAssistantText(stream) {
  const llmPackage = await importDshPackage('@deepseek-ai/dsh-llm')
  if (typeof llmPackage?.BlockAssembler !== 'function') {
    throw new Error('运行时没有给出 BlockAssembler，无法拼装模型流')
  }
  const assembler = new llmPackage.BlockAssembler()
  let finished = false
  let failure
  for await (const chunk of stream) {
    assembler.push(chunk)
    if (chunk?.type === 'finish') {
      finished = true
      if (chunk.reason?.kind !== 'stop') {
        failure = chunk.reason?.failure?.message ?? chunk.reason?.kind ?? 'unknown'
      }
    }
  }
  if (!finished) throw new Error('模型流没有给出结束原因')
  if (failure !== undefined) throw new Error(`模型流以非正常原因结束：${failure}`)
  return assembler.blocks()
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}
