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
  it('把目录作用域归约为它的目录', () => {
    assert.equal(scopePrefix('src/'), 'src')
    assert.equal(scopePrefix('src/**'), 'src')
  })

  it('文件作用域原样保留，因此只匹配它自己', () => {
    assert.equal(scopePrefix('src/a.c'), 'src/a.c')
  })

  it('把裸文件名保留为根级文件，而不是别名', () => {
    // 这里保留了写作用域门禁所作的那一区分：`mod.c` 绝不能与
    // `src/mod.c` 冲突。
    assert.equal(scopePrefix('mod.c'), 'mod.c')
  })

  it('把 glob 归约为它之前的字面前缀', () => {
    assert.equal(scopePrefix('src/*.c'), 'src')
    assert.equal(scopePrefix('src/deep/*.c'), 'src/deep')
  })

  it('规范化分隔符、点段与大小写', () => {
    assert.equal(scopePrefix('./src\\a.c'), 'src/a.c')
    assert.equal(scopePrefix('SRC/A.C'), 'src/a.c')
  })

  it('对覆盖根目录的作用域返回空前缀', () => {
    assert.equal(scopePrefix('**'), '')
  })

  it('拒绝空条目或非字符串条目', () => {
    assert.throws(() => scopePrefix(''), TypeError)
    assert.throws(() => scopePrefix(7), TypeError)
  })
})

describe('findScopeOverlap — 必须抓到的相撞', () => {
  const cases = [
    ['完全相同的文件', ['src/a.c'], ['src/a.c']],
    ['完全相同的目录', ['src/'], ['src/']],
    ['已占用目录之内的文件', ['src/deep/a.c'], ['src/']],
    ['包含已占用文件的目录', ['src/'], ['src/a.c']],
    ['嵌套在已占用目录之内的目录', ['src/deep/'], ['src/']],
    ['已占用目录之内的 glob', ['src/*.c'], ['src/']],
    ['覆盖某个文件的已占用 glob', ['src/a.c'], ['src/*.c']],
    ['大小写不同', ['SRC/A.C'], ['src/a.c']],
    ['解析后落进占用范围的遍历', ['src/sub/../a.c'], ['src/a.c']],
    ['覆盖整个根目录的作用域', ['**'], ['src/a.c']],
  ]

  for (const [label, candidate, existing] of cases) {
    it(`抓到 ${label}`, () => {
      assert.equal(findScopeOverlap(candidate, existing).conflict, true)
    })
  }
})

describe('findScopeOverlap — 绝不能相撞的情形', () => {
  it('不把不同目录下的两个裸文件名判为相撞', () => {
    // `mod.c` 就是 ./mod.c，从来不是 src/mod.c。如果这两者冲突，跨一个
    // monorepo 的互不相关会话就会不停地互相阻塞。
    assert.equal(findScopeOverlap(['mod.c'], ['src/mod.c']).conflict, false)
  })

  it('不把兄弟目录判为相撞', () => {
    assert.equal(findScopeOverlap(['src/'], ['test/']).conflict, false)
  })

  it('不让共享的名字前缀相撞', () => {
    // 分隔符守卫：`src` 绝不能吞掉 `src2`。
    assert.equal(findScopeOverlap(['src/'], ['src2/a.c']).conflict, false)
    assert.equal(findScopeOverlap(['src/a.c'], ['src2/a.c']).conflict, false)
  })

  it('不把同一个目录内的兄弟项判为相撞', () => {
    assert.equal(findScopeOverlap(['src/a.c'], ['src/b.c']).conflict, false)
  })
})

describe('findScopeOverlap — 刻意为之的多报', () => {
  it('把同一个目录下两个互不相交的 glob 上报为冲突', () => {
    // `src/*.c` 与 `src/*.h` 共享前缀 `src`，所以即便两个集合互不相交也会
    // 被上报。这是刻意选的：一次误报的代价是损失一些并行度，一次漏报则会
    // 让两位写者撞上同一个文件。把它断言下来，是为了让这成为一项有记录的
    // 决定，而不是日后的一份缺陷报告。
    assert.equal(findScopeOverlap(['src/*.c'], ['src/*.h']).conflict, true)
  })
})

describe('findScopeOverlap — 上报内容', () => {
  it('指名两个条目，让拒绝能自我说明', () => {
    const overlap = findScopeOverlap(['src/deep/a.c'], ['src/'])
    assert.equal(overlap.scope, 'src/deep/a.c')
    assert.equal(overlap.claimed, 'src/')
  })
})

describe('findClaimConflict', () => {
  it('返回第一条冲突的占用声明及其持有者', () => {
    const result = findClaimConflict({
      scope: ['src/a.c'],
      claims: [claim(['other/']), claim(['src/'], { session_id: 's-2', task_id: 'REQ-2' })],
    })
    assert.equal(result.conflict, true)
    assert.equal(result.claim.task_id, 'REQ-2')
  })

  it('忽略 exclude_dispatch 指名的占用声明，使会话能重新声明自己', () => {
    const result = findClaimConflict({
      scope: ['src/a.c'],
      claims: [claim(['src/'], { dispatch_id: 'd-self' })],
      exclude_dispatch: 'd-self',
    })
    assert.equal(result.conflict, false)
  })

  it('对空的占用声明列表上报无冲突', () => {
    assert.equal(findClaimConflict({ scope: ['src/'], claims: [] }).conflict, false)
  })

  it('跳过格式错误的条目，而不是向调用方抛错', () => {
    const result = findClaimConflict({
      scope: ['src/'],
      claims: [null, 'nonsense', { dispatch_id: 'x' }, claim(['src/'])],
    })
    assert.equal(result.conflict, true)
  })

  it('拒绝非数组的作用域或占用声明列表', () => {
    assert.throws(() => findClaimConflict({ scope: 'src/', claims: [] }), TypeError)
    assert.throws(() => findClaimConflict({ scope: [], claims: {} }), TypeError)
  })
})

describe('validateClaim', () => {
  it('接受格式良好的占用声明并冻结其作用域', () => {
    const valid = validateClaim(claim(['src/']))
    assert.equal(Object.isFrozen(valid.write_scope), true)
  })

  it('拒绝缺少标识字段的占用声明', () => {
    for (const field of ['dispatch_id', 'session_id', 'task_id', 'node_id']) {
      assert.throws(
        () => validateClaim(claim(['src/'], { [field]: '' })),
        (error) => error.code === CLAIM_CODES.MALFORMED,
      )
    }
  })

  it('拒绝非数组作用域', () => {
    assert.throws(() => validateClaim(claim('src/')), (error) => error.code === CLAIM_CODES.MALFORMED)
  })

  it('拒绝作用域内的空条目', () => {
    assert.throws(() => validateClaim(claim(['src/', '  '])), (error) => error.code === CLAIM_CODES.MALFORMED)
  })

  it('指名来源，让坏文件可被找到', () => {
    assert.throws(() => validateClaim({}, 'C:/proj/.dsh/gac/claims/s-1.json'), /s-1\.json/u)
  })
})

describe('describeConflict', () => {
  it('指名持有者、涉及的路径，以及被拒绝的原因', () => {
    const message = describeConflict({
      claim: claim(['src/'], { task_id: 'REQ-9', node_id: 'T4', session_id: 's-9', dispatch_id: 'd-9' }),
      scope: 'src/a.c',
      claimed: 'src/',
    })
    // 模型无法据以行动的拒绝会变成重试循环。
    for (const expected of ['REQ-9', 'T4', 's-9', 'd-9', 'src/a.c', 'src/']) {
      assert.ok(message.includes(expected), `消息应当点名 ${expected}: ${message}`)
    }
  })
})
