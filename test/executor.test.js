/**
 * 执行者边界测试。
 *
 * 两条最要紧的性质：进程内执行者**只**承载不写文件的节点（它没有写入工具，假装能写会
 * 产出一份什么都没改的成功报告），以及模型流以非正常原因结束时不能被当成结论（半截话
 * 伪装成完成的报告）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EXECUTION_STATUSES,
  createInProcessExecutor,
  createSessionExecutor,
  pickExecutor,
} from '../lib/executor.js'

const ROUTE = { provider: 'test-provider', model: 'test-model' }

/**
 * 造一条分块流，形状与运行时给的一致。
 *
 * @param {object[]} chunks
 * @returns {AsyncIterable<object>}
 */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/**
 * 一条正常的模型流：一段文本然后正常结束。
 *
 * @param {string} text
 * @returns {AsyncIterable<object>}
 */
function goodStream(text) {
  return streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
}

/** 一个不写文件的节点（验证型）。 */
const REPORT_NODE = {
  id: 'T2',
  objective: '独立验证',
  write_scope: [],
  required_capabilities: ['verification'],
  depends_on: ['T1'],
  expected_artifacts: ['VerificationReport'],
}

/** 一个要写文件的节点（实现型）。 */
const WRITE_NODE = {
  id: 'T1',
  objective: '实现功能',
  write_scope: ['src/'],
  required_capabilities: ['implementation'],
  depends_on: [],
  expected_artifacts: ['ChangeSet'],
}

/**
 * 调用 `run` 所需的上下文。
 *
 * 注意流是由 `llmFor()` 提供的那个，不能从外面塞进来——执行者走的是 `llm.stream()`，
 * 早先的测试版本试着在这里传流，结果是失败用例其实跑的是「正常流」，于是断言在测一个
 * 根本没被执行的路径。
 *
 * @param {object} node
 * @returns {object}
 */
function runInput(node) {
  return {
    node,
    task: { task_id: 'REQ-1', mode: 'standard_task' },
    root: 'D:/work/proj',
    dispatchId: 'REQ-1-T1-A1',
    signal: new AbortController().signal,
  }
}

describe('EXECUTION_STATUSES', () => {
  it('是一个闭集，且含 in_progress 以表示「仍在进行」', () => {
    assert.deepEqual([...EXECUTION_STATUSES], ['completed', 'failed', 'blocked', 'in_progress'])
  })
})

/** 正常流里那段文本，供断言复用而不是各写一遍。 */
const GOOD_TEXT = '检查了三条验收，全部通过'

describe('createInProcessExecutor — 只承载不写文件的节点', () => {
  const executor = createInProcessExecutor({
    llmFor: () => ({ stream: () => goodStream(GOOD_TEXT) }),
    route: ROUTE,
  })

  it('承载只回传报告的节点', () => {
    assert.equal(executor.supports(REPORT_NODE), true)
  })

  it('拒绝需要写文件的节点', () => {
    // 没有写入工具却接下写代码的活，会产出一份什么都没改的成功报告。
    assert.equal(executor.supports(WRITE_NODE), false)
  })

  it('跑完返回 completed 与文本结论', async () => {
    const outcome = await executor.run(runInput(REPORT_NODE))
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.summary, GOOD_TEXT)
  })

  it('流以 error 结束时如实失败，不把半截话当结论', async () => {
    const failing = streamOf([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '检查到一半' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: '上游断开' } } },
    ])
    const broken = createInProcessExecutor({ llmFor: () => ({ stream: () => failing }), route: ROUTE })
    const outcome = await broken.run(runInput(REPORT_NODE))
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.summary, /上游断开/u)
  })

  it('流没有结束原因时如实失败', async () => {
    const truncated = streamOf([{ type: 'text-delta', index: 0, text: '没写完' }])
    const broken = createInProcessExecutor({ llmFor: () => ({ stream: () => truncated }), route: ROUTE })
    const outcome = await broken.run(runInput(REPORT_NODE))
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.summary, /没有给出结束原因/u)
  })

  it('模型服务缺席时报 blocked，而不是假装完成', async () => {
    const noLlm = createInProcessExecutor({ llmFor: () => undefined, route: ROUTE })
    const outcome = await noLlm.run(runInput(REPORT_NODE))
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.summary, /llm/u)
  })

  it('调用层抛错时报 blocked，让 repair 能区分「没跑起来」与「干砸了」', async () => {
    const throwing = createInProcessExecutor({
      llmFor: () => ({ stream: () => { throw new Error('transport down') } }),
      route: ROUTE,
    })
    const outcome = await throwing.run(runInput(REPORT_NODE))
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.summary, /transport down/u)
  })

  it('提示词里带上写范围与停止条件，而不是指望执行者自觉', async () => {
    let captured
    const capturing = createInProcessExecutor({
      llmFor: () => ({
        stream: (options) => {
          captured = options
          return goodStream('ok')
        },
      }),
      route: ROUTE,
    })
    await capturing.run({
      ...runInput(REPORT_NODE),
      task: { task_id: 'REQ-9', mode: 'high_risk_task' },
    })
    const prompt = captured.messages[0].content[0].text
    assert.match(prompt, /REQ-9/u)
    assert.match(prompt, /T2/u)
    assert.match(prompt, /不能写文件/u)
    assert.equal(captured.temperature, 0)
  })

  it('名字里带上能力与模型，便于辨认是谁在跑', () => {
    assert.match(executor.name, /test-provider/u)
  })

  it('名字可以被上层改写为按能力命名', () => {
    const renamed = Object.assign(
      createInProcessExecutor({ llmFor: () => undefined, route: ROUTE }),
      { name: 'verification:test-provider/test-model', capability: 'verification' },
    )
    assert.equal(renamed.capability, 'verification')
  })
})

describe('createSessionExecutor — 如实说明自己不能承载', () => {
  const executor = createSessionExecutor()

  it('声称支持一切，因为会话确实有不限范围的工具', () => {
    assert.equal(executor.supports(WRITE_NODE), true)
  })

  it('不做事，只登记为待会话执行', async () => {
    // 返回 in_progress 而不是 completed：一次没跑起来的派遣，其结果是未知的。
    const outcome = await executor.run(runInput(WRITE_NODE))
    assert.equal(outcome.status, 'in_progress')
    assert.match(outcome.summary, /必须由带工具的会话执行/u)
    assert.match(outcome.summary, /src\//u)
  })
})

describe('pickExecutor', () => {
  it('挑选第一个能承载该节点的执行者', () => {
    const inProcess = createInProcessExecutor({ llmFor: () => undefined, route: ROUTE })
    const session = createSessionExecutor()
    assert.equal(pickExecutor([inProcess, session], REPORT_NODE), inProcess)
    assert.equal(pickExecutor([inProcess, session], WRITE_NODE), session)
  })

  it('没有能承载的执行者时返回 undefined，而不是随便给一个', () => {
    const inProcess = createInProcessExecutor({ llmFor: () => undefined, route: ROUTE })
    assert.equal(pickExecutor([inProcess], WRITE_NODE), undefined)
  })
})
