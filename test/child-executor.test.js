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
  childOutputSchemaFor,
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

/**
 * 父会话可收集合：角色工具面是从这份清单里**做减法**得到的，因此断言「某个工具被收掉」
 * 必须先保证它本来在清单里——清单里没有的名字，deny 里也没有它，于是「收掉了」与
 * 「压根没这一项」会看起来一样。
 *
 * 它放在**文件级作用域**，是被多个 `describe` 共用的常量：这个文件里至少有两组反例
 * （「角色工具面」与「verification_design 的输入」）都要用它构造 `namesFor`。早先它被写在
 * 各自 `describe` 内部，下一组就只能引用一个在自己作用域里不存在的名字，于是那组用例在
 * 运行到 `namesFor: () => INHERITABLE` 时直接 `ReferenceError`（不是断言失败，是整条用例
 * 报错）——同一条事实被复制成两份，其中一份还会因为作用域够不着而根本跑不起来。
 *
 * 各角色实际会拿到哪些名字由 `lib/role-tools.js` 的策略表决定；这里要的是「读取、shell、
 * 写入、委派」四类都齐全的一份父会话清单，好让 deny 的差异可归因到角色策略而不是清单缺失。
 */
const INHERITABLE = ['read', 'glob', 'grep', 'read_image', 'pwsh', 'write', 'edit', 'subagent', 'subagent_fork', 'gac_task', 'gac_scope', 'gac_evidence']

describe('角色工具面', () => {

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

  it('契约的名字、签名与行为都进提示词 —— 只给签名等于把形状藏起来', () => {
    // 载荷形状写在 `behavior` 里。只注入 name + signature 时它对设计角色完全不可见，于是设计自己
    // 发明字段名：2026-10-08 活体 `REQ-DD-3` 里两份设计写 `claim_released`、冻结契约与冻结验证计划
    // 都写 `released`，而设计包的一致性核对查的是追溯编号、查不出键名对不上——冲突直到主会话裁决
    // 才被发现，那时设计已经冻结、计划已经冻结，两边不可能同时满足。
    const text = buildChildPrompt({
      node: node({ role: 'software_design', write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
      contract: {
        name: '审计契约',
        operations: [{
          name: '审计事件词表',
          signature: '两个事件类型',
          behavior: '载荷形状 { session_id, root, released }',
        }],
      },
    })
    assert.ok(text.includes('已冻结的接口契约：审计契约，1 个操作。'))
    assert.ok(text.includes('载荷形状 { session_id, root, released }'))
    assert.ok(text.includes('硬约束'), '名字与形状是硬约束这句话必须说出口')
  })

  it('契约缺席时不提契约 —— 不能凭空写一句「没有契约」让子会话以为没有约束', () => {
    const text = buildChildPrompt({
      node: node({ role: 'software_design', write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
    })
    assert.ok(!text.includes('已冻结的接口契约'))
  })

  it('设计角色被告知不得规定新增或删除文件 —— 写范围由任务图给定', () => {
    // 活体 `REQ-DD-3` 里软件架构的追溯要求新增 `test/scope-audit.test.js`，而测试架构明确说不新增
    // 测试文件、任务图里实现节点的写范围也不含它：两份已冻结的设计互相打架，实现节点两边都满足不了。
    const text = buildChildPrompt({
      node: node({ role: 'software_design', write_scope: [] }),
      task,
      root: 'D:/proj',
      dispatchId: 'REQ-1-T1-A1',
      criteria: ['AC1'],
    })
    assert.ok(text.includes('不要在设计里规定**新增或删除哪些文件**'))
    assert.ok(text.includes('由任务图给定'))
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

  it('软件设计与测试设计也拿得到冻结契约 —— 只在验证设计那一支取，另外两个设计角色只能自己发明约定', async () => {
    for (const role of ['software_design', 'test_design']) {
      const { service, starts } = fakeSubagents()
      const asked = []
      const executor = createChildExecutor({
        subagentsFor: () => service,
        contractFor: (taskId) => {
          asked.push(taskId)
          return {
            name: '审计契约',
            operations: [{ name: '审计事件词表', behavior: '载荷形状 { released }' }],
          }
        },
      })
      await executor.run(runInput({
        node: node({ role, write_scope: [], required_capabilities: ['documentation'] }),
      }))

      assert.deepEqual(asked, ['REQ-1'], `${role} 必须去取冻结契约`)
      assert.ok(starts[0].request.prompt[0].text.includes('载荷形状 { released }'),
        `${role} 的提示词里必须真的出现契约内容`)
    }
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

describe('盲化边界：test_design 的提示词里有工程事实，工具面里没有 read/shell', () => {
  // 这是本文件里最要紧的一组反例。测试设计节点的提示词里**确实**要出现工程事实（它得知道
  // 现有测试怎么跑、有哪些可用能力），而它**同时**必须拿不到 `read`/`grep`/`glob`/`pwsh`——
  // 因为「预期必须从需求推导」这件事只有结构性隔离才成立：一条写着「不要读实现」的提示词，
  // 管不住一个手里有 `read` 的模型（真实 `REQ-HR-5` 里设计子会话就是这样自己把实现产物读了
  // 回来，`hr5-artifact.txt` 的 `Length=3`，推理里出现「3 bytes = ok\n likely」）。
  //
  // 「提示词给了事实」与「工具面收掉了读取」不是互相抵消的两件事，而是必须**同时**成立：
  // 前者是它凭什么能在不看仓库的情况下推导，后者是它为什么只能这么推导。任何一边松掉，
  // 这组测试都要红——尤其要防「因为提示词里讲了工程事实，所以顺手把 read 留着吧」这种
  // 看起来合理的削弱。

  /** 工程事实：现有测试怎么跑、有哪些能力可用——提示词里会给，工具面里不许有。 */
  const ENGINEERING_FACT = '现有测试用 `npm test` 跑，单文件用 `node --test test/xxx.test.js`。'

  // 父会话可收集合（`INHERITABLE`）在**文件级作用域**上声明：这一组与下面「verification_design
  // 的输入」那一组都要用它，写在任一 `describe` 内部都会让另一组够不着。清单的内容与理由见
  // 文件顶部那处声明。

  /**
   * 一个测试设计节点：写范围为空（它不写文件），期望产物是测试详设。
   *
   * @param {object} [overrides]
   * @returns {object}
   */
  function testDesignNode(overrides = {}) {
    return node({
      id: 'TD1',
      role: 'test_design',
      required_capabilities: ['architecture'],
      write_scope: [],
      expected_artifacts: ['test_detail'],
      ...overrides,
    })
  }

  it('提示词里**真的**带着工程事实 —— 不是「什么都不告诉它」', () => {
    // 先把正向那一半钉住：如果这一半不成立，下面「工具面收掉了读取」就不再是「刻意的盲化」，
    // 而只是「什么都不知道的瞎猜」——两层意思完全不同。
    const text = buildChildPrompt({
      node: testDesignNode(),
      task: { task_id: 'REQ-6', mode: 'standard_task', requirement: ENGINEERING_FACT },
      root: 'D:/proj',
      dispatchId: 'REQ-6-TD1-A1',
      criteria: ['AC1'],
      requirement: ENGINEERING_FACT,
    })
    assert.ok(text.includes(ENGINEERING_FACT), '工程事实必须原样出现在提示词里')
    assert.match(text, /npm test/u)
  })

  it('同一份提示词也明说「你没有读仓库的工具，这是刻意的」，并说明为什么不能读', () => {
    const text = buildChildPrompt({
      node: testDesignNode(),
      task: { task_id: 'REQ-6', mode: 'standard_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-6-TD1-A1',
      criteria: ['AC1'],
      requirement: ENGINEERING_FACT,
    })
    // 不是「不要读」，而是「你手里没有读的工具」——措辞的性质不一样，前者只是请求，
    // 后者是对当前事实的陈述。
    assert.match(text, /你没有读仓库的工具，这是刻意的/u)
    // 旧断言是 `assert.match(text, /在 summary 里写明你需要什么/u)`，它**钉错了东西**：那句
    // 「需要什么就在 summary 里写明，由运行时决定是否提供」正是本次改动刻意删掉的旧求助通道
    // （§4.1 改为运行时注入工程事实）。summary 是**结论**，不是提问通道——把追问留在提示词里，
    // 这份设计要么停在一次追问上，要么自己编一套跑法写进详设再被下游照着执行。旧断言钉的是那条
    // 被替换掉的通道，不是行为本身，所以它在实现改对之后仍然要求旧文案存在——那是把缺陷当契约。
    // 旧断言里还有一条 `assert.match(text, /而不是自己去翻/u)`，它是**同一处错误**的另一半：
    // 「需要什么就在 summary 里写明……而不是自己去翻」是**同一句话**的两截，随那条旧求助通道
    // 一起被删掉了（`lib/` 里现在搜不到「自己去翻」这个说法）。留着它同样是拿被替换掉的旧文案
    // 当契约，所以一并去掉，只保留下面那两条**仍然成立**的引导。
    // 引导它为什么不能读的那半句话仍然必须在（说明理由），而不是把整段删掉。
    assert.match(text, /读本次实现会让预期照着实现写/u)
    assert.match(text, /实现自洽/u)
  })

  it('工程事实在场时，提示词里出现**由运行时注入的事实段落**（不是让它去追问，也不是让它去翻）', () => {
    // 这是替换掉旧求助通道的那一半新行为：`test_design` 要知道「现有测试怎么跑、构建与测试入口
    // 是什么、有哪些能力」，而它手里没有 `read`/`shell`。运行时把这份事实**作为文本注入**，
    // 于是它凭依据推导，而不是凭观测，也不是凭一次追问。
    const text = buildChildPrompt({
      node: testDesignNode(),
      task: { task_id: 'REQ-6', mode: 'standard_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-6-TD1-A1',
      criteria: ['AC1'],
      requirement: ENGINEERING_FACT,
      engineering_facts: ENGINEERING_FACT,
    })
    // 段落的**标题**必须点明这是工程事实，否则读到的人分不清这段是需求正文还是工程现状。
    assert.match(text, /工程的测试与构建事实/u)
    assert.ok(text.includes(ENGINEERING_FACT), '注入的事实正文必须原样出现在提示词里')
    // 并且要说清这份事实的**来源与性质**：由运行时提供、是这次派遣的依据之一、补的正是它看不到的那部分。
    assert.match(text, /由运行时提供/u)
    assert.match(text, /依据/u)
    // 反向：在场时**不得**再出现「没有带上工程事实」那条缺口声明——两条分支互斥，
    // 同时出现会让子会话不知道该按哪一条行事。
    assert.doesNotMatch(text, /本次派遣没有带上工程的测试与构建事实/u)
    // 旧求助通道必须彻底不在场：它被删掉是本次改动的**目的**，留着就等于没改。
    assert.doesNotMatch(text, /在 summary 里写明你需要什么/u)
  })

  it('工程事实缺席时，提示词里点明这一缺口，并要求在 summary 里明确写出它', () => {
    // 缺席不是「什么都不说」：一份不知道「怎么跑」的测试详设会把这件事推给下游去猜，
    // 所以缺口必须被**显式点出**，并且明确要求在 summary 里写出它——summary 是结论，
    // 缺口本身就是一条结论，而不是一次提问。
    const text = buildChildPrompt({
      node: testDesignNode(),
      task: { task_id: 'REQ-6', mode: 'standard_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-6-TD1-A1',
      criteria: ['AC1'],
      requirement: ENGINEERING_FACT,
      // 刻意不传 engineering_facts：派遣方这次没带上工程事实。
    })
    assert.match(text, /本次派遣没有带上工程的测试与构建事实/u)
    // 缺口要在 summary 里**写出来**（是结论），而不是「在 summary 里问你需要什么」（是提问）。
    assert.match(text, /summary/u)
    assert.match(text, /明确写出/u)
    assert.match(text, /缺口/u)
    // 同时必须禁掉「凭空编一套」这条退路：没有依据时编出来的跑法与入口会被下游照着执行。
    assert.match(text, /不要凭空编/u)
    // 正向那一半不得在场：没有事实却摆出事实段落，会让子会话以为拿到了依据。
    assert.doesNotMatch(text, /工程的测试与构建事实（由运行时提供/u)
  })

  it('工具面把 read/grep/glob/pwsh 全部收掉 —— 提示词里有事实**不等于**手里有读取', () => {
    const filter = roleToolFilterFor(testDesignNode(), INHERITABLE)
    assert.ok(filter !== undefined && Array.isArray(filter.deny))
    for (const name of ['read', 'glob', 'grep', 'read_image', 'pwsh']) {
      assert.ok(filter.deny.includes(name), `${name} 必须被收掉：测试设计的预期只能从需求推导`)
    }
    // 写入面同样不许有：它交的是产物（`design`），不是对代码的修改。
    assert.ok(filter.deny.includes('write'))
    assert.ok(filter.deny.includes('edit'))
  })

  it('收掉的是**读取与 shell**，不是「整个工具面一起收掉」——它仍能回报结论', () => {
    // 反向的过度纠正同样是缺陷：把 `structured_output` 一类的通道也收掉，子会话就变成了
    // 一个干不成活也说不出来的陷阱（`lib/tool-targets.js` 的 RUNTIME_TOOLS 记着这次教训）。
    const filter = roleToolFilterFor(testDesignNode(), [...INHERITABLE, 'structured_output', 'todo_write'])
    assert.equal(filter.deny.includes('structured_output'), false, '回报通道不能被自己收掉')
    assert.equal(filter.deny.includes('todo_write'), false)
  })

  it('派遣请求里同时看得见两件事：提示词带工程事实，toolFilter 里带 read/shell', async () => {
    // 这是「盲化边界不被削弱」的端到端那一半：单看提示词像是有事实可用，单看工具面像是收干净
    // 了——只有把同一次派遣的两面放在一起读，才能确认这个角色处在「有依据、无观测」的位置上。
    const { service, starts } = fakeSubagents({
      result: {
        structured: { status: 'completed', summary: '写了测试详设', design: { artifact: 'test_detail', content: '…', traceability: [] } },
        stopReason: 'completed',
      },
    })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      namesFor: () => INHERITABLE,
    })
    const outcome = await executor.run(runInput({
      node: testDesignNode(),
      task: { task_id: 'REQ-6', mode: 'standard_task' },
      requirement: ENGINEERING_FACT,
      criteria: ['AC1'],
    }))

    assert.equal(outcome.status, 'completed')
    const [call] = starts
    assert.ok(call.request.prompt[0].text.includes(ENGINEERING_FACT), '提示词那一面：工程事实在场')
    assert.ok(call.request.toolFilter.deny.includes('read'), '工具面那一面：read 不在场')
    assert.ok(call.request.toolFilter.deny.includes('pwsh'), '工具面那一面：shell 不在场')
    // 两面同时成立才是这个角色的定义；任何一面单独看都会被误读。
    assert.equal(call.request.outputSchema, childOutputSchemaFor(testDesignNode()))
  })

  it('verification_design 是同一档：也是只推理，也拿不到 read/shell', () => {
    // 两个设计角色的判据不同（`test_design` 的理由是「预期不能照实现写」，
    // `verification_design` 的理由是「方案要在实现之前独立推导」），但工具面同档。
    const filter = roleToolFilterFor(
      node({ id: 'D1', role: 'verification_design', write_scope: [] }),
      INHERITABLE,
    )
    for (const name of ['read', 'glob', 'grep', 'pwsh']) {
      assert.ok(filter.deny.includes(name), `verification_design 也必须收掉 ${name}`)
    }
  })

  it('对照组：software_design 读得到仓库 —— 因此上面那组收权确实是**按角色**的，不是一刀切', () => {
    // 没有这个对照，「收掉 read」看起来像是对所有设计角色一视同仁，而实际上软件设计必须能读
    // 现有代码才谈得上设计（`lib/role-tools.js` 的策略表里它只 deny 写入面）。
    const filter = roleToolFilterFor(
      node({ id: 'SD1', role: 'software_design', write_scope: [] }),
      INHERITABLE,
    )
    assert.equal(filter.deny.includes('read'), false, '软件设计要能读现有代码')
    assert.equal(filter.deny.includes('pwsh'), false, '软件设计要能跑诊断命令')
    assert.ok(filter.deny.includes('write'), '但它不改代码')
  })
})

describe('verification_design 的输入带着详设产物引用', () => {
  // 验证设计的依据来自需求侧事实：验收标准、冻结契约、需求正文。它**不读实现**（上面那组
  // 已经钉住了工具面），所以凡是它必须用到的东西都得由派遣方在提示词里交到它手上。
  //
  // 这里要分清两件事，混起来会把测试写成对不存在行为的断言：
  //
  //  1. **这一层真的做了什么**：`buildChildPrompt` 交出去的是「节点声明的期望产物」
  //     （`expected_artifacts` 原样进提示词），以及契约、验收标准、需求正文。它**不**接收
  //     也不需要知道「详设产物的引用/标识」——那个形状目前不在 `createChildExecutor` 的
  //     签名里，断言它存在就是在编行为。
  //  2. **调用方在派遣时确实带上了详设引用**：验证设计节点的输入里带着详设产物的引用，
  //     而这一层要**原样透传、不丢不改**——这条同样重要：透传丢了，下游拿到的计划就没有
  //     与详设对齐的依据。
  //
  // 于是这一组钉的是这两条，而不是一个凭空的 `detail_ref` 字段。

  /** 一份详设产物引用：名字取自 `DESIGN_ARTIFACTS` 闭集，ref 是编译后产物在盘上的身份。 */
  const DETAIL_REF = {
    artifact: 'software_detail',
    ref: 'design:REQ-7/software_detail',
  }

  /**
   * 一次验证设计派遣的输入。
   *
   * @param {object} [overrides]
   * @returns {object}
   */
  function designInput(overrides = {}) {
    return {
      node: node({
        id: 'D1',
        role: 'verification_design',
        required_capabilities: ['verification'],
        write_scope: [],
        expected_artifacts: ['verification_plan'],
      }),
      task: { task_id: 'REQ-7', mode: 'high_risk_task' },
      root: 'D:/proj',
      dispatchId: 'REQ-7-D1-A1',
      criteria: ['AC1', 'AC2'],
      requirement: 'AC1：解析器拒绝空输入。AC2：错误信息里带字段名。',
      contract: {
        name: 'parseConfig',
        operations: [{ name: 'parseConfig', signature: 'parseConfig(text: string): Config', behavior: '载荷形状 { field, message }' }],
      },
      ...overrides,
    }
  }

  it('节点声明的期望产物原样进提示词 —— 派遣方用这一条把详设引用交到它手上', () => {
    // 「输入里带着详设产物引用」在这条链路上的落点就是 `expected_artifacts`：它是派遣方
    // 决定要交什么的那一处事实，也是提示词里唯一会原样出现产物名的地方。它丢了或写错了，
    // 子会话就不知道自己该产出什么，下游也就无从把计划里的用例对齐到详设的具体位置。
    const text = buildChildPrompt(designInput({
      node: node({
        id: 'D1',
        role: 'verification_design',
        required_capabilities: ['verification'],
        write_scope: [],
        expected_artifacts: ['software_detail', 'verification_plan'],
      }),
    }))
    assert.match(text, /期望产物：software_detail、verification_plan。/u)
    assert.ok(text.includes(DETAIL_REF.artifact), '详设产物名必须原样出现')
  })

  it('引用是**派遣方交进来的**：不读仓库也拿得到，因此与「有没有 read 工具」无关', async () => {
    // 把两件事绑在一起验：同一个角色的 toolFilter 里没有 `read`，而提示词里**仍然**有
    // 详设引用——引用来自输入，不来自观测。这正是它为什么不需要读工具。
    const { service, starts } = fakeSubagents({
      result: {
        structured: {
          status: 'completed',
          summary: '方案写好了',
          plan: {
            cases: [
              { id: 'C1', covers: ['AC1'], type: 'positive', expect: '空输入被拒' },
              { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '空输入被接受' },
            ],
          },
        },
        stopReason: 'completed',
      },
    })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      namesFor: () => INHERITABLE,
      contractFor: () => designInput().contract,
    })
    const outcome = await executor.run(runInput({
      node: node({
        id: 'D1',
        role: 'verification_design',
        required_capabilities: ['verification'],
        write_scope: [],
        expected_artifacts: ['software_detail', 'verification_plan'],
      }),
      task: designInput().task,
      criteria: designInput().criteria,
      requirement: designInput().requirement,
    }))

    assert.equal(outcome.status, 'completed')
    const [call] = starts
    assert.equal(call.request.toolFilter.deny.includes('read'), true, '验证设计不读实现')
    assert.ok(call.request.prompt[0].text.includes(DETAIL_REF.artifact),
      '但它照样拿得到详设产物名 —— 那是派遣方交进来的输入')
    // 注意这里**不**断言「引用标识被某处校验过」：`buildChildPrompt` 不认识 `ref` 这个形状，
    // 断言它存在就是在编一条实现里没有的行为。
  })

  it('调用方交给这一层的额外输入原样透传，不被丢掉', async () => {
    // `run()` 的输入里那三个需求侧事实（criteria / requirement / contract）由派遣者交进来，
    // 而这一层**不改写**它们：需求正文与验收标准进提示词时逐字一致。任何一次「顺手格式化」
    // 都会让编号与正文的对应关系漂移，而那正是 `criteriaNote` 要防的事。
    const { service, starts } = fakeSubagents({
      result: {
        structured: {
          status: 'completed',
          summary: '方案写好了',
          plan: { cases: [{ id: 'C1', covers: ['AC1'], type: 'positive', expect: 'x' }] },
        },
        stopReason: 'completed',
      },
    })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      namesFor: () => INHERITABLE,
      contractFor: () => designInput().contract,
    })
    await executor.run(runInput({
      node: designInput().node,
      task: designInput().task,
      criteria: ['AC1', 'AC2'],
      requirement: designInput().requirement,
    }))

    const prompt = starts[0].request.prompt[0].text
    assert.ok(prompt.includes(designInput().requirement), '需求正文逐字进提示词')
    assert.ok(prompt.includes('验收标准（每条都要有正例与反例）：AC1、AC2'), '验收标准逐字进提示词')
  })

  it('需求侧三样事实同时在场：验收标准、冻结契约、需求正文', () => {
    // 少任何一样，验证设计就只能自己发明一套。活体 `REQ-DD-3` 里两份设计写 `claim_released`
    // 而冻结契约与冻结计划都写 `released`，就是这个缺口的样子。
    const text = buildChildPrompt(designInput())
    assert.match(text, /验收标准（每条都要有正例与反例）：AC1、AC2/u)
    assert.match(text, /已冻结的接口契约：parseConfig，1 个操作。/u)
    assert.match(text, /载荷形状 \{ field, message \}/u)
    assert.match(text, /需求正文（用户原话）：AC1：解析器拒绝空输入。AC2：错误信息里带字段名。/u)
  })

  it('契约走的是 contractFor → buildChildPrompt 这一条链，不是子会话自己去读', async () => {
    // 契约必须**由派遣方取出来**再交进去：`createChildExecutor` 只对 `CONTRACT_ROLES` 里的
    // 三个角色调 `contractFor`，取到的东西进提示词。子会话不读仓库，所以这条链断了它就一无所知。
    const asked = []
    const { service, starts } = fakeSubagents({
      result: {
        structured: {
          status: 'completed',
          summary: '方案写好了',
          plan: { cases: [{ id: 'C1', covers: ['AC1'], type: 'positive', expect: 'x' }] },
        },
        stopReason: 'completed',
      },
    })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      namesFor: () => INHERITABLE,
      contractFor: (taskId) => {
        asked.push(taskId)
        return designInput().contract
      },
    })
    await executor.run(runInput({ node: designInput().node, task: designInput().task }))

    assert.deepEqual(asked, ['REQ-7'], '验证设计必须去取冻结契约')
    assert.match(starts[0].request.prompt[0].text, /载荷形状 \{ field, message \}/u)
  })

  it('契约里的 operation 名字与签名逐字沿用，不改写也不补字段', () => {
    const text = buildChildPrompt(designInput())
    assert.match(text, /parseConfig\(text: string\): Config/u)
    assert.match(text, /一律逐字沿用/u)
    assert.match(text, /不要自己补一个契约里没有的字段/u)
  })

  it('计划产出契约要求 cases 逐条给出 id / covers / type（正例 expect、反例 expect_failure）', () => {
    // 输入给了事实，输出还得有形状：验证设计交回来的必须是一份**计划**，而不是一段散文。
    const prompt = buildChildPrompt(designInput())
    assert.match(prompt, /plan\.cases/u)
    assert.match(prompt, /expect_failure/u)
    assert.match(prompt, /不要\*\*去读实现/u)
    const schema = childOutputSchemaFor(designInput().node)
    assert.deepEqual(schema.required, ['status', 'summary', 'plan'])
    assert.deepEqual(
      schema.properties.plan.properties.cases.items.required,
      ['id', 'covers', 'type'],
    )
  })
})

describe('verification_execution 的产出契约：收合法载荷、拒缺字段载荷', () => {
  // 这一组按宿主的标准 JSON Schema 语义逐条判定「什么样的载荷会被接受」。**不引入任何校验库**：
  // 依赖面要与运行时同等对待（`test/install-surface.test.js` 盯着 package.json），而且真正
  // 执行校验的是宿主的 `child:spawn`，这里要钉的是**这份 schema 的形状**对不对。
  //
  // 判定实现只覆盖这份 schema 实际用到的两个约束：`required`（对象层）与 `additionalProperties`。
  // 它刻意做得很笨：笨到读的人能一眼核对，而不是又变成一处需要被信任的黑盒。

  /**
   * 按这份 schema 的约束判一份载荷合不合法。
   *
   * @param {object} schema
   * @param {unknown} payload
   * @returns {string[]} 违反项；空数组表示合法。
   */
  function violations(schema, payload) {
    const found = []
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return ['载荷不是一个对象']
    }
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(payload, name)) found.push(`缺字段 ${name}`)
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(payload)) {
        if (!Object.hasOwn(schema.properties ?? {}, name)) found.push(`多出字段 ${name}`)
      }
    }
    return found
  }

  /** 一个执行节点。 */
  const executionNode = node({
    id: 'V1',
    role: 'verification_execution',
    required_capabilities: ['verification'],
    write_scope: [],
    expected_artifacts: [],
  })

  const schema = childOutputSchemaFor(executionNode)

  /** 一份合法的载荷：plan_id 和逐条 executions 都齐。 */
  function goodPayload(overrides = {}) {
    return {
      status: 'completed',
      summary: 'C1 过了，C2 用错误实现复跑被抓住。',
      plan_id: 'plan-abc123',
      executions: [
        { case_id: 'C1', outcome: 'passed', evidence_ref: 'self:3' },
        { case_id: 'C2', outcome: 'failed', evidence_ref: 'self:5' },
      ],
      ...overrides,
    }
  }

  it('合法载荷（带 evidence_ref 归因/取证字段）被接受', () => {
    assert.deepEqual(violations(schema, goodPayload()), [])
  })

  it('每条用例只带必需的两个字段时也被接受 —— evidence_ref 是可选，不是必需', () => {
    // outcome 为 `failed` 的用例可以没有通过证据：它恰恰是「没通过」的记录。schema 在这里
    // 不能把 evidence_ref 写成必需，否则一条失败的用例都报不上来。
    assert.deepEqual(
      violations(schema, goodPayload({ executions: [{ case_id: 'C1', outcome: 'failed' }] })),
      [],
    )
  })

  it('executions 为空数组时整份载荷仍**合法** —— 「一条都不能少」由提示词与门禁管，不由 schema 管', () => {
    // 这一条是刻意的边界说明：schema 只做传输形状校验，做不了「8 条用例交了 5 条」这种判断
    // （那需要对照计划，而计划不在 schema 里）。把它误当成覆盖检查的防线，就会以为派遣这一层
    // 已经拦住了漏报——实际拦住它的是提示词里那句写死的「一条都不能少」与收口门禁。
    assert.deepEqual(violations(schema, goodPayload({ executions: [] })), [])
  })

  it('缺顶层必需字段的载荷被拒 —— 逐个数出来', () => {
    for (const missing of ['status', 'summary', 'plan_id', 'executions']) {
      const payload = goodPayload()
      delete payload[missing]
      const found = violations(schema, payload)
      assert.deepEqual(found, [`缺字段 ${missing}`], `缺 ${missing} 时应当恰好报这一项`)
    }
  })

  it('多出一个 schema 没声明的字段同样被拒 —— additionalProperties: false', () => {
    // 报错方向是「拒」而不是「忽略」：一份多带字段的载荷会在建子会话之前/校验时被退回来，
    // 而不是让那个字段静默消失（活体 `REQ-DD-3` 的键名冲突正是从「字段被静默丢掉」开始的）。
    assert.deepEqual(
      violations(schema, goodPayload({ verification: { plan_id: 'x' } })),
      ['多出字段 verification'],
    )
  })

  it('顶层 required 在对象层，四个字段一个不少', () => {
    assert.deepEqual([...schema.required].sort(), ['executions', 'plan_id', 'status', 'summary'])
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.equal(Object.hasOwn(property, 'required'), false, `${name} 的属性里不该有 required`)
    }
  })

  it('载荷真的按这份 schema 收下：带归因字段的结论原样进 semantic.payload', async () => {
    // 上面几条是纯函数判定；这一条把它放回真实派遣里：合法的载荷要能一路走到
    // `outcome.semantic.payload`，并且 `role` 与 `child_session_id` 一并带上——验证者报的
    // 是 `self:<n>`，运行时把那个序号解析成真实证据号时要知道**是哪个会话**的记录。
    const payload = goodPayload()
    const { service, starts } = fakeSubagents({
      result: { structured: payload, stopReason: 'completed' },
    })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      planFor: () => ({
        cases: [
          { id: 'C1', covers: ['AC1'], type: 'positive', expect: '空输入被拒' },
          { id: 'C2', covers: ['AC1'], type: 'falsification', expect_failure: '空输入被接受' },
        ],
      }),
    })
    const outcome = await executor.run(runInput({
      node: executionNode,
      task: { task_id: 'REQ-8', mode: 'high_risk_task' },
    }))

    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.semantic.role, 'verification_execution')
    assert.equal(outcome.semantic.child_session_id, 'child-session-1')
    assert.deepEqual(outcome.semantic.payload, payload)
    // 计划必须原样交到它手里，连同运行时算好的 id（它要回报回来做身份核对）。
    const prompt = starts[0].request.prompt[0].text
    assert.match(prompt, /已冻结验证计划\*\*：id = plan-/u)
    assert.match(prompt, /每条用例必须引用各自那次调用/u)
  })

  it('缺字段的载荷原样运输 —— 执行者不替宿主补齐缺的字段', async () => {
    // 执行者这一层只运输、不解释：缺 `plan_id` 的载荷该由宿主的 schema 校验在建子会话之前拒掉，
    // 而不是由 `createChildExecutor` 补一个 `plan_id` 出来。这里钉住的是「这一层不猜」：
    // 真的漏到它手里时，它原样运输（`semantic.payload` 就是子会话给的那一份），
    // 缺什么由 `settleVerificationReport` 那一道核对并判失败。
    const incomplete = { status: 'completed', summary: '我跑了 8 条' }
    const { service } = fakeSubagents({
      result: { structured: incomplete, stopReason: 'completed' },
    })
    const executor = createChildExecutor({ subagentsFor: () => service })
    const outcome = await executor.run(runInput({
      node: executionNode,
      task: { task_id: 'REQ-8', mode: 'high_risk_task' },
    }))

    assert.deepEqual(outcome.semantic.payload, incomplete, '这一层不补字段')
    assert.equal(Object.hasOwn(outcome.semantic.payload, 'plan_id'), false)
    assert.equal(Object.hasOwn(outcome.semantic.payload, 'executions'), false)
  })

  it('status 是闭集：三个值之外的一律不做成结论', () => {
    assert.deepEqual(schema.properties.status.enum, ['completed', 'failed', 'blocked'])
    assert.deepEqual(schema.properties.executions.items.properties.outcome.enum, ['passed', 'failed'])
  })
})

describe('子会话超时 —— 四个截止时间，一个都不许伪造成「取消成功」', () => {
  const CHILD_CAPS = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }

  /**
   * 一个可以被外部决定何时给出结果、且记录中断请求的假子会话服务。
   *
   * @param {object} [options]
   * @param {number} [options.resolveAfterMs] 到点后才交结果；不给就一直不交
   * @param {() => Promise<void>} [options.dispose]
   * @returns {{service: object, calls: object, disposeCalls: number[]}}
   */
  function controlledSubagents({ resolveAfterMs, dispose } = {}) {
    const calls = { interrupts: [], interruptsByParent: [], disposed: 0 }
    let resolveResult
    const result = new Promise((resolve) => { resolveResult = resolve })
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ name: 'spawn', capabilities: CHILD_CAPS }),
      start: async () => ({
        id: 'child-stall',
        localAgent: undefined,
        result,
        dispose: async () => {
          calls.disposed += 1
          if (dispose !== undefined) return dispose()
          return undefined
        },
      }),
      interrupt: (id, authority) => calls.interrupts.push({ id, authority }),
      interruptByParent: (id, parent, mode) => calls.interruptsByParent.push({ id, parent, mode }),
    }
    if (resolveAfterMs !== undefined) {
      setTimeout(() => resolveResult({
        structured: { status: 'completed', summary: '迟到的真结果' },
        stopReason: 'completed',
      }), resolveAfterMs)
    }
    return { service, calls }
  }

  /**
   * 记录授权释放的绑定桩：`release` 是否被调用决定「写权限有没有被放掉」。
   *
   * @returns {{bindings: object, released: string[]}}
   */
  function claimBindings() {
    const released = []
    return {
      released,
      bindings: {
        bind: () => ({ write_scope: ['src/'] }),
        declareRole: () => {},
        release: (dispatchId) => released.push(dispatchId),
        releaseRole: (dispatchId) => released.push(`role:${dispatchId}`),
      },
    }
  }

  it('登记超时：按「启动状态无法确认」处理，不重试、不装作成功', async () => {
    let starts = 0
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ name: 'spawn', capabilities: CHILD_CAPS }),
      start: () => { starts += 1; return new Promise(() => {}) },
    }
    const executor = createChildExecutor({ subagentsFor: () => service, timeouts: { start_ms: 20 } })
    await assert.rejects(
      () => executor.run(runInput()),
      (error) => {
        assert.equal(error.code, 'GAC_CHILD_START_FAILED')
        assert.equal(error.retryable, false, '无法确认的启动绝不能自动重试')
        assert.match(error.detail, /无法确认/u)
        assert.match(error.detail, /不得自动重试/u)
        return true
      },
    )
    assert.equal(starts, 1, '不得因为超时再起一个可能重复写入的执行者')
  })

  it('无进展 → 请求中断 → 窗口内等不到结果：标未知、保留写权限、留下诊断', async () => {
    const { service, calls } = controlledSubagents({ dispose: async () => { throw new Error('清理通道坏了') } })
    const { bindings, released } = claimBindings()
    const faults = []
    const executor = createChildExecutor({
      subagentsFor: () => service,
      bindings,
      timeouts: { start_ms: 50, progress_ms: 20, cancel_ms: 30, cleanup_ms: 30 },
      onFault: (code, detail) => faults.push({ code, detail }),
    })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.blocked_by.code, 'GAC_CHILD_STALLED')
    assert.equal(outcome.retryable, false, '无法确认它已经停下 → 不得自动重做副作用')
    assert.match(outcome.blocked_by.detail, /无法确认子会话已经停下/u)
    // 中断是**请求**：宿主回执只说明信号被受理，因此这里只要求「发出过」，不要求「停下了」。
    assert.equal(calls.interruptsByParent.length + calls.interrupts.length, 1, '必须真的向宿主请求过中断')
    assert.equal(released.includes('REQ-1-T1-A1'), false, '可能还活着的执行者不能被放掉写权限')
    const codes = faults.map((entry) => entry.code)
    assert.ok(codes.includes('GAC_CHILD_STALLED'), '无进展要留痕')
    assert.ok(codes.includes('GAC_CHILD_CLEANUP_FAILED'), '收尾失败必须留痕，不能静默吞掉')
  })

  it('取消确认窗口内结果到了：用的是子会话的真结果，而不是「取消成功」', async () => {
    const { service, calls } = controlledSubagents({ resolveAfterMs: 45 })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      timeouts: { start_ms: 50, progress_ms: 15, cancel_ms: 300, cleanup_ms: 100 },
    })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'completed')
    assert.match(outcome.summary, /迟到的真结果/u)
    assert.equal(calls.interruptsByParent.length + calls.interrupts.length, 1)
  })

  it('正常执行不被无进展机制误伤 —— 阈值之内照常收结果', async () => {
    const { service } = controlledSubagents({ resolveAfterMs: 20 })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      timeouts: { start_ms: 50, progress_ms: 200, cancel_ms: 100, cleanup_ms: 100 },
    })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'completed')
  })

  it('工程可以把无进展上限整项关掉（长编译 / 长测试 / 硬件验证）', async () => {
    const { service, calls } = controlledSubagents({ resolveAfterMs: 60 })
    const executor = createChildExecutor({
      subagentsFor: () => service,
      // `null` 是**显式的关闭**，不是「用默认值」：这类活儿没有可靠的进展信号。
      timeouts: { start_ms: 50, progress_ms: null, cancel_ms: 20, cleanup_ms: 100 },
    })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'completed')
    assert.equal(calls.interruptsByParent.length + calls.interrupts.length, 0, '关掉之后不该请求中断')
  })

  it('收尾超时：结论照旧，但收尾这件事必须被记下来', async () => {
    const { service } = controlledSubagents({
      resolveAfterMs: 5,
      dispose: () => new Promise(() => {}),
    })
    const faults = []
    const executor = createChildExecutor({
      subagentsFor: () => service,
      timeouts: { start_ms: 50, progress_ms: 200, cancel_ms: 50, cleanup_ms: 20 },
      onFault: (code, detail) => faults.push({ code, detail }),
    })
    const outcome = await executor.run(runInput())
    assert.equal(outcome.status, 'completed', '收尾失败不改变已经发生的结果')
    assert.ok(faults.some((entry) => entry.code === 'GAC_CHILD_CLEANUP_FAILED' && /dispose/u.test(entry.detail)))
  })

  it('超时阈值可被工程逐项覆盖，非法值一律忽略（不能把超时静默改成永不触发）', async () => {
    const { resolveChildTimeouts, CHILD_TIMEOUT_DEFAULTS } = await import('../lib/child-executor.js')
    assert.deepEqual(resolveChildTimeouts(undefined), { ...CHILD_TIMEOUT_DEFAULTS })
    assert.equal(resolveChildTimeouts({ progress_ms: 5000 }).progress_ms, 5000)
    assert.equal(resolveChildTimeouts({ progress_ms: null }).progress_ms, null)
    assert.equal(resolveChildTimeouts({ progress_ms: '30m' }).progress_ms, CHILD_TIMEOUT_DEFAULTS.progress_ms)
    assert.equal(resolveChildTimeouts({ progress_ms: -1 }).progress_ms, CHILD_TIMEOUT_DEFAULTS.progress_ms)
    assert.equal(resolveChildTimeouts({ progress_ms: 0 }).progress_ms, CHILD_TIMEOUT_DEFAULTS.progress_ms)
  })
})

describe('长会话上下文保护 —— 长结论留在产物里，回给父会话的是摘要加引用', () => {
  it('子会话的长结论只回一段有上限的摘要，并带上可追溯的引用', async () => {
    // 子会话的汇报可以很长（一次重构的实现说明、一份逐条验证记录）。父会话的上下文是有限的公共
    // 资源：全文塞回去，一次派遣就能把协调会话的上下文撑走一大截，而且它并不需要全文——它需要的是
    // 「去哪取全文」。
    const long = '这一条结论很长，因为它记录了逐个文件的改动理由。'.repeat(200)
    const { service } = fakeSubagents({
      result: {
        structured: { status: 'completed', summary: long, artifacts: ['src/a.c'] },
        stopReason: 'completed',
      },
    })
    const executor = createChildExecutor({ subagentsFor: () => service, namesFor: () => INHERITABLE })
    const outcome = await executor.run(runInput())

    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.detail.includes(long), false, '全文不得回给父会话')
    assert.ok(outcome.detail.length < 600, `回给父会话的 detail 必须有上限，实际 ${outcome.detail.length}`)
    assert.match(outcome.detail, /（截断）/u)
    // 截断必须与引用同时出现：只说「截断了」而不说去哪取，等于把结论丢掉了。
    assert.match(outcome.detail, /child-session-1/u)
    assert.match(outcome.detail, /src\/a\.c/u)
    assert.equal(outcome.artifact, 'child-session:child-session-1')
    assert.equal(outcome.semantic.child_session_id, 'child-session-1')
  })

  it('短结论原样回，不加多余标记 —— 截断是例外而不是默认行为', async () => {
    const { service } = fakeSubagents({
      result: { structured: { status: 'completed', summary: '改了 src/a.c' }, stopReason: 'completed' },
    })
    const executor = createChildExecutor({ subagentsFor: () => service, namesFor: () => INHERITABLE })
    const outcome = await executor.run(runInput())
    assert.match(outcome.detail, /结论：改了 src\/a\.c/u)
    assert.doesNotMatch(outcome.detail, /截断/u)
  })
})
