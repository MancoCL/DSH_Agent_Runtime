/**
 * GAC runtime core.
 *
 * @module dsh-gac-runtime/plugin
 *
 * Everything testable about the plugin lives here, with its dependencies
 * injected; `lib/index.js` is the DSH-shaped shell that supplies real ones.
 * The split exists so that the *denial decision* — the one behaviour the whole
 * architecture rests on — can be asserted in a unit test instead of only being
 * observed by running a live harness and hoping.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR
 * ---------------------------------
 * The architecture outline §22 puts a guard in front of every tool call:
 *
 *     Tool Call → Pre-execute Guard → Authority Check → Write Scope Check
 *               → Approval Check → Execute
 *
 * and requires an out-of-scope write to be denied BEFORE execution rather than
 * merely observed afterwards (§25). This module implements that one gate.
 *
 * THE GATE FAILS CLOSED ON EVERY UNKNOWN, AND THAT IS THE DESIGN
 * -------------------------------------------------------------
 *  - No declared scope for the session  → governed by nobody, so GAC does not
 *    interfere. Enforcing a scope that was never declared would make the
 *    plugin unusable outside GAC-managed work.
 *  - A tool whose write behaviour is unknown → DENIED while a scope is active.
 *    A new tool appearing in a runtime upgrade must not silently acquire the
 *    power to write outside a declared scope.
 *  - A shell executor → DENIED while a scope is active, because a redirection
 *    target inside a command string cannot be inspected here at all. Denying
 *    is the only truthful option; the alternative is claiming a guarantee this
 *    seam cannot provide (adaptation plan §7, boundary 1).
 *
 * The denial carries a stable `code` and names the declared scope, so the model
 * can correct itself. A denial it cannot act on becomes a retry loop, which
 * costs more than the write it prevented.
 */

import { relativize } from './path-utils.js'
import { SessionScopeRegistry } from './session-scope.js'
import { CALL_KINDS, classifyCall } from './tool-targets.js'

/** Structured error codes carried on every denial. */
export const GAC_CODES = Object.freeze({
  WRITE_SCOPE_DENIED: 'GAC_WRITE_SCOPE_DENIED',
  UNGUARDABLE_WRITE_DENIED: 'GAC_UNGUARDABLE_WRITE_DENIED',
  SHELL_DENIED_UNDER_SCOPE: 'GAC_SHELL_DENIED_UNDER_SCOPE',
})

/**
 * The default logger. Silent, because a plugin that writes to stdout inside a
 * harness corrupts the transport it runs in.
 *
 * @type {{debug: (message: string, detail?: object) => void}}
 */
const silentLogger = Object.freeze({ debug: () => {} })

/**
 * Build the GAC core.
 *
 * @param {object} [options]
 * @param {SessionScopeRegistry} [options.registry]
 * @param {{debug: (message: string, detail?: object) => void}} [options.logger]
 * @param {(sessionId: string) => string|undefined} [options.resolveRoot]
 *   Supplies the project root for a session, used to make an absolute candidate
 *   comparable to a relative declared scope. Absent, candidates are compared as
 *   written and a denial is still the safe outcome.
 * @param {boolean} [options.foldCase]
 * @returns {{
 *   registry: SessionScopeRegistry,
 *   preExecute: (exec: unknown) => {kind: 'allow'} | {kind: 'deny', reason: string, info: object},
 *   declareScope: (input: object) => object,
 *   clearScope: (sessionId: string) => boolean,
 *   inspect: (sessionId: string) => object
 * }}
 */
export function createGacCore(options = {}) {
  const registry = options.registry ?? new SessionScopeRegistry({ foldCase: options.foldCase })
  const logger = options.logger ?? silentLogger
  const resolveRoot = options.resolveRoot

  /**
   * Normalise one candidate into scope-relative form when a root is known.
   *
   * @param {string} sessionId
   * @param {string} candidate
   * @returns {string}
   */
  const toComparable = (sessionId, candidate) => {
    const root = resolveRoot?.(sessionId)
    if (root === undefined) return candidate
    return relativize(candidate, root, { foldCase: options.foldCase })
  }

  /**
   * The pre-execute decision for one tool call.
   *
   * Shape matches DSH's `PreToolDecision`: `{kind:'allow'}` continues the
   * pipeline, `{kind:'deny', reason, info}` stops it before dispatch.
   *
   * @param {unknown} exec - a DSH `ToolExecution`.
   * @returns {{kind: 'allow'} | {kind: 'deny', reason: string, info: {name: string, code: string, reason: string}}}
   */
  const preExecute = (exec) => {
    if (exec === null || typeof exec !== 'object') return { kind: 'allow' }
    const { agent, name, arguments: args } = /** @type {any} */ (exec)

    // No agent means no session to look up, and a global guard must not fire
    // on work it cannot attribute.
    const sessionId = agent?.session?.id ?? agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'allow' }

    const declaration = registry.get(sessionId)
    if (declaration === undefined) return { kind: 'allow' }

    const call = classifyCall(name, args)

    if (call.kind === CALL_KINDS.SHELL) {
      logger.debug('gac: denying shell executor under an active write scope', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.SHELL_DENIED_UNDER_SCOPE,
        `GAC: "${call.name}" is not permitted while a write scope is active for task `
          + `${declaration.task_id}/${declaration.node_id}: a redirection or generator `
          + 'target inside a command string cannot be checked against the declared scope. '
          + 'Use the structured write/edit tools so the write stays inside the scope.',
      )
    }

    if (call.kind === CALL_KINDS.UNKNOWN) {
      logger.debug('gac: denying unknown write-capable tool under an active write scope', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.UNGUARDABLE_WRITE_DENIED,
        `GAC: "${call.name}" is not a tool this runtime knows how to check against a write `
          + 'scope. It is refused while a scope is active rather than assumed safe. '
          + 'Use a known write tool, or clear the scope if this work is not part of the task.',
      )
    }

    if (call.kind !== CALL_KINDS.WRITE) return { kind: 'allow' }

    if (call.guarded === false) {
      logger.debug('gac: denying unguardable write tool call', {
        session: sessionId,
        tool: call.name,
      })
      return deny(
        GAC_CODES.UNGUARDABLE_WRITE_DENIED,
        `GAC: "${call.name}" carried no readable path argument, so it cannot be checked `
          + `against the declared write scope for task ${declaration.task_id}.`,
      )
    }

    for (const rawPath of call.paths) {
      const candidate = toComparable(sessionId, rawPath)
      const verdict = registry.evaluate(sessionId, candidate)
      if (verdict.governed === true && verdict.allowed === false) {
        logger.debug('gac: denied out-of-scope write', {
          session: sessionId,
          tool: call.name,
          path: rawPath,
        })
        return deny(
          GAC_CODES.WRITE_SCOPE_DENIED,
          `GAC: task ${declaration.task_id} node ${declaration.node_id} may write `
            + `[${declaration.write_scope.join(', ')}]. "${rawPath}" is outside that `
            + `scope (${verdict.reason ?? 'no matching scope entry'}).`,
        )
      }
    }

    return { kind: 'allow' }
  }

  return {
    registry,
    preExecute,
    /**
     * Declare a session's write scope. Thin passthrough so callers never reach
     * into the registry directly, keeping the declaration the single entry point.
     *
     * @param {object} input
     * @returns {object}
     */
    declareScope: (input) => registry.declare(input),
    /**
     * @param {string} sessionId
     * @returns {boolean}
     */
    clearScope: (sessionId) => registry.clear(sessionId),
    /**
     * Diagnostic view of one session's governance.
     *
     * @param {string} sessionId
     * @returns {object}
     */
    inspect: (sessionId) => ({
      session_id: sessionId,
      governed: registry.get(sessionId) !== undefined,
      declaration: registry.get(sessionId) ?? null,
    }),
  }
}

/**
 * Materialise a denial in the shape DSH's tool pipeline expects.
 *
 * @param {string} code
 * @param {string} reason
 * @returns {{kind: 'deny', reason: string, info: {name: string, code: string, reason: string}}}
 */
function deny(code, reason) {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'GacScopeDenied',
      code,
      reason,
    },
  }
}
