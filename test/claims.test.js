/**
 * Write-claim conflict tests.
 *
 * The rule under test is prefix overlap, and the cases below pin down both what
 * it catches and what it deliberately over-reports. The over-report is a design
 * choice with a stated cost (see the module header), so it is asserted here
 * rather than left as an accident someone later "fixes".
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CLAIM_CODES,
  describeConflict,
  findClaimConflict,
  findScopeOverlap,
  scopePrefix,
  validateClaim,
} from '../lib/claims.js'

/**
 * A minimal valid claim.
 *
 * @param {string[]} writeScope
 * @param {object} [overrides]
 * @returns {object}
 */
function claim(writeScope, overrides = {}) {
  return {
    dispatch_id: 'd-1',
    session_id: 's-1',
    task_id: 'REQ-1',
    node_id: 'T1',
    write_scope: writeScope,
    created_at: 0,
    heartbeat_at: 0,
    ...overrides,
  }
}

describe('scopePrefix', () => {
  it('reduces a directory scope to its directory', () => {
    assert.equal(scopePrefix('src/'), 'src')
    assert.equal(scopePrefix('src/**'), 'src')
  })

  it('keeps a file scope as-is, so it only matches itself', () => {
    assert.equal(scopePrefix('src/a.c'), 'src/a.c')
  })

  it('keeps a bare basename as a root-level file, not an alias', () => {
    // The distinction the write-scope gate makes, preserved here: `mod.c` must
    // not collide with `src/mod.c`.
    assert.equal(scopePrefix('mod.c'), 'mod.c')
  })

  it('reduces a glob to the literal prefix before it', () => {
    assert.equal(scopePrefix('src/*.c'), 'src')
    assert.equal(scopePrefix('src/deep/*.c'), 'src/deep')
  })

  it('normalises separators, dot segments and case', () => {
    assert.equal(scopePrefix('./src\\a.c'), 'src/a.c')
    assert.equal(scopePrefix('SRC/A.C'), 'src/a.c')
  })

  it('returns an empty prefix for a scope covering the root', () => {
    assert.equal(scopePrefix('**'), '')
  })

  it('rejects an empty or non-string entry', () => {
    assert.throws(() => scopePrefix(''), TypeError)
    assert.throws(() => scopePrefix(7), TypeError)
  })
})

describe('findScopeOverlap — collisions that must be caught', () => {
  const cases = [
    ['an identical file', ['src/a.c'], ['src/a.c']],
    ['an identical directory', ['src/'], ['src/']],
    ['a file inside a claimed directory', ['src/deep/a.c'], ['src/']],
    ['a directory containing a claimed file', ['src/'], ['src/a.c']],
    ['a directory nested in a claimed directory', ['src/deep/'], ['src/']],
    ['a glob inside a claimed directory', ['src/*.c'], ['src/']],
    ['a claimed glob covering a file', ['src/a.c'], ['src/*.c']],
    ['differing case', ['SRC/A.C'], ['src/a.c']],
    ['a traversal that resolves into the claim', ['src/sub/../a.c'], ['src/a.c']],
    ['a root-wide scope', ['**'], ['src/a.c']],
  ]

  for (const [label, candidate, existing] of cases) {
    it(`catches ${label}`, () => {
      assert.equal(findScopeOverlap(candidate, existing).conflict, true)
    })
  }
})

describe('findScopeOverlap — things that must NOT collide', () => {
  it('does not collide two bare basenames in different directories', () => {
    // `mod.c` is ./mod.c and never src/mod.c. If this collided, unrelated
    // sessions across a monorepo would block each other constantly.
    assert.equal(findScopeOverlap(['mod.c'], ['src/mod.c']).conflict, false)
  })

  it('does not collide sibling directories', () => {
    assert.equal(findScopeOverlap(['src/'], ['test/']).conflict, false)
  })

  it('does not let a shared name prefix collide', () => {
    // The separator guard: `src` must not swallow `src2`.
    assert.equal(findScopeOverlap(['src/'], ['src2/a.c']).conflict, false)
    assert.equal(findScopeOverlap(['src/a.c'], ['src2/a.c']).conflict, false)
  })

  it('does not collide siblings inside one directory', () => {
    assert.equal(findScopeOverlap(['src/a.c'], ['src/b.c']).conflict, false)
  })
})

describe('findScopeOverlap — the deliberate over-report', () => {
  it('reports two disjoint globs in one directory as conflicting', () => {
    // `src/*.c` and `src/*.h` share the prefix `src`, so they are reported even
    // though the sets are disjoint. Chosen on purpose: a false positive costs
    // some parallelism, a false negative lets two writers hit one file. Asserted
    // so that this is a documented decision rather than a bug report later.
    assert.equal(findScopeOverlap(['src/*.c'], ['src/*.h']).conflict, true)
  })
})

describe('findScopeOverlap — reporting', () => {
  it('names both entries so the refusal can explain itself', () => {
    const overlap = findScopeOverlap(['src/deep/a.c'], ['src/'])
    assert.equal(overlap.scope, 'src/deep/a.c')
    assert.equal(overlap.claimed, 'src/')
  })
})

describe('findClaimConflict', () => {
  it('returns the first-conflicting claim with its holder', () => {
    const result = findClaimConflict({
      scope: ['src/a.c'],
      claims: [claim(['other/']), claim(['src/'], { session_id: 's-2', task_id: 'REQ-2' })],
    })
    assert.equal(result.conflict, true)
    assert.equal(result.claim.task_id, 'REQ-2')
  })

  it('ignores a claim named by exclude_dispatch, so a session can re-declare itself', () => {
    const result = findClaimConflict({
      scope: ['src/a.c'],
      claims: [claim(['src/'], { dispatch_id: 'd-self' })],
      exclude_dispatch: 'd-self',
    })
    assert.equal(result.conflict, false)
  })

  it('reports no conflict against an empty claim list', () => {
    assert.equal(findClaimConflict({ scope: ['src/'], claims: [] }).conflict, false)
  })

  it('skips malformed entries rather than throwing at the caller', () => {
    const result = findClaimConflict({
      scope: ['src/'],
      claims: [null, 'nonsense', { dispatch_id: 'x' }, claim(['src/'])],
    })
    assert.equal(result.conflict, true)
  })

  it('rejects a non-array scope or claim list', () => {
    assert.throws(() => findClaimConflict({ scope: 'src/', claims: [] }), TypeError)
    assert.throws(() => findClaimConflict({ scope: [], claims: {} }), TypeError)
  })
})

describe('validateClaim', () => {
  it('accepts a well-formed claim and freezes its scope', () => {
    const valid = validateClaim(claim(['src/']))
    assert.equal(Object.isFrozen(valid.write_scope), true)
  })

  it('refuses a claim missing an identifying field', () => {
    for (const field of ['dispatch_id', 'session_id', 'task_id', 'node_id']) {
      assert.throws(
        () => validateClaim(claim(['src/'], { [field]: '' })),
        (error) => error.code === CLAIM_CODES.MALFORMED,
      )
    }
  })

  it('refuses a non-array scope', () => {
    assert.throws(() => validateClaim(claim('src/')), (error) => error.code === CLAIM_CODES.MALFORMED)
  })

  it('refuses an empty entry inside a scope', () => {
    assert.throws(() => validateClaim(claim(['src/', '  '])), (error) => error.code === CLAIM_CODES.MALFORMED)
  })

  it('names its source, so a bad file is findable', () => {
    assert.throws(() => validateClaim({}, 'C:/proj/.dsh/gac/claims/s-1.json'), /s-1\.json/u)
  })
})

describe('describeConflict', () => {
  it('names the holder, the paths, and why it was refused', () => {
    const message = describeConflict({
      claim: claim(['src/'], { task_id: 'REQ-9', node_id: 'T4', session_id: 's-9', dispatch_id: 'd-9' }),
      scope: 'src/a.c',
      claimed: 'src/',
    })
    // A refusal the model cannot act on becomes a retry loop.
    for (const expected of ['REQ-9', 'T4', 's-9', 'd-9', 'src/a.c', 'src/']) {
      assert.ok(message.includes(expected), `message should name ${expected}: ${message}`)
    }
  })
})
