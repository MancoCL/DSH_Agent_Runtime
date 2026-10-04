/**
 * Write-claim conflict detection.
 *
 * @module dsh-gac-runtime/claims
 *
 * WHAT THIS IS FOR
 * ----------------
 * The architecture outline (§24, §45) wants two sessions that would write the
 * same files to be kept apart *physically*, not merely warned about. DSH does
 * not provide this: `agentTeams` normalises `writeScopes` and emits an overlap
 * warning, but its own README states it will "never block claim or authorize
 * writes". So this is a genuine gap and this module fills it.
 *
 * Claims are compared as **scope prefixes**, never as literal path strings. Two
 * declarations of `src/` and `src/deep/a.c` do not collide textually, yet a
 * write to the second is plainly inside the first — comparing strings would miss
 * exactly the collisions worth catching.
 *
 * THE RULE IS PREFIX OVERLAP, AND IT IS DELIBERATELY CONSERVATIVE
 * -------------------------------------------------------------
 * Two scopes conflict when one's directory prefix is at, above, or below the
 * other's. That over-reports in one case: `src/*.c` and `src/*.h` share the
 * prefix `src` and are reported as conflicting although the sets are disjoint.
 *
 * The asymmetry is chosen, not overlooked. A false positive costs a session some
 * parallelism; a false negative lets two writers collide on one file, which is
 * the failure this module exists to prevent and which is not repairable after
 * the fact — the second writer's work cannot be separated from the first's. The
 * outline's own §33 ("minimum necessary complexity") permits a coarse rule where
 * the refined one buys nothing that matters.
 *
 * Scope entries are read from the same declaration the write-scope gate uses, so
 * a claim can never cover less than what its session is permitted to write.
 */

import { normalizePath } from './write-scope.js'

/** Structured codes, so callers branch on a code and not on a message. */
export const CLAIM_CODES = Object.freeze({
  CONFLICT: 'GAC_WRITE_SCOPE_BUSY',
  MALFORMED: 'GAC_CLAIM_MALFORMED',
})

/**
 * A claim as stored: what one dispatch declared, and when.
 *
 * @typedef {object} Claim
 * @property {string} dispatch_id
 * @property {string} session_id
 * @property {string} task_id
 * @property {string} node_id
 * @property {readonly string[]} write_scope
 * @property {number} created_at
 * @property {number} heartbeat_at
 */

/**
 * Reduce one scope entry to the directory prefix it covers.
 *
 * `src/` becomes `src`; `src/a.c` becomes `src/a.c` (a file scope is its own
 * prefix, so an equal path overlaps it); `src/*.c` becomes `src`; `src/**`
 * becomes `src`. A bare `mod.c` stays `mod.c`, which is what keeps it from
 * matching `src/mod.c` — the same distinction the write-scope gate makes.
 *
 * @param {string} entry
 * @param {{foldCase?: boolean}} [options]
 * @returns {string} normalised prefix, or '' for a scope covering the root.
 * @throws {TypeError} on a non-string or empty entry.
 */
export function scopePrefix(entry, options = {}) {
  if (typeof entry !== 'string') {
    throw new TypeError(`claims: scope entry must be a string, received ${typeof entry}`)
  }
  const trimmed = entry.trim()
  if (trimmed === '') {
    throw new TypeError('claims: scope entry must not be empty')
  }

  // Drop the subtree marker, which describes coverage rather than name.
  const withoutSubtree = trimmed.replace(/[\\/]\*\*$/u, '')
  const unified = withoutSubtree.replace(/\\/gu, '/')

  // Keep only the segments before the first segment containing a glob
  // metacharacter — that literal run is the prefix every match shares.
  const literalSegments = []
  for (const segment of unified.split('/')) {
    if (/[*?[\]]/u.test(segment)) break
    literalSegments.push(segment)
  }
  const literal = literalSegments.join('/')
  if (literal === '') return ''
  return normalizePath(literal, options)
}

/**
 * Does one scope entry's coverage overlap another's?
 *
 * @param {string} leftPrefix - `scopePrefix` output.
 * @param {string} rightPrefix - `scopePrefix` output.
 * @returns {boolean}
 */
function prefixesOverlap(leftPrefix, rightPrefix) {
  const left = leftPrefix.replace(/\/+$/u, '')
  const right = rightPrefix.replace(/\/+$/u, '')

  // An empty prefix is a root-level scope and contains everything.
  if (left === '' || right === '') return true
  if (left === right) return true

  // Containment in either direction. The separator guard is what stops `src`
  // from swallowing `src2`.
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Does a declared scope overlap an already-claimed scope?
 *
 * @param {readonly string[]} scope - candidate scope entries.
 * @param {readonly string[]} claimed - existing claim's scope entries.
 * @param {{foldCase?: boolean}} [options]
 * @returns {{conflict: boolean, scope?: string, claimed?: string}}
 *   On a conflict, names the two entries so the refusal can say which paths
 *   disagree rather than only that something did.
 */
export function findScopeOverlap(scope, claimed, options = {}) {
  for (const entry of scope) {
    const entryPrefix = scopePrefix(entry, options)
    for (const existing of claimed) {
      if (prefixesOverlap(entryPrefix, scopePrefix(existing, options))) {
        return { conflict: true, scope: entry, claimed: existing }
      }
    }
  }
  return { conflict: false }
}

/**
 * Find the first claim that conflicts with a candidate declaration.
 *
 * Liveness is the caller's business: a claim whose session has died must be
 * pruned before this runs, or a dead session would block a live one forever.
 * That separation is deliberate — this function is pure, and "is that session
 * still alive" is a question only the host can answer.
 *
 * @param {object} input
 * @param {readonly string[]} input.scope - the candidate's declared scope.
 * @param {readonly Claim[]} input.claims - claims to test against.
 * @param {string} [input.exclude_dispatch] - ignore this claim (self re-entry).
 * @param {{foldCase?: boolean}} [options]
 * @returns {{conflict: false} | {conflict: true, claim: Claim, scope: string, claimed: string}}
 */
export function findClaimConflict(input, options = {}) {
  const { scope, claims } = input
  if (!Array.isArray(scope)) {
    throw new TypeError('claims: scope must be an array of path strings')
  }
  if (!Array.isArray(claims)) {
    throw new TypeError('claims: claims must be an array')
  }

  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object') continue
    if (input.exclude_dispatch !== undefined && claim.dispatch_id === input.exclude_dispatch) {
      continue
    }
    if (!Array.isArray(claim.write_scope)) continue
    const overlap = findScopeOverlap(scope, claim.write_scope, options)
    if (overlap.conflict) {
      return { conflict: true, claim, scope: overlap.scope, claimed: overlap.claimed }
    }
  }
  return { conflict: false }
}

/**
 * Validate a claim read from storage.
 *
 * A malformed claim file is reported rather than skipped. Silently ignoring it
 * would let a corrupted or hand-edited claim disable collision protection for
 * the paths it names — the protection would look present and be absent.
 *
 * @param {unknown} raw
 * @param {string} source - for the error message.
 * @returns {Claim}
 * @throws {Error} carrying {@link CLAIM_CODES}.MALFORMED.
 */
export function validateClaim(raw, source = '<memory>') {
  const fail = (detail) => {
    const error = new Error(`claim at ${source} is invalid: ${detail}`)
    error.code = CLAIM_CODES.MALFORMED
    throw error
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('must be a JSON object')
  }
  for (const field of ['dispatch_id', 'session_id', 'task_id', 'node_id']) {
    if (typeof raw[field] !== 'string' || raw[field] === '') {
      fail(`"${field}" must be a non-empty string`)
    }
  }
  if (!Array.isArray(raw.write_scope)) fail('"write_scope" must be an array')
  for (const entry of raw.write_scope) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      fail('"write_scope" entries must be non-empty strings')
    }
  }
  return {
    dispatch_id: raw.dispatch_id,
    session_id: raw.session_id,
    task_id: raw.task_id,
    node_id: raw.node_id,
    write_scope: Object.freeze([...raw.write_scope]),
    created_at: typeof raw.created_at === 'number' ? raw.created_at : 0,
    heartbeat_at: typeof raw.heartbeat_at === 'number' ? raw.heartbeat_at : 0,
  }
}

/**
 * Render a conflict as a message a model can act on.
 *
 * A refusal that does not name the holder becomes a retry loop, and a retry loop
 * costs more than the collision it avoided.
 *
 * @param {{claim: Claim, scope: string, claimed: string}} conflict
 * @returns {string}
 */
export function describeConflict(conflict) {
  const { claim, scope, claimed } = conflict
  return `declared write scope "${scope}" overlaps "${claimed}" held by task `
    + `${claim.task_id} node ${claim.node_id} (session ${claim.session_id}, `
    + `dispatch ${claim.dispatch_id}). Another writer already owns that path, so this `
    + 'declaration is refused rather than allowing both to write it.'
}
