/**
 * 原生子会话执行者的测试。
 *
 * 这一层的价值全在「真派遣」这四个字上，因此测试盯的是三件事：
 *
 *  1. **请求形状**：provider 名、自包含提示词、人格段、产出契约、深度上限、父 agent、取消信号——
 *     少一样，子会话要么建不起来，要么拿到一份需要父会话上下文才能读懂的提示词（而它是 fresh 的，
 *     没有父上下文）。
 *  2. **结论映射**：结构化产出才判定成败；没有结构化产出、或 `status` 不在契约内，一律按失败，
 *     绝不当成「大概成了」。
 *  3. **接缝缺席时是显式降级**：消息里必须说清「原生子会话不可用」以及为什么——否则「这一轮其实
 *     是主会话自己干」就无从判断。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHILD_OUTPUT_SCHEMA,
  buildChildPersona,
  buildChildPrompt,
  createChildExecutor,
  describeChildSeam,
  needsChildSession,
  parentDelegationDepth,
  roleToolFilterFor,
} from '../lib/child-executor.js'

/** 一个够用的节点。 */
function node(overrides = {}) {
  return {
    id: 'T1',
    objective: '把配置字段删掉',
    write_scope: ['src/'],
    depends_on: [],
    expected_artifacts: ['Patch'],
    required_capabilities: ['implementation'],
    ...overrides,
  }
}

/** 一个够用的任务。 */
const task = { task_id: 'REQ-1', mode: 'standard_task' }

/**
 * 一个假的子会话服务：记下 start 的参数，并按给定结果回复。
 *
 * @param {object} [options]
 * @param {string[]} [options.providers]
 * @param {object} [options.capabilities]
 * @param {object} [options.result]
 * @param {boolean} [options.startThrows]
 * @returns {{service: object, starts: object[], disposed: string[]}}
 */
function fakeSubagents({
  providers = ['spawn'],
  capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  result = { structured: { status: 'completed', summary: '改了 src/a.c' }, stopReason: 'completed' },
  startThrows = false,
} = {}) {
  const starts = []
  const disposed = []
  const service = {
    list: () => providers,
    getProvider: (name) => (providers.includes(name) ? { name, capabilities } : undefined),
    start: async (provider, request) => {
      if (startThrows) throw new Error('provider 起不来')
      starts.push({ provider, request })
      return {
        id: 'child-session-1',
        localAgent: undefined,
        result: Promise.resolve(result),
        dispose: async () => { disposed.push('child-session-1') },
      }
    },
  }
  return { service, starts, disposed }
}

/** 一次调用的输入。 */
function runInput(overrides = {}) {
  return {
    node: node(),
    task,
    root: 'D:/proj',
    dispatchId: 'REQ-1-T1-A1',
    agent: { id: 'agent-1', session: { id: 'parent-session', header: { delegationDepth: 0 } } },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('角色工具面', () => {
  const INHERITABLE = ['read', 'glob', 'grep', 'pwsh', 'write', 'edit', 'subagent', 'subagent_fork', 'gac_task', 'gac_scope', 'gac_evidence']

  it('要写文件的节点保留写入工具，只去掉委派与父会话协调类', () => {
    const filter = roleToolFilterFor(node(), INHERITABLE)
    assert.deepEqual([...filter.deny].sort(), ['gac_evidence', 'gac_scope', 'gac_task', 'subagent', 'subagent_fork'])
    assert.equal(filter.deny.includes('write'), false, 'Builder 必须能写文件')
    assert.equal(filter.deny.includes('pwsh'), false, 'Builder 要能跑命令')
  })

  it('写范围为空的节点连写入工具一并去掉 —— 这才是「清单里根本没有 write」', () => {
    const filter = roleToolFilterFor(node({ write_scope: [] }), INHERITABLE)
    assert.ok(filter.deny.includes('write'))
    assert.ok(filter.deny.includes('edit'))
    // 但 shell 留着：验证者要靠它逐条执行计划用例，那一层另有守卫兜底。
    assert.equal(filter.deny.includes('pwsh'), false)
  })

  it('只点名列在可收集合里的名字 —— 点错一个名字会让整次子会话创建失败', () => {
    // `SubagentStartRequest.toolFilter` 被直接交给创建窗口里的 `childCtx.tools.restrict()`，
    // 它对不认识的名字抛错（实测原文：`names unknown global tools "spawn_teammate", …`）。
    const filter = roleToolFilterFor(node({ write_scope: [] }), ['read', 'write', 'gac_task'])
    assert.deepEqual([...filter.deny].sort(), ['gac_task', 'write'])
  })

  it('读不出可收集合时不设工具面（调用方要把这件事记进结果）', () => {
    assert.equal(roleToolFilterFor(node(), undefined), undefined)
    assert.equal(roleToolFilterFor(node({ write_scope: [] }), undefined), undefined)
    // 可收集合里没有该点名的东西 → 也返回 undefined，而不是塞一个空的 deny（空过滤器会被宿主拒绝）。
    assert.equal(roleToolFilterFor(node(), ['read', 'pwsh']), undefined)
  })

  it('派遣请求里带上工具面，并且它进的是子会话的创建窗口', async () => {
    const { service, starts } = fakeSubagents()
    const executor = createChildExecutor({
      subagentsFor: () => service,
      namesFor: () => INHERITABLE,
    })
    await executor.run(runInput())
    assert.ok(Array.isArray(starts[0].request.toolFilter.deny))
    assert.equal(starts[0].request.toolFilter.deny.includes('write'), false)
    assert.ok(starts[0].request.toolFilter.deny.includes('gac_task'))
  })

  it('工具面被宿主拒绝时退到无过滤重试，并把「这一层没生效」写进结果', async () => {
    // 静默降级是最坏的形态：读的人会以为模型面里已经没有写入工具，而其实只剩守卫。
    const starts = []
    let calls = 0
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      start: async (_provider, request) => {
        calls += 1
        if (calls === 1) throw new Error('tools.restrict() names unknown global tools "spawn_teammate"')
        starts.push(request)
        return {
          id: 'child-session-2',
          result: Promise.resolve({ structured: { status: 'completed', summary: '做完了' }, stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    }
    const executor = createChildExecutor({ subagentsFor: () => service, namesFor: () => INHERITABLE })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'completed')
    assert.equal(Object.hasOwn(starts[0], 'toolFilter'), false, '重试时不该再带工具面')
    assert.match(outcome.detail, /角色工具面未生效/u)
  })

  it('既不是「未生效」也不是「名字不认识」的抛错，照样按失败上报（不吞）', async () => {
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      start: async () => { throw new Error('宿主内部错误') },
    }
    const executor = createChildExecutor({ subagentsFor: () => service, namesFor: () => INHERITABLE })
    await assert.rejects(() => executor.run(runInput()), /宿主内部错误/u)
  })
})

describe('委派深度上限是相对的', () => {
  it('上限 = 调用方深度 + 1：根会话（0）得到 1，深度 1 的调用方得到 2', () => {
    // 写死 1 会让「调用方自己就是子会话」的场景整个用不了——活体验收实测过：
    // 宿主回 `subagent depth 2 exceeds maxDepth 1`，而那正是由深度 1 的会话发起的派遣。
    assert.equal(parentDelegationDepth({ session: { header: { delegationDepth: 0 } } }), 0)
    assert.equal(parentDelegationDepth({ session: { header: { delegationDepth: 2 } } }), 2)
  })

  it('会话头与 AgentOptions 取**更深**的那个：被恢复的子会话不能从零重算', () => {
    assert.equal(
      parentDelegationDepth({
        session: { header: { delegationDepth: 1 } },
        options: { subagentDepth: 3 },
      }),
      3,
    )
  })

  it('读不出来时返回 undefined，不猜一个数字', () => {
    assert.equal(parentDelegationDepth(undefined), undefined)
    assert.equal(parentDelegationDepth({}), undefined)
    assert.equal(parentDelegationDepth({ session: { header: {} } }), undefined)
    // 非法值同样不采信。
    assert.equal(parentDelegationDepth({ options: { subagentDepth: -1 } }), undefined)
    assert.equal(parentDelegationDepth({ options: { subagentDepth: 1.5 } }), undefined)
  })

  it('请求里带上按调用方算出的 maxDepth；读不到深度时干脆不带这个字段', async () => {
    const { service, starts } = fakeSubagents()
    const executor = createChildExecutor({ subagentsFor: () => service })

    await executor.run(runInput())
    assert.equal(starts[0].request.maxDepth, 1, '根会话（深度 0）应当得到 1')

    await executor.run(runInput({
      agent: { session: { id: 'mid', header: { delegationDepth: 1 } } },
    }))
    assert.equal(starts[1].request.maxDepth, 2, '深度 1 的调用方应当得到 2')

    await executor.run(runInput({ agent: { id: 'unknown' } }))
    assert.equal(Object.hasOwn(starts[2].request, 'maxDepth'), false, '读不到深度就不带这个字段')
  })
})

describe('产出契约必须是标准 JSON Schema', () => {
  it('required 在对象层，不在属性内部 —— 写成工具创作 DSL 那种会被宿主直接拒', () => {
    // 实测原文：`unsupported JSON schema: schema.properties.status.required is not supported on
    // type "string"`。工具产出契约里 `{ type: 'string', required: true }` 是 DSL 约定、`defineTool`
    // 接受；而 `outputSchema` 走的是宿主的标准 JSON Schema 校验。两者混用会让派遣在**子会话创建
    // 之前**就被拒掉，节点停在 pending。
    const schema = CHILD_OUTPUT_SCHEMA
    assert.deepEqual([...schema.required].sort(), ['status', 'summary'])
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.equal(Object.hasOwn(property, 'required'), false, `${name} 的属性里不该有 required`)
    }
  })
})

describe('判定谁该由子会话承载', () => {
  it('写范围非空 → 是；写范围为空 → 不是', () => {
    // 判据是**声明的写范围**，不是能力名：用能力名会让一个同样要写文件却没叫 implementation 的
    // 节点落回主会话。
    assert.equal(needsChildSession(node()), true)
    assert.equal(needsChildSession(node({ write_scope: [] })), false)
    assert.equal(needsChildSession(node({ required_capabilities: ['documentation'], write_scope: ['d/'] })), true)
    assert.equal(needsChildSession(undefined), false)
  })

  it('承载所有节点：写文件的与只读的都跑独立会话，差别体现在工具面上', () => {
    // 阶段 2 起 Verifier / Reviewer 也跑独立会话——「独立验证」的实质是独立 session identity、独立
    // 上下文、独立工具面，而不是把同一个会话换个 prompt。角色差别由 `roleToolFilterFor` 表达。
    const executor = createChildExecutor({ subagentsFor: () => fakeSubagents().service })
    assert.equal(executor.supports(node()), true)
    assert.equal(executor.supports(node({ write_scope: [] })), true)
  })
})

describe('提示词与人格段', () => {
  it('提示词自包含：节点契约、写范围、期望产物、停止条件都在里面', () => {
    // 子会话是 fresh 的（spawn 提供者不继承父上下文），所以这份提示词缺什么，子会话就永远不知道。
    const text = buildChildPrompt({ node: node(), task, root: 'D:/proj', dispatchId: 'REQ-1-T1-A1' })
    for (const fragment of ['D:/proj', 'REQ-1', 'T1', '把配置字段删掉', 'REQ-1-T1-A1', 'src/', 'Patch', '停止条件', 'completed']) {
      assert.ok(text.includes(fragment), `提示词里应当有「${fragment}」`)
    }
  })

  it('人格段说的是「你有工具、要把活干完」，不是进程内执行者那句「你没有任何写入工具」', () => {
    const persona = buildChildPersona(node())
    assert.ok(persona.includes('有工具'))
    assert.ok(persona.includes('src/'))
    assert.ok(!persona.includes('没有任何写入工具'))
  })

  it('写范围为空的节点，人格段明说不得写文件', () => {
    assert.ok(buildChildPersona(node({ write_scope: [] })).includes('不得写任何文件'))
  })

  it('需求正文原样进提示词 —— 验收标准只存编号，编号不表达意思', () => {
    // 活体验收里真实发生过：`requirement` 是空字符串，只有 `AC1`…`AC6` 六个编号，于是不读实现的
    // 验证设计节点只能照契约里 operation 的顺序猜「编号↔口径」，交回来的计划与任务书的编号整体
    // 错位——而形状完全正常，没有任何门禁看得出来。正文是那些读不到实现的角色唯一的依据来源。
    const text = buildChildPrompt({
      node: node({ role: 'verification_design', write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
      requirement: '把配置字段删掉，删干净。',
    })
    assert.ok(text.includes('需求正文（用户原话）：把配置字段删掉，删干净。'))
  })

  it('提示词说清「编号↔含义」的对应写在正文里 —— 别自己另配一套', () => {
    // 正文与编号是两样事实：只给编号，读不到实现的角色只能自己编一套对应，而编错是静默的
    // （活体 REQ-DD-2 的 12 条用例里 AC2/AC3/AC6 整体移位）。对应关系在哪，必须在提示词里说清。
    const text = buildChildPrompt({
      node: node({ role: 'verification_design', write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
      requirement: '把配置字段删掉，删干净。AC1：删掉之后配置解析不再接受这个字段。',
    })
    assert.ok(text.includes('一律以正文为准'))
    assert.ok(text.includes('不要自己给编号另配一套含义'))
  })

  it('正文与编号都没有时，不提对应关系（没有可对应的东西）', () => {
    const text = buildChildPrompt({
      node: node({ role: 'verification_design', write_scope: [] }),
      task: { task_id: 'REQ-1', mode: 'high_risk_task', acceptance_criteria: [] },
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: [],
    })
    assert.ok(!text.includes('一律以正文为准'))
  })

  it('正文缺席时明说这是缺口，而不是让子会话照编号猜', () => {
    const text = buildChildPrompt({
      node: node({ role: 'verification_design', write_scope: [] }),
      task: { task_id: 'REQ-1', mode: 'high_risk_task', acceptance_criteria: ['AC1'] },
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
    })
    assert.ok(text.includes('没有记下需求正文'))
    assert.ok(text.includes('不要照编号猜'))
  })

  it('设计角色的提示词讲清一致性规则，否则它会撞上自己的门禁', () => {
    // 一致性核对是运行时逐条比对的：架构在 `traceability` 里承诺过的 criteria，详设必须原样
    // 出现同一条。规则不写进提示词，设计角色只能靠猜——而猜错的代价是整份设计包判为自相矛盾，
    // 连批准都签不了（见 `evaluateDesignApproval`）。
    const text = buildChildPrompt({
      node: node({ role: 'software_design', write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
      requirement: '把配置字段删掉。',
    })
    assert.ok(text.includes('裸编号'))
    assert.ok(text.includes('详设产物必须原样出现同一条'))
  })
})

describe('接缝可用性', () => {
  it('服务缺席 / 形状不符 / 没有 provider / 能力缺失，都如实报不可用', () => {
    assert.equal(describeChildSeam(undefined).available, false)
    assert.match(describeChildSeam(undefined).reason, /不在/u)
    assert.equal(describeChildSeam({}).available, false)
    assert.match(describeChildSeam({}).reason, /形状不符/u)
    assert.equal(describeChildSeam({ list: () => [], start: () => {} }).available, false)
    assert.match(describeChildSeam({ list: () => [], start: () => {} }).reason, /没有任何/u)
    const weak = { list: () => ['spawn'], start: () => {}, getProvider: () => ({ capabilities: { outputSchema: true } }) }
    const seam = describeChildSeam(weak)
    assert.equal(seam.available, false)
    assert.match(seam.reason, /缺少能力/u)
  })

  it('默认 provider 不在时退到已注册的第一个，并报出它', () => {
    const service = { list: () => ['other'], start: () => {}, getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }) }
    const seam = describeChildSeam(service)
    assert.equal(seam.available, true)
    assert.equal(seam.provider, 'other')
  })
})

describe('真的起一个子会话', () => {
  it('请求形状正确，并把结构化结论回成节点状态', async () => {
    const { service, starts, disposed } = fakeSubagents()
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput())

    assert.equal(starts.length, 1)
    const [call] = starts
    assert.equal(call.provider, 'spawn')
    assert.equal(call.request.label, 'REQ-1/T1')
    assert.equal(call.request.parent.session.id, 'parent-session')
    assert.equal(call.request.maxDepth, 1, '调用方深度为 0，因此只允许再开一层')
    assert.deepEqual(call.request.outputSchema, CHILD_OUTPUT_SCHEMA)
    assert.equal(call.request.prompt.length, 1)
    assert.equal(call.request.prompt[0].type, 'text')
    assert.ok(call.request.prompt[0].text.includes('把配置字段删掉'))
    assert.ok(call.request.persona.includes('有工具'))

    assert.equal(outcome.status, 'completed')
    assert.match(outcome.summary, /改了 src\/a\.c/u)
    assert.match(outcome.summary, /child-session-1/u)
    assert.equal(outcome.artifact, 'child-session:child-session-1')
    assert.deepEqual(disposed, ['child-session-1'], '子会话必须被收掉')
  })

  it('子会话报 failed / blocked 时如实透传，不当成完成', async () => {
    for (const status of ['failed', 'blocked']) {
      const { service } = fakeSubagents({
        result: { structured: { status, summary: `它说它 ${status}` }, stopReason: 'completed' },
      })
      const executor = createChildExecutor({ subagentsFor: () => service })
      const outcome = await executor.run(runInput())
      assert.equal(outcome.status, status)
      assert.match(outcome.summary, new RegExp(`它说它 ${status}`, 'u'))
    }
  })

  it('没有结构化产出 → 失败，并留下 stopReason', async () => {
    const { service } = fakeSubagents({ result: { output: [{ type: 'text', text: '我大概做完了' }], stopReason: 'max-tokens' } })
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.summary, /没有按契约回结构化产出/u)
    assert.match(outcome.summary, /max-tokens/u)
  })

  it('status 不在契约内 → 失败', async () => {
    const { service } = fakeSubagents({ result: { structured: { status: 'done', summary: 'x' }, stopReason: 'completed' } })
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.summary, /不在契约内/u)
  })

  it('拿不到父 agent 时不猜：显式降级，且不起子会话', async () => {
    const { service, starts } = fakeSubagents()
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput({ agent: undefined }))
    assert.equal(starts.length, 0)
    assert.equal(outcome.status, 'in_progress')
    assert.match(outcome.summary, /没有可用的父 agent/u)
  })
})

describe('接缝缺席时显式降级', () => {
  it('服务不在 → in_progress，并说清「原生子会话不可用」与原因', async () => {
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'in_progress')
    assert.match(outcome.summary, /原生子会话不可用/u)
    assert.match(outcome.summary, /降级/u)
    assert.match(outcome.summary, /src\//u)
    assert.equal(outcome.reason !== undefined, true, '降级必须带上原因，供报告与诊断使用')
  })

  it('provider 能力不足 → 同样降级，不起子会话', async () => {
    const { service, starts } = fakeSubagents({ capabilities: { outputSchema: true } })
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput())
    assert.equal(starts.length, 0)
    assert.equal(outcome.status, 'in_progress')
    assert.match(outcome.summary, /缺少能力/u)
  })
})

describe('接缝缺席时不得静默退回主会话', () => {
  // 「原生子会话不可用」有两种处理：显式降级（由上层看见并决定）与阻塞（不许替跑）。
  // 分界线是**这次任务是否要求独立执行者**——高风险、非实现节点、以及本来就不该派子会话的
  // direct_edit，三者都必须 fail closed：降级成 in_progress 等于让主会话悄悄把活干了。

  it('高风险任务：接缝缺席 → blocked，并带上稳定码', async () => {
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput({ task: { task_id: 'REQ-HR', mode: 'high_risk_task' } }))

    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.blocked_by.code, 'GAC_CHILD_SEAM_UNAVAILABLE')
    assert.match(outcome.blocked_by.detail, /high_risk_task/u)
    assert.match(outcome.summary, /不由主会话代跑/u)
    assert.equal(outcome.reason !== undefined, true, '阻塞同样要带原因')
  })

  it('direct_edit：本来就不该派子会话，缺席也是 blocked', async () => {
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput({ task: { task_id: 'REQ-D', mode: 'direct_edit' } }))

    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.blocked_by.detail, /direct_edit/u)
  })

  it('任务里有非实现节点：缺席就是 blocked，并点名是哪些节点', async () => {
    // 有独立验证者要跑，却把实现也交给主会话——那正是「自我验证」，必须挡住。
    const nodes = new Map([
      ['T1', { id: 'T1', role: 'implementation', write_scope: ['src/'] }],
      ['V1', { id: 'V1', role: 'verification_execution', write_scope: [] }],
    ])
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput({
      task: { task_id: 'REQ-2', mode: 'standard_task', nodes },
    }))

    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.blocked_by.detail, /V1/u)
    assert.equal(outcome.blocked_by.detail.includes('T1'), false, '实现节点不是阻塞理由')
  })

  it('节点表写成数组时同样读得出来', async () => {
    const nodes = [
      { id: 'T1', role: 'implementation', write_scope: ['src/'] },
      { id: 'R1', role: 'review', write_scope: [] },
    ]
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput({
      task: { task_id: 'REQ-3', mode: 'standard_task', nodes },
    }))
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.blocked_by.detail, /R1/u)
  })

  it('拿不到父 agent + 高风险 → blocked，不是 in_progress', async () => {
    const { service } = fakeSubagents()
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput({
      agent: undefined,
      task: { task_id: 'REQ-HR', mode: 'high_risk_task' },
    }))
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.blocked_by.code, 'GAC_CHILD_SEAM_UNAVAILABLE')
    assert.match(outcome.summary, /没有可用的父 agent/u)
  })

  it('节点表读不出来时如实说，并按「只有实现节点」处理', async () => {
    // 读不出节点表就无法核对独立性。按「只有实现节点」处理是唯一不谎报的选择，
    // 但消息里必须写明白——否则「为什么这次降级了」无从判断。
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput({
      task: { task_id: 'REQ-4', mode: 'standard_task', nodes: 42 },
    }))
    assert.equal(outcome.status, 'in_progress')
    assert.match(outcome.summary, /读不出来/u)
  })

  it('只有实现节点的 standard_task 仍是显式降级 —— 老行为不变', async () => {
    const nodes = new Map([['T1', { id: 'T1', role: 'implementation', write_scope: ['src/'] }]])
    const executor = createChildExecutor({ subagentsFor: () => undefined })
    const outcome = await executor.run(runInput({
      task: { task_id: 'REQ-5', mode: 'standard_task', nodes },
    }))
    assert.equal(outcome.status, 'in_progress')
    assert.match(outcome.summary, /原生子会话不可用/u)
  })
})
