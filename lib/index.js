/**
 * DSH plugin entry - the harness-shaped shell around the GAC core.
 *
 * @module dsh-gac-runtime
 *
 * WHY THIS FILE IS THIN
 * ---------------------
 * Every decision lives in a dependency-injected module so it can be unit tested
 * (lib/plugin.js and below, covered by test/). This file only translates between
 * DSH's Cordis surface and those modules. The translation is exactly where a
 * harness-upgrade mistake would hide, which is why it is kept small enough to
 * read in one sitting.
 *
 * WHAT IT REGISTERS
 * -----------------
 *  1. The interception: `tools/pre-execute`, prepended so GAC decides before the
 *     per-call authorization reviewer runs. `prepend: true` matters - a reviewer
 *     that authorizes a call the write-scope gate would have refused spends
 *     tokens to produce a decision that is then discarded.
 *
 *     `ctx.tools.guard()` was the other candidate seam and was rejected: a guard
 *     receives only the execution, so it cannot be given a cancellation signal,
 *     while `tools/pre-execute` supplies the typed {allow|deny|ask|cancel}
 *     vocabulary this runtime needs. One seam, not two.
 *
 *  2. The scope source: the `gac_scope` tool. Without a way to declare a scope
 *     the gate could never fire, so its behaviour would stay unproven. The
 *     coordinator will reuse this same seam rather than introduce a second way
 *     for a scope to come into existence.
 *
 * DEGRADATION IS EXPLICIT
 * -----------------------
 * If the `gac_scope` tool cannot be registered (the runtime's authoring helper
 * is unreachable from a linked install), the guard is STILL installed and the
 * load report says the tool is missing. A plugin that silently drops half its
 * behaviour because an optional import failed is worse than one that reports it.
 */

import { appendFileSync } from 'node:fs'

import { createGacCore } from './plugin.js'
import { projectRootFromCwd } from './path-utils.js'
import { ProjectState } from './project-state.js'
import { describeResolutionFailure, importDshPackage } from './resolve-dsh.js'
import { PROJECT_TOOL_NAME, createProjectTool } from './tool-project.js'
import { SCOPE_TOOL_NAME, createScopeTool } from './tool-scope.js'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'gac-runtime'

/**
 * Services that must exist before this plugin activates, enumerated honestly.
 * Declaring fewer would let the plugin load into a composition where its guard
 * silently cannot see what it must decide on.
 */
export const inject = ['tools', 'sessions']

/**
 * Absolute path of the JSONL load/enforcement report.
 *
 * A file rather than a log line, because the point of this phase is to prove the
 * plugin loaded at all: a marker in the profile's own data directory survives,
 * whereas console output inside a web-served harness is not reliably visible and
 * can corrupt a transport.
 *
 * @returns {string}
 */
function reportPath() {
  const home = process.env.DSH_HOME
    ?? (process.env.USERPROFILE ?? process.env.HOME ?? '.')
  const separator = home.includes('\\') ? '\\' : '/'
  return `${home}${separator}gac-runtime-report.jsonl`
}

/**
 * Append one record to the report. Never throws: a diagnostic that can fail the
 * plugin it is diagnosing is worse than no diagnostic.
 *
 * @param {object} record
 * @returns {void}
 */
function report(record) {
  try {
    appendFileSync(reportPath(), `${JSON.stringify({ time: Date.now(), ...record })}\n`, 'utf8')
  } catch {
    // Intentionally ignored - see the JSDoc above.
  }
}

/**
 * Register the model-facing GAC tools, or explain why they could not be.
 *
 * Kept outside `apply` because the Cordis effect body passed to `ctx.effect` is
 * a generator, not an async function: `await` is a syntax error inside it. The
 * async work therefore happens first and its outcome is handed to the effect.
 *
 * Registration is all-or-nothing by design. A session that could declare a mode
 * but not a write scope (or the reverse) would enforce half a policy while
 * appearing to enforce one, which is worse than enforcing none.
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.core
 * @param {import('./project-state.js').ProjectState} deps.state
 * @returns {Promise<{status: string, note: string, tools: string[]}>}
 */
async function registerTools(ctx, { core, state }) {
  try {
    const toolsPackage = await importDshPackage('@deepseek-ai/dsh-tools')
    if (typeof toolsPackage?.defineTool !== 'function') {
      return {
        status: 'unavailable',
        note: describeResolutionFailure('@deepseek-ai/dsh-tools'),
        tools: [],
      }
    }
    const defineTool = toolsPackage.defineTool
    ctx.tools.register(createProjectTool({ state, defineTool }))
    ctx.tools.register(createScopeTool({ core, defineTool }))
    return {
      status: 'registered',
      note: 'execution mode and write scope can be declared, and scope is enforced before dispatch',
      tools: [PROJECT_TOOL_NAME, SCOPE_TOOL_NAME],
    }
  } catch (error) {
    return {
      status: 'failed',
      note: error instanceof Error ? error.message : String(error),
      tools: [],
    }
  }
}

/**
 * Install the GAC write-scope gate and its declaration tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  // One place resolves a session's project root, so the scope matcher, the
  // adapter lookup and the diagnostic view can never disagree about where the
  // project is.
  const rootOf = (sessionId) => {
    try {
      return projectRootFromCwd(ctx.sessions?.get?.(sessionId)?.header?.cwd)
    } catch {
      return undefined
    }
  }

  const core = createGacCore({ resolveRoot: rootOf })
  const state = new ProjectState({ resolveRoot: rootOf })

  const observed = { calls: 0, denials: 0 }
  const tools = await registerTools(ctx, { core, state })

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', (exec) => {
      observed.calls += 1
      const decision = core.preExecute(exec)
      if (decision.kind === 'deny') {
        observed.denials += 1
        report({
          event: 'guard-denied',
          tool: exec?.name,
          session: exec?.agent?.session?.id,
          code: decision.info?.code,
          reason: decision.reason,
        })
      }
      return decision
    }, { prepend: true })

    // A mode declaration is recorded whether or not it escalated, because the
    // escalation path is a policy decision worth auditing after the fact.
    yield ctx.on('tools/result', (exec) => {
      if (exec?.name !== PROJECT_TOOL_NAME) return
      const sessionId = exec?.agent?.session?.id
      const mode = state.modeFor(sessionId)
      if (mode === undefined) return
      report({
        event: 'mode-declared',
        session: sessionId,
        mode: mode.mode,
        declared_mode: mode.declared_mode,
        escalated: mode.escalated,
        risk: mode.risk,
        unchecked: mode.unchecked === true,
      })
    })

    report({
      event: 'plugin-loaded',
      services: { tools: ctx.tools !== undefined, sessions: ctx.sessions !== undefined },
      scope_tool: tools.status,
      scope_tool_note: tools.note,
      registered_tools: tools.tools,
      enforcement: tools.status === 'registered'
        ? 'active - a declared scope is enforced before dispatch'
        : 'guard installed but no declaration tools, so no session can be governed',
    })

    yield () => {
      report({ event: 'plugin-unloaded', observed })
    }
  }, 'gac-runtime lifecycle')
}
