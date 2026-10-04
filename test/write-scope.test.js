/**
 * 写作用域包含判定（containment）测试。
 *
 * 这些是架构大纲 §21（「严格写作用域」）与 §56（「便利别名绝不可渗入安全边界」）
 * 的可执行形式。下面每一个用例都对应前身 Python 运行时里的一次真实绕过，或者对应
 * 大纲自己给出的示例。
 *
 * 运行：node --test test/
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createWriteScope, normalizePath, normalizeScope } from '../lib/write-scope.js'

describe('normalizePath', () => {
  it('unifies separators', () => {
    assert.equal(normalizePath('src\\mod.c', { foldCase: false }), 'src/mod.c')
  })

  it('resolves . and .. lexically', () => {
    assert.equal(normalizePath('./src/./mod.c', { foldCase: false }), 'src/mod.c')
    assert.equal(normalizePath('src/sub/../mod.c', { foldCase: false }), 'src/mod.c')
  })

  it('drops a trailing separator', () => {
    assert.equal(normalizePath('src/', { foldCase: false }), 'src')
  })

  it('keeps a leading .. that escapes the scope, so it cannot match', () => {
    // 一个离开根目录的向上穿越绝不能被折叠成作用域相对路径；保留它才能让包含判定
    // 失败即拒绝（保守方向）。
    assert.equal(normalizePath('../outside.c', { foldCase: false }), '../outside.c')
  })

  it('folds case by default because Windows filenames are case-insensitive', () => {
    assert.equal(normalizePath('SRC/MOD.C'), 'src/mod.c')
  })

  it('preserves case when folding is disabled', () => {
    assert.equal(normalizePath('SRC/MOD.C', { foldCase: false }), 'SRC/MOD.C')
  })

  it('rejects an empty path instead of treating it as a scope', () => {
    assert.throws(() => normalizePath('   '), TypeError)
  })

  it('rejects a non-string path', () => {
    assert.throws(() => normalizePath(42), TypeError)
  })
})

describe('normalizeScope', () => {
  it('classifies a bare basename as an exact file, never as an alias', () => {
    const scope = normalizeScope('mod.c')
    assert.equal(scope.kind, 'file')
    assert.equal(scope.value, 'mod.c')
  })

  it('classifies a trailing separator as a directory subtree', () => {
    assert.equal(normalizeScope('src/').kind, 'dir')
    assert.equal(normalizeScope('src/**').kind, 'dir')
  })

  it('classifies a wildcard as a glob', () => {
    assert.equal(normalizeScope('src/*.c').kind, 'glob')
  })

  it('normalises the literal prefix of a glob', () => {
    assert.equal(normalizeScope('./src/*.c').value, 'src/*.c')
  })
})

describe('createWriteScope — the outline §21 worked example', () => {
  const scope = createWriteScope(['mod.c'])

  it('allows ./mod.c', () => {
    assert.equal(scope.allows('./mod.c'), true)
  })

  it('allows the bare name itself', () => {
    assert.equal(scope.allows('mod.c'), true)
  })

  it('denies src/mod.c — the basename alias bypass', () => {
    assert.equal(scope.allows('src/mod.c'), false)
  })

  it('denies other/mod.c', () => {
    assert.equal(scope.allows('other/mod.c'), false)
  })

  it('explains the refusal so the model can correct itself', () => {
    const verdict = scope.explain('sub/mod.c')
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /mod\.c/u)
  })
})

describe('createWriteScope — case folding', () => {
  it('treats a case variant as the same file', () => {
    const scope = createWriteScope(['src/mod.c'])
    assert.equal(scope.allows('SRC/MOD.C'), true)
  })

  it('does not let a case variant escape a directory scope', () => {
    const scope = createWriteScope(['src/'])
    assert.equal(scope.allows('SRC/mod.c'), true)
    assert.equal(scope.allows('other/mod.c'), false)
  })
})

describe('createWriteScope — directory scopes', () => {
  const scope = createWriteScope(['src/'])

  it('allows a direct child', () => {
    assert.equal(scope.allows('src/a.c'), true)
  })

  it('allows a deep descendant', () => {
    assert.equal(scope.allows('src/sub/deep/a.c'), true)
  })

  it('allows the directory itself', () => {
    assert.equal(scope.allows('src'), true)
  })

  it('denies a sibling prefix that merely starts with the same text', () => {
    assert.equal(scope.allows('src2/a.c'), false)
  })

  it('denies a traversal out of the scope', () => {
    assert.equal(scope.allows('src/../other.c'), false)
  })
})

describe('createWriteScope — glob scopes', () => {
  it('matches one level', () => {
    assert.equal(createWriteScope(['src/*.c']).allows('src/a.c'), true)
  })

  it('does not match a name that is not a .c file', () => {
    assert.equal(createWriteScope(['src/*.c']).allows('src/a.h'), false)
  })

  it('lets * cross separators, matching fnmatch as the predecessor did', () => {
    // 有文档记录、刻意为之、且失败安全：更宽的作用域允许得更多，所以放宽它是那个
    // 不会悄悄放行工程本意要禁止的写入的方向。见模块头部第 3 点。
    assert.equal(createWriteScope(['src/*.c']).allows('src/sub/a.c'), true)
  })

  it('matches a ** subtree', () => {
    const scope = createWriteScope(['src/**'])
    assert.equal(scope.allows('src/a.c'), true)
    assert.equal(scope.allows('src/deep/a.c'), true)
  })

  it('matches a mid-pattern ** including zero directories', () => {
    const scope = createWriteScope(['src/**/*.c'])
    assert.equal(scope.allows('src/a.c'), true)
    assert.equal(scope.allows('src/sub/a.c'), true)
  })
})

describe('createWriteScope — root prefix stripping', () => {
  const scope = createWriteScope(['src/a.c'], { rootPrefix: 'D:/work/proj' })

  it('accepts an absolute candidate inside the project root', () => {
    assert.equal(scope.allows('D:/work/proj/src/a.c'), true)
  })

  it('still denies a sibling directory outside the scope', () => {
    assert.equal(scope.allows('D:/work/proj/src/b.c'), false)
  })

  it('normalises case and separators in the absolute candidate too', () => {
    assert.equal(scope.allows('D:\\WORK\\PROJ\\SRC\\A.C'), true)
  })
})

describe('createWriteScope — refusal cases', () => {
  it('an empty scope permits nothing, rather than permitting everything', () => {
    const scope = createWriteScope([])
    assert.equal(scope.allows('anything.c'), false)
    assert.match(scope.explain('anything.c').reason, /no write scope/u)
  })

  it('rejects a non-array scope', () => {
    assert.throws(() => createWriteScope('src/'), TypeError)
  })

  it('rejects an empty-string scope entry', () => {
    assert.throws(() => createWriteScope(['']), TypeError)
  })
})
