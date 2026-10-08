/**
 * 构建者写范围分类的测试。
 *
 * 这一层要守住的是**实现与测试不由同一个节点产出**这条推理前提。它有两个容易写错的方向：
 *
 *  1. **对称与有方向不能混用。** `findScopeOverlap` 问的是「两者相不相交」，而这里问的是「这个
 *     写范围是不是整个落在测试路径之内」。用对称判定代替它，`test/` 与 `test/unit/` 会互相被判成
 *     落在对方之内，于是一个只写 `test/` 的节点与一个只写 `test/unit/` 的节点看起来像同一类。
 *  2. **没声明就不管。** 适配器不声明 `test_paths` 时这一层必须完全沉默（`unspecified`），否则
 *     每个已有工程的每个节点都会突然被判成「跨类」——那是把一个新约束当成追溯性的违规。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BUILDER_CODES,
  BUILDER_KINDS,
  describeMixedScope,
  mixedScopeNodes,
  testPathsOf,
  writeScopeClass,
} from '../lib/builder-scope.js'

/** 造一个只有 `nodes` 的任务壳；这一层只读节点。 */
function taskOf(...nodes) {
  return { task_id: 'REQ-1', nodes: new Map(nodes.map((node) => [node.id, node])) }
}

/** 造一个实现节点。 */
function builder(id, writeScope, overrides = {}) {
  return {
    id,
    objective: '把配置字段删掉',
    write_scope: writeScope,
    required_capabilities: ['implementation'],
    role: 'implementation',
    ...overrides,
  }
}

describe('writeScopeClass —— 一条写范围属于哪一类构建者', () => {
  it('完全落在测试路径之内的是测试构建者', () => {
    assert.deepEqual(writeScopeClass(['test/'], ['test/']), {
      kind: BUILDER_KINDS.TEST,
      test: ['test/'],
      software: [],
      spanning: [],
    })
    assert.equal(writeScopeClass(['test/unit/'], ['test/']).kind, BUILDER_KINDS.TEST)
    assert.equal(writeScopeClass(['test/a.test.js'], ['test/']).kind, BUILDER_KINDS.TEST)
  })

  it('完全不碰测试路径的是软件构建者', () => {
    const verdict = writeScopeClass(['src/'], ['test/'])
    assert.equal(verdict.kind, BUILDER_KINDS.SOFTWARE)
    assert.deepEqual(verdict.software, ['src/'])
    assert.deepEqual(verdict.spanning, [])
  })

  it('整仓写范围跨了两类：它既在改产品、又在改测试', () => {
    // `.` 与 `*` 都是覆盖根目录的作用域（前缀归约为空串），因此与测试路径相交却不落在它之内。
    assert.equal(writeScopeClass(['.'], ['test/']).kind, BUILDER_KINDS.MIXED)
    assert.deepEqual(writeScopeClass(['.'], ['test/']).spanning, ['.'])
    assert.equal(writeScopeClass(['*'], ['test/']).kind, BUILDER_KINDS.MIXED)
  })

  it('一个节点里一条测试路径加一条产品路径，也是跨类', () => {
    const verdict = writeScopeClass(['src/', 'test/'], ['test/'])
    assert.equal(verdict.kind, BUILDER_KINDS.MIXED)
    assert.deepEqual(verdict.test, ['test/'])
    assert.deepEqual(verdict.software, ['src/'])
    assert.deepEqual(verdict.spanning, [])
    // 每条路径各自都很干净，但**汇总**必须是跨类：一次推理产出两份产物，测试就会照着实现写。
    // 只看「有没有一条自己跨了」会把它判成测试构建者，恰好放过要拦的那一种。
    assert.notEqual(verdict.kind, BUILDER_KINDS.TEST)
  })

  it('测试路径覆盖根目录时，所有写范围都落在它之内', () => {
    assert.equal(writeScopeClass(['src/'], ['.']).kind, BUILDER_KINDS.TEST)
    assert.equal(writeScopeClass(['.'], ['.']).kind, BUILDER_KINDS.TEST)
  })

  it('兄弟目录不算落在测试路径之内', () => {
    // `test-old/` 与 `test/` 前缀不同，`findScopeOverlap` 也不会说它们相交。
    assert.equal(writeScopeClass(['test-old/'], ['test/']).kind, BUILDER_KINDS.SOFTWARE)
  })

  it('适配器没声明测试路径时完全不管', () => {
    assert.deepEqual(writeScopeClass(['src/'], []), {
      kind: BUILDER_KINDS.UNSPECIFIED,
      test: [],
      software: [],
      spanning: [],
    })
    assert.equal(writeScopeClass([], ['test/']).kind, BUILDER_KINDS.UNSPECIFIED)
  })

  it('非法条目被判成跨类，而不是让整次分类崩掉', () => {
    // 空串、null、数字都读不出前缀。它们既不能说落在测试路径之内，也不能说完全不碰它，
    // 于是判成跨类——失败方向是拒绝。
    assert.equal(writeScopeClass([''], ['test/']).kind, BUILDER_KINDS.MIXED)
    assert.equal(writeScopeClass([null], ['test/']).kind, BUILDER_KINDS.MIXED)
    assert.equal(writeScopeClass([42], ['test/']).kind, BUILDER_KINDS.MIXED)
    // 一条非法加一条干净的测试路径，仍然是跨类。
    assert.equal(writeScopeClass(['test/', null], ['test/']).kind, BUILDER_KINDS.MIXED)
  })

  it('读不出前缀的测试路径被跳过，而不是让分类崩掉', () => {
    assert.equal(writeScopeClass(['src/'], [null, 'test/']).kind, BUILDER_KINDS.SOFTWARE)
  })

  it('非数组入参不抛错', () => {
    assert.equal(writeScopeClass(undefined, ['test/']).kind, BUILDER_KINDS.UNSPECIFIED)
    assert.equal(writeScopeClass(['src/'], undefined).kind, BUILDER_KINDS.UNSPECIFIED)
  })
})

describe('testPathsOf —— 从适配器读测试路径声明', () => {
  it('读的是归一之后的那份声明', () => {
    assert.deepEqual(testPathsOf({ authority: { test_paths: ['test/', 'spec/'] } }), ['test/', 'spec/'])
  })

  it('没声明、读不到、类型不对都回空数组', () => {
    assert.deepEqual(testPathsOf(undefined), [])
    assert.deepEqual(testPathsOf({}), [])
    assert.deepEqual(testPathsOf({ authority: {} }), [])
    assert.deepEqual(testPathsOf({ authority: { test_paths: 'test/' } }), [])
  })
})

describe('mixedScopeNodes —— 只审实现节点', () => {
  const TESTS = ['test/']

  it('适配器没声明测试路径时一个都不报', () => {
    const task = taskOf(builder('T1', ['src/', 'test/']))
    assert.deepEqual(mixedScopeNodes(task, []), [])
  })

  it('报出跨类的实现节点，并点明是哪条路径跨了', () => {
    const task = taskOf(
      builder('T1', ['src/', 'test/']),
      builder('T2', ['src/']),
    )
    const offenders = mixedScopeNodes(task, TESTS)
    assert.deepEqual(offenders.map((entry) => entry.node_id), ['T1'])
    assert.equal(offenders[0].kind, BUILDER_KINDS.MIXED)
  })

  it('只写测试路径或只写产品路径的实现节点都不报', () => {
    const task = taskOf(builder('T1', ['test/']), builder('T2', ['src/']))
    assert.deepEqual(mixedScopeNodes(task, TESTS), [])
  })

  it('设计、验证与复核节点跨不跨类都不报', () => {
    // 它们写的是设计产物或干脆不写；「谁写实现、谁写测试」不因它们而改变。
    const task = taskOf(
      builder('D1', ['src/', 'test/'], { role: 'software_design' }),
      builder('V1', ['src/', 'test/'], { role: 'verification_execution' }),
      builder('R1', ['src/', 'test/'], { role: 'review' }),
    )
    assert.deepEqual(mixedScopeNodes(task, TESTS), [])
  })

  it('按能力推断成实现的节点也要审（缺省角色就是实现）', () => {
    const inferred = {
      id: 'T1',
      objective: '删掉字段',
      write_scope: ['src/', 'test/'],
      required_capabilities: ['implementation'],
    }
    assert.deepEqual(mixedScopeNodes(taskOf(inferred), TESTS).map((e) => e.node_id), ['T1'])
  })

  it('任务壳缺失时不抛错', () => {
    assert.deepEqual(mixedScopeNodes(undefined, TESTS), [])
    assert.deepEqual(mixedScopeNodes({}, TESTS), [])
  })
})

describe('describeMixedScope —— 拒绝信息要能照着做', () => {
  it('逐条点出跨类的路径与声明的测试路径', () => {
    const offenders = mixedScopeNodes(taskOf(builder('T1', [''])), ['test/'])
    const text = describeMixedScope(offenders, ['test/'])
    assert.match(text, /节点 T1/u)
    assert.match(text, /test\//u)
    assert.match(text, /既不在测试路径/u)
  })

  it('没声明测试路径时如实写「未声明」', () => {
    const text = describeMixedScope([{ node_id: 'T1', spanning: ['src/'] }], [])
    assert.match(text, /未声明/u)
  })

  it('两条来源的措辞分开：一条自己跨了 vs 两类各一条', () => {
    // 只说「跨了类」读的人不知道该拆哪一条。整仓写范围要拆的是那一条，而 `['src/', 'test/']`
    // 拆的依据是「它同时含两类」——写成同一句话会让第二种情况出现一截空话。
    const spanning = describeMixedScope(mixedScopeNodes(taskOf(builder('T1', ['.'])), ['test/']), ['test/'])
    assert.match(spanning, /既不在测试路径/u)

    const both = describeMixedScope(mixedScopeNodes(taskOf(builder('T1', ['src/', 'test/'])), ['test/']), ['test/'])
    assert.match(both, /同时含产品路径 src\/ 与测试路径 test\//u)
    assert.equal(/既不在测试路径/u.test(both), false)
  })
})

describe('BUILDER_CODES —— 拒绝码是闭集', () => {
  it('跨类写范围有一个稳定的码', () => {
    assert.equal(BUILDER_CODES.SCOPE_CLASS_MIXED, 'GAC_BUILDER_SCOPE_MIXED')
  })
})
