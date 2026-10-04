/**
 * Per-session declared write scope.
 *
 * @module dsh-gac-runtime/session-scope
 *
 * This is the bridge that makes the write-scope gate usable before the full
 * coordinator exists. It holds, for each live session, the write scope its
 * current task node declared — and nothing else. It is the runtime's memory of
 * an authority decision, never the decision itself:
 *
 *  - The *scope* comes from a declared node (`authority.write` in the
 *    architecture outline §20, §21). This module never invents one.
 *  - A session with no entry is UNGOVERNED, not permissive-by-default. The
 *    guard must treat "no declaration" as "no GAC authority to enforce", which
 *    is different from "may write anywhere".
 *
 * Deliberately in-memory for now. A process restart drops every scope, and
 * that is the correct failure direction: a stale scope that outlives its
 * session would keep enforcing an authority nobody holds. Durable task state
 * arrives with the coordinator (adaptation plan Phase 2-3), which will
 * re-declare scopes on resume from the session event log.
 *
 * Kept free of `ctx` so it is unit-testable; lib/plugin.js owns the wiring.
 */

import { createWriteScope } from './write-scope.js'

/**
 * @typedef {object} ScopeDeclaration
 * @property {string} session_id
 * @property {string} task_id
 * @property {string} node_id
 * @property {readonly string[]} write_scope
 * @property {string} [root]
 * @property {number} declared_at
 */

/**
 * Registry of declared write scopes, keyed by session id.
 */
export class SessionScopeRegistry {
  /**
   * @param {{foldCase?: boolean, now?: () => number}} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, ScopeDeclaration & {matcher: ReturnType<typeof createWriteScope>}>} */
    this.entries = new Map()
    this.foldCase = options.foldCase !== false
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Declare the write scope for one session.
   *
   * Re-declaring replaces the previous scope, which is how a task moves from
   * one node to the next. Replacement is intentional and must be an explicit
   * act by the coordinator, not an implicit merge: merging two nodes' scopes
   * would silently widen authority as a task progresses.
   *
   * @param {object} input
   * @param {string} input.session_id
   * @param {string} input.task_id
   * @param {string} input.node_id
   * @param {readonly string[]} input.write_scope
   * @param {string} [input.root]
   * @returns {ScopeDeclaration}
   * @throws {TypeError} on a malformed declaration.
   */
  declare(input) {
    const { session_id: sessionId, task_id: taskId, node_id: nodeId, write_scope: writeScope } = input
    for (const [label, value] of [
      ['session_id', sessionId],
      ['task_id', taskId],
      ['node_id', nodeId],
    ]) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`session-scope: ${label} must be a non-empty string`)
      }
    }
    if (!Array.isArray(writeScope)) {
      throw new TypeError('session-scope: write_scope must be an array of path strings')
    }

    const matcher = createWriteScope(writeScope, {
      foldCase: this.foldCase,
      ...(input.root === undefined ? {} : { rootPrefix: input.root }),
    })
    const declaration = {
      session_id: sessionId,
      task_id: taskId,
      node_id: nodeId,
      write_scope: Object.freeze([...writeScope]),
      ...(input.root === undefined ? {} : { root: input.root }),
      declared_at: this.now(),
    }
    this.entries.set(sessionId, { ...declaration, matcher })
    return declaration
  }

  /**
   * The declaration governing one session, or `undefined` when ungoverned.
   *
   * @param {string} sessionId
   * @returns {ScopeDeclaration|undefined}
   */
  get(sessionId) {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    const { matcher: _matcher, ...declaration } = entry
    return declaration
  }

  /**
   * Evaluate one path against a session's declared scope.
   *
   * @param {string} sessionId
   * @param {string} candidate
   * @returns {{governed: false}
   *   | {governed: true, allowed: boolean, candidate: string, reason?: string, task_id: string, node_id: string}}
   */
  evaluate(sessionId, candidate) {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return { governed: false }
    const verdict = entry.matcher.explain(candidate)
    return {
      governed: true,
      allowed: verdict.allowed,
      candidate: verdict.candidate,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      task_id: entry.task_id,
      node_id: entry.node_id,
    }
  }

  /**
   * Drop one session's scope, e.g. when its task closes.
   *
   * @param {string} sessionId
   * @returns {boolean} whether an entry was removed.
   */
  clear(sessionId) {
    return this.entries.delete(sessionId)
  }

  /**
   * List live session ids holding a scope. Diagnostics only.
   *
   * @returns {string[]}
   */
  sessions() {
    return [...this.entries.keys()]
  }
}
