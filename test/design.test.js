/**
 * 设计包：把需求翻译成「可以照着实现、也可以照着验证」的那份记录。
 *
 * 这个文件钉住的是**能被机器判定的那一半**：身份从内容算出来、引用对不对、四份产物齐不齐、追溯有没有
 * 缺口、需求与契约引用有没有串版。判不了的那一半（详设有没有引入架构未声明的组件、测试设计是否真的
 * 独立于实现）刻意不在这里——一条判不准的规则会给一份其实不成立的设计盖上「已核对」的章。
 *
 * 三个角色的越界也是这里钉的：软件设计专家不去写测试架构、测试设计专家不去写软件详设。两个角色都不写
 * 文件，它们的**唯一**产出就是那几份产物，所以越界产出必须被拒——不然「角色」又退化成一个标签。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DESIGN_ARTIFACTS,
  DESIGN_CODES,
  DESIGN_DECISIONS,
  DesignError,
  artifactKeyForRole,
  compileDesignApproval,
  compileDesignArtifact,
  compileDesignPackage,
  deepFreezeDesign,
  designId,
  evaluateDesignApproval,
  evaluateDesignPackage,
  freezeDesign,
  isFrozenDesign,
  reviewSubjectOf,
  roleMayAuthorArtifact,
  sameDesign,
} from '../lib/design.js'

/**
 * 编译一份产物。
 *
 * @param {string} name
 * @param {string} [content]
 * @param {object[]} [traceability]
 * @returns {object}
 */
function artifact(name, content = `${name} 的正文`, traceability = [{ criteria: 'AC1', where: '§1' }]) {
  return compileDesignArtifact({ artifact: name, content, traceability })
}

/**
 * 四份产物齐了的集合。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function fourArtifacts(overrides = {}) {
  return {
    software_architecture: artifact('software_architecture'),
    software_detail: artifact('software_detail'),
    test_architecture: artifact('test_architecture'),
    test_detail: artifact('test_detail'),
    ...overrides,
  }
}

/**
 * 编译一份设计包（默认四份齐、追溯完整、需求与契约引用都对得上）。
 *
 * @param {object} [raw]
 * @param {object} [options]
 * @returns {object}
 */
function build(raw = {}, options = {}) {
  return compileDesignPackage({
    task_id: 'REQ-1',
    requirement_ref: 'requirement-abc',
    artifacts: fourArtifacts(),
    requirement_traceability: [
      { criteria: 'AC1', artifact: 'software_architecture' },
      { criteria: 'AC1', artifact: 'software_detail' },
      { criteria: 'AC1', artifact: 'test_architecture' },
      { criteria: 'AC1', artifact: 'test_detail' },
    ],
    ...raw,
  }, {
    criteria: ['AC1'],
    requirementId: 'requirement-abc',
    ...options,
  })
}

describe('设计产物：身份从正文算出来', () => {
  it('正文改一个字，引用就变', () => {
    const before = artifact('software_detail', '接口 A 返回配置')
    const after = artifact('software_detail', '接口 A 返回配置。')
    assert.notEqual(before.ref, after.ref)
    assert.equal(before.hash, before.ref.replace('artifact-', ''))
  })

  it('同一份正文编两次，身份相同', () => {
    assert.equal(artifact('software_detail', '同样的正文').ref, artifact('software_detail', '同样的正文').ref)
  })

  it('产物名不在闭集内被拒，并给出可分支的 code', () => {
    assert.throws(
      () => compileDesignArtifact({ artifact: 'api_design', content: '正文' }),
      (error) => error instanceof DesignError && error.code === DESIGN_CODES.UNKNOWN_ARTIFACT,
    )
  })

  it('空正文与缺 where 的追溯项都被拒', () => {
    assert.throws(
      () => compileDesignArtifact({ artifact: 'software_detail', content: '   ' }),
      (error) => error.code === DESIGN_CODES.MALFORMED,
    )
    assert.throws(
      () => compileDesignArtifact({
        artifact: 'software_detail',
        content: '正文',
        traceability: [{ criteria: 'AC1' }],
      }),
      (error) => error.code === DESIGN_CODES.MALFORMED,
    )
  })

  it('产出它的子会话由运行时盖章，不是自报', () => {
    const stamped = compileDesignArtifact(
      { artifact: 'software_detail', content: '正文' },
      { childSessionId: 'child-session-9' },
    )
    assert.equal(stamped.author_child_session_id, 'child-session-9')
    assert.equal(artifact('software_detail').author_child_session_id, null)
  })

  it('角色只能产出它那两份产物', () => {
    assert.equal(roleMayAuthorArtifact('software_design', 'software_architecture'), true)
    assert.equal(roleMayAuthorArtifact('software_design', 'test_detail'), false)
    assert.equal(roleMayAuthorArtifact('test_design', 'test_detail'), true)
    assert.equal(roleMayAuthorArtifact('test_design', 'software_detail'), false)
    assert.equal(roleMayAuthorArtifact('implementation', 'software_detail'), false)
    assert.equal(artifactKeyForRole('software_design', 'architecture'), 'software_architecture')
    assert.equal(artifactKeyForRole('test_design', 'detail'), 'test_detail')
    assert.equal(artifactKeyForRole('software_design', '不存在的阶段'), undefined)
  })
})

describe('设计包：四份齐了才算一份设计', () => {
  it('缺一份就拒，并指名缺哪份', () => {
    const artifacts = fourArtifacts()
    delete artifacts.test_detail
    assert.throws(
      () => build({ artifacts }),
      (error) => error.code === DESIGN_CODES.INCOMPLETE && error.detail.missing.includes('test_detail'),
    )
  })

  it('某一位上放错了产物被拒', () => {
    assert.throws(
      () => build({ artifacts: fourArtifacts({ software_detail: artifact('software_architecture') }) }),
      (error) => error.code === DESIGN_CODES.MALFORMED,
    )
  })

  it('正文被改过（引用与正文对不上）被拒', () => {
    // 伪造：把正文换掉却保留原来的 ref/hash——这正是「设计被就地改写」的样子。
    const tampered = { ...artifact('software_detail'), content: '偷偷换掉的正文' }
    assert.throws(
      () => build({ artifacts: fourArtifacts({ software_detail: tampered }) }),
      (error) => error.code === DESIGN_CODES.ARTIFACT_MISMATCH,
    )
  })

  it('验收标准在设计里找不到归属就拒', () => {
    assert.throws(
      () => build({}, { criteria: ['AC1', 'AC2'] }),
      (error) => error.code === DESIGN_CODES.TRACEABILITY_GAP && error.detail.uncovered.includes('AC2'),
    )
  })

  it('追溯项指向不存在的产物被拒', () => {
    assert.throws(
      () => build({ requirement_traceability: [{ criteria: 'AC1', artifact: 'api_design' }] }),
      (error) => error.code === DESIGN_CODES.UNKNOWN_ARTIFACT,
    )
  })

  it('未解决的问题必须写明理由，否则被拒', () => {
    assert.throws(
      () => build({ unresolved_issues: [{ issue: '并发写没有定序' }] }),
      (error) => error.code === DESIGN_CODES.UNRESOLVED_ISSUES,
    )
    const withReason = build({
      unresolved_issues: [{ issue: '并发写没有定序', reason: '本任务只有一个写者' }],
    })
    assert.equal(withReason.unresolved_issues.length, 1)
  })

  it('需求换了版本，引用旧需求的设计被拒', () => {
    assert.throws(
      () => build({ requirement_ref: 'requirement-old' }),
      (error) => error.code === DESIGN_CODES.REQUIREMENT_MISMATCH,
    )
  })

  it('契约引用串了版，一致性核对记下冲突（而不是当成没问题）', () => {
    const pkg = build({ interface_contract_ref: 'contract-old' }, { contractId: 'contract-new' })
    assert.equal(pkg.consistency_result.ok, false)
    assert.equal(pkg.consistency_result.conflicts.length, 1)
    assert.match(pkg.consistency_result.conflicts[0], /contract-old/u)
  })

  it('架构承诺了某条验收标准、详设里却没有，记下冲突', () => {
    const pkg = build({
      artifacts: fourArtifacts({
        software_architecture: artifact('software_architecture', '架构', [
          { criteria: 'AC1', where: '§1' },
          { criteria: 'AC2', where: '§2' },
        ]),
      }),
    }, { criteria: ['AC1'] })
    assert.equal(pkg.consistency_result.ok, false)
    assert.match(pkg.consistency_result.conflicts[0], /software_architecture 承诺了 AC2/u)
  })
})

describe('设计身份：改写即换身份，重排不算改写', () => {
  it('frozen_at 不进身份', () => {
    const early = build({}, { frozenAt: 1 })
    const late = build({}, { frozenAt: 999 })
    assert.equal(designId(early), designId(late))
  })

  it('正文改一个字，设计身份就变', () => {
    const before = build()
    const after = build({ artifacts: fourArtifacts({ test_detail: artifact('test_detail', '另一份测试详设') }) })
    assert.notEqual(designId(before), designId(after))
    assert.equal(sameDesign(before, after), false)
    assert.equal(sameDesign(before, build()), true)
  })

  it('追溯项顺序不影响身份（顺序不携带语义）', () => {
    const two = [
      { criteria: 'AC1', artifact: 'software_architecture' },
      { criteria: 'AC2', artifact: 'software_detail' },
    ]
    const forward = build({ requirement_traceability: two }, { criteria: ['AC1', 'AC2'] })
    const reversed = build({ requirement_traceability: [...two].reverse() }, { criteria: ['AC1', 'AC2'] })
    assert.equal(designId(forward), designId(reversed))
  })

  it('设计 id 带前缀，便于一眼看出它是什么引用', () => {
    assert.match(designId(build()), /^design-[0-9a-f]{8}$/u)
  })
})

describe('设计冻结：同一份是 unchanged，换一份是拒绝', () => {
  it('没有旧的就冻结', () => {
    const pkg = build()
    const result = freezeDesign(pkg, undefined)
    assert.equal(result.status, 'frozen')
    assert.equal(result.id, designId(pkg))
  })

  it('同一份内容重复提交是 unchanged', () => {
    assert.equal(freezeDesign(build(), build()).status, 'unchanged')
  })

  it('换一份内容来覆盖是拒绝，并同时报出两个 id', () => {
    const existing = build()
    const proposed = build({ artifacts: fourArtifacts({ software_detail: artifact('software_detail', '改过的详设') }) })
    assert.throws(
      () => freezeDesign(proposed, existing),
      (error) => error.code === DESIGN_CODES.ALREADY_FROZEN
        && error.detail.expected === designId(existing)
        && error.detail.proposed === designId(proposed),
    )
  })

  it('冻结形状可判定', () => {
    assert.equal(isFrozenDesign(build()), true)
    assert.equal(isFrozenDesign(undefined), false)
    assert.equal(isFrozenDesign({ schema_version: 1 }), false)
  })

  it('深冻结把正文与追溯表一起冻住', () => {
    const pkg = deepFreezeDesign(build())
    assert.equal(Object.isFrozen(pkg), true)
    assert.equal(Object.isFrozen(pkg.artifacts.software_detail), true)
    assert.equal(Object.isFrozen(pkg.artifacts.software_detail.traceability), true)
    assert.equal(Object.isFrozen(pkg.requirement_traceability), true)
    assert.equal(Object.isFrozen(pkg.consistency_result), true)
  })
})

describe('设计包校验：返回逐条违规，而不是一个布尔', () => {
  it('完整的设计包没有违规', () => {
    const result = evaluateDesignPackage(build(), { criteria: ['AC1'], requirementId: 'requirement-abc' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.ok, true)
    assert.match(result.design_id, /^design-/u)
  })

  it('不是设计包时如实报结构不成立，而不是假装核对通过', () => {
    const result = evaluateDesignPackage({ task_id: 'REQ-1' })
    assert.equal(result.ok, false)
    assert.equal(result.violations[0].code, DESIGN_CODES.MALFORMED)
    assert.equal(result.design_id, undefined)
  })

  it('正文被改过、追溯有缺口、需求串版都逐条报出来', () => {
    const pkg = build()
    const tampered = {
      ...pkg,
      artifacts: { ...pkg.artifacts, test_detail: { ...pkg.artifacts.test_detail, content: '换过的正文' } },
      requirement_ref: 'requirement-old',
    }
    const codes = evaluateDesignPackage(tampered, { criteria: ['AC1', 'AC2'], requirementId: 'requirement-abc' })
      .violations.map((entry) => entry.code)
    assert.ok(codes.includes(DESIGN_CODES.ARTIFACT_MISMATCH))
    assert.ok(codes.includes(DESIGN_CODES.TRACEABILITY_GAP))
    assert.ok(codes.includes(DESIGN_CODES.REQUIREMENT_MISMATCH))
  })

  it('四份产物名是一个固定闭集', () => {
    assert.deepEqual([...DESIGN_ARTIFACTS], [
      'software_architecture',
      'software_detail',
      'test_architecture',
      'test_detail',
    ])
  })
})

describe('设计裁决：批准是主会话的一次判断，不是设计自报', () => {
  it('裁决记下决定、理由与签发者', () => {
    const approval = compileDesignApproval(
      { decision: 'approved', reason: '逐条核对过' },
      { designId: 'design-abc', sessionId: 'main-1', at: 7 },
    )
    assert.equal(approval.design_id, 'design-abc')
    assert.equal(approval.decision, 'approved')
    assert.equal(approval.reason, '逐条核对过')
    assert.equal(approval.decided_by_session_id, 'main-1')
    assert.equal(approval.decided_at, 7)
    assert.equal(Object.isFrozen(approval), true)
  })

  it('三种决定是一个固定闭集', () => {
    assert.deepEqual([...DESIGN_DECISIONS], ['approved', 'revision_requested', 'escalated'])
  })

  it('决定不在闭集、理由空白、没指名设计都被拒', () => {
    assert.throws(
      () => compileDesignApproval({ decision: 'looks_good', reason: 'r' }, { designId: 'design-abc' }),
      (error) => error instanceof DesignError && error.code === DESIGN_CODES.MALFORMED,
    )
    assert.throws(
      () => compileDesignApproval({ decision: 'approved', reason: '   ' }, { designId: 'design-abc' }),
      (error) => error.code === DESIGN_CODES.MALFORMED,
    )
    assert.throws(
      () => compileDesignApproval({ decision: 'approved', reason: 'r' }, {}),
      (error) => error.code === DESIGN_CODES.MALFORMED,
    )
    assert.throws(
      () => compileDesignApproval(undefined, { designId: 'design-abc' }),
      (error) => error.code === DESIGN_CODES.MALFORMED,
    )
  })

  it('没有人裁决过就是没批准', () => {
    const result = evaluateDesignApproval(undefined, build())
    assert.equal(result.ok, false)
    assert.equal(result.violations[0].code, DESIGN_CODES.NOT_APPROVED)
  })

  it('批准的是另一版设计时算过期，而不是算批准', () => {
    const design = build()
    const other = build({ artifacts: fourArtifacts({ test_detail: artifact('test_detail', '改过的测试详设') }) })
    const stale = compileDesignApproval(
      { decision: 'approved', reason: 'r' },
      { designId: designId(other) },
    )
    const result = evaluateDesignApproval(stale, design)
    assert.equal(result.ok, false)
    assert.equal(result.violations[0].code, DESIGN_CODES.STALE_APPROVAL)
    assert.equal(result.violations[0].detail.approved, designId(other))
    assert.equal(result.violations[0].detail.current, designId(design))
  })

  it('请求修订与升级给用户都不是批准，且各自留得下痕迹', () => {
    const design = build()
    for (const decision of ['revision_requested', 'escalated']) {
      const approval = compileDesignApproval({ decision, reason: 'r' }, { designId: designId(design) })
      const result = evaluateDesignApproval(approval, design)
      assert.equal(result.ok, false)
      assert.equal(result.violations[0].code, DESIGN_CODES.NOT_APPROVED)
      assert.equal(result.violations[0].detail.decision, decision)
    }
  })

  it('对上了当前这一版就是批准', () => {
    const design = build()
    const approval = compileDesignApproval({ decision: 'approved', reason: 'r' }, { designId: designId(design) })
    assert.deepEqual(evaluateDesignApproval(approval, design), { ok: true, violations: [] })
  })
})

describe('复核对象：由节点声明的产物判定', () => {
  it('点名了设计产物的节点复核的是设计', () => {
    assert.equal(reviewSubjectOf({ expected_artifacts: ['design_package'] }), 'design')
    assert.equal(reviewSubjectOf({ expected_artifacts: ['software_detail'] }), 'design')
    assert.equal(reviewSubjectOf({ expected_artifacts: ['Patch', 'test_architecture'] }), 'design')
  })

  it('没点名设计的节点复核的是这次实现（缺省不是无害的，是默认这一种）', () => {
    assert.equal(reviewSubjectOf({ expected_artifacts: ['Patch'] }), 'implementation')
    assert.equal(reviewSubjectOf({ expected_artifacts: [] }), 'implementation')
    assert.equal(reviewSubjectOf(undefined), 'implementation')
  })
})
