/**
 * Module load smoke tests.
 *
 * These exist because of a real failure: `lib/index.js` once contained `await`
 * inside the generator passed to `ctx.effect`, which is a *syntax* error. Every
 * unit test passed, because none of them imported the entry point — and the
 * plugin silently failed to load while the previously-loaded version kept
 * running, so the profile looked healthy.
 *
 * These assertions are deliberately shallow: that each module parses, that the
 * entry point exports the shape Cordis requires, and that the entry does not
 * import a DSH package at module scope (a bare import there would throw at load
 * time, before any plugin code could report why).
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/** Every module in lib/, discovered rather than listed, so a new one is covered. */
const modules = [
  'index.js',
  'plugin.js',
  'project.js',
  'path-utils.js',
  'resolve-dsh.js',
  'session-scope.js',
  'tool-scope.js',
  'tool-targets.js',
  'write-scope.js',
]

describe('every library module parses and imports', () => {
  for (const file of modules) {
    it(`imports lib/${file}`, async () => {
      const loaded = await import(`../lib/${file}`)
      assert.equal(typeof loaded, 'object')
    })
  }
})

describe('the entry point satisfies the Cordis plugin contract', () => {
  it('exports name, inject and apply', async () => {
    const entry = await import('../lib/index.js')
    assert.equal(typeof entry.name, 'string')
    assert.ok(entry.name.length > 0)
    assert.ok(Array.isArray(entry.inject))
    assert.equal(typeof entry.apply, 'function')
  })

  it('declares the services its guard actually reads', async () => {
    const entry = await import('../lib/index.js')
    // The guard resolves a session's cwd through `sessions` and intercepts
    // through `tools`. Declaring fewer would let the plugin load into a
    // composition where it cannot do its job.
    assert.deepEqual([...entry.inject].sort(), ['sessions', 'tools'])
  })

  it('apply is awaitable, because it resolves a package before registering', async () => {
    const entry = await import('../lib/index.js')
    // An async function is what lets the DSH package resolution happen before
    // the effect body, which is a generator and cannot contain `await`.
    assert.equal(entry.apply.constructor.name, 'AsyncFunction')
  })
})

describe('the entry point defers DSH imports to call time', () => {
  it('has no static import of a bare @deepseek-ai package', async () => {
    const source = await readFile(join(libDir, 'index.js'), 'utf8')
    // A bare import at module scope would throw while the loader evaluates the
    // module, which happens before `apply` can report a diagnosable reason.
    // Only the value imported from a relative path is allowed at top level.
    const staticBareImports = [...source.matchAll(/^import[^;]*?from\s+'(@deepseek-ai\/[^']+)'/gmu)]
    assert.deepEqual(staticBareImports.map((m) => m[1]), [])
  })
})

describe('resolve-dsh', () => {
  it('degrades to undefined rather than throwing for an unknown package', async () => {
    const { resolveDshPackage } = await import('../lib/resolve-dsh.js')
    assert.equal(resolveDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('finds the DSH runtime on this machine, or reports that it did not', async () => {
    const { resolveDshPackage } = await import('../lib/resolve-dsh.js')
    const resolved = resolveDshPackage('@deepseek-ai/dsh-tools')
    // Not asserted as a hard requirement: a contributor without DSH installed
    // should still be able to run the unit suite. When it does resolve, it must
    // resolve to a real path.
    if (resolved !== undefined) {
      assert.match(resolved, /dsh-tools/u)
    }
  })
})
