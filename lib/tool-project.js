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
      'Read this project\'s GAC adapter and declare how much process the current request '
      + 'needs. Call it with no arguments first, to see the project\'s identity, its declared '
      + 'high-risk paths, and its capability vocabulary. Then declare a mode when you are about '
      + 'to do work. '
      + 'Modes, cheapest sufficient process first: '
      + 'read_only (explain, search, read, analyse — no task record is created); '
      + 'direct_edit (one unambiguous, local, reversible change you can verify immediately — no '
      + 'task record, no verifier); '
      + 'standard_task (an ordinary bugfix, feature, or local refactor where behaviour changes '
      + 'and real testing is needed — an independent verifier checks the result); '
      + 'high_risk_task (security, authentication, persistent state, migrations, public '
      + 'contracts, boot or critical state machines, production — a verification plan is '
      + 'produced from the requirement before implementation and an independent review follows). '
      + 'Choose the LOWEST sufficient mode: process ceremony is itself a cost, and a change '
      + 'being a modification does not make it a workflow. '
      + 'Declaring a mode whose target paths fall in a project-declared high-risk path is '
      + 'escalated to high_risk_task automatically — do not try to pre-empt that, just declare '
      + 'honestly and report what you are told.',
    parameters: {
      // 每个参数都是可选的：不传参数意味着「检查」。运行时的编写 DSL 会拒绝
      // `required: false`，所以可选性通过完全省略该键来表达。
      mode: {
        type: 'string',
        enum: [...EXECUTION_MODES],
        description:
          'The lowest sufficient execution mode for this request. Omit to only inspect.',
      },
      reason: {
        type: 'string',
        description:
          'Why this mode is the lowest sufficient one. Recorded as the audit basis, so it '
          + 'should name the actual risk consideration, not restate the mode.',
      },
      target_paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Paths this work will touch, so they can be checked against the project\'s '
          + 'high-risk paths. Worth providing: without it the escalation check has nothing '
          + 'to check.',
      },
      irreversible: {
        type: 'boolean',
        description: 'Whether the change cannot be undone by reverting it.',
      },
      ambiguous: {
        type: 'boolean',
        description: 'Whether the requirement still has unresolved ambiguity.',
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
        throw new Error('gac_project requires an owning agent session')
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
            'gac_project: cannot declare a mode because this session has no resolvable project '
            + 'root, so no adapter could be read and no high-risk path could be checked',
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
            'This session has no resolvable project root, so no GAC adapter could be read. '
            + 'It is ungoverned: a declared mode would not be cross-checked against declared '
            + 'high-risk paths.',
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
      `No GAC adapter at ${view.adapter_path}: ${view.adapter_note ?? 'unknown reason'}. `
      + 'This project is ungoverned, so a declared mode will not be cross-checked against '
      + 'declared high-risk paths.',
    )
  } else {
    const adapter = view.adapter
    lines.push(
      `Project ${adapter.project.id} (${adapter.project.title}) governed by ${view.adapter_path}.`,
    )
    lines.push(
      adapter.risk.high_risk_paths.length === 0
        ? 'It declares no high-risk paths, so no path will force a mode escalation.'
        : `High-risk paths: ${adapter.risk.high_risk_paths.join(', ')}. Work touching these is `
          + 'escalated to high_risk_task.',
    )
    lines.push(
      adapter.capabilities.length === 0
        ? 'It declares no capability vocabulary.'
        : `Capabilities: ${adapter.capabilities.join(', ')}.`,
    )
  }
  if (view.mode !== null) {
    lines.push(`Current mode: ${view.mode.mode} (risk ${view.mode.risk}) — ${view.mode.reason}`)
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
      `Escalated from ${decision.escalated_from} to ${decision.mode}: ${decision.reason}.`,
    )
  } else {
    parts.push(`Mode ${decision.mode} (risk ${decision.risk}): ${decision.reason}.`)
  }
  if (decision.unchecked === true) {
    parts.push(
      'This is recorded but was NOT cross-checked against high-risk paths, because the project '
      + 'has no adapter. Create .dsh/gac/project.json to make the check possible.',
    )
  }
  if (decision.mode === 'read_only' || decision.mode === 'direct_edit') {
    parts.push('No task record is created at this level, and no independent verifier runs.')
  } else if (decision.mode === 'standard_task') {
    parts.push('An independent verifier should check the result.')
  } else {
    parts.push(
      'A verification plan must be derived from the requirement before implementation, and an '
      + 'independent review follows.',
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
