/**
 * 写占用声明冲突测试。
 *
 * 被测的规则是前缀重叠，下面这些用例既钉住了它会抓到什么，也钉住了它刻意
 * 多报什么。多报是一项有明示代价的设计选择（见模块头部），所以它在这里被
 * 断言下来，而不是留成一处日后被谁「顺手修掉」的意外。
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
 * 一个最小的合法占用声明。
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
    // 这里保留了写作用域门禁所作的那一区分：`mod.c` 绝不能与
    // `src/mod.c` 冲突。
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
    // `mod.c` 就是 ./mod.c，从来不是 src/mod.c。如果这两者冲突，跨一个
    // monorepo 的互不相关会话就会不停地互相阻塞。
    assert.equal(findScopeOverlap(['mod.c'], ['src/mod.c']).conflict, false)
  })

  it('does not collide sibling directories', () => {
    assert.equal(findScopeOverlap(['src/'], ['test/']).conflict, false)
  })

  it('does not let a shared name prefix collide', () => {
    // 分隔符守卫：`src` 绝不能吞掉 `src2`。
    assert.equal(findScopeOverlap(['src/'], ['src2/a.c']).conflict, false)
    assert.equal(findScopeOverlap(['src/a.c'], ['src2/a.c']).conflict, false)
  })

  it('does not collide siblings inside one directory', () => {
    assert.equal(findScopeOverlap(['src/a.c'], ['src/b.c']).conflict, false)
  })
})

describe('findScopeOverlap — the deliberate over-report', () => {
  it('reports two disjoint globs in one directory as conflicting', () => {
    // `src/*.c` 与 `src/*.h` 共享前缀 `src`，所以即便两个集合互不相交也会
    // 被上报。这是刻意选的：一次误报的代价是损失一些并行度，一次漏报则会
    // 让两位写者撞上同一个文件。把它断言下来，是为了让这成为一项有记录的
    // 决定，而不是日后的一份缺陷报告。
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
    // 模型无法据以行动的拒绝会变成重试循环。
    for (const expected of ['REQ-9', 'T4', 's-9', 'd-9', 'src/a.c', 'src/']) {
      assert.ok(message.includes(expected), `message should name ${expected}: ${message}`)
    }
  })
})
