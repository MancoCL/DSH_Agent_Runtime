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
  it('统一分隔符', () => {
    assert.equal(normalizePath('src\\mod.c', { foldCase: false }), 'src/mod.c')
  })

  it('按字面词法解析 . 与 ..', () => {
    assert.equal(normalizePath('./src/./mod.c', { foldCase: false }), 'src/mod.c')
    assert.equal(normalizePath('src/sub/../mod.c', { foldCase: false }), 'src/mod.c')
  })

  it('去掉末尾的分隔符', () => {
    assert.equal(normalizePath('src/', { foldCase: false }), 'src')
  })

  it('保留穿出作用域的起始 ..，使它无法匹配', () => {
    // 一个离开根目录的向上穿越绝不能被折叠成作用域相对路径；保留它才能让包含判定
    // 失败即拒绝（保守方向）。
    assert.equal(normalizePath('../outside.c', { foldCase: false }), '../outside.c')
  })

  it('默认折叠大小写，因为 Windows 文件名不区分大小写', () => {
    assert.equal(normalizePath('SRC/MOD.C'), 'src/mod.c')
  })

  it('关闭折叠时保留大小写', () => {
    assert.equal(normalizePath('SRC/MOD.C', { foldCase: false }), 'SRC/MOD.C')
  })

  it('拒绝空路径，而不是把它当成一个作用域', () => {
    assert.throws(() => normalizePath('   '), TypeError)
  })

  it('拒绝非字符串路径', () => {
    assert.throws(() => normalizePath(42), TypeError)
  })
})

describe('normalizeScope', () => {
  it('把裸文件名归类为精确文件，而绝不归类为别名', () => {
    const scope = normalizeScope('mod.c')
    assert.equal(scope.kind, 'file')
    assert.equal(scope.value, 'mod.c')
  })

  it('把末尾分隔符归类为目录子树', () => {
    assert.equal(normalizeScope('src/').kind, 'dir')
    assert.equal(normalizeScope('src/**').kind, 'dir')
  })

  it('把通配符归类为 glob', () => {
    assert.equal(normalizeScope('src/*.c').kind, 'glob')
  })

  it('规范化 glob 的字面前缀', () => {
    assert.equal(normalizeScope('./src/*.c').value, 'src/*.c')
  })
})

describe('createWriteScope — 大纲 §21 的示例', () => {
  const scope = createWriteScope(['mod.c'])

  it('允许 ./mod.c', () => {
    assert.equal(scope.allows('./mod.c'), true)
  })

  it('允许裸文件名本身', () => {
    assert.equal(scope.allows('mod.c'), true)
  })

  it('拒绝 src/mod.c —— 裸文件名别名绕过', () => {
    assert.equal(scope.allows('src/mod.c'), false)
  })

  it('拒绝 other/mod.c', () => {
    assert.equal(scope.allows('other/mod.c'), false)
  })

  it('说明拒绝原因，让模型能自我纠正', () => {
    const verdict = scope.explain('sub/mod.c')
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /mod\.c/u)
  })
})

describe('createWriteScope — 大小写折叠', () => {
  it('把大小写变体当作同一个文件', () => {
    const scope = createWriteScope(['src/mod.c'])
    assert.equal(scope.allows('SRC/MOD.C'), true)
  })

  it('不让大小写变体逃出目录作用域', () => {
    const scope = createWriteScope(['src/'])
    assert.equal(scope.allows('SRC/mod.c'), true)
    assert.equal(scope.allows('other/mod.c'), false)
  })
})

describe('createWriteScope — 目录作用域', () => {
  const scope = createWriteScope(['src/'])

  it('允许直接子项', () => {
    assert.equal(scope.allows('src/a.c'), true)
  })

  it('允许深层后代', () => {
    assert.equal(scope.allows('src/sub/deep/a.c'), true)
  })

  it('允许该目录本身', () => {
    assert.equal(scope.allows('src'), true)
  })

  it('拒绝仅文本前缀相同的兄弟目录', () => {
    assert.equal(scope.allows('src2/a.c'), false)
  })

  it('拒绝穿出作用域的遍历', () => {
    assert.equal(scope.allows('src/../other.c'), false)
  })
})

describe('createWriteScope — glob 作用域', () => {
  it('匹配一层', () => {
    assert.equal(createWriteScope(['src/*.c']).allows('src/a.c'), true)
  })

  it('不匹配不是 .c 文件的名字', () => {
    assert.equal(createWriteScope(['src/*.c']).allows('src/a.h'), false)
  })

  it('让 * 跨越分隔符，与前身一样与 fnmatch 一致', () => {
    // 有文档记录、刻意为之、且失败安全：更宽的作用域允许得更多，所以放宽它是那个
    // 不会悄悄放行工程本意要禁止的写入的方向。见模块头部第 3 点。
    assert.equal(createWriteScope(['src/*.c']).allows('src/sub/a.c'), true)
  })

  it('匹配 ** 子树', () => {
    const scope = createWriteScope(['src/**'])
    assert.equal(scope.allows('src/a.c'), true)
    assert.equal(scope.allows('src/deep/a.c'), true)
  })

  it('匹配模式中段的 **，包括零层目录', () => {
    const scope = createWriteScope(['src/**/*.c'])
    assert.equal(scope.allows('src/a.c'), true)
    assert.equal(scope.allows('src/sub/a.c'), true)
  })
})

describe('createWriteScope — 剥离工程根前缀', () => {
  const scope = createWriteScope(['src/a.c'], { rootPrefix: 'D:/work/proj' })

  it('接受工程根之内的绝对路径候选', () => {
    assert.equal(scope.allows('D:/work/proj/src/a.c'), true)
  })

  it('仍拒绝作用域之外的兄弟目录', () => {
    assert.equal(scope.allows('D:/work/proj/src/b.c'), false)
  })

  it('绝对路径候选也规范化大小写与分隔符', () => {
    assert.equal(scope.allows('D:\\WORK\\PROJ\\SRC\\A.C'), true)
  })
})

describe('createWriteScope — 拒绝情形', () => {
  it('空作用域什么都不放行，而不是放行一切', () => {
    const scope = createWriteScope([])
    assert.equal(scope.allows('anything.c'), false)
    assert.match(scope.explain('anything.c').reason, /该节点没有声明任何写作用域/u)
  })

  it('拒绝非数组作用域', () => {
    assert.throws(() => createWriteScope('src/'), TypeError)
  })

  it('拒绝空字符串的作用域条目', () => {
    assert.throws(() => createWriteScope(['']), TypeError)
  })
})
