/**
 * Durable write-claim store.
 *
 * @module dsh-gac-runtime/claim-store
 *
 * Claims outlive the process that made them and must be visible to every session
 * in every process, because the collision they prevent is between writers that
 * know nothing about each other. So they live on disk, one file per claim, under
 * `<project>/.dsh/gac/claims/`.
 *
 * ONE FILE PER CLAIM, CREATED EXCLUSIVELY
 * --------------------------------------
 * A single registry file would need read-modify-write, and two sessions racing
 * on it would lose one claim — the failure mode this layer exists to prevent.
 * One file per session, opened with the exclusive-create flag, makes the
 * filesystem do the mutual exclusion: whoever creates the file owns the claim.
 *
 * A CLAIM IS KEYED BY SESSION, NOT BY DISPATCH
 * --------------------------------------------
 * The natural key would be a dispatch id, but a scope is declared *before* work
 * starts and often before a dispatch exists. Keying by session matches how a
 * scope is actually held — one live scope per session — and makes release
 * authorisation trivial: only the owning session may release its own claim.
 * Without that check, a forged or stale declaration could free another writer's
 * guard, which is the mistake the predecessor runtime recorded in its own notes.
 *
 * LIVENESS IS THE HOST'S QUESTION
 * -------------------------------
 * A claim whose session has died would block writers forever. Pruning therefore
 * needs to know which sessions are live, which this module cannot determine, so
 * a predicate is injected. When no predicate is available claims are kept, not
 * guessed away: blocking a writer is recoverable, and letting two write one file
 * is not. Age alone is never treated as death for the same reason.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { findClaimConflict, validateClaim } from './claims.js'

/** Directory, relative to a project root, holding claim files. */
export const CLAIMS_RELATIVE_DIR = '.dsh/gac/claims'

/**
 * Join path fragments into one `/`-separated path.
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
 * Convert a `/`-separated path to the separator this platform expects.
 *
 * @param {string} path
 * @returns {string}
 */
function toNativePath(path) {
  return process.platform === 'win32' ? path.replace(/\//gu, '\\') : path
}

/**
 * Make a session id safe to use as a filename.
 *
 * Session ids are host-minted and normally filename-safe, but this store must
 * not assume that: a crafted id containing a separator would escape the claims
 * directory. Anything outside the safe set is percent-encoded, and the original
 * id is kept inside the file, so the round trip is lossless and verifiable.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function claimFileName(sessionId) {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}.json`
}

/**
 * The write-claim store for one project root.
 */
export class ClaimStore {
  /**
   * @param {object} options
   * @param {string} options.root - absolute project root.
   * @param {() => readonly string[]} [options.liveSessions]
   *   Returns the session ids that are currently alive. Injected because only
   *   the host knows. Absent, no claim is ever pruned as dead.
   * @param {() => number} [options.now]
   * @param {boolean} [options.foldCase]
   */
  constructor(options) {
    if (typeof options?.root !== 'string' || options.root === '') {
      throw new TypeError('ClaimStore requires a project root')
    }
    this.root = options.root
    this.directory = join(options.root, CLAIMS_RELATIVE_DIR)
    this.liveSessions = options.liveSessions
    this.now = options.now ?? (() => Date.now())
    this.foldCase = options.foldCase !== false
    /** Claims whose file could not be read or parsed, for the diagnostics view. */
    this.unreadable = []
  }

  /**
   * Read every readable claim, reporting the ones that are not.
   *
   * A malformed file is reported rather than skipped, because skipping it would
   * silently drop collision protection for the paths it named — the protection
   * would look present and be absent. It is also not deleted: an unreadable
   * claim is evidence, and destroying evidence to tidy a directory is the wrong
   * trade.
   *
   * @returns {import('./claims.js').Claim[]}
   */
  list() {
    this.unreadable = []

    // Verify the root first. On Windows, listing a path under a non-directory
    // reports ENOENT, which is indistinguishable from "no claims yet" — so a
    // store pointed at a bogus root would report itself as empty and let a
    // writer proceed against unknown holders. Checking the root explicitly
    // separates "nothing here yet" from "cannot see what is here".
    try {
      if (!statSync(toNativePath(this.root)).isDirectory()) {
        this.unreadable.push({ file: this.root, reason: 'project root is not a directory' })
        return []
      }
    } catch (error) {
      this.unreadable.push({
        file: this.root,
        reason: `project root is not readable (${String(error?.code ?? error)})`,
      })
      return []
    }

    let names
    try {
      names = readdirSync(toNativePath(this.directory))
    } catch (error) {
      // The root exists but there is no claims directory: that is the normal
      // state before any claim has been made, not a problem.
      if (error instanceof Error && error.code === 'ENOENT') return []
      this.unreadable.push({ file: this.directory, reason: String(error?.code ?? error) })
      return []
    }

    const claims = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.directory, name)
      let parsed
      try {
        parsed = JSON.parse(readFileSync(toNativePath(path), 'utf8'))
      } catch (error) {
        this.unreadable.push({ file: path, reason: String(error?.code ?? error) })
        continue
      }
      try {
        const claim = validateClaim(parsed, path)
        // The filename must agree with the claim it holds, or a file placed by
        // hand could claim to be someone else's session.
        if (claimFileName(claim.session_id) !== name) {
          this.unreadable.push({ file: path, reason: 'filename does not match its session_id' })
          continue
        }
        claims.push(claim)
      } catch (error) {
        this.unreadable.push({ file: path, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return claims
  }

  /**
   * Claims that are not held by a live session.
   *
   * A predicate that returns `undefined` is saying "I do not know who is live" —
   * distinct from returning `[]`, which says "nobody is". Unknown liveness keeps
   * every claim, for the same reason a missing predicate does: blocking a writer
   * is recoverable, and two writers on one file is not.
   *
   * @param {readonly import('./claims.js').Claim[]} [claims]
   * @returns {import('./claims.js').Claim[]}
   */
  orphans(claims = this.list()) {
    if (typeof this.liveSessions !== 'function') return []
    let live
    try {
      live = this.liveSessions()
    } catch {
      // A failing predicate must not be read as "everything is dead".
      return []
    }
    if (live === undefined) return []
    const living = new Set(live)
    return claims.filter((claim) => !living.has(claim.session_id))
  }

  /**
   * Remove claims whose session is gone.
   *
   * @returns {{removed: string[], failed: string[]}}
   */
  pruneOrphans() {
    const removed = []
    const failed = []
    for (const claim of this.orphans()) {
      if (this.remove(claim.session_id)) removed.push(claim.session_id)
      else failed.push(claim.session_id)
    }
    return { removed, failed }
  }

  /**
   * The claim one session holds, if any.
   *
   * @param {string} sessionId
   * @returns {import('./claims.js').Claim|undefined}
   */
  get(sessionId) {
    const path = join(this.directory, claimFileName(sessionId))
    try {
      return validateClaim(JSON.parse(readFileSync(toNativePath(path), 'utf8')), path)
    } catch {
      return undefined
    }
  }

  /**
   * Try to acquire a claim for one session.
   *
   * @param {object} input
   * @param {string} input.session_id
   * @param {string} input.task_id
   * @param {string} input.node_id
   * @param {readonly string[]} input.write_scope
   * @returns {{acquired: true, claim: import('./claims.js').Claim}
   *   | {acquired: false, conflict: object}}
   * @throws {Error} when a claim file cannot be written at all.
   */
  acquire(input) {
    const { session_id: sessionId, write_scope: writeScope } = input
    // Sweep the dead before judging a conflict: a departed session must not hold
    // the paths it left behind. The sweep runs only when liveness is actually
    // KNOWN — with an unknown or absent predicate, "every claim is an orphan"
    // would DELETE live claims and silently disable collision protection, which
    // is the exact failure this module exists to prevent.
    if (this.orphans().length > 0) this.pruneOrphans()

    const existing = this.list().filter((claim) => claim.session_id !== sessionId)
    const conflict = findClaimConflict(
      { scope: writeScope, claims: existing },
      { foldCase: this.foldCase },
    )
    if (conflict.conflict) return { acquired: false, conflict }

    const timestamp = this.now()
    const claim = validateClaim({
      dispatch_id: `${sessionId}:${renderScopeKey(writeScope)}`,
      session_id: sessionId,
      task_id: input.task_id,
      node_id: input.node_id,
      write_scope: writeScope,
      created_at: timestamp,
      heartbeat_at: timestamp,
    })

    mkdirSync(toNativePath(this.directory), { recursive: true })
    // Exclusive create is the mutual exclusion: if the file already exists a
    // sibling process won the race for this session's slot.
    writeFileSync(toNativePath(join(this.directory, claimFileName(sessionId))), `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    })

    // Re-check after writing. The pre-write check and the write are not atomic,
    // so a claim that appeared in between would otherwise be missed entirely.
    const after = this.list().filter((claim_) => claim_.session_id !== sessionId)
    const raced = findClaimConflict(
      { scope: writeScope, claims: after },
      { foldCase: this.foldCase },
    )
    if (raced.conflict) {
      this.remove(sessionId)
      return { acquired: false, conflict: raced }
    }
    return { acquired: true, claim }
  }

  /**
   * Release a claim, but only for the session that holds it.
   *
   * @param {string} sessionId
   * @param {string} [requireSessionId] - when given, the claim must belong to it.
   * @returns {boolean} whether a claim was removed.
   */
  release(sessionId, requireSessionId) {
    if (requireSessionId !== undefined && requireSessionId !== sessionId) return false
    return this.remove(sessionId)
  }

  /**
   * Delete one claim file.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  remove(sessionId) {
    try {
      rmSync(toNativePath(join(this.directory, claimFileName(sessionId))), { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * Refresh a claim's heartbeat.
   *
   * @param {string} sessionId
   * @returns {boolean} whether a claim was refreshed.
   */
  heartbeat(sessionId) {
    const claim = this.get(sessionId)
    if (claim === undefined) return false
    try {
      writeFileSync(
        toNativePath(join(this.directory, claimFileName(sessionId))),
        `${JSON.stringify({ ...claim, heartbeat_at: this.now() }, null, 2)}\n`,
        'utf8',
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * Diagnostic view of every claim, plus the unreadable files.
   *
   * @returns {{claims: object[], orphans: string[], unreadable: {file: string, reason: string}[], directory: string}}
   */
  inspect() {
    const claims = this.list()
    return {
      directory: this.directory,
      claims: claims.map((claim) => ({
        session_id: claim.session_id,
        task_id: claim.task_id,
        node_id: claim.node_id,
        write_scope: [...claim.write_scope],
        heartbeat_at: claim.heartbeat_at,
      })),
      orphans: this.orphans(claims).map((claim) => claim.session_id),
      unreadable: [...this.unreadable],
    }
  }
}

/**
 * A stable, human-readable key describing a scope, for a claim's display id.
 *
 * @param {readonly string[]} scope
 * @returns {string}
 */
function renderScopeKey(scope) {
  const rendered = scope.join(',')
  return rendered.length <= 80 ? rendered : `${rendered.slice(0, 77)}...`
}
