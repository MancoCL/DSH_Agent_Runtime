/**
 * 语义角色与角色专属结果契约。
 *
 * 为什么要与能力名分开
 * ------------------
 * `required_capabilities` 决定「谁来做」（执行者路由），`role` 决定「做什么、产物是什么、受哪道
 * 门禁管」。同一个 `verification` 能力：`verification_design` 产出**验证计划**（它就是计划作者），
 * `verification_execution` 执行**已冻结的计划**并产出逐条结论。真实 `REQ-HR-1` 里这两件事被混成
 * 一件，于是父会话先替设计节点写好计划再派它出去——语义是倒置的。
 *
 * 这个文件钉住两条最容易出事的性质：**缺省推断永远不会给出 `verification_design`**（那条角色带着
 * 「可以没有计划就开工」的豁免，靠推断给出豁免等于让没声明角色的验证节点悄悄绕过门禁），以及
 * **四个角色的产出契约各自要求该给的字段**。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CHILD_OUTPUT_SCHEMAS, buildChildPrompt, childOutputSchemaFor } from '../lib/child-executor.js'
import { CoordinatorError, NODE_ROLES, compileTask, nodeRoleOf } from '../lib/coordinator.js'

/**
 * 造一个最小节点。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function node(overrides = {}) {
  return {
    id: 'T1',
    objective: '做事',
    required_capabilities: ['implementation'],
    write_scope: ['src/'],
    ...overrides,
  }
}

describe('语义角色：能力名不是角色', () => {
  it('显式声明的角色被采纳', () => {
    assert.equal(nodeRoleOf(node({ role: 'verification_design' })), 'verification_design')
    for (const role of NODE_ROLES) {
      assert.equal(nodeRoleOf(node({ role })), role)
    }
  })

  it('词表之外的角色被拒，并给出可分支的 code', () => {
    assert.throws(
      () => nodeRoleOf(node({ role: 'architect' })),
      (error) => error instanceof CoordinatorError && error.code === 'GAC_NODE_ROLE_UNKNOWN',
    )
    assert.throws(() => nodeRoleOf(node({ role: 42 })), CoordinatorError)
  })

  it('缺省按能力推断 —— 而且**永远不会**推断成 verification_design', () => {
    // 这条是安全性质，不是风格：`verification_design` 带着「可以没有冻结计划就开工」的豁免。
    // 若靠推断给出它，一个**没声明角色**的验证节点就会悄悄绕过计划门禁。
    assert.equal(nodeRoleOf(node({ required_capabilities: ['verification'] })), 'verification_execution')
    assert.equal(nodeRoleOf(node({ required_capabilities: ['review'] })), 'review')
    assert.equal(nodeRoleOf(node({ required_capabilities: ['implementation'] })), 'implementation')
    assert.equal(nodeRoleOf(node({ required_capabilities: ['verification', 'review'] })), 'review')
  })

  it('编译后的节点带上 role，计划里读得到', () => {
    const task = compileTask({
      task_id: 'REQ-1',
      nodes: [
        node({ id: 'D1', required_capabilities: ['verification'], write_scope: [], role: 'verification_design' }),
        node({ id: 'V1', required_capabilities: ['verification'], write_scope: [], depends_on: ['D1'] }),
      ],
    })
    assert.equal(task.nodes.get('D1').role, 'verification_design')
    assert.equal(task.nodes.get('V1').role, 'verification_execution')
  })
})

describe('按角色挑产出契约', () => {
  it('四个角色各有一份，且都是标准 JSON Schema', () => {
    assert.deepEqual(Object.keys(CHILD_OUTPUT_SCHEMAS).sort(), [...NODE_ROLES].sort())
    for (const [role, schema] of Object.entries(CHILD_OUTPUT_SCHEMAS)) {
      assert.equal(schema.type, 'object', `${role} 的契约应当是对象`)
      assert.equal(schema.additionalProperties, false, `${role} 的契约应当是封闭的`)
      // `required` 在**对象层**：写成工具创作 DSL 那种「属性内部 required」会被宿主直接拒
      // （ADR §9 记着这次实测）。
      assert.ok(Array.isArray(schema.required), `${role} 的契约应当在对象层声明 required`)
    }
  })

  it('每个角色要求它真正该交的东西', () => {
    assert.deepEqual(CHILD_OUTPUT_SCHEMAS.implementation.required, ['status', 'summary'])
    assert.deepEqual(CHILD_OUTPUT_SCHEMAS.verification_design.required, ['status', 'summary', 'plan'])
    assert.deepEqual(
      CHILD_OUTPUT_SCHEMAS.verification_execution.required,
      ['status', 'summary', 'plan_id', 'executions'],
    )
    assert.deepEqual(
      CHILD_OUTPUT_SCHEMAS.review.required,
      ['status', 'summary', 'verification_independence', 'engineering_quality'],
    )
    // 六问与五维都要有：缺一项就不该被当成一份复核报告。
    assert.equal(CHILD_OUTPUT_SCHEMAS.review.properties.verification_independence.required.length, 6)
    assert.equal(CHILD_OUTPUT_SCHEMAS.review.properties.engineering_quality.required.length, 5)
  })

  it('按节点角色取契约；认不出的角色退到 Builder，而不是猜一个', () => {
    assert.equal(childOutputSchemaFor({ role: 'verification_design' }), CHILD_OUTPUT_SCHEMAS.verification_design)
    assert.equal(childOutputSchemaFor({ role: 'review' }), CHILD_OUTPUT_SCHEMAS.review)
    assert.equal(childOutputSchemaFor({ role: 'implementation' }), CHILD_OUTPUT_SCHEMAS.implementation)
    assert.equal(childOutputSchemaFor({ role: '不存在的角色' }), CHILD_OUTPUT_SCHEMAS.implementation)
    assert.equal(childOutputSchemaFor(undefined), CHILD_OUTPUT_SCHEMAS.implementation)
  })
})

describe('设计节点的提示词只给需求侧事实', () => {
  const task = { task_id: 'REQ-1', mode: 'high_risk_task' }

  it('带上验收标准与冻结契约，并明说不要读实现', () => {
    const prompt = buildChildPrompt({
      node: node({ id: 'D1', role: 'verification_design', required_capabilities: ['verification'], write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-D1-A1',
      criteria: ['AC1', 'AC2'],
      contract: {
        name: 'parseConfig',
        operations: [{ name: 'parseConfig', signature: 'parseConfig(text: string): Config' }],
      },
    })
    assert.match(prompt, /验收标准（每条都要有正例与反例）：AC1、AC2/u)
    assert.match(prompt, /parseConfig\(text: string\): Config/u)
    assert.match(prompt, /不要\*\*去读实现/u)
    assert.match(prompt, /expect_failure/u)
  })

  it('没有验收标准时如实说缺口，而不是编一份', () => {
    const prompt = buildChildPrompt({
      node: node({ id: 'D1', role: 'verification_design', required_capabilities: ['verification'], write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-D1-A1',
      criteria: [],
    })
    assert.match(prompt, /本任务没有登记验收标准/u)
  })

  it('非设计节点不出现这些字段（它们不需要，也不该被引导去写方案）', () => {
    const prompt = buildChildPrompt({
      node: node({ id: 'T1', role: 'implementation' }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
    })
    assert.doesNotMatch(prompt, /验收标准/u)
    assert.doesNotMatch(prompt, /expect_failure/u)
  })
})
