/**
 * Strict path containment for GAC write scope.
 *
 * @module dsh-gac-runtime/write-scope
 *
 * WHY THIS MODULE IS PURE AND STANDALONE
 * --------------------------------------
 * This is the security boundary named in the architecture outline (§21, §56):
 *
 *     "Convenience aliases must never leak into security boundaries."
 *
 * At runtime the *candidate* path comes from the filesystem provider
 * (`ctx.fs.resolve`, which already collapses symlinks and realpaths) and the
 * project boundary is answered by `ctx.fs.contains`. But the *decision —
 * does this candidate fall inside the declared write scope* — must be
 * one implementation, testable without DSH, because a second implementation
 * living only inside the ABI would silently drift from this one.
 *
 * So: normalisation + containment are pure functions here, covered by
 * test/write-scope.test.js, and lib/index.js is a thin caller.
 *
 * SEMANTICS THAT ARE LOAD-BEARING (each was a real defect in the predecessor
 * Python runtime — see ~/.claude/workflow/README.md, "口径" section):
 *
 *  1. A scope of `mod.c` means EXACTLY `./mod.c`.
 *     It does NOT mean `src/mod.c`, and it does NOT mean `other/mod.c`.
 *     Bare basenames are scopes in their own right, never aliases.
 *
 *  2. `SRC/MOD.C` and `src/mod.c` are the same file on Windows.
 *     Folding only the spelling but not the case leaves every gate below it
 *     bypassable with one keystroke.
 *
 *  3. `*` and `**` both cross directory separators, matching `fnmatch`.
 *     This intentionally widens `src/*` to cover `src/sub/a.c`. It is
 *     preserved for behavioural compatibility: an over-broad scope narrows
 *     what is *permitted* to be written, so it fails safe. Do not "fix" it
 *     into `*`-stops-at-separator semantics without re-reading (2).
 */

/** Glob metacharacters recognised in a scope. */
const GLOB_CHARS = /[*?[\]]/u

/**
 * Fold case unless explicitly told not to.
 *
 * Windows and macOS default filesystems are case-insensitive, so `src/x.c`
 * and `SRC/X.C` are one file. We fold by default (fail-closed on the strict
 * side); a caller that knows better can opt out. Note that folding *more*
 * aggressively than the filesystem only ever makes the scope stricter for a
 * directory-style scope, and for an exact-file scope it prevents a
 * case-variant bypass — which is the direction we want to be wrong in.
 *
 * @param {string} value
 * @param {boolean} foldCase
 * @returns {string}
 */
function fold(value, foldCase) {
  return foldCase ? value.toLowerCase() : value
}

/**
 * Normalise a path for comparison: convert separators, resolve `.` and `..`
 * segments, and drop a trailing separator (except for a root).
 *
 * `..` is resolved lexically. That is deliberate: resolving it against the
 * real filesystem would make the security decision depend on I/O, and a
 * lexical resolution that *fails to collapse* a traversal is the safe error
 * (it yields a non-matching path, so the write is denied).
 *
 * @param {string} raw - path as written (scope or candidate).
 * @param {{foldCase?: boolean}} [options]
 * @returns {string} normalised path with `\` replaced by `/`.
 * @throws {TypeError} when `raw` is not a non-empty string.
 */
export function normalizePath(raw, options = {}) {
  const foldCase = options.foldCase !== false
  if (typeof raw !== 'string') {
    throw new TypeError(`write-scope: path must be a string, received ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TypeError('write-scope: path must not be empty')
  }

  // A trailing separator is meaningful ONLY as "this is a directory scope".
  // It is re-attached by normalizeScope, so drop it here.
  const unified = trimmed.replace(/\\/gu, '/')
  const isAbsolute = unified.startsWith('/') || /^[A-Za-z]:\//u.test(unified)

  const segments = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Pop the previous segment when we can; otherwise keep the `..` so a
      // traversal out of the scope can never accidentally match.
      const previous = segments.at(-1)
      if (previous !== undefined && previous !== '..') segments.pop()
      else if (!isAbsolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }

  const joined = segments.join('/')
  const body = isAbsolute ? `/${joined}` : joined
  return fold(body, foldCase)
}

/**
 * Normalise a scope entry.
 *
 * Returns a descriptor rather than a string because the caller must be able to
 * distinguish "directory scope" (covers a subtree) from "exact file scope"
 * (covers one path) — collapsing that distinction is exactly how a basename
 * alias leaks into the boundary.
 *
 * @param {string} raw
 * @param {{foldCase?: boolean}} [options]
 * @returns {{raw: string, kind: 'dir'|'file'|'glob', value: string, prefixSegments?: string[]}}
 * @throws {TypeError} on an empty or non-string scope.
 */
export function normalizeScope(raw, options = {}) {
  const foldCase = options.foldCase !== false
  if (typeof raw !== 'string') {
    throw new TypeError(`write-scope: scope must be a string, received ${typeof raw}`)
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TypeError('write-scope: scope must not be empty')
  }

  const unified = trimmed.replace(/\\/gu, '/')
  // `src/**` and `src/` both mean "the src subtree".
  const ancestorSuffix = /\/\*\*$/u
  const isAncestorForm = ancestorSuffix.test(unified) || unified.endsWith('/')
  const withoutSuffix = unified.replace(/\/\*\*$/u, '')

  if (!GLOB_CHARS.test(withoutSuffix)) {
    const belongsHere = isAncestorForm && withoutSuffix !== ''
    const normalized = belongsHere
      ? normalizePath(withoutSuffix, options)
      : normalizePath(unified, options)
    return {
      raw: trimmed,
      kind: belongsHere ? 'dir' : 'file',
      value: normalized,
    }
  }

  // Glob scope. Normalise the non-glob path prefix lexically, then keep the
  // remaining pattern segments verbatim.
  const segments = withoutSuffix.split('/')
  const literalSegments = []
  let index = 0
  for (; index < segments.length; index += 1) {
    if (GLOB_CHARS.test(segments[index])) break
    literalSegments.push(segments[index])
  }
  const literalPrefix = literalSegments.join('/')
  const normalizedPrefix = literalPrefix === ''
    ? ''
    : normalizePath(literalPrefix, options)
  const patternTail = segments.slice(index)
  const pattern = [...(normalizedPrefix === '' ? [] : normalizedPrefix.split('/')), ...patternTail]
    .join('/')
  const folded = fold(pattern, foldCase)

  return {
    raw: trimmed,
    kind: 'glob',
    value: folded,
    prefixSegments: pattern.split('/'),
  }
}

/**
 * Expand a glob segment list into a regular expression.
 *
 * `*` and `**` both match across separators (see header, point 3);
 * `?` matches one character; `[...]` is a character class.
 *
 * @param {string[]} segments
 * @returns {RegExp}
 */
function globToRegExp(segments) {
  let source = '^'
  segments.forEach((segment, position) => {
    if (position > 0) source += '/'
    if (segment === '**') {
      // `a/**/b` must also match `a/b`, so consume the separator when the
      // double-star sits between two other segments.
      if (position > 0) source = source.slice(0, -1)
      source += position === 0 ? '.*' : '(?:/.*)?'
      return
    }
    let inner = ''
    for (let i = 0; i < segment.length; i += 1) {
      const character = segment[i]
      if (character === '*') {
        inner += '.*'
      } else if (character === '?') {
        inner += '.'
      } else if (character === '[') {
        const close = segment.indexOf(']', i + 1)
        if (close === -1) {
          inner += '\\['
        } else {
          inner += segment.slice(i, close + 1)
          i = close
        }
      } else {
        inner += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      }
    }
    source += inner
  })
  return new RegExp(`${source}$`, 'u')
}

/**
 * Does one normalised candidate fall inside one normalised scope?
 *
 * Both inputs must already be normalised (same case folding, same separator)
 * — callers should go through {@link createWriteScope} rather than call this
 * directly, so that normalisation cannot be forgotten on one side.
 *
 * @param {string} candidate - normalised relative or absolute path.
 * @param {{kind: string, value: string, prefixSegments?: string[]}} scope
 * @returns {boolean}
 */
function containsNormalized(candidate, scope) {
  if (scope.kind === 'dir') {
    return candidate === scope.value || candidate.startsWith(`${scope.value}/`)
  }
  if (scope.kind === 'file') {
    return candidate === scope.value
  }
  return globToRegExp(scope.prefixSegments).test(candidate)
}

/**
 * Compile a declared write scope into a reusable matcher.
 *
 * The matcher answers "may this node write this path?" and, on refusal,
 * explains which scope existed so the model can correct itself instead of
 * guessing. That explanation is not decoration: a denial the model cannot act
 * on turns into a retry loop, which costs more than the write it prevented.
 *
 * @param {readonly string[]} scopes - declared write scope entries.
 * @param {{foldCase?: boolean, rootPrefix?: string}} [options]
 *   `rootPrefix` is a normalised project-root prefix to strip from candidates
 *   that arrive as absolute paths.
 * @returns {{
 *   scopes: readonly object[],
 *   allows: (candidate: string) => boolean,
 *   explain: (candidate: string) => {allowed: boolean, candidate: string, reason?: string}
 * }}
 * @throws {TypeError} when `scopes` is not an array.
 */
export function createWriteScope(scopes, options = {}) {
  if (!Array.isArray(scopes)) {
    throw new TypeError('write-scope: scopes must be an array of path strings')
  }
  const foldCase = options.foldCase !== false
  const normalizedScopes = scopes.map((scope) => normalizeScope(scope, { foldCase }))
  const rootPrefix = options.rootPrefix === undefined
    ? undefined
    : normalizePath(options.rootPrefix, { foldCase }).replace(/\/$/u, '')

  const toCandidate = (candidate) => {
    const normalized = normalizePath(candidate, { foldCase })
    if (rootPrefix === undefined || rootPrefix === '') return normalized
    if (normalized === rootPrefix) return ''
    if (normalized.startsWith(`${rootPrefix}/`)) {
      return normalized.slice(rootPrefix.length + 1)
    }
    return normalized
  }

  const allows = (candidate) => {
    const normalized = toCandidate(candidate)
    return normalizedScopes.some((scope) => containsNormalized(normalized, scope))
  }

  const explain = (candidate) => {
    const normalized = toCandidate(candidate)
    if (normalizedScopes.some((scope) => containsNormalized(normalized, scope))) {
      return { allowed: true, candidate: normalized }
    }
    const declared = normalizedScopes.map((scope) => scope.raw)
    return {
      allowed: false,
      candidate: normalized,
      reason: declared.length === 0
        ? 'this node declares no write scope'
        : `declared write scope is [${declared.join(', ')}]`,
    }
  }

  return { scopes: normalizedScopes, allows, explain }
}
