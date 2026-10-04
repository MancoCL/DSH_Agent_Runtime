/**
 * Project state: the loaded Project Adapter and the resolved execution mode,
 * held per session.
 *
 * @module dsh-gac-runtime/project-state
 *
 * This is where the runtime learns what project it is in. Two facts live here
 * and nowhere else:
 *
 *  1. **The adapter**, loaded once per project root from
 *     `<root>/.dsh/gac/project.json` and validated by `lib/project.js`.
 *  2. **The execution mode** a session declared, after it has been cross-checked
 *     against that adapter's declared high-risk paths.
 *
 * WHY THE MODE IS CROSS-CHECKED RATHER THAN TRUSTED
 * ------------------------------------------------
 * The architecture outline (§5, §6) makes the mode a semantic judgement: the
 * runtime cannot tell whether a change touches an authentication boundary, so
 * the model declares it. But a declaration must not be self-certifying, or
 * "start at the lowest sufficient level" becomes "claim the lowest level". So
 * the declaration is checked against the one thing code *can* check — whether a
 * target path falls in a project-declared high-risk path — and escalated when it
 * does.
 *
 * Note what is deliberately absent: any parsing of the requirement text.
 * Keyword-matching an intent is the kind of plausible gate that fails open on
 * the phrasing it did not anticipate, and the predecessor runtime banned it in
 * its own policy for that reason.
 *
 * NO ADAPTER IS NOT AN ERROR
 * --------------------------
 * A project that has not been adopted has no adapter; it is simply ungoverned.
 * Refusing to work without one would make the plugin unusable everywhere, and
 * inventing a default adapter would silently apply policy the project never
 * declared. `adapter: undefined` is a real state, reported as such.
 *
 * Cache failures are not cached: a missing file may be created a moment later
 * by the very act of adopting the project.
 */

import { readFileSync } from 'node:fs'

import { ProjectAdapterError, modeToRisk, resolveExecutionMode, validateProjectAdapter } from './project.js'

/** The adapter path relative to a project root. */
export const ADAPTER_RELATIVE_PATH = '.dsh/gac/project.json'

/**
 * Join path fragments into one `/`-separated path.
 *
 * This module reports paths in a stable, `/`-separated form so they can be
 * compared with the same convention `lib/write-scope.js` normalises to. A
 * filesystem operation must convert with {@link toNativePath} first: Node
 * accepts `/` on Windows, but being explicit is what keeps reported paths and
 * filesystem paths from silently drifting apart.
 *
 * @param {...string} parts
 * @returns {string}
 */
function join(...parts) {
  const [first, ...rest] = parts
  return [first, ...rest]
    .map((part) => part.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/\/+$/u, ''))
    .filter((part, index) => part !== '' || index === 0)
    .join('/')
}

/**
 * Convert a `/`-separated path to the separator this platform's filesystem API
 * expects.
 *
 * @param {string} path
 * @returns {string}
 */
function toNativePath(path) {
  return process.platform === 'win32' ? path.replace(/\//gu, '\\') : path
}

/**
 * Project Adapter and execution-mode state for the live sessions.
 */
export class ProjectState {
  /**
   * @param {object} [options]
   * @param {(sessionId: string) => string|undefined} [options.resolveRoot]
   *   Supplies the project root for a session. Injected rather than read here so
   *   this module stays free of DSH's session service and remains unit-testable.
   * @param {boolean} [options.foldCase]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    /** @type {Map<string, {status: string, adapter?: object, note?: string, path: string}>} */
    this.adapters = new Map()
    /** @type {Map<string, object>} */
    this.modes = new Map()
    this.resolveRoot = options.resolveRoot ?? (() => undefined)
    this.foldCase = options.foldCase !== false
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * The project root governing one session, or `undefined` when unresolvable.
   *
   * @param {string} sessionId
   * @returns {string|undefined}
   */
  rootFor(sessionId) {
    return this.resolveRoot(sessionId)
  }

  /**
   * Load and validate the adapter for a project root, caching the outcome.
   *
   * @param {string} root - absolute project root.
   * @returns {{status: 'loaded', adapter: object, path: string}
   *   | {status: 'absent', path: string, note: string}
   *   | {status: 'invalid', path: string, note: string}}
   */
  loadAdapter(root) {
    const path = join(root, ADAPTER_RELATIVE_PATH)
    const cached = this.adapters.get(root)
    if (cached !== undefined) return cached

    let outcome
    let text
    try {
      text = readFileSync(toNativePath(path), 'utf8')
    } catch (error) {
      const code = error instanceof Error ? error.code : undefined
      outcome = {
        status: 'absent',
        path,
        note: code === 'ENOENT'
          ? 'this project has no GAC adapter, so it is ungoverned'
          : `could not read the adapter (${code ?? 'unknown error'})`,
      }
      // Absence is cached: re-probing on every call would be I/O for nothing.
      // A project adopting itself mid-session calls `forget()` instead.
      this.adapters.set(root, outcome)
      return outcome
    }

    try {
      outcome = { status: 'loaded', adapter: loadAdapterText(text, path), path }
      this.adapters.set(root, outcome)
    } catch (error) {
      // An invalid adapter is deliberately NOT cached: it is a transient
      // authoring mistake the user is likely fixing right now, and a cached
      // failure would require a restart to clear.
      outcome = {
        status: 'invalid',
        path,
        note: error instanceof Error ? error.message : String(error),
      }
    }
    return outcome
  }

  /**
   * Drop cached adapter state, so the next read reflects the disk.
   *
   * @param {string} [root] - omit to clear every project.
   * @returns {void}
   */
  forget(root) {
    if (root === undefined) {
      this.adapters.clear()
      return
    }
    this.adapters.delete(root)
  }

  /**
   * Record the execution mode one session declared, after cross-checking it.
   *
   * @param {object} input
   * @param {string} input.session_id
   * @param {string} input.root - project root, for adapter lookup.
   * @param {string} input.declared_mode
   * @param {string} [input.reason]
   * @param {readonly string[]} [input.target_paths]
   * @param {boolean} [input.irreversible]
   * @param {boolean} [input.ambiguous]
   * @returns {object} the recorded mode decision.
   * @throws {ProjectAdapterError} on an unknown mode.
   */
  declareMode(input) {
    const loaded = this.loadAdapter(input.root)
    const adapter = loaded.status === 'loaded' ? loaded.adapter : undefined

    const resolved = adapter === undefined
      // With no adapter there is no declared high-risk path to check against,
      // so the declaration stands on its own and says so.
      ? {
        mode: input.declared_mode,
        declared_mode: input.declared_mode,
        escalated: false,
        risk: modeToRisk(input.declared_mode),
        reason: input.reason ?? 'no basis recorded',
        unchecked: true,
      }
      : resolveExecutionMode({
        declared_mode: input.declared_mode,
        reason: input.reason,
        target_paths: input.target_paths,
        irreversible: input.irreversible,
        ambiguous: input.ambiguous,
        adapter,
      }, { foldCase: this.foldCase })

    const record = {
      ...resolved,
      session_id: input.session_id,
      project_id: adapter?.project.id ?? null,
      adapter_path: loaded.path,
      declared_at: this.now(),
    }
    this.modes.set(input.session_id, record)
    return record
  }

  /**
   * The mode one session has declared, if any.
   *
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  modeFor(sessionId) {
    return this.modes.get(sessionId)
  }

  /**
   * Drop a session's mode, e.g. when its task closes.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  clearMode(sessionId) {
    return this.modes.delete(sessionId)
  }

  /**
   * Diagnostic view of one session's project state.
   *
   * @param {string} sessionId
   * @param {string|undefined} root
   * @returns {object}
   */
  inspect(sessionId, root) {
    if (root === undefined) {
      return {
        governed: false,
        note: 'this session has no resolvable project root, so no adapter was read',
        mode: this.modes.get(sessionId) ?? null,
      }
    }
    const loaded = this.loadAdapter(root)
    return {
      governed: loaded.status === 'loaded',
      root,
      adapter_path: loaded.path,
      adapter_status: loaded.status,
      adapter: loaded.status === 'loaded' ? loaded.adapter : null,
      adapter_note: loaded.note ?? null,
      mode: this.modes.get(sessionId) ?? null,
    }
  }
}

/**
 * Load an adapter from text, converting the validator's error into a plain note.
 *
 * @param {string} text
 * @param {string} path
 * @returns {object}
 */
function loadAdapterText(text, path) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ProjectAdapterError(`${path} is not valid JSON: ${detail}`, 'GAC_PROJECT_ADAPTER_INVALID')
  }
  return validateProjectAdapter(parsed, path)
}
