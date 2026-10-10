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
import { CoordinatorError, NODE_ROLES, compileTask, deserializeTask, nodeRoleOf, serializeTask } from '../lib/coordinator.js'
import { roleDenyFor } from '../lib/role-tools.js'
import { planId } from '../lib/verification.js'

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

/**
 * 宿主 `child:spawn` 认得的**约束**关键字（`@deepseek-ai/dsh-tools` 的 `CONSTRAINT_KEYWORDS`）。
 *
 * 这份名单必须与宿主逐字一致：写多一个关键字不是「校验更严」，而是**子会话根本建不起来**。
 */
const HOST_CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/** 宿主额外容忍的注解关键字（`ANNOTATION_KEYWORDS`）——只影响文档，不参与校验。 */
const HOST_ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

/**
 * 递归收集一份 schema 里宿主会拒的东西。
 *
 * 为什么要递归而不是只看顶层：真实事故（2026-10-08，活体 `REQ-DD-2`）里出事的 `minItems` 埋在
 * `design.properties.traceability` 第四层，顶层断言 `type`/`additionalProperties`/`required` 全绿，
 * 而四个设计节点在第一波里全部于**建子会话之前**失败——`verification_design` 因为没有这个关键字
 * 照常成功，差别只在这一处。浅层断言抓不到它，所以这里按结构逐层走一遍。
 *
 * 三类判据都取自宿主的 `json-schema` 校验：① 关键字必须在白名单里；② 对象层 `required` 点名的
 * 属性必须真的在 `properties` 里；③ `additionalProperties` 只接受布尔量。
 *
 * @param {unknown} schema 待检查的 schema 片段
 * @param {string} [path] 出错时用于定位的路径
 * @returns {string[]} 违反项，空数组表示干净
 */
function schemaViolations(schema, path = 'schema') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return []
  const found = []
  for (const [key, value] of Object.entries(schema)) {
    if (!HOST_CONSTRAINT_KEYWORDS.has(key) && !HOST_ANNOTATION_KEYWORDS.has(key)) {
      found.push(`${path}.${key} 不是宿主认得的 schema 关键字`)
      continue
    }
    if (key === 'additionalProperties' && typeof value !== 'boolean') {
      found.push(`${path}.additionalProperties 只能是布尔量`)
    }
    if (key === 'required') {
      if (!Array.isArray(value)) {
        found.push(`${path}.required 应当是数组`)
      } else {
        for (const name of value) {
          if (!Object.hasOwn(schema.properties ?? {}, name)) {
            found.push(`${path}.required 里的 ${name} 没有在 properties 里声明`)
          }
        }
      }
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value)) {
        found.push(...schemaViolations(sub, `${path}.properties.${name}`))
      }
    }
    if (key === 'items') found.push(...schemaViolations(value, `${path}.items`))
    if (key === 'oneOf' && Array.isArray(value)) {
      value.forEach((sub, index) => found.push(...schemaViolations(sub, `${path}.oneOf[${index}]`)))
    }
  }
  return found
}

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

  it('每个角色的契约逐层都只用宿主认得的关键字 —— 多一个就建不起子会话', () => {
    for (const [role, schema] of Object.entries(CHILD_OUTPUT_SCHEMAS)) {
      assert.deepEqual(schemaViolations(schema), [], `${role} 的契约会被宿主拒`)
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
    assert.deepEqual(
      CHILD_OUTPUT_SCHEMAS.software_design.required,
      ['status', 'summary', 'design'],
    )
    assert.deepEqual(
      CHILD_OUTPUT_SCHEMAS.test_design.required,
      ['status', 'summary', 'design'],
    )
    // 设计角色交的**是一份产物**，不是一段散文：产物名取自闭集，正文与追溯表分开。
    assert.deepEqual(
      CHILD_OUTPUT_SCHEMAS.software_design.properties.design.properties.artifact.enum,
      ['software_architecture', 'software_detail'],
    )
    assert.deepEqual(
      CHILD_OUTPUT_SCHEMAS.test_design.properties.design.properties.artifact.enum,
      ['test_architecture', 'test_detail'],
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

describe('验证执行节点的提示词 —— 活体第一次跑漏报之后补上的三条', () => {
  const plan = {
    schema_version: 1,
    criteria: [],
    frozen_at: 0,
    cases: [
      { id: 'C1', covers: ['AC1'], type: 'positive', expect: '文件存在' },
      { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '文件缺失时应当判失败' },
    ],
  }

  /**
   * @returns {string}
   */
  function promptFor() {
    return buildChildPrompt({
      node: node({
        id: 'V1',
        role: 'verification_execution',
        required_capabilities: ['verification'],
        write_scope: [],
        depends_on: ['D1'],
      }),
      task: { task_id: 'REQ-1', mode: 'high_risk_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-1-V1-A1',
      plan,
    })
  }

  it('计划 id 由运行时算好交给它，而不是「(见盘上)」', () => {
    // 活体验收里那轮提示词写的是「id = (见盘上)」，子会话只好去读盘反推内容寻址的 id。
    // 那是运行时算得出来的事实，不该让子会话猜。
    const prompt = promptFor()
    assert.match(prompt, new RegExp(planId(plan), 'u'))
    assert.doesNotMatch(prompt, /见盘上/u)
  })

  it('明说每一条用例都必须出现，一条都不能少', () => {
    // 子会话报了 8 条用例的结论，却只在结构化字段里放了 5 条 → 整份报告被拒（缺 C2/C3/C6）。
    assert.match(promptFor(), /每一条都必须出现在 executions 里，一条都不能少/u)
  })

  it('明说每条用例要引用各自那次调用，并禁止去读运行时的证据账本挑号', () => {
    const prompt = promptFor()
    assert.match(prompt, /每条用例必须引用各自那次调用/u)
    assert.match(prompt, /取证摊薄/u)
    assert.match(prompt, /去读 `\.dsh\/gac\/evidence\/`/u)
    assert.match(prompt, /self:<n>/u)
  })

  it('用例逐条列出来（正例给 expect、反例给 expect_failure）', () => {
    const prompt = promptFor()
    assert.match(prompt, /C1（covers AC1，positive）：期望：文件存在/u)
    assert.match(prompt, /C2（covers AC1，falsification）：反例/u)
  })

  it('没有冻结计划时如实说，而不是编一个 id', () => {
    const prompt = buildChildPrompt({
      node: node({ id: 'V1', role: 'verification_execution', required_capabilities: ['verification'], write_scope: [] }),
      task: { task_id: 'REQ-1', mode: 'high_risk_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-1-V1-A1',
    })
    assert.match(prompt, /还没有冻结的验证计划/u)
  })
})

describe('设计专家的提示词：产物名说死，测试设计明说它看不到仓库', () => {
  const task = { task_id: 'REQ-1', mode: 'high_risk_task' }

  /**
   * @param {string} role
   * @param {string[]} artifacts
   * @returns {string}
   */
  function promptFor(role, artifacts) {
    return buildChildPrompt({
      node: node({
        id: 'A1',
        role,
        required_capabilities: ['architecture'],
        write_scope: [],
        expected_artifacts: artifacts,
      }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-A1-A1',
      criteria: ['AC1'],
      contract: { name: 'parseConfig', operations: [{ name: 'parseConfig', signature: 'parseConfig(text: string): Config' }] },
    })
  }

  it('产物名取自节点声明的期望产物，不是让它猜', () => {
    const prompt = promptFor('software_design', ['software_architecture'])
    assert.match(prompt, /你要交的是设计产物 `software_architecture`/u)
    assert.match(prompt, /`design\.content`/u)
    assert.match(prompt, /parseConfig\(text: string\): Config/u)
  })

  it('没声明期望产物时给出它那两份的闭集，而不是留空', () => {
    const prompt = promptFor('test_design', [])
    assert.match(prompt, /test_architecture 或 test_detail/u)
  })

  it('测试设计明说「你没有读仓库的工具，这是刻意的」', () => {
    // 测试设计的预期必须从需求推导；读本次实现会让预期照着实现写。
    assert.match(promptFor('test_design', ['test_detail']), /你没有读仓库的工具，这是刻意的/u)
    assert.doesNotMatch(promptFor('software_design', ['software_detail']), /你没有读仓库的工具/u)
  })

  it('软件设计能读仓库（不读代码就谈不上设计），因此不出现那句禁令', () => {
    const prompt = promptFor('software_design', ['software_detail'])
    assert.match(prompt, /写到\*\*另一个人能照着做\*\*的程度/u)
    assert.match(prompt, /design\.unresolved_issues/u)
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

describe('创建阶段的角色歧义 —— 推断只能给出没有歧义的角色', () => {
  /**
   * 活体任务里真实失败过的节点形状：要写测试代码，却只声明了验证能力、没写 role。
   *
   * @param {object} [overrides]
   * @returns {object}
   */
  function ambiguousNode(overrides = {}) {
    return {
      id: 'n4-tests',
      objective: '按测试详设补测试',
      required_capabilities: ['verification', 'c-safety'],
      write_scope: ['boot/06_Test/'],
      ...overrides,
    }
  }

  it('声明验证能力又要写文件，却没说 role → 派遣之前就报 GAC_NODE_ROLE_AMBIGUOUS', () => {
    assert.throws(
      () => compileTask({ task_id: 'boot-highrisk-fixes-req-d', mode: 'high_risk_task', nodes: [ambiguousNode()] }),
      (error) => {
        assert.ok(error instanceof CoordinatorError)
        assert.equal(error.code, 'GAC_NODE_ROLE_AMBIGUOUS')
        assert.equal(error.detail.node, 'n4-tests')
        assert.equal(error.detail.role, 'verification_execution')
        assert.deepEqual(error.detail.write_scope, ['boot/06_Test/'])
        assert.equal(error.detail.role_declared, false)
        // 报错本身要把出路说清楚，而不是只说「不行」。
        assert.match(error.message, /显式声明 role: "implementation"/u)
        assert.match(error.message, /write_scope 改成 \[\]/u)
        return true
      },
    )
  })

  it('显式声明 role: "implementation" 的同型计划照旧建立 —— 写测试代码属于实现工作', () => {
    const task = compileTask({
      task_id: 'boot-highrisk-fixes-req-d',
      mode: 'high_risk_task',
      nodes: [ambiguousNode({ role: 'implementation', required_capabilities: ['implementation', 'verification', 'c-safety'] })],
    })
    assert.equal(task.nodes.get('n4-tests').role, 'implementation')
    assert.deepEqual([...task.nodes.get('n4-tests').write_scope], ['boot/06_Test/'])
    // 角色这一层放行；越界与否由写范围（createWriteScope）继续判定。
    assert.equal(roleDenyFor({ role: 'implementation', name: 'edit', write_scope: ['boot/06_Test/'] }), undefined)
  })

  it('独立的只读验证节点照旧推断成 verification_execution，且不因新校验被拒', () => {
    const task = compileTask({
      task_id: 'REQ-2',
      mode: 'high_risk_task',
      nodes: [ambiguousNode({ id: 'V1', required_capabilities: ['verification'], write_scope: [] })],
    })
    assert.equal(task.nodes.get('V1').role, 'verification_execution')
  })

  it('显式写下验证角色时不拦（工具面继续拒写，安全边界没变）', () => {
    const task = compileTask({
      task_id: 'REQ-3',
      mode: 'high_risk_task',
      nodes: [ambiguousNode({ role: 'verification_execution', required_capabilities: ['verification'] })],
    })
    assert.equal(task.nodes.get('n4-tests').role, 'verification_execution')
    // 非空写范围**不放宽**验证角色的写权限：这仍然是一次会被拒的写入。
    assert.deepEqual(
      roleDenyFor({ role: 'verification_execution', name: 'edit', write_scope: ['boot/06_Test/'] }),
      { code: 'GAC_ROLE_TOOL_DENIED', category: 'write' },
    )
  })

  it('历史任务照旧读得进来 —— 反序列化不吃这条创建期校验', () => {
    // `ota-upgrade-refactor.json` 里就有「验证角色 + 非空写范围」的完成态节点。历史记录只能读、
    // 不能被新规则判成非法，否则升级之后整个任务目录都会变成不可读。
    const legacy = compileTask(
      { task_id: 'ota-upgrade-refactor', mode: 'high_risk_task', nodes: [ambiguousNode({ id: 'n5-host-tests' })] },
      { legacy: true },
    )
    const restored = deserializeTask(JSON.parse(JSON.stringify(serializeTask(legacy))))
    assert.equal(restored.nodes.get('n5-host-tests').role, 'verification_execution')
    assert.deepEqual([...restored.nodes.get('n5-host-tests').write_scope], ['boot/06_Test/'])
  })
})
