/**
 * DSH plugin entry — the harness-shaped shell around lib/plugin.js.
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
 * One interception: `tools/pre-execute`, prepended so GAC decides before the
 * per-call authorization reviewer runs. `prepend: true` matters — a reviewer
 * that authorizes a call the write-scope gate would have refused spends tokens
 * to produce a decision that is then discarded.
 *
 * `ctx.tools.guard()` was the other candidate seam and was rejected: a guard
 * receives only the execution, so it cannot be given a cancellation signal, and
 * `tools/pre-execute` already supplies the typed {allow|deny|ask|cancel}
 * vocabulary this runtime needs. One seam, not two.
 *
 * THE SCOPE SOURCE IS STILL MISSING, DELIBERATELY
 * -----------------------------------------------
 * v0.1 has no way for a task to declare its write scope, so every session is
 * ungoverned and the guard allows everything. That is a truthful phase boundary,
 * not an oversight: the interception path is the only unverified assumption in
 * the architecture, so it is being proven in isolation before the coordinator
 * that would feed it is built. The load report below records exactly that.
 */

import { appendFileSync } from 'node:fs'
import { createGacCore } from './plugin.js'
import { projectRootFromCwd } from './path-utils.js'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'gac-runtime'

/**
 * Services that must exist before this plugin activates, enumerated honestly:
 * the tool registry to intercept, and the session store to resolve a caller's
 * project root. Declaring fewer would let the plugin load into a composition
 * where its guard silently cannot see what it must decide on.
 */
export const inject = ['tools', 'sessions']

/**
 * Where the load report is written.
 *
 * A file rather than a log line, because the point of this phase is to prove
 * the plugin loaded at all: a marker that survives in the profile's own data
 * directory is evidence, whereas console output inside a web-served harness is
 * not reliably visible and can corrupt a transport.
 *
 * @returns {string} absolute path of the JSONL report.
 */
function reportPath() {
  const home = process.env.DSH_HOME
    ?? (process.env.USERPROFILE ?? process.env.HOME ?? '.')
  const separator = home.includes('\\') ? '\\' : '/'
  return `${home}${separator}gac-runtime-report.jsonl`
}

/**
 * Append one record to the load report. Never throws: a diagnostic that can
 * fail the plugin it is diagnosing is worse than no diagnostic.
 *
 * @param {object} record
 * @returns {void}
 */
function report(record) {
  try {
    appendFileSync(reportPath(), `${JSON.stringify({ time: Date.now(), ...record })}\n`, 'utf8')
  } catch {
    // Intentionally ignored — see the JSDoc above.
  }
}

/**
 * Install the write-scope gate.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {void}
 */
export function apply(ctx) {
  const core = createGacCore({
    // The project root for a session comes from its own header, so containment
    // compares like with like even though the declared scope is relative.
    resolveRoot: (sessionId) => {
      try {
        const session = ctx.sessions?.get?.(sessionId)
        return projectRootFromCwd(session?.header?.cwd)
      } catch {
        return undefined
      }
    },
  })

  const observed = { calls: 0, denials: 0 }

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
        })
      }
      return decision
    }, { prepend: true })

    report({
      event: 'plugin-loaded',
      services: {
        tools: ctx.tools !== undefined,
        sessions: ctx.sessions !== undefined,
      },
      // Stated explicitly so a reader of the report cannot mistake a loaded
      // plugin for an enforcing one.
      enforcement: 'inactive — no scope declaration source in v0.1',
    })

    yield () => {
      report({ event: 'plugin-unloaded', observed })
    }
  }, 'gac-runtime lifecycle')
}
