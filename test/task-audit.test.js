/**
 * 任务审计视图：从已落盘的产物与追加日志里派生，而不是新建一份存储。
 *
 * 这个文件钉住三件审计才看得见的事：**时间线**（日志本身只有一串事件，没有「任务视图」）、
 * **产物之间的身份核对**（验证/复核报告写的是不是**当前**那份计划——单看任何一份产物都发现不了，
 * 每一份自己都是合法的），以及**把缺口说出来**（缺什么、什么没冻、哪条引用的证据号不存在）。
 * 一句「一切正常」如果是从「读不到就当没有」推出来的，比不说更坏，所以缺口必须来自**读到的东西**。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { composeTaskAudit } from '../lib/task-audit.js'
import { compileTask, deserializeTask, serializeTask } from '../lib/coordinator.js'
import {
  compileDesignApproval,
  compileDesignArtifact,
  compileDesignPackage,
  deepFreezeDesign,
  designId,
  freezeDesign,
} from '../lib/design.js'
import { planId } from '../lib/verification.js'

/**
 * 一个四节点的任务（设计/实现/验证执行/复核），全部完成。
 *
 * @returns {object}
 */
function task() {
  return compileTask({
    task_id: 'REQ-AUDIT',
    mode: 'high_risk_task',
    created_at: 1,
    nodes: [
      {
        id: 'D1',
        objective: '设计方案',
        required_capabilities: ['verification'],
        write_scope: [],
        role: 'verification_design',
      },
      {
        id: 'I1',
        objective: '实现',
        required_capabilities: ['implementation'],
        write_scope: ['src/'],
        depends_on: ['D1'],
      },
      {
        id: 'V1',
        objective: '执行验证',
        required_capabilities: ['verification'],
        write_scope: [],
        depends_on: ['I1'],
        role: 'verification_execution',
      },
      {
        id: 'R1',
        objective: '复核',
        required_capabilities: ['review'],
        write_scope: [],
        depends_on: ['V1'],
        role: 'review',
      },
    ],
  })
}

/**
 * 把任务里每个节点标成已完成（审计只读状态，不需要真的跑）。
 *
 * @param {object} compiled
 * @returns {object}
 */
function completed(compiled) {
  const raw = serializeTask(compiled)
  for (const node of raw.nodes) node.status = 'completed'
  raw.status = 'completed'
  // 用 `deserializeTask` 而不是 `compileTask`：后者会把状态一律重置成 `pending`（状态是**恢复**出来的，
  // 不是编译出来的）。这个差别正是「任务记录重载之后状态还在不在」那条测试守着的。
  return deserializeTask(raw, '<test>')
}

/** 一份计划：两条用例覆盖一条标准。 */
const PLAN = {
  schema_version: 1,
  criteria: ['AC1'],
  frozen_at: 100,
  cases: [
    { id: 'C1', covers: ['AC1'], type: 'positive', expect: '文件存在' },
    { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '文件缺失应当判失败' },
  ],
}

/**
 * 一份四份产物齐、追溯覆盖 AC1 的设计包。
 *
 * @param {readonly string[]} [criteria]
 * @returns {object}
 */
function designPackage(criteria = ['AC1']) {
  const artifact = (name, content) => compileDesignArtifact(
    { artifact: name, content, traceability: criteria.map((id) => ({ criteria: id, where: '§1' })) },
    { childSessionId: `design-child-${name}`, createdAt: 1 },
  )
  return compileDesignPackage({
    task_id: 'REQ-AUDIT',
    requirement_ref: 'requirement-abc',
    interface_contract_ref: 'contract-abc',
    artifacts: {
      software_architecture: artifact('software_architecture', '架构：一个模块。'),
      software_detail: artifact('software_detail', '详设：一个函数。'),
      test_architecture: artifact('test_architecture', '测试架构：两条用例。'),
      test_detail: artifact('test_detail', '测试详设：正例与反例各一。'),
    },
    requirement_traceability: criteria.map((id) => ({ criteria: id, artifact: 'software_detail' })),
    consistency_result: { ok: true, conflicts: [] },
    unresolved_issues: [],
  }, { criteria, frozenAt: 1 })
}

/** 冻好的设计包（盘上那一份的样子）。 */
const DESIGN = deepFreezeDesign(designPackage())

/**
 * 一份针对某份设计作出的裁决。
 *
 * @param {string} [decision]
 * @param {string} [against] - 裁决挂在哪一份设计上（默认当前这一份）。
 * @returns {object}
 */
function approvalFor(decision = 'approved', against = designId(DESIGN)) {
  return compileDesignApproval({ decision, reason: '审计用例' }, { designId: against, sessionId: 'session-1', at: 2 })
}

/** 一份齐备的输入。 */
function complete() {
  return {
    task: completed(task()),
    grilling: { acceptance_criteria: ['AC1'], frozen_at: 50, confirmed_by_user: true },
    contract: { name: 'demo', operations: [{ name: 'op' }] },
    plan: PLAN,
    verification: {
      plan_id: planId(PLAN),
      executions: [
        { case_id: 'C1', outcome: 'passed', evidence_ref: 'ev-1' },
        { case_id: 'C2', outcome: 'passed', evidence_ref: 'ev-2' },
      ],
    },
    review: {
      reviewed_plan_id: planId(PLAN),
      blocking_issues: [],
      evidence: ['ev-3#明细'],
    },
    events: [
      { at: 10, type: 'gac/task-created', data: { task_id: 'REQ-AUDIT', mode: 'high_risk_task' } },
      { at: 20, type: 'gac/node-dispatched', data: { task_id: 'REQ-AUDIT', node_id: 'D1', attempt: 1, dispatch_id: 'REQ-AUDIT-D1-A1' } },
      { at: 30, type: 'gac/node-reported', data: { task_id: 'REQ-AUDIT', node_id: 'D1', status: 'completed', classification: 'accepted' } },
      { at: 40, type: '别的插件的/事件', data: { task_id: 'REQ-AUDIT' } },
    ],
    issuedEvidence: ['ev-1', 'ev-2', 'ev-3'],
    planIdOf: planId,
    contractRequired: true,
    reviewRequired: true,
    designRequired: true,
    design: DESIGN,
    designApproval: approvalFor(),
  }
}

describe('审计视图：齐全的链条', () => {
  it('报出各产物的身份，且没有缺口', () => {
    const audit = composeTaskAudit(complete())

    assert.equal(audit.ok, true)
    assert.deepEqual(audit.gaps, [])
    assert.equal(audit.artifacts.requirement_frozen, true)
    assert.equal(audit.artifacts.acceptance_criteria, 1)
    assert.equal(audit.artifacts.plan, planId(PLAN))
    assert.equal(audit.artifacts.plan_cases, 2)
    assert.equal(audit.artifacts.plan_falsification, 1)
    assert.equal(audit.artifacts.verification_executions, 2)
    assert.equal(audit.artifacts.review, planId(PLAN))
    assert.equal(audit.artifacts.evidence_issued, 3)
    assert.equal(audit.artifacts.design, designId(DESIGN))
    assert.equal(audit.artifacts.design_approved, true)
    assert.equal(audit.nodes.length, 4)
  })

  it('时间线按日志顺序讲一遍，认不出的事件类型原样报出', () => {
    const audit = composeTaskAudit(complete())

    assert.equal(audit.timeline.length, 4)
    assert.match(audit.timeline[1].summary, /派遣 D1（第 1 次，REQ-AUDIT-D1-A1）/u)
    assert.match(audit.timeline[2].summary, /D1 回报 completed（accepted）/u)
    assert.equal(audit.timeline[3].summary, '别的插件的/事件')
  })
})

describe('审计视图：缺口必须说出来', () => {
  it('有计划但缺验证报告与复核报告，各自点名', () => {
    const input = complete()
    const audit = composeTaskAudit({ ...input, verification: undefined, review: undefined })

    assert.equal(audit.ok, false)
    assert.equal(audit.gaps.some((gap) => /没有验证报告/u.test(gap)), true)
    assert.equal(audit.gaps.some((gap) => /要求独立复核报告/u.test(gap)), true)
  })

  it('**一个根因只报一次**：连计划都没有时，不再把「缺验证报告」重复数一遍', () => {
    // 没有计划就没有可执行的用例，缺报告是它的后果而不是第二个独立缺口。审计的价值在指向根因，
    // 不在把同一个根因换几种说法凑数——那会让「发现 5 个缺口」这种读数失去意义。
    const input = complete()
    const audit = composeTaskAudit({ ...input, plan: undefined, verification: undefined, review: undefined })

    assert.equal(audit.gaps.some((gap) => /没有验证计划/u.test(gap)), true)
    assert.equal(audit.gaps.some((gap) => /没有验证报告/u.test(gap)), false)
  })

  it('计划没了而报告还在时，报告被标成「对不上当前计划」—— 那两份报告自己都还是合法的', () => {
    const input = complete()
    const audit = composeTaskAudit({ ...input, plan: undefined })

    assert.equal(audit.gaps.some((gap) => /验证报告对不上当前计划/u.test(gap)), true)
    assert.equal(audit.gaps.some((gap) => /复核报告审的不是当前计划/u.test(gap)), true)
  })

  it('需求没冻结 / 验收标准为空，是两种不同的缺口', () => {
    const noFreeze = composeTaskAudit({ ...complete(), grilling: undefined })
    assert.equal(noFreeze.gaps.some((gap) => /需求未冻结/u.test(gap)), true)

    const emptyCriteria = composeTaskAudit({
      ...complete(),
      grilling: { acceptance_criteria: [], frozen_at: 50 },
    })
    assert.equal(emptyCriteria.gaps.some((gap) => /验收标准为空/u.test(gap)), true)
  })

  it('计划里没有反例要单独说 —— 只有正例证明不了「错误实现会被抓住」', () => {
    const onlyPositive = {
      ...PLAN,
      cases: [{ id: 'C1', covers: ['AC1'], type: 'positive', expect: '文件存在' }],
    }
    const audit = composeTaskAudit({
      ...complete(),
      plan: onlyPositive,
      verification: {
        plan_id: planId(onlyPositive),
        executions: [{ case_id: 'C1', outcome: 'passed', evidence_ref: 'ev-1' }],
      },
      review: { reviewed_plan_id: planId(onlyPositive), blocking_issues: [], evidence: [] },
    })

    assert.equal(audit.gaps.some((gap) => /没有反例/u.test(gap)), true)
  })

  it('用例没执行、没通过，都点名', () => {
    const input = complete()
    const audit = composeTaskAudit({
      ...input,
      verification: {
        plan_id: planId(PLAN),
        executions: [{ case_id: 'C1', outcome: 'failed', evidence_ref: 'ev-1' }],
      },
    })

    assert.equal(audit.gaps.some((gap) => /这些用例没有执行结论：C2/u.test(gap)), true)
    assert.equal(audit.gaps.some((gap) => /这些用例没通过：C1\(failed\)/u.test(gap)), true)
  })

  it('节点没完成要点名', () => {
    const audit = composeTaskAudit({ ...complete(), task: task() })

    assert.equal(audit.gaps.some((gap) => /这些节点没有完成/u.test(gap)), true)
  })
})

describe('审计视图：设计门禁的缺口要分辨「没做出来」与「做出来没人批」', () => {
  it('要求设计却没有设计包，点名', () => {
    const audit = composeTaskAudit({ ...complete(), design: undefined, designApproval: undefined })
    assert.equal(audit.ok, false)
    assert.equal(audit.gaps.some((gap) => /没有冻结的设计包/u.test(gap)), true)
    assert.equal(audit.artifacts.design, null)
    assert.equal(audit.artifacts.design_approved, null)
  })

  it('设计冻了但没有裁决，与「没有设计包」是两条不同的缺口', () => {
    const audit = composeTaskAudit({ ...complete(), designApproval: undefined })
    assert.equal(audit.gaps.some((gap) => /已冻结但还没有任何裁决/u.test(gap)), true)
    assert.equal(audit.gaps.some((gap) => /没有冻结的设计包/u.test(gap)), false)
  })

  it('裁决是「请求修订」时如实记下决定与理由', () => {
    const audit = composeTaskAudit({ ...complete(), designApproval: approvalFor('revision_requested') })
    assert.equal(audit.gaps.some((gap) => /裁决是 revision_requested/u.test(gap)), true)
    assert.equal(audit.artifacts.design_approved, false)
  })

  it('批准挂在另一版设计上时算失效，而不是算批准', () => {
    const other = deepFreezeDesign(designPackage(['AC1', 'AC2']))
    const audit = composeTaskAudit({
      ...complete(),
      designApproval: approvalFor('approved', designId(other)),
    })
    assert.equal(audit.gaps.some((gap) => /设计批准已失效/u.test(gap)), true)
  })

  it('不要求设计的模式不报设计缺口', () => {
    const audit = composeTaskAudit({ ...complete(), designRequired: false, design: undefined, designApproval: undefined })
    assert.equal(audit.gaps.some((gap) => /设计/u.test(gap)), false)
  })

  it('复核对象进链条：缺省是实现，也可以记成设计', () => {
    assert.equal(composeTaskAudit(complete()).artifacts.review_subject, 'implementation')
    const input = complete()
    const audit = composeTaskAudit({ ...input, review: { ...input.review, subject: 'design' } })
    assert.equal(audit.artifacts.review_subject, 'design')
  })
})

describe('审计视图：单看一份产物发现不了的错配', () => {
  it('验证报告对不上当前计划 —— 两份自己都合法，配在一起才是错的', () => {
    const input = complete()
    const audit = composeTaskAudit({
      ...input,
      verification: { ...input.verification, plan_id: 'plan-00000000' },
    })

    assert.equal(audit.gaps.some((gap) => /验证报告对不上当前计划/u.test(gap)), true)
  })

  it('复核报告审的不是当前计划', () => {
    const input = complete()
    const audit = composeTaskAudit({
      ...input,
      review: { ...input.review, reviewed_plan_id: 'plan-00000000' },
    })

    assert.equal(audit.gaps.some((gap) => /复核报告审的不是当前计划/u.test(gap)), true)
  })

  it('引用了运行时从未签发过的证据号 —— 收口之后也能查出来', () => {
    const input = complete()
    const audit = composeTaskAudit({
      ...input,
      verification: {
        plan_id: planId(PLAN),
        executions: [
          { case_id: 'C1', outcome: 'passed', evidence_ref: 'ev-999' },
          { case_id: 'C2', outcome: 'passed', evidence_ref: 'ev-2' },
        ],
      },
      review: { ...input.review, evidence: ['ev-888#明细'] },
    })

    assert.equal(audit.gaps.some((gap) => /运行时从未签发过：ev-999/u.test(gap)), true)
    assert.equal(audit.gaps.some((gap) => /复核引用的证据号里有运行时从未签发过的：ev-888/u.test(gap)), true)
  })

  it('复核留下阻塞问题要点名数量', () => {
    const input = complete()
    const audit = composeTaskAudit({
      ...input,
      review: { ...input.review, blocking_issues: ['验证方法有洞'] },
    })

    assert.equal(audit.gaps.some((gap) => /复核留下 1 个阻塞问题/u.test(gap)), true)
  })

  it('要求契约却没冻，要点名', () => {
    const audit = composeTaskAudit({ ...complete(), contract: undefined })

    assert.equal(audit.gaps.some((gap) => /要求接口契约/u.test(gap)), true)
  })
})

describe('审计视图：文本给人看', () => {
  it('齐全时写「未发现缺口」，缺的时候逐条列出来', () => {
    const ok = composeTaskAudit(complete())
    assert.match(ok.text, /未发现缺口/u)
    assert.match(ok.text, /运行时签发过的证据：3 条/u)

    const broken = composeTaskAudit({ ...complete(), plan: undefined })
    assert.match(broken.text, /发现 3 个缺口/u)
    assert.match(broken.text, /- 没有验证计划/u)
  })
})
