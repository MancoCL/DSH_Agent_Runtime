/**
 * The `gac_project` tool: inspect the Project Adapter and declare an execution
 * mode.
 *
 * @module dsh-gac-runtime/tool-project
 *
 * WHY ONE TOOL DOES BOTH
 * ----------------------
 * Inspecting and declaring are two halves of one decision. The model needs to
 * know which project it is in and what that project considers risky *before* it
 * can honestly declare how much process the work needs — and if they were two
 * tools, the model could declare a mode without ever having read the adapter.
 *
 * THE DESCRIPTION TEACHES THE MODE LADDER
 * ---------------------------------------
 * The mode vocabulary is the model's to apply, so the tool text carries the
 * ladder and the escalation rule. It states the consequence of each level rather
 * than the level's name, because "standard_task" means nothing on its own while
 * "an independent verifier will check this" does.
 *
 * The escalation is described as something that *happens to* a declaration, not
 * something the model should pre-empt: a model that tried to predict the gate
 * would sometimes guess wrong and pick a heavier process than the work needs,
 * which is the ceremony the outline's §34 exists to prevent.
 */

import { EXECUTION_MODES } from './project.js'

/** Tool name as the model sees it. */
export const PROJECT_TOOL_NAME = 'gac_project'

/**
 * Build the authoring options for the `gac_project` tool.
 *
 * @param {object} deps
 * @param {object} deps.state - a `ProjectState` instance.
 * @returns {object} options ready for the runtime's `defineTool`.
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
      // Every parameter is optional: no arguments means "inspect". The runtime's
      // authoring DSL rejects `required: false`, so optionality is expressed by
      // omitting the key entirely.
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
     * Inspect the Project Adapter, or declare an execution mode.
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

      // The root is checked BEFORE inspecting, and the no-root case never
      // reaches `inspect`. Ordering matters here: with no root there is no
      // adapter, so inspecting would have to invent a shape for a project it
      // never found — and an earlier version dereferenced the absent adapter and
      // threw a TypeError at the model instead of a sentence it could act on.
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
 * Render the inspection half.
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
 * Render the declaration half.
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
 * Build a registry-ready `gac_project` ToolDefinition.
 *
 * @param {object} deps
 * @param {object} deps.state - a `ProjectState` instance.
 * @param {(options: object) => object} deps.defineTool
 * @returns {object}
 */
export function createProjectTool({ state, defineTool }) {
  return defineTool(projectToolOptions({ state }))
}
