/**
 * `gac_project` 工具：检查工程适配器并声明执行模式。
 *
 * @module dsh-gac-runtime/tool-project
 *
 * 为什么一个工具同时做两件事
 * --------------------------
 * 检查与声明是同一个决定的两半。模型必须先知道自己在哪个工程里、该工程认为
 * 什么是高风险的，然后才能诚实地声明这项工作需要多少流程 —— 而如果它们是
 * 两个工具，模型就可能从未读过适配器便声明了一个模式。
 *
 * 工具描述教给模型模式阶梯
 * ------------------------
 * 模式词汇表要由模型来应用，所以工具文本承载了阶梯与升级规则。它陈述每一级
 * 的后果，而不是该级的名字，因为「standard_task」本身什么也说明不了，而
 * 「一个独立验证者会检查它」则确实说明了问题。
 *
 * 升级被描述成*发生在*某次声明之上的事情，而不是模型应当去预先规避的事情：
 * 试图预测门禁的模型有时会猜错，选一个比工作所需更重的流程，而这正是架构
 * 大纲 §34 要防止的仪式。
 */

import { EXECUTION_MODES } from './project.js'

/** 模型看到的工具名。 */
export const PROJECT_TOOL_NAME = 'gac_project'

/**
 * 构造 `gac_project` 工具的编写选项。
 *
 * @param {object} deps
 * @param {object} deps.state - 一个 `ProjectState` 实例。
 * @returns {object} 可直接交给运行时 `defineTool` 的选项。
 */
export function projectToolOptions({ state }) {
  return {
    name: PROJECT_TOOL_NAME,
    description:
      '读取本工程的 GAC 适配器，并声明当前请求需要多少流程。'
      + '先不带任何参数调用一次，看看本工程的身份、它声明的高风险路径，以及它的能力'
      + '词汇表。然后在即将动手做事时'
      + '声明一个模式。'
      + '模式，按最省的够用流程排在前面：'
      + 'read_only（讲解、搜索、阅读、分析——不创建任务记录）；'
      + 'direct_edit（一处明确、局部、可回退，且你能立即验证的改动——没有'
      + '任务记录，也没有验证者）；'
      + 'standard_task（普通的缺陷修复、功能开发或局部重构，行为会改变'
      + '且需要真实测试——由独立验证者检查结果）；'
      + 'high_risk_task（安全、认证、持久化状态、迁移、公开'
      + '契约、启动或关键状态机、生产——实现之前先从需求'
      + '导出验证计划，随后进行独立复核）。'
      + '选择**最低**的够用模式：流程仪式本身就是成本，而一项改动'
      + '属于修改，并不因此就构成一套工作流。'
      + '声明某个模式时，如果它的目标路径落在工程声明的高风险路径内，就会被自动'
      + '升级为 high_risk_task——不要试图抢先规避它，只需如实声明，'
      + '并报告你被告知的内容。',
    parameters: {
      // 每个参数都是可选的：不传参数意味着「检查」。运行时的编写 DSL 会拒绝
      // `required: false`，所以可选性通过完全省略该键来表达。
      mode: {
        type: 'string',
        enum: [...EXECUTION_MODES],
        description:
          '本次请求最低的够用执行模式。省略则只做检查。',
      },
      reason: {
        type: 'string',
        description:
          '为什么这个模式是最低的够用档。它会作为审计依据被记录下来，所以'
          + '应当点出真实的风险考量，而不是复述模式本身。',
      },
      target_paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          '本次工作会触及的路径，以便拿它们比对工程的'
          + '高风险路径。值得提供：没有它，升级检查就'
          + '无从检查。',
      },
      irreversible: {
        type: 'boolean',
        description: '这次改动是否无法通过回退来撤销。',
      },
      ambiguous: {
        type: 'boolean',
        description: '需求是否仍有未消解的歧义。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          governed: { type: 'boolean', required: true },
          project_id: { type: 'string' },
          adapter_status: { type: 'string', required: true },
          high_risk_paths: { type: 'array', required: true, items: { type: 'string' } },
          capabilities: { type: 'array', required: true, items: { type: 'string' } },
          mode: { type: 'string' },
          escalated: { type: 'boolean' },
          escalated_from: { type: 'string' },
          risk: { type: 'string' },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    /**
     * 检查工程适配器，或声明一个执行模式。
     *
     * @param {object} args
     * @param {{agent?: {session?: {id?: string}}}} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('gac_project 需要一个拥有它的智能体会话')
      }
      const root = state.rootFor(sessionId)
      const declaring = typeof args.mode === 'string' && args.mode !== ''

      // root 会在检查之前先被检验，而没有 root 的情形永远不会走到 `inspect`。
      // 这里的顺序很要紧：没有 root 就没有适配器，检查将不得不为一个从未找到
      // 的工程编造出形状 —— 而更早的版本解引用了不存在的适配器，向模型抛出一个
      // TypeError，而不是一句它能够据以行动的话。
      if (root === undefined) {
        if (declaring) {
          throw new Error(
            'gac_project: 无法声明模式，因为这个会话没有可解析出的工程'
            + '根目录，所以读不到任何适配器，也无从检查任何高风险路径',
          )
        }
        return {
          governed: false,
          adapter_status: 'unresolvable',
          high_risk_paths: [],
          capabilities: [],
          ...(state.modeFor(sessionId) === undefined
            ? {}
            : { mode: state.modeFor(sessionId).mode, risk: state.modeFor(sessionId).risk }),
          summary:
            '这个会话没有可解析出的工程根目录，所以读不到任何 GAC 适配器。'
            + '它处于无管辖状态：声明的模式不会与所声明的'
            + '高风险路径做交叉检查。',
        }
      }

      const view = state.inspect(sessionId, root)
      const adapter = view.adapter
      const base = {
        governed: view.governed,
        ...(adapter === null ? {} : { project_id: adapter.project.id }),
        adapter_status: view.adapter_status,
        high_risk_paths: adapter === null ? [] : [...adapter.risk.high_risk_paths],
        capabilities: adapter === null ? [] : [...adapter.capabilities],
      }

      if (!declaring) {
        return {
          ...base,
          ...(view.mode === null ? {} : { mode: view.mode.mode, risk: view.mode.risk }),
          summary: describeInspection(view),
        }
      }

      const decision = state.declareMode({
        session_id: sessionId,
        root,
        declared_mode: args.mode,
        reason: args.reason,
        target_paths: Array.isArray(args.target_paths) ? args.target_paths : [],
        irreversible: args.irreversible === true,
        ambiguous: args.ambiguous === true,
      })

      return {
        ...base,
        mode: decision.mode,
        escalated: decision.escalated,
        ...(decision.escalated_from === undefined ? {} : { escalated_from: decision.escalated_from }),
        risk: decision.risk,
        summary: describeDeclaration(decision),
      }
    },
  }
}

/**
 * 渲染「检查」那一半。
 *
 * @param {object} view
 * @returns {string}
 */
function describeInspection(view) {
  const lines = []
  if (view.adapter_status !== 'loaded') {
    lines.push(
      `${view.adapter_path} 处没有 GAC 适配器：${view.adapter_note ?? '原因未知'}。`
      + '本工程处于无管辖状态，所以声明的模式不会与所声明的'
      + '高风险路径做交叉检查。',
    )
  } else {
    const adapter = view.adapter
    lines.push(
      `工程 ${adapter.project.id}（${adapter.project.title}）由 ${view.adapter_path} 管辖。`,
    )
    lines.push(
      adapter.risk.high_risk_paths.length === 0
        ? '它没有声明任何高风险路径，所以不会有路径强制触发模式升级。'
        : `高风险路径：${adapter.risk.high_risk_paths.join(', ')}。触及这些路径的工作会被`
          + '升级为 high_risk_task。',
    )
    lines.push(
      adapter.capabilities.length === 0
        ? '它没有声明能力词汇表。'
        : `能力：${adapter.capabilities.join(', ')}。`,
    )
  }
  if (view.mode !== null) {
    lines.push(`当前模式：${view.mode.mode}（风险 ${view.mode.risk}）——${view.mode.reason}`)
  }
  return lines.join(' ')
}

/**
 * 渲染「声明」那一半。
 *
 * @param {object} decision
 * @returns {string}
 */
function describeDeclaration(decision) {
  const parts = []
  if (decision.escalated === true) {
    parts.push(
      `已从 ${decision.escalated_from} 升级为 ${decision.mode}：${decision.reason}。`,
    )
  } else {
    parts.push(`模式 ${decision.mode}（风险 ${decision.risk}）：${decision.reason}。`)
  }
  if (decision.unchecked === true) {
    parts.push(
      '这条记录已被保存，但**没有**与高风险路径做交叉检查，因为本工程'
      + '没有适配器。创建 .dsh/gac/project.json 才能让这项检查成为可能。',
    )
  }
  if (decision.mode === 'read_only' || decision.mode === 'direct_edit') {
    parts.push('这一级别不创建任务记录，也不会有独立验证者运行。')
  } else if (decision.mode === 'standard_task') {
    parts.push('应当由独立验证者检查结果。')
  } else {
    parts.push(
      '实现之前必须先从需求导出验证计划，随后进行'
      + '独立复核。',
    )
  }
  return parts.join(' ')
}

/**
 * 构造一个可直接注册的 `gac_project` ToolDefinition。
 *
 * @param {object} deps
 * @param {object} deps.state - 一个 `ProjectState` 实例。
 * @param {(options: object) => object} deps.defineTool
 * @returns {object}
 */
export function createProjectTool({ state, defineTool }) {
  return defineTool(projectToolOptions({ state }))
}
