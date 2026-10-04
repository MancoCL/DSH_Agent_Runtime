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
 * that is turns out to be environment-dependent, and this module carries the
 * scar of getting it wrong: a single guessed anchor resolved correctly from a
 * developer shell and failed inside the host process, so the plugin loaded with
 * its tool silently absent.
 *
 * Hence the anchor list. `createRequire` needs a path to an existing file to
 * serve as a resolution origin; the file need not be meaningful. Candidates are
 * tried in order and the first that resolves wins. The list prefers
 * process-grounded anchors (the running executable, the plugin's own location,
 * the working directory) over environment variables, because the former are
 * facts about this process while the latter may simply be unset.
 *
 * Vendoring a copy of `defineTool` would avoid all of this and was rejected: the
 * part worth reusing is the runtime's own argument validation, and a vendored
 * copy would drift from it silently.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Join path fragments, keeping the separator style of the first fragment.
 *
 * Avoids importing `node:path` to concatenate, and keeps a Windows drive path
 * from being normalised into a form `existsSync` rejects.
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
 * The plugin's own directory, as a filesystem path.
 *
 * @returns {string}
 */
function pluginDirectory() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/**
 * Files that can serve as a `createRequire` origin, most process-grounded first.
 *
 * @returns {string[]}
 */
export function candidateAnchors() {
  const anchors = []

  // The running Node executable: a fact about this process, living inside the
  // harness installation where the runtime packages are installed.
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    anchors.push(process.execPath)
  }

  // Beside the plugin itself. `createRequire` walks upward from an origin, so an
  // existing file here reaches the harness when the plugin sits inside it.
  try {
    anchors.push(join(pluginDirectory(), 'package.json'))
  } catch {
    // A non-file module URL has no directory; the remaining anchors apply.
  }

  // The profile the plugin was installed into.
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    anchors.push(join(home, 'profiles', 'package.json'))
    anchors.push(join(home, 'package.json'))
  }
  const userHome = process.env.USERPROFILE ?? process.env.HOME
  if (typeof userHome === 'string' && userHome !== '') {
    anchors.push(join(userHome, '.dsh', 'profiles', 'package.json'))
    anchors.push(join(userHome, '.dsh', 'package.json'))
  }

  // Where a checkout-launched harness would keep them.
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
 * Returned rather than logged so the caller can put a diagnosable reason in its
 * report instead of an unhelpful "not resolvable".
 *
 * @param {string} specifier - e.g. `@deepseek-ai/dsh-tools`.
 * @param {string[]} [anchors] - override, for tests.
 * @returns {{resolved?: string, attempts: {anchor: string, reason: string}[]}}
 */
export function resolveWithDiagnostics(specifier, anchors = candidateAnchors()) {
  const attempts = []
  for (const anchor of anchors) {
    // An anchor missing from disk cannot serve as an origin. Recording that
    // distinctly from "the origin exists but lacks the package" matters: the
    // two point at different problems.
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
 * This is what turns an opaque "not resolvable" into something actionable in the
 * load report.
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
 * @param {string} specifier
 * @returns {Promise<any|undefined>}
 */
export async function importDshPackage(specifier) {
  const resolved = resolveDshPackage(specifier)
  if (resolved === undefined) return undefined
  try {
    return await import(resolved)
  } catch {
    return undefined
  }
}
