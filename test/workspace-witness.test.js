/**
 * 工作区差异观测（witness）的测试。
 *
 * 这些断言**从冻结的接口契约推导**，而不是从实现里读出来
 * ------------------------------------------------------------------
 * 任务 REQ-WITNESS 的接口契约在动手之前就冻结在
 * `.dsh/gac/contracts/plan-REQ-WITNESS.json` 里（冻结是派遣前的一道门禁）。这份测试依据的
 * 是那份契约逐条写下的行为，因此它本来可以在实现存在之前就写出来——这正是「接口契约冻结」
 * 存在的理由：测试与实现各自从契约推导，而不是互相抄。
 *
 * 本仓库对这条纪律的诚实说明：这一次的两份产物出自同一个作者，所以它证明的是「契约可以被
 * 独立执行」，**不**证明「两个作者真的独立」。那个缺口记在 `docs/CUTOVER.md` §6 第 6 条。
 *
 * 为什么用假 ctx 驱动入口
 * ----------------------
 * 契约把「运行时在 session/event 上订阅 workspace/changes」列为一项行为。纯函数的单测覆盖
 * 不到它，而这一层的失败方向是**静默**的：插件照常加载、门禁照常生效，只是工作区观测一条
 * 也没记下——本仓库在证据采集上吃过完全一样的亏（采集一度按会话内存状态判定，插件一重载就
 * 静默停止，而一切看起来都正常）。所以这里驱动真实的 `apply()`，并断言证据真的落了盘。
 *
 * 报告写进临时 `DSH_HOME`：本文件会驱动真实的 `apply()`，而它会往加载报告里追加记录。
 * 让它写进真实报告，审计轨迹里就会多出几行从未发生过的插件加载，而下一个人正是靠那份报告
 * 判断插件到底加载了几次。代价与 `test/prompt-wiring.test.js` 相同：临时 DSH_HOME 下解析不到
 * DSH 包，于是工具注册如实报 unavailable——本条测试断言的不是工具。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { compileEvidence, digest, isPassingEvidence } from '../lib/evidence.js'
import { EVIDENCE_FILE, EVIDENCE_RELATIVE_DIR } from '../lib/evidence-store.js'
import { summarizeEvidence } from '../lib/metrics.js'
import { metricsToolOptions } from '../lib/tool-metrics.js'
import { evidenceToolOptions, projectEvidence, selectEvidence } from '../lib/tool-evidence.js'
import {
  WITNESS_SOURCE,
  WitnessError,
  SUMMARY_READ_STEPS,
  classifyWitnessChanges,
  compileWitnessSummary,
  composeWitnessRecord,
  readWitnessSummary,
  resolveGoverningSession,
  witnessFacts,
} from '../lib/workspace-witness.js'

/** 本文件里所有纯函数用例共用的工程根。 */
const ROOT = '/work/proj'

/**
 * 宿主会给出的一份变更摘要。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function summary(overrides = {}) {
  return {
    turn: 3,
    cwd: ROOT,
    files: [
      { path: 'src/a.c', display: 'src/a.c', added: 4, deleted: 1 },
      { path: 'lib/b.js', display: 'lib/b.js', added: 0, deleted: 2 },
    ],
    total: 2,
    added: 4,
    deleted: 3,
    ...overrides,
  }
}

/**
 * 一条已记录的原始证据，形状与 `lib/evidence-store.js` 交给编译器的那个对象一致。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function rawEvidence(overrides = {}) {
  return { tool: 'pwsh', arguments: {}, value: { exitCode: 0 }, ...overrides }
}

describe('WITNESS_SOURCE 与 WitnessError', () => {
  it('常量取值与证据里的 tool / source 是同一个字符串', () => {
    // 三处必须逐字相同：常量、证据的 tool 字段、证据的 source 字段。写成三个字面量迟早会有
    // 一处漂移，而漂移的后果是「工作区观测」在指标与渲染里被当成一次普通工具调用。
    assert.equal(WITNESS_SOURCE, 'workspace-changes')
  })

  it('形状不合法时抛出带 code 的 WitnessError', () => {
    for (const bad of [null, undefined, 'not an object', 42, []]) {
      assert.throws(
        () => compileWitnessSummary(bad),
        (error) => error instanceof WitnessError
          && error.name === 'WitnessError'
          && error.code === 'GAC_WITNESS_MALFORMED',
        `应当拒绝 ${JSON.stringify(bad)}`,
      )
    }
  })

  it('files 不是数组时拒绝，而不是当成空变更', () => {
    // 把一份读不动的摘要当成「这一轮什么都没改」，恰好是会放过越界写入的那个方向。
    assert.throws(
      () => compileWitnessSummary({ turn: 1, cwd: ROOT, files: 'src/a.c' }),
      (error) => error instanceof WitnessError,
    )
  })
})

describe('compileWitnessSummary —— 把宿主摘要折成可比较的记录', () => {
  it('折出各个字段，total 缺省时等于 listed', () => {
    const compiled = compileWitnessSummary(summary({ total: undefined }))
    assert.equal(compiled.turn, 3)
    assert.equal(compiled.cwd, ROOT)
    assert.equal(compiled.listed, 2)
    assert.equal(compiled.total, 2)
    assert.equal(compiled.truncated, false)
  })

  it('顶层 added / deleted 缺省时由文件求和', () => {
    const compiled = compileWitnessSummary(summary({ added: undefined, deleted: undefined }))
    assert.equal(compiled.added, 4)
    assert.equal(compiled.deleted, 3)
  })

  it('truncated 的唯一判据是 total > listed', () => {
    // 宿主按 maxFiles 截断过，唯一的痕迹就是「总数大于列出的条数」。把它记成布尔量，是为了让
    // 「覆盖完整不完整」在证据里是一个可读的事实，而不是要事后去猜。
    const compiled = compileWitnessSummary(summary({ total: 9 }))
    assert.equal(compiled.truncated, true)
    assert.equal(compiled.listed, 2)
    assert.equal(compiled.total, 9)
  })

  it('每个文件折成 path / display / added / deleted / kind', () => {
    const compiled = compileWitnessSummary(summary({
      files: [
        { path: 'a.c', display: 'a.c', added: 2, deleted: 0 },
        { path: 'big.bin', display: 'big.bin', oversized: true },
        { path: 'img.png', display: 'img.png', binary: true },
        // oversized 与 binary 同时为真时 oversized 优先：它解释了「为什么没有行数」。
        { path: 'both.bin', display: 'both.bin', binary: true, oversized: true },
      ],
      total: 4,
    }))
    assert.deepEqual(
      compiled.files.map((file) => file.kind),
      ['text', 'oversized', 'binary', 'oversized'],
    )
    assert.equal(compiled.files[1].added, 0)
    assert.equal(compiled.files[1].deleted, 0)
  })

  it('path 不是字符串时折成空串，display 缺省时退回 path', () => {
    // 空串是「宿主没给出可用的路径」，不是一个叫 '' 的文件。如实记下它，判定那一层会把它算作
    // 不可归属，因此它绝不会被声称落在作用域之内。
    const compiled = compileWitnessSummary(summary({
      files: [{ path: 42, added: 1 }, { path: 'src/a.c' }],
      total: 2,
    }))
    assert.equal(compiled.files[0].path, '')
    assert.equal(compiled.files[0].display, '')
    assert.equal(compiled.files[1].display, 'src/a.c')
  })

  it('turn / cwd 不是合适类型时折成 0 与空串', () => {
    const compiled = compileWitnessSummary(summary({ turn: 'three', cwd: 7 }))
    assert.equal(compiled.turn, 0)
    assert.equal(compiled.cwd, '')
  })

  it('折出来的记录被冻结：顶层、数组与每个元素', () => {
    const compiled = compileWitnessSummary(summary())
    assert.equal(Object.isFrozen(compiled), true)
    assert.equal(Object.isFrozen(compiled.files), true)
    assert.equal(Object.isFrozen(compiled.files[0]), true)
  })
})

describe('resolveGoverningSession —— 谁在治理这次改动', () => {
  it('本会话自己声明过时不再上溯', () => {
    const scope = { session_id: 's1', write_scope: ['src/'] }
    const governing = resolveGoverningSession('s1', {
      headerFor: () => ({ parentSession: 's0' }),
      scopeFor: (id) => (id === 's1' ? scope : undefined),
    })
    assert.equal(governing.session_id, 's1')
    assert.equal(governing.hops, 0)
    assert.equal(governing.scope, scope)
  })

  it('子会话可以借用先代会话已声明的写作用域', () => {
    // 子会话对产品文件的改动属于同一个工程，而它的写作用域声明留在先代会话的内存里。不借用
    // 的话，子会话产出的每一次变更都会被算成未受治理，越界也就无从发现。
    const scope = { session_id: 's0', write_scope: ['src/'] }
    const governing = resolveGoverningSession('s2', {
      headerFor: (id) => (id === 's2' ? { parentSession: 's1' } : { parentSession: 's0' }),
      scopeFor: (id) => (id === 's0' ? scope : undefined),
    })
    assert.equal(governing.session_id, 's0')
    assert.equal(governing.hops, 2)
    assert.equal(governing.scope, scope)
  })

  it('最多上溯 maxHops 步', () => {
    // 中止条件是必需的：一条异常长的先代链会把一次工具调用变成一次长遍历，而这段代码跑在
    // 会话事件的发布路径上。
    const chain = { s0: 's1', s1: 's2', s2: 's3', s3: 's4' }
    const governing = resolveGoverningSession('s0', {
      headerFor: (id) => ({ parentSession: chain[id] }),
      scopeFor: () => undefined,
      maxHops: 2,
    })
    assert.equal(governing.hops, 2)
    assert.equal(governing.session_id, 's0')
    assert.equal(governing.scope, undefined)
  })

  it('上溯路径上出现重复 id 时立即停止', () => {
    // 环形的先代链会变成死循环。
    const governing = resolveGoverningSession('s0', {
      headerFor: (id) => ({ parentSession: id === 's0' ? 's1' : 's0' }),
      scopeFor: () => undefined,
    })
    assert.equal(governing.hops, 1)
    assert.equal(governing.session_id, 's0')
  })

  it('parentSession 不是非空字符串时停止上溯', () => {
    for (const parent of [undefined, '', 42, null]) {
      const governing = resolveGoverningSession('s0', {
        headerFor: () => ({ parentSession: parent }),
        scopeFor: () => undefined,
      })
      assert.equal(governing.hops, 0, `parentSession=${JSON.stringify(parent)} 时不应上溯`)
    }
  })

  it('回调缺失、抛错或返回非法值时按「没有」处理，本函数从不抛错', () => {
    assert.doesNotThrow(() => resolveGoverningSession('s0', {}))
    assert.equal(resolveGoverningSession('s0', {}).scope, undefined)

    const throwing = resolveGoverningSession('s0', {
      headerFor: () => { throw new Error('header 读不出来') },
      scopeFor: () => { throw new Error('作用域读不出来') },
    })
    assert.equal(throwing.scope, undefined)
    assert.equal(throwing.hops, 0)

    // scopeFor 返回一个非对象（例如被误传成布尔量）等于没有声明，而不是一份「有效声明」。
    assert.equal(resolveGoverningSession('s0', {
      headerFor: () => undefined,
      scopeFor: () => true,
    }).scope, undefined)

    // headerFor 返回的不是对象时按「没有先代」处理。
    const badHeader = resolveGoverningSession('s0', {
      headerFor: () => 'session-header',
      scopeFor: () => undefined,
    })
    assert.equal(badHeader.hops, 0)
    assert.equal(badHeader.session_id, 's0')
  })

  it('找不到任何声明时 session_id 是入参本身', () => {
    const governing = resolveGoverningSession('s9', {
      headerFor: () => ({ parentSession: 's8' }),
      scopeFor: () => undefined,
    })
    assert.equal(governing.session_id, 's9')
    assert.equal(governing.scope, undefined)
  })
})

describe('classifyWitnessChanges —— 每个文件落在谁的范围里', () => {
  it('未受治理时不产出任何越界结论', () => {
    // 这是本模块最容易走错的地方：没有声明时，每一个改动都「不在任何作用域内」，于是每一轮
    // 都会报一堆越界。那不是发现，那是噪声——而噪声会把真正的越界淹掉。
    const compiled = compileWitnessSummary(summary())
    for (const scope of [undefined, []]) {
      const classified = classifyWitnessChanges(compiled, { scope, root: ROOT, cwd: ROOT })
      assert.equal(classified.governed, false)
      assert.deepEqual(classified.scope, [])
      assert.deepEqual(classified.in_scope, [])
      assert.deepEqual(classified.out_of_scope, [])
      assert.deepEqual(classified.outside_project, [])
      // 覆盖度与治理无关：它说的是这份摘要本身列全了没有。
      assert.equal(classified.coverage, 'complete')
      assert.equal(classified.listed, 2)
      assert.equal(classified.total, 2)
    }
  })

  it('受治理时把文件分进 in_scope 与 out_of_scope', () => {
    const compiled = compileWitnessSummary(summary())
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    assert.equal(classified.governed, true)
    assert.deepEqual(classified.scope, ['src/'])
    assert.deepEqual(classified.in_scope, ['src/a.c'])
    assert.deepEqual(classified.out_of_scope, ['lib/b.js'])
    assert.deepEqual(classified.outside_project, [])
  })

  it('工程根之外的文件同时出现在 out_of_scope 与 outside_project', () => {
    // outside_project 是 out_of_scope 的子集标记，不是第三类：在工程之外的改动必然不在已声明
    // 的写作用域内，但它值得单独指出——那已经越出了工程的边界。
    const compiled = compileWitnessSummary(summary({
      files: [{ path: '/elsewhere/c.c', display: '~/c.c', added: 1, deleted: 1 }],
      total: 1,
    }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    assert.deepEqual(classified.out_of_scope, ['/elsewhere/c.c'])
    assert.deepEqual(classified.outside_project, ['/elsewhere/c.c'])
    assert.deepEqual(classified.in_scope, [])
  })

  it('相对路径按会话 cwd 折算，而不是按工程根', () => {
    // 宿主给出的 path 相对的是会话工作目录，两者可以是不同的目录。
    const compiled = compileWitnessSummary(summary({
      files: [{ path: 'a.c', display: 'a.c', added: 1, deleted: 0 }],
      total: 1,
    }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: '/work/proj/src',
    })
    assert.deepEqual(classified.in_scope, ['src/a.c'])
  })

  it('cwd 缺失时按「相对工程根」处理', () => {
    const compiled = compileWitnessSummary(summary({
      cwd: undefined,
      files: [{ path: 'src/a.c', display: 'src/a.c', added: 1, deleted: 0 }],
      total: 1,
    }))
    const classified = classifyWitnessChanges(compiled, { scope: ['src/'], root: ROOT })
    assert.deepEqual(classified.in_scope, ['src/a.c'])
  })

  it('三个列表按原顺序去重', () => {
    // 同一路径出现两次是宿主摘要里完全可能的事，而把它报两遍会让「越界文件数」这个数虚高，
    // 指标随之失真。
    const compiled = compileWitnessSummary(summary({
      files: [
        { path: 'lib/b.js', display: 'lib/b.js' },
        { path: 'lib/b.js', display: 'lib/b.js' },
        { path: 'src/a.c', display: 'src/a.c' },
      ],
      total: 3,
    }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    assert.deepEqual(classified.out_of_scope, ['lib/b.js'])
    assert.deepEqual(classified.in_scope, ['src/a.c'])
  })

  it('覆盖度由 truncated 决定', () => {
    const compiled = compileWitnessSummary(summary({ total: 40 }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    assert.equal(classified.coverage, 'partial')
    assert.equal(classified.listed, 2)
    assert.equal(classified.total, 40)
  })

  it('包含判定复用 write-scope 的语义（glob 跨分隔符、大小写折叠）', () => {
    // 第二份包含判定会与本仓库的安全边界漂移：`src/*.c` 覆盖不覆盖 `src/deep/a.c`，必须与
    // 门禁给出的答案一致。
    const compiled = compileWitnessSummary(summary({
      files: [
        { path: 'SRC/DEEP/A.C', display: 'SRC/DEEP/A.C' },
        { path: 'src/deep/b.c', display: 'src/deep/b.c' },
        { path: 'src/deep/c.h', display: 'src/deep/c.h' },
      ],
      total: 3,
    }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/*.c'],
      root: ROOT,
      cwd: ROOT,
    })
    assert.deepEqual(classified.in_scope, ['src/deep/a.c', 'src/deep/b.c'])
    assert.deepEqual(classified.out_of_scope, ['src/deep/c.h'])
  })

  it('空路径既不算在作用域内，也不声称它在工程之外', () => {
    const compiled = compileWitnessSummary(summary({ files: [{ path: 42 }], total: 1 }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    assert.deepEqual(classified.in_scope, [])
    assert.deepEqual(classified.out_of_scope, [''])
    assert.deepEqual(classified.outside_project, [])
  })

  it('工程根未知时不产出 outside_project 结论', () => {
    // 没有根就无从判断「在工程之外」；此时只有作用域内/外的分别，而那个分别仍然成立。
    const compiled = compileWitnessSummary(summary({ cwd: undefined }))
    const classified = classifyWitnessChanges(compiled, { scope: ['src/'] })
    assert.equal(classified.governed, true)
    assert.deepEqual(classified.in_scope, ['src/a.c'])
    assert.deepEqual(classified.out_of_scope, ['lib/b.js'])
    assert.deepEqual(classified.outside_project, [])
  })
})

describe('witnessFacts —— 压成可长期留存的字段', () => {
  it('给出扁平字段与文件摘要', () => {
    const compiled = compileWitnessSummary(summary({ total: 5 }))
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    const facts = witnessFacts(classified, compiled)
    assert.equal(facts.turn, 3)
    assert.equal(facts.listed, 2)
    assert.equal(facts.total, 5)
    assert.equal(facts.truncated, true)
    assert.equal(facts.coverage, 'partial')
    assert.equal(facts.in_scope_count, 1)
    // **清单而不只是计数**：收口门禁要核对的是「哪些文件被判在范围内」，只有计数时那份判断无法复核。
    assert.deepEqual(facts.in_scope, ['src/a.c'])
    assert.deepEqual(facts.out_of_scope, ['lib/b.js'])
    assert.deepEqual(facts.outside_project, [])
    assert.equal(typeof facts.files_digest, 'string')
    assert.equal(facts.files_digest.length, 8)
  })

  it('文件摘要对内容敏感、对同一内容稳定', () => {
    const build = (added) => {
      const compiled = compileWitnessSummary(summary({
        files: [{ path: 'src/a.c', display: 'src/a.c', added, deleted: 0 }],
        total: 1,
      }))
      const classified = classifyWitnessChanges(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })
      return witnessFacts(classified, compiled).files_digest
    }
    assert.equal(build(1), build(1))
    assert.notEqual(build(1), build(2))
  })

  it('两个字符串数组是副本，不是分类结果里的原数组', () => {
    // 共享同一个数组会让后来的一次改动同时改到「判定结果」与「已落盘的证据」，而证据的含义
    // 是「当时观察到的事实」。
    const compiled = compileWitnessSummary(summary())
    const classified = classifyWitnessChanges(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
    })
    const facts = witnessFacts(classified, compiled)
    assert.notEqual(facts.out_of_scope, classified.out_of_scope)
    assert.notEqual(facts.outside_project, classified.outside_project)
    assert.deepEqual(facts.out_of_scope, classified.out_of_scope)
  })

  it('身份字段给了才出现 —— 没有治理会话是真实情形，不该被记成空值', () => {
    const compiled = compileWitnessSummary(summary())
    const classified = classifyWitnessChanges(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })

    const bare = witnessFacts(classified, compiled)
    assert.equal('governing_session_id' in bare, false)
    assert.equal('task_id' in bare, false)
    assert.equal('node_id' in bare, false)

    const identified = witnessFacts(classified, compiled, {
      governing_session_id: 'parent-1',
      task_id: 'REQ-1',
      node_id: 'T1',
    })
    assert.equal(identified.governing_session_id, 'parent-1')
    assert.equal(identified.task_id, 'REQ-1')
    assert.equal(identified.node_id, 'T1')
  })
})

describe('composeWitnessRecord 的身份字段一路进到证据载荷', () => {
  it('治理会话与任务节点被带上，且能过证据编译器（工作区字段是闭集）', () => {
    const compiled = compileWitnessSummary(summary({ total: 1, files: [{ path: 'src/a.c' }] }))
    const composed = composeWitnessRecord(compiled, {
      scope: ['src/'],
      root: ROOT,
      cwd: ROOT,
      governingSessionId: 'parent-1',
      taskId: 'REQ-1',
      nodeId: 'T1',
    })

    assert.equal(composed.facts.governing_session_id, 'parent-1')
    assert.equal(composed.facts.task_id, 'REQ-1')
    assert.equal(composed.facts.node_id, 'T1')
    // 闭集校验：多一个没声明的键就会被拒，所以这条断言实际在测「字段表也一起扩展了」。
    const record = compileEvidence(
      rawEvidence({ source: WITNESS_SOURCE, tool: WITNESS_SOURCE, workspace: { ...composed.facts } }),
      { id: 'ev-w1' },
    )
    assert.equal(record.workspace.task_id, 'REQ-1')
    assert.deepEqual(record.workspace.in_scope, ['src/a.c'])
  })

  it('没有治理会话时不写这个键，编译器照样接受', () => {
    const compiled = compileWitnessSummary(summary({ total: 1, files: [{ path: 'src/a.c' }] }))
    const composed = composeWitnessRecord(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })

    assert.equal('governing_session_id' in composed.facts, false)
    const record = compileEvidence(
      rawEvidence({ source: WITNESS_SOURCE, tool: WITNESS_SOURCE, workspace: { ...composed.facts } }),
      { id: 'ev-w2' },
    )
    assert.equal(record.workspace.governing_session_id, undefined)
  })
})

describe('composeWitnessRecord —— 判定与报告出口收在一处', () => {
  it('每条观测都产出一条 witness-turn', () => {
    const compiled = compileWitnessSummary(summary())
    const composed = composeWitnessRecord(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })
    const turn = composed.reports.filter((entry) => entry.event === 'witness-turn')
    assert.equal(turn.length, 1)
    assert.equal(turn[0].turn, 3)
    assert.equal(turn[0].out_of_scope, 1)
  })

  it('越界非空时另写一条 witness-out-of-scope，并区分工程之外', () => {
    const compiled = compileWitnessSummary(summary({
      files: [{ path: '/elsewhere/c.c', display: '~/c.c' }],
      total: 1,
    }))
    const composed = composeWitnessRecord(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })
    const outOfScope = composed.reports.filter((entry) => entry.event === 'witness-out-of-scope')
    assert.equal(outOfScope.length, 1)
    assert.equal(outOfScope[0].files, 1)
    assert.equal(outOfScope[0].outside_project, 1)
  })

  it('没有越界时不写那条事件', () => {
    // 每轮都写一条「零个越界」会让报告里真正的越界被自己淹掉。
    const compiled = compileWitnessSummary(summary({
      files: [{ path: 'src/a.c', display: 'src/a.c' }],
      total: 1,
    }))
    const composed = composeWitnessRecord(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })
    assert.equal(composed.reports.filter((entry) => entry.event === 'witness-out-of-scope').length, 0)
  })

  it('facts 就是进证据记录的那份字段', () => {
    const compiled = compileWitnessSummary(summary())
    const composed = composeWitnessRecord(compiled, { scope: ['src/'], root: ROOT, cwd: ROOT })
    assert.deepEqual(composed.facts, witnessFacts(composed.classification, compiled))
  })
})

describe('compileEvidence 的工作区扩展', () => {
  /**
   * 一份合法的 workspace 载荷。
   *
   * @param {object} [overrides]
   * @returns {object}
   */
  function workspace(overrides = {}) {
    return {
      turn: 3,
      listed: 2,
      total: 5,
      truncated: true,
      coverage: 'partial',
      in_scope_count: 1,
      out_of_scope: ['lib/b.js'],
      outside_project: [],
      files_digest: digest('x'),
      ...overrides,
    }
  }

  it('source 缺省为 tool-result，显式给出工作区观测时如实记下', () => {
    assert.equal(compileEvidence(rawEvidence(), { id: 'ev-1' }).source, 'tool-result')
    const record = compileEvidence(
      rawEvidence({ source: WITNESS_SOURCE, tool: WITNESS_SOURCE, workspace: workspace() }),
      { id: 'ev-2' },
    )
    assert.equal(record.source, WITNESS_SOURCE)
    assert.equal(record.tool, WITNESS_SOURCE)
  })

  it('除此之外的 source 一律拒绝', () => {
    // 来源是一个闭集：多出来的取值会让「这条证据是什么」在指标与渲染里都无从判断。
    for (const source of ['fs/observed', 'workspaceChanges', '', 7, null]) {
      assert.throws(
        () => compileEvidence(rawEvidence({ source }), { id: 'ev-1' }),
        (error) => error.code === 'GAC_EVIDENCE_MALFORMED',
        `应当拒绝 source=${JSON.stringify(source)}`,
      )
    }
  })

  it('workspace 只保留声明过的键', () => {
    const record = compileEvidence(
      rawEvidence({ source: WITNESS_SOURCE, workspace: workspace() }),
      { id: 'ev-1' },
    )
    assert.deepEqual(Object.keys(record.workspace).sort(), [
      'coverage',
      'files_digest',
      'in_scope_count',
      'listed',
      'out_of_scope',
      'outside_project',
      'total',
      'truncated',
      'turn',
    ])
  })

  it('workspace 未声明的键或类型不符一律拒绝', () => {
    for (const bad of [
      workspace({ extra: 1 }),
      workspace({ turn: '3' }),
      workspace({ truncated: 'yes' }),
      workspace({ coverage: 'mostly' }),
      workspace({ out_of_scope: 'lib/b.js' }),
      workspace({ out_of_scope: ['lib/b.js', 7] }),
      workspace({ files_digest: 42 }),
      'not an object',
      [],
      null,
    ]) {
      assert.throws(
        () => compileEvidence(rawEvidence({ source: WITNESS_SOURCE, workspace: bad }), { id: 'ev-1' }),
        (error) => error.code === 'GAC_EVIDENCE_MALFORMED',
        `应当拒绝 workspace=${JSON.stringify(bad)}`,
      )
    }
  })

  it('不带 source 与 workspace 的调用形状与既有版本一致', () => {
    const record = compileEvidence(rawEvidence(), { id: 'ev-1' })
    assert.equal(record.tool, 'pwsh')
    assert.equal(record.exit_code, 0)
    assert.equal(record.is_error, false)
    assert.equal(Object.hasOwn(record, 'workspace'), false)
  })
})

describe('isPassingEvidence 的越界扩展', () => {
  it('越界文件非空时不可用，且理由里带越界文件数', () => {
    // 一次改动写出了已声明范围之外的产品文件，「它跑过了」证明不了这次改动是合规的。
    const verdict = isPassingEvidence({
      is_error: false,
      exit_code: 0,
      workspace: { out_of_scope: ['lib/b.js', 'lib/c.js'], outside_project: [] },
    })
    assert.equal(verdict.usable, false)
    assert.match(verdict.reason, /2/u)
    assert.match(verdict.reason, /越界/u)
  })

  it('越界为空、或没有 workspace 的记录不受影响', () => {
    assert.equal(isPassingEvidence({
      is_error: false,
      exit_code: 0,
      workspace: { out_of_scope: [], outside_project: [] },
    }).usable, true)
    assert.equal(isPassingEvidence({ is_error: false, exit_code: 0 }).usable, true)
  })

  it('既有三条判定一条都没被放宽', () => {
    assert.equal(isPassingEvidence(undefined).usable, false)
    assert.equal(isPassingEvidence({ is_error: true }).usable, false)
    assert.equal(isPassingEvidence({ is_error: false, exit_code: 1 }).usable, false)
  })
})

describe('证据列表与指标里的工作区观测', () => {
  /**
   * 一条已编译的工作区观测记录。
   *
   * @returns {Readonly<object>}
   */
  function witnessRecord() {
    return compileEvidence(
      rawEvidence({
        source: WITNESS_SOURCE,
        tool: WITNESS_SOURCE,
        value: { turn: 3 },
        workspace: {
          turn: 3,
          listed: 2,
          total: 5,
          truncated: true,
          coverage: 'partial',
          in_scope_count: 1,
          out_of_scope: ['lib/b.js'],
          outside_project: ['/elsewhere/c.c'],
          files_digest: digest('x'),
        },
      }),
      { id: 'ev-9', at: 10 },
    )
  }

  it('投影里带上 source 与 workspace 摘要', () => {
    const projected = projectEvidence(witnessRecord())
    assert.equal(projected.source, WITNESS_SOURCE)
    assert.equal(projected.workspace.total, 5)
    assert.equal(projected.workspace.coverage, 'partial')
  })

  it('工具调用的投影不受影响', () => {
    const projected = projectEvidence(compileEvidence(rawEvidence(), { id: 'ev-1' }))
    assert.equal(projected.source, 'tool-result')
    assert.equal(Object.hasOwn(projected, 'workspace'), false)
    assert.equal(projected.tool, 'pwsh')
  })

  it('指标新增一个 witness 块，工具调用的统计一个都不变', () => {
    const toolCall = compileEvidence(rawEvidence({ value: { exitCode: 0 } }), { id: 'ev-1' })
    const block = summarizeEvidence([toolCall, witnessRecord()])
    // `available` 是三态：调用方没给「观测源在不在」这个环境事实时它是 `null`——不宣称可用，
    // 也不宣称不可用。压成 `!== false` 会让报告在最需要谨慎的地方显得笃定；写成 `undefined`
    // 则不是合法 JSON（活体踩到过，见 test/evidence.test.js 的无损断言）。
    assert.deepEqual(block.witness, {
      available: null,
      observations: 1,
      out_of_scope: 1,
      partial_coverage: 1,
    })
    assert.equal(block.total, 2)
    assert.equal(block.errors, 0)
    assert.equal(block.denied_writes, 0)
    assert.equal(block.denied_shells, 0)
    assert.deepEqual(block.by_tool, { 'workspace-changes': 1, pwsh: 1 })
  })

  it('观测源缺席时 witness 块如实记 false —— 那三个 0 因此读得出来', () => {
    const block = summarizeEvidence([witnessRecord()], { observationAvailable: false })
    assert.equal(block.witness.available, false)
    assert.equal(block.witness.observations, 1, '在场与否不改变已经落盘的观测条数')
  })

  it('渲染把工作区观测讲成四件事，而不是工具调用的那三行', () => {
    const witnessText = renderEvidence(selectEvidence([witnessRecord()], {}))
    const toolText = renderEvidence(selectEvidence([compileEvidence(rawEvidence(), { id: 'ev-1' })], {}))
    assert.match(witnessText, /工作区观测/u)
    assert.match(witnessText, /2\/5/u)
    assert.match(witnessText, /未列全/u)
    assert.match(witnessText, /越界 1/u)
    // 「工具 / 参数 / 产出」那三行讲的是工具调用，套在工作区观测上等于把观测说成了调用。
    assert.doesNotMatch(witnessText, /参数：/u)
    assert.doesNotMatch(witnessText, /产出：/u)
    assert.match(toolText, /参数：/u)
  })

  it('指标工具的渲染里带上工作区观测这一句', async () => {
    // 结构化字段对了、渲染不带上，等于这个数没人看得到——本仓库在 gac_evidence 上吃过同一亏：
    // 数据完全正确，渲染只有一行汇总，工具因此毫无用处。
    const tool = metricsToolOptions({
      taskStoreFor: () => ({ list: () => [], load: () => undefined }),
      sessionRootFor: () => ROOT,
      evidenceFor: () => [witnessRecord()],
    })
    const value = await tool.execute({}, { agent: { session: { id: 's-1' } } })
    assert.match(value.summary, /工作区观测 1 轮/u)
    assert.match(value.summary, /越界改动 1 个/u)
    assert.match(tool.output.render({}, value)[0].text, /工作区观测 1 轮/u)
  })

  it('没有观测时也说明是 0 轮，而不是略过这一句', async () => {
    // 「0 轮」的意思是观测源没有产出，不是「一切正常」。省掉这一句会让读的人以为观测在跑。
    const tool = metricsToolOptions({
      taskStoreFor: () => ({ list: () => [], load: () => undefined }),
      sessionRootFor: () => ROOT,
      evidenceFor: () => [],
    })
    const value = await tool.execute({}, { agent: { session: { id: 's-1' } } })
    assert.match(value.summary, /工作区观测 0 轮/u)
  })
})

/**
 * 从证据工具的定义里取出渲染结果。
 *
 * 渲染是接口的一部分——模型实际读到的是它，而不是数据结构。单独把它取出来断言，是因为本
 * 仓库吃过一次亏：数据完全正确，渲染却只给了一行汇总，于是工具毫无用处。
 *
 * @param {object} selection - `selectEvidence` 的结果。
 * @returns {string}
 */
function renderEvidence(selection) {
  const options = evidenceToolOptions({ evidenceFor: () => [], sessionRootFor: () => ROOT })
  const value = { ...selection, summary: '摘要', root: ROOT }
  return options.output.render({}, value)[0].text
}

/**
 * 本文件里驱动入口的会话 id。
 */
const SESSION_ID = 'session-witness'

/**
 * 临时 DSH_HOME。
 *
 * 在 import `lib/index.js` 之前设好，因为加载报告路径是在模块求值时算出来的。
 */
const tempHome = mkdtempSync(join(tmpdir(), 'gac-witness-home-'))
process.env.DSH_HOME = tempHome
const REPORT_PATH = join(tempHome, 'gac-runtime-report.jsonl')
const { apply } = await import('../lib/index.js')

/**
 * 造一个临时工程根；`governed` 为真时带上适配器，因此它已纳管。
 *
 * 每条用例各造一个根，而不是共用一个：证据是只追加的，共用会让「记了几条」这个断言取决于
 * 用例的执行顺序——那种测试在单独跑时绿、一起跑时红。
 *
 * @param {string} prefix
 * @param {{governed?: boolean}} [options]
 * @returns {string}
 */
function makeProject(prefix, { governed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  if (!governed) return root
  mkdirSync(join(root, '.dsh', 'gac'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'gac', 'project.json'),
    JSON.stringify({ project: { id: `${prefix}demo`, title: 'Witness demo' } }),
    'utf8',
  )
  return root
}

/**
 * 一个够用的假 ctx。
 *
 * `effect` 会把 `apply()` 传进来的生成器跑一遍：里面逐个 `yield` 的正是监听器注册，不跑就
 * 等于把订阅装在了空气里。`inject` 只对**提供了的**依赖调用回调——这正是真实 Cordis 的
 * 语义：服务缺席时回调不会跑，插件因此照常加载。
 *
 * @param {object} [options]
 * @param {object|undefined} [options.workspaceSummary] - 服务会给出的那一轮摘要。
 * @param {boolean} [options.summaryLate] - 摘要**晚一步**才就绪：前几次读（同一同步块内）返回
 *   `undefined`，让出一个宏任务之后才给。这是生产者的真实形状——它先 `append`（同步发布事件）、
 *   再把摘要存进记录表，两者在同一个同步块里。
 * @param {boolean} [options.provideWorkspaceChanges] - 是否提供 `workspaceChanges` 服务。
 * @param {string} [options.cwd] - 会话工作目录。
 * @returns {{ctx: object, seen: {listeners: object[], injections: object[]}}}
 */
function createFakeContext({
  workspaceSummary,
  summaryLate = false,
  provideWorkspaceChanges = true,
  cwd,
} = {}) {
  const seen = { listeners: [], injections: [] }
  const disposer = () => {}
  const session = { id: SESSION_ID, header: { cwd }, append: () => {} }
  // **按时间**就绪，而不是按调用次数：生产者的「稍后」是同一个同步块结束，不是「下一次调用」。
  // 用调用次数模拟会让「去掉等待」的突变悄悄通过（实测踩到过）。第一次读发生在事件发布期间
  // （`append` 内部），此时安排一个宏任务把摘要「存下来」——与生产者先发布、后 `records.set` 一致。
  let ready = !summaryLate
  let scheduled = false
  const summary = () => {
    if (!ready && !scheduled) {
      scheduled = true
      setImmediate(() => { ready = true })
    }
    return ready ? workspaceSummary : undefined
  }
  const ctx = {
    sessions: {
      get: (id) => (id === SESSION_ID ? session : undefined),
      list: () => [session],
    },
    tools: { register: () => disposer },
    get: (name) => (name === 'workspaceChanges' && provideWorkspaceChanges
      ? { summary }
      : undefined),
    on: (event, listener, options) => {
      seen.listeners.push({ event, listener, options })
      return disposer
    },
    effect: (body) => {
      for (const _yielded of body()) { /* 逐个注册，返回值就是销毁器 */ }
      return disposer
    },
    inject: (deps, callback) => {
      seen.injections.push({ deps, callback })
      const provided = {}
      if (deps.includes('systemPrompt')) provided.systemPrompt = { section: () => disposer }
      if (deps.includes('workspaceChanges') && provideWorkspaceChanges) {
        provided.workspaceChanges = { summary }
      }
      callback(provided)
      return disposer
    },
    llm: undefined,
  }
  return { ctx, seen }
}

/**
 * 读回某个工程根上已落盘的证据。
 *
 * @param {string} root
 * @returns {object[]}
 */
function readEvidence(root) {
  const path = join(root, EVIDENCE_RELATIVE_DIR, EVIDENCE_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * 读回加载报告里的记录。
 *
 * @returns {object[]}
 */
function readReport() {
  if (!existsSync(REPORT_PATH)) return []
  return readFileSync(REPORT_PATH, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

/**
 * 让出若干步，等延迟读取走完。
 *
 * 缺失/就绪的判断发生在让出几步之后（生产者先发布事件、后存摘要），所以断言前必须等它。
 *
 * @returns {Promise<void>}
 */
async function flushDeferred() {
  for (let i = 0; i < SUMMARY_READ_STEPS + 2; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
  }
}

/**
 * 触发一轮工作区变更事件。
 *
 * @param {object} ctx
 * @param {object} seen
 * @param {object} [event]
 */
function emitWorkspaceChanges(ctx, seen, event = { type: 'workspace/changes', seq: 7, data: { turn: 3 } }) {
  const listener = seen.listeners.find((entry) => entry.event === 'session/event')
  assert.ok(listener !== undefined, 'apply() 必须订阅 session/event')
  listener.listener(ctx.sessions.get(SESSION_ID), event)
}

describe('readWitnessSummary —— 等生产者把摘要存下来', () => {
  it('摘要已经就绪时立刻返回，不让出任何一步', async () => {
    let defers = 0
    const found = await readWitnessSummary({
      read: () => ({ turn: 3 }),
      defer: async () => { defers += 1 },
    })
    assert.deepEqual(found, { summary: { turn: 3 }, attempts: 0 })
    assert.equal(defers, 0)
  })

  it('摘要晚一步就绪时让出一步再读到（这就是真实顺序）', async () => {
    let reads = 0
    let defers = 0
    const found = await readWitnessSummary({
      read: () => { reads += 1; return reads === 1 ? undefined : { turn: 35 } },
      defer: async () => { defers += 1 },
    })
    assert.deepEqual(found, { summary: { turn: 35 }, attempts: 1 })
    assert.equal(defers, 1)
  })

  it('一直读不到就有界地放弃 —— 让出 steps-1 步，返回 undefined', async () => {
    let defers = 0
    const found = await readWitnessSummary({
      read: () => undefined,
      steps: 4,
      defer: async () => { defers += 1 },
    })
    assert.equal(found, undefined)
    assert.equal(defers, 3, '有界：不无限等')
  })

  it('读的时候抛错按「还没就绪」处理，绝不把异常抛给事件发布路径', async () => {
    let reads = 0
    const found = await readWitnessSummary({
      read: () => { reads += 1; if (reads === 1) throw new Error('服务坏了'); return { turn: 1 } },
      defer: async () => {},
    })
    assert.deepEqual(found, { summary: { turn: 1 }, attempts: 1 })
  })

  it('没有 read 时也返回 undefined，而不是抛错', async () => {
    assert.equal(await readWitnessSummary({ defer: async () => {}, steps: 2 }), undefined)
  })
})

describe('生产能力契约的执行点：第一次用到某个工程时核对并留痕', () => {
  /**
   * 一个声明了 `required_capabilities` 的工程。
   *
   * @param {string[]} required
   * @returns {string} 工程根。
   */
  function projectRequiring(required) {
    const root = mkdtempSync(join(tmpdir(), 'gac-capability-'))
    mkdirSync(join(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(
      join(root, '.dsh', 'gac', 'project.json'),
      JSON.stringify({
        project: { id: 'capability-demo', title: '能力契约' },
        execution: { required_capabilities: required },
      }),
      'utf8',
    )
    return root
  }

  /**
   * 触发一次「工具调用前」拦截（核对就挂在这条路径上）。
   *
   * @param {object} ctx
   * @param {object} seen
   */
  function emitToolCall(ctx, seen) {
    const listener = seen.listeners.find((entry) => entry.event === 'tools/pre-execute')
    assert.ok(listener !== undefined, 'apply() 必须订阅 tools/pre-execute')
    // 形状要与真实内核一致：会话挂在 `agent.session` 上（`exec.agent.session.id`），不是 `agent` 本身。
    listener.listener({
      name: 'write',
      arguments: { file_path: 'a.c' },
      agent: { session: ctx.sessions.get(SESSION_ID) },
    })
  }

  it('声明的能力不在场时，报告里留下缺项（可见，而不是等收口失败才知道）', async () => {
    const root = projectRequiring(['workspace_observation'])
    const { ctx, seen } = createFakeContext({ provideWorkspaceChanges: false, cwd: root })
    await apply(ctx)
    const mark = readReport().length
    emitToolCall(ctx, seen)

    const check = readReport().slice(mark).filter((record) => record.event === 'capability-check')
    assert.equal(check.length, 1)
    assert.deepEqual(check[0].required, ['workspace_observation'])
    assert.deepEqual(check[0].missing, ['workspace_observation'])
    assert.equal(check[0].ok, false)
  })

  it('能力在场时核对为 ok，且同一个工程只报一次（不刷屏）', async () => {
    const root = projectRequiring(['workspace_observation'])
    const { ctx, seen } = createFakeContext({ workspaceSummary: summary({ cwd: root }), cwd: root })
    await apply(ctx)
    const mark = readReport().length
    emitToolCall(ctx, seen)
    emitToolCall(ctx, seen)

    const check = readReport().slice(mark).filter((record) => record.event === 'capability-check')
    assert.equal(check.length, 1, '每次工具调用都报一遍会把报告刷满')
    assert.deepEqual(check[0].missing, [])
    assert.equal(check[0].ok, true)
  })

  it('要求的子会话接缝不在场时如实报缺 —— 这条映射是真的，不是写死的', async () => {
    // 这个假 ctx 只提供 `workspaceChanges`，没有 `subagents`；所以「原生子会话」这一项必须被判缺。
    const root = projectRequiring(['workspace_observation', 'native_child_dispatch'])
    const { ctx, seen } = createFakeContext({ workspaceSummary: summary({ cwd: root }), cwd: root })
    await apply(ctx)
    const mark = readReport().length
    emitToolCall(ctx, seen)

    const check = readReport().slice(mark).filter((record) => record.event === 'capability-check')
    assert.equal(check.length, 1)
    assert.deepEqual(check[0].missing, ['native_child_dispatch'])
    assert.equal(check[0].ok, false)
  })

  it('没有声明需要的工程不产生这一行 —— 免得报告里全是「不要求任何能力」', async () => {
    const root = makeProject('gac-capability-none-')
    const { ctx, seen } = createFakeContext({ workspaceSummary: summary({ cwd: root }), cwd: root })
    await apply(ctx)
    const mark = readReport().length
    emitToolCall(ctx, seen)

    assert.equal(
      readReport().slice(mark).some((record) => record.event === 'capability-check'),
      false,
    )
  })
})

describe('入口：把每一轮工作区变更记成一条证据', () => {
  it('workspace/changes 事件落成一条工作区观测证据', async () => {
    const root = makeProject('gac-witness-record-')
    const mark = readReport().length
    const { ctx, seen } = createFakeContext({
      workspaceSummary: summary({ cwd: root }),
      cwd: root,
    })
    await apply(ctx)
    emitWorkspaceChanges(ctx, seen)

    // 观测源在场时，加载报告里那条诊断要说 available: true——它是「这一层到底在不在跑」的唯一
    // 入口，说反了比不说更糟。
    const seam = readReport().slice(mark).filter((record) => record.event === 'witness-seam')
    assert.equal(seam.length, 1)
    assert.equal(seam[0].available, true)

    const witness = readEvidence(root).filter((record) => record.tool === WITNESS_SOURCE)
    assert.equal(witness.length, 1)
    assert.equal(witness[0].source, WITNESS_SOURCE)
    assert.equal(witness[0].is_error, false)
    assert.equal(witness[0].session_id, SESSION_ID)
    assert.equal(witness[0].workspace.turn, 3)
    assert.equal(witness[0].workspace.listed, 2)
    // 未声明写作用域时，观测照记，但绝不产出越界结论。
    assert.deepEqual(witness[0].workspace.out_of_scope, [])
    assert.equal(witness[0].workspace.coverage, 'complete')
  })

  it('同一轮事件重复到达时各记一条，观测不合并', async () => {
    // 证据是观测：两次观测就是两条记录。合并会让「这一轮观察到什么」变成一件可以事后改写
    // 的事，而证据的语义正是「当时看到的就是这个」。
    const root = makeProject('gac-witness-repeat-')
    const { ctx, seen } = createFakeContext({
      workspaceSummary: summary({ cwd: root }),
      cwd: root,
    })
    await apply(ctx)
    emitWorkspaceChanges(ctx, seen, { type: 'workspace/changes', seq: 7, data: { turn: 3 } })
    emitWorkspaceChanges(ctx, seen, { type: 'workspace/changes', seq: 8, data: { turn: 4 } })
    assert.equal(
      readEvidence(root).filter((record) => record.tool === WITNESS_SOURCE).length,
      2,
    )
  })

  it('非工作区事件立即返回，不记证据', async () => {
    const bare = makeProject('gac-witness-other-')
    const { ctx, seen } = createFakeContext({
      workspaceSummary: summary({ cwd: bare }),
      cwd: bare,
    })
    await apply(ctx)
    emitWorkspaceChanges(ctx, seen, { type: 'user/message', seq: 3, data: {} })
    assert.deepEqual(readEvidence(bare), [])
  })

  it('未纳管的工程不采集', async () => {
    const bareRoot = makeProject('gac-witness-bare-', { governed: false })
    const { ctx, seen } = createFakeContext({
      workspaceSummary: summary({ cwd: bareRoot }),
      cwd: bareRoot,
    })
    await apply(ctx)
    emitWorkspaceChanges(ctx, seen)
    assert.deepEqual(readEvidence(bareRoot), [])
  })

  it('取不到那一轮的摘要时只写报告，不记证据、不抛错', async () => {
    const alone = makeProject('gac-witness-nosummary-')
    const { ctx, seen } = createFakeContext({
      workspaceSummary: undefined,
      cwd: alone,
    })
    await apply(ctx)
    assert.doesNotThrow(() => emitWorkspaceChanges(ctx, seen))
    // 缺失是**让出几步之后**才下的结论（生产者先发布、后存摘要），所以要等那几步走完再断言。
    await flushDeferred()
    assert.deepEqual(readEvidence(alone), [])
    assert.ok(
      readReport().some((record) => record.event === 'witness-summary-missing'),
      '取不到摘要时必须留下可查的痕迹，而不是安静地什么都不做',
    )
  })

  it('生产者先发布事件、后存摘要时，仍然记下这一轮（真实事故的回归钉）', async () => {
    // 实测踩到的顺序：生产者 `session.append("workspace/changes", …)` 会**同步**发布本事件，而摘要
    // 是在 append 返回**之后**才存进它的记录表。也就是说处理函数第一次读到的必然是空——当时的表现
    // 是加载报告里只有 `witness-summary-missing`（seq 8560），会话日志里那个事件却确实存在。
    // 这条断言的是「等几步之后能读到」，也就是那次事故的修复本身。
    const ordered = makeProject('gac-witness-ordered-')
    const { ctx, seen } = createFakeContext({
      workspaceSummary: summary({ cwd: ordered, turn: 35 }),
      summaryLate: true,
      cwd: ordered,
    })
    await apply(ctx)
    const mark = readReport().length
    emitWorkspaceChanges(ctx, seen, { type: 'workspace/changes', seq: 8560, data: { turn: 35 } })
    // 摘要要等一个宏任务才就绪；等待期间**不能**被记成缺失。
    assert.equal(
      readReport().slice(mark).some((record) => record.event === 'witness-summary-missing'),
      false,
      '还在等的时候不该下「缺失」的结论',
    )
    await flushDeferred()

    const mine = readReport().slice(mark)
    assert.ok(
      mine.some((record) => record.event === 'witness-turn'),
      '等到摘要就绪之后必须留下 witness-turn，而不是把这一轮算成缺失',
    )
    assert.equal(
      mine.some((record) => record.event === 'witness-summary-missing'),
      false,
      '摘要只是晚一步，不该被记成缺失',
    )
    assert.equal(readEvidence(ordered).length, 1, '这一轮必须真的落一条证据')
  })

  it('workspaceChanges 服务缺席时插件照常加载，事件到达也不抛错', async () => {
    // 这条不是假想：本机 profile 里 dsh-workspace-changes 没有被装配进 bundles，因此这个服务
    // 目前就是缺席的。把它写进 inject 列表会让整个插件（连同写作用域闸门）不加载——拿一道
    // 强制执行去换一个可选的观测源，方向反了。
    const mark = readReport().length
    const { ctx, seen } = createFakeContext({ provideWorkspaceChanges: false, cwd: tempHome })
    await apply(ctx)
    assert.deepEqual(
      seen.injections.filter((entry) => entry.deps.includes('workspaceChanges')).length,
      1,
      '应当以 inject 的方式尝试这个可选依赖',
    )
    // 闸门必须在场：丢一段观测绝不能以丢掉一道强制执行为代价。
    assert.ok(seen.listeners.some((entry) => entry.event === 'tools/pre-execute'))
    assert.doesNotThrow(() => emitWorkspaceChanges(ctx, seen))

    // 诊断必须在**服务缺席**时也留下：inject 的回调此时根本不会执行，所以只把它写在回调里
    // 等于在最该出现的时候消失。实测踩到过——加载报告里 210 条 plugin-loaded、0 条 witness-seam。
    const seam = readReport().slice(mark).filter((record) => record.event === 'witness-seam')
    assert.equal(seam.length, 1)
    assert.equal(seam[0].available, false)
  })

  it('每条记录都留下 witness-turn，报告里能核对到这一轮', async () => {
    const turnRoot = makeProject('gac-witness-turn-')
    const { ctx, seen } = createFakeContext({
      workspaceSummary: summary({ cwd: turnRoot, turn: 11 }),
      cwd: turnRoot,
    })
    await apply(ctx)
    emitWorkspaceChanges(ctx, seen, { type: 'workspace/changes', seq: 5, data: { turn: 11 } })
    const turns = readReport().filter((record) => record.event === 'witness-turn')
    assert.ok(turns.length >= 1)
    assert.equal(turns[turns.length - 1].turn, 11)
  })
})
