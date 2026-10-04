/**
 * Package-resolution tests.
 *
 * These exist because of a real failure: the anchor list resolved correctly in a
 * developer shell and failed inside the host process, so the plugin loaded with
 * its scope tool silently absent and reported only "not resolvable". The
 * strategy is therefore tested on its contract — ordered anchors, distinct
 * reasons, no throwing — rather than only on "does it work on this machine".
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  candidateAnchors,
  describeResolutionFailure,
  importDshPackage,
  resolveDshPackage,
  resolveWithDiagnostics,
} from '../lib/resolve-dsh.js'

describe('candidateAnchors', () => {
  it('returns a de-duplicated, non-empty list', () => {
    const anchors = candidateAnchors()
    assert.ok(anchors.length > 0)
    assert.equal(new Set(anchors).size, anchors.length)
  })

  it('leads with this process, not with an environment variable', () => {
    // A process-grounded anchor is a fact; an environment variable may be unset.
    // Ordering puts the certain thing first.
    assert.equal(candidateAnchors()[0], process.execPath)
  })

  it('includes an anchor beside the plugin itself', () => {
    assert.ok(
      candidateAnchors().some((anchor) => anchor.endsWith('package.json') && anchor.includes('Agent_Runtime')),
      'expected the plugin directory to contribute an anchor',
    )
  })

  it('returns only absolute-looking paths', () => {
    for (const anchor of candidateAnchors()) {
      assert.match(anchor, /^([A-Za-z]:[\\/]|\/)/u, `anchor is not absolute: ${anchor}`)
    }
  })
})

describe('resolveWithDiagnostics', () => {
  it('resolves a real package from a real anchor', () => {
    const found = candidateAnchors().find((anchor) => {
      const { resolved } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [anchor])
      return resolved !== undefined
    })
    // Tolerant by design: a contributor without DSH installed can still run the
    // unit suite. When it does resolve, the path must be the real package.
    if (found !== undefined) {
      const { resolved } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [found])
      assert.match(resolved, /dsh-tools/u)
    }
  })

  it('records a missing anchor distinctly from a package miss', () => {
    const missing = '/definitely/not/a/real/path/package.json'
    const { resolved, attempts } = resolveWithDiagnostics('@deepseek-ai/dsh-tools', [missing])
    assert.equal(resolved, undefined)
    assert.deepEqual(attempts, [{ anchor: missing, reason: 'anchor does not exist' }])
  })

  it('records why an existing anchor failed to satisfy the request', () => {
    // A real file that exists but sits nowhere near the package: the reason must
    // be a module-resolution code, not "anchor does not exist".
    const { resolved, attempts } = resolveWithDiagnostics(
      '@deepseek-ai/definitely-not-a-real-package',
      [process.execPath],
    )
    assert.equal(resolved, undefined)
    assert.equal(attempts.length, 1)
    assert.notEqual(attempts[0].reason, 'anchor does not exist')
  })

  it('never throws, whatever it is handed', () => {
    assert.doesNotThrow(() => resolveWithDiagnostics('@deepseek-ai/dsh-tools', []))
    assert.doesNotThrow(() => resolveWithDiagnostics('', [process.execPath]))
  })
})

describe('describeResolutionFailure', () => {
  it('names every anchor tried and its reason', () => {
    // This is the string that lands in the load report; "not resolvable" alone
    // sent a real debugging session in the wrong direction.
    const message = describeResolutionFailure('@deepseek-ai/definitely-not-a-real-package')
    assert.match(message, /@deepseek-ai\/definitely-not-a-real-package/u)
    assert.match(message, /anchors tried/u)
    assert.match(message, /\[/u)
  })
})

describe('public helpers', () => {
  it('resolveDshPackage returns undefined rather than throwing', () => {
    assert.equal(resolveDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('importDshPackage returns undefined for an unresolvable package', async () => {
    assert.equal(await importDshPackage('@deepseek-ai/definitely-not-a-real-package'), undefined)
  })

  it('importDshPackage yields a usable defineTool when the runtime is present', async () => {
    const tools = await importDshPackage('@deepseek-ai/dsh-tools')
    if (tools !== undefined) {
      assert.equal(typeof tools.defineTool, 'function')
    }
  })
})
