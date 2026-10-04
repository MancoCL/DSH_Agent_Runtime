/**
 * Small path helpers shared by the plugin bridge.
 *
 * @module dsh-gac-runtime/path-utils
 *
 * `lib/write-scope.js` owns containment. This module owns the two little
 * questions the DSH bridge needs before it can call containment: "is this
 * path absolute?" and "drop the project-root prefix if it is". They live apart
 * so that the security primitive stays free of host-shaped concerns, and so
 * `lib/write-scope.js` can be tested with no notion of a drive letter.
 */

import { normalizePath } from './write-scope.js'

/**
 * Is this a rooted path on any platform we run on?
 *
 * Windows drive paths and both POSIX and UNC roots are recognised. The check
 * is deliberately syntactic: it runs before any filesystem round-trip, and a
 * wrong answer here degrades to "treat it as relative", which fails closed in
 * containment.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
export function isAbsolutePath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  const unified = candidate.replace(/\\/gu, '/')
  return unified.startsWith('/')
    || unified.startsWith('//')
    || /^[A-Za-z]:\//u.test(unified)
}

/**
 * Strip a project-root prefix from an absolute candidate.
 *
 * Returns the candidate unchanged when it is not inside the root, so a path
 * that escapes the project cannot be laundered into a scope-relative path and
 * then match a scope it should miss.
 *
 * @param {string} candidate - path as written.
 * @param {string} root - project root, absolute.
 * @param {{foldCase?: boolean}} [options]
 * @returns {string} the path relative to `root`, or `candidate` unchanged.
 */
export function relativize(candidate, root, options = {}) {
  const normalizedCandidate = normalizePath(candidate, options)
  const normalizedRoot = normalizePath(root, options).replace(/\/+$/u, '')
  if (normalizedRoot === '') return normalizedCandidate
  if (normalizedCandidate === normalizedRoot) return '.'
  if (normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    return normalizedCandidate.slice(normalizedRoot.length + 1)
  }
  return normalizedCandidate
}

/**
 * Best-effort project root from a session's working directory.
 *
 * The session header carries an absolute `cwd`; GAC treats that as the project
 * root unless a Project Adapter says otherwise. Returning `undefined` rather
 * than a guess keeps the caller honest: with no root, containment compares
 * raw paths and a denial is still the safe outcome.
 *
 * @param {unknown} cwd
 * @returns {string|undefined}
 */
export function projectRootFromCwd(cwd) {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.trim()
  if (trimmed === '' || !isAbsolutePath(trimmed)) return undefined
  return trimmed.replace(/\\/gu, '/')
}
