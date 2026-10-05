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
  CHILD_MAX_DEPTH,
  CHILD_OUTPUT_SCHEMA,
  buildChildPersona,
  buildChildPrompt,
  createChildExecutor,
  describeChildSeam,
  needsChildSession,
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
    agent: { id: 'agent-1', session: { id: 'parent-session' } },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('判定谁该由子会话承载', () => {
  it('写范围非空 → 是；写范围为空 → 不是', () => {
    // 判据是**声明的写范围**，不是能力名：用能力名会让一个同样要写文件却没叫 implementation 的
    // 节点落回主会话。
    assert.equal(needsChildSession(node()), true)
    assert.equal(needsChildSession(node({ write_scope: [] })), false)
    assert.equal(needsChildSession(node({ required_capabilities: ['documentation'], write_scope: ['d/'] })), true)
    assert.equal(needsChildSession(undefined), false)
  })

  it('supports 只认要写文件的节点', () => {
    const executor = createChildExecutor({ subagentsFor: () => fakeSubagents().service })
    assert.equal(executor.supports(node()), true)
    assert.equal(executor.supports(node({ write_scope: [] })), false)
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
    assert.equal(call.request.maxDepth, CHILD_MAX_DEPTH)
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
