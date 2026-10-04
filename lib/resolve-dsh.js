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
 * The fix is to resolve from a location that *does* see them: the profile
 * directory, whose `node_modules` holds the DSH runtime. This is a real
 * constraint of local-path installation and not something to design around with
 * a vendored copy — a vendored `defineTool` would drift from the runtime's
 * argument validation, which is the part worth reusing.
 *
 * Resolution is attempted against a short list of known roots rather than one
 * hardcoded path, because the profile's home directory is configurable and a
 * plugin that only works on the author's machine is not a working plugin.
 */

import { createRequire } from 'node:module'

/**
 * Candidate directories whose `node_modules` can see the DSH runtime, in order.
 *
 * @returns {string[]} absolute-ish directory paths, separated by `/`.
 */
function candidateRoots() {
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME
  const roots = []
  if (home !== undefined && home !== '') {
    const unified = home.replace(/\\/gu, '/').replace(/\/+$/u, '')
    roots.push(`${unified}/profiles`)
    roots.push(unified)
  }
  // The harness executable's own tree, as a last resort.
  roots.push(process.execPath.replace(/\\/gu, '/'))
  return roots
}

/**
 * Resolve one DSH package to an absolute file URL.
 *
 * @param {string} specifier - e.g. `@deepseek-ai/dsh-tools`.
 * @returns {string|undefined} absolute path, or undefined when unresolvable.
 */
export function resolveDshPackage(specifier) {
  for (const root of candidateRoots()) {
    try {
      const require = createRequire(`${root}/package.json`)
      return require.resolve(specifier)
    } catch {
      // Try the next root.
    }
  }
  return undefined
}

/**
 * Import one DSH package by name, resolved from the DSH runtime.
 *
 * Returns `undefined` instead of throwing so a caller can degrade: a plugin
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
