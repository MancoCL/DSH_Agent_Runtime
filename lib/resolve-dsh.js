/**
 * Resolve DSH packages from inside a linked plugin.
 *
 * @module dsh-gac-runtime/resolve-dsh
 *
 * A plugin installed into a DSH profile by local path is linked, not copied, so
 * it keeps its own `node_modules` — which does not contain `@deepseek-ai/*`.
 * Bare imports of those packages therefore fail from here even though they
 * succeed from every shipped plugin.
 *
 * The fix is to resolve from a location that *does* see them. Which location
 * that is turns out to be environment-specific, and this module carries the scar
 * of getting it wrong twice:
 *
 *  1. A single guessed anchor (`$DSH_HOME/profiles/package.json`) resolved in a
 *     developer shell and failed in the host, so the plugin loaded with its tool
 *     silently absent. That file does not exist — `profiles/` is a container,
 *     not a package.
 *  2. The corrected list still missed, because it anchored to non-existent
 *     manifests. The location that actually works is a **profile directory**:
 *     Node walks upward from it and finds the hoisted
 *     `profiles/node_modules/@deepseek-ai/*`.
 *
 * Hence: anchors are real files, discovered rather than assumed, and ordered
 * most-process-grounded first. `createRequire` only needs a path that exists;
 * the file need not be a manifest.
 *
 * Vendoring a copy of `defineTool` would sidestep all of this and was rejected:
 * the part worth reusing is the runtime's own argument validation, and a
 * vendored copy would drift from it silently.
 */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Join path fragments, keeping the separator style of the first fragment.
 *
 * Avoids importing `node:path` to concatenate, and keeps a Windows drive path in
 * the form `existsSync` expects.
 *
 * @param {...string} parts
 * @returns {string}
 */
function join(...parts) {
  const [first, ...rest] = parts
  const separator = first.includes('\\') ? '\\' : '/'
  return [first.replace(/[\\/]+$/u, ''), ...rest.map((p) => p.replace(/^[\\/]+|[\\/]+$/gu, ''))]
    .filter((part) => part !== '')
    .join(separator)
}

/**
 * Directory names directly under a parent, or an empty list when unreadable.
 *
 * @param {string} parent
 * @returns {string[]}
 */
function directoriesIn(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * The DSH home directory, from the environment the harness sets.
 *
 * @returns {string|undefined}
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  const userHome = process.env.USERPROFILE ?? process.env.HOME
  return userHome === undefined || userHome === '' ? undefined : join(userHome, '.dsh')
}

/**
 * Files that can serve as a `createRequire` origin, most reliable first.
 *
 * Exported because a resolution failure is diagnosed from the anchor list, and
 * the list is the thing that was wrong both times this broke.
 *
 * @returns {string[]}
 */
export function candidateAnchors() {
  const anchors = []

  // The running executable. A fact about this process, though on a machine with
  // a system Node it sits nowhere near the harness install — which is exactly
  // why it is not the only anchor.
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    anchors.push(process.execPath)
  }

  // Beside the plugin. Reaches the harness only when the plugin lives inside it.
  try {
    anchors.push(join(fileURLToPath(new URL('..', import.meta.url)), 'package.json'))
  } catch {
    // A non-file module URL has no directory; the remaining anchors apply.
  }

  const home = dshHome()
  if (home !== undefined) {
    // A profile DIRECTORY is the anchor that works: Node walks upward from it to
    // the hoisted profiles/node_modules. Anchoring to `profiles/package.json`
    // assumed a manifest that does not exist.
    const profilesDir = join(home, 'profiles')
    for (const profile of directoriesIn(profilesDir)) {
      anchors.push(join(profilesDir, profile, 'package.json'))
    }
    // A hoisted install with no profile beside it.
    anchors.push(join(profilesDir, 'package.json'))
    anchors.push(join(home, 'package.json'))
  }

  // A checkout-launched harness.
  try {
    anchors.push(join(process.cwd(), 'package.json'))
  } catch {
    // A removed working directory throws here; it is only one candidate.
  }

  return [...new Set(anchors)]
}

/**
 * Resolve one package, reporting every anchor tried and why each failed.
 *
 * Returned rather than logged so the caller can put a diagnosable reason into
 * its report instead of an unhelpful "not resolvable".
 *
 * @param {string} specifier - e.g. `@deepseek-ai/dsh-tools`.
 * @param {string[]} [anchors] - override, for tests.
 * @returns {{resolved?: string, attempts: {anchor: string, reason: string}[]}}
 */
export function resolveWithDiagnostics(specifier, anchors = candidateAnchors()) {
  const attempts = []
  for (const anchor of anchors) {
    // An anchor missing from disk cannot serve as an origin. Recording that
    // distinctly from "the origin exists but lacks the package" matters: the two
    // point at different problems, and conflating them cost this session a
    // wrong-direction debugging round.
    if (!existsSync(anchor)) {
      attempts.push({ anchor, reason: 'anchor does not exist' })
      continue
    }
    try {
      const require = createRequire(anchor)
      return { resolved: require.resolve(specifier), attempts }
    } catch (error) {
      attempts.push({
        anchor,
        reason: error instanceof Error ? (error.code ?? error.message) : String(error),
      })
    }
  }
  return { attempts }
}

/**
 * Resolve one DSH package to an absolute path.
 *
 * @param {string} specifier
 * @returns {string|undefined}
 */
export function resolveDshPackage(specifier) {
  return resolveWithDiagnostics(specifier).resolved
}

/**
 * Explain a failed resolution, naming each anchor tried and why it failed.
 *
 * @param {string} specifier
 * @returns {string}
 */
export function describeResolutionFailure(specifier) {
  const { attempts } = resolveWithDiagnostics(specifier)
  if (attempts.length === 0) return `no resolution anchors are available for ${specifier}`
  const detail = attempts
    .map(({ anchor, reason }) => `${anchor} [${reason}]`)
    .join('; ')
  return `could not resolve ${specifier}; anchors tried: ${detail}`
}

/**
 * Import one DSH package by name, resolved from the DSH runtime.
 *
 * Returns `undefined` instead of throwing so the caller can degrade: a plugin
 * that cannot import an optional helper should still install its guard, because
 * the guard is the part that matters.
 *
 * The resolved path must be converted to a `file:` URL before import: on Windows
 * the default ESM loader rejects a bare drive path with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. This was a real bug — resolution worked and
 * the import silently returned nothing, which the caller reported as "not
 * resolvable" and sent one debugging round in the wrong direction.
 *
 * A successful import can still be useless (a module can evaluate to `null`
 * under an exotic loader), which is why callers must check the shape they need
 * rather than trusting a truthy import result.
 *
 * @param {string} specifier
 * @returns {Promise<any|undefined>}
 */
export async function importDshPackage(specifier) {
  const resolved = resolveDshPackage(specifier)
  if (resolved === undefined) return undefined
  try {
    return (await import(pathToFileURL(resolved).href)) ?? undefined
  } catch {
    return undefined
  }
}
