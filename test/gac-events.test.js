/**
 * GAC 会话事件测试。
 *
 * 这一层的两条性质最要紧：**归约必须可重放**（同一份日志必然得出同一个结果，否则「重启后
 * reduce 出同一状态」无从谈起），以及**载荷必须在 append 之前校验**（会话日志追加即不可改，
 * 一条形状不对的事件会永久留在历史里，而后续的 reduce 会在一个早已无法修正的地方读到它）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  GAC_EVENT_CODES,
  GAC_EVENT_SHAPES,
  GAC_EVENT_TYPES,
  GacEventError,
  compileGacEvent,
  createGacProjection,
  gacEventsFrom,
  reduceGacEvents,
} from '../lib/gac-events.js'

/**
 * 造一条会话事件。
 *
 * @param {string} type
 * @param {number} seq
 * @param {object} data
 * @returns {object}
 */
function event(type, seq, data) {
  return { type, seq, time: seq * 1000, data }
}

/** 一份覆盖一个任务完整生命周期的日志。 */
const FULL_LOG = [
  event('gac/mode-declared', 1, { mode: 'standard_task', declared_mode: 'standard_task', escalated: false, risk: 'medium' }),
  event('gac/scope-declared', 2, { task_id: 'R', node_id: 'T1', scope: ['lib/a.js'] }),
  event('gac/task-created', 3, { task_id: 'R', mode: 'standard_task', project_id: 'p', node_count: 2 }),
  event('gac/requirement-frozen', 4, { task_id: 'R', rounds: 2, criteria: ['AC1'] }),
  event('gac/contract-frozen', 5, { task_id: 'R', contract_id: 'contract-1', operation_count: 2 }),
  event('gac/plan-registered', 6, { task_id: 'R', plan_id: 'plan-1', case_count: 4, criteria: ['AC1'] }),
  event('gac/node-dispatched', 7, { task_id: 'R', node_id: 'T1', attempt: 1, dispatch_id: 'R-T1-A1' }),
  event('gac/node-reported', 8, { task_id: 'R', node_id: 'T1', status: 'completed', classification: 'accepted' }),
  event('gac/review-registered', 9, { task_id: 'R', review_id: 'review-1', blocking_issues: 1, violations: 0 }),
  event('gac/evidence-recorded', 10, { evidence_id: 'ev-1', tool: 'pwsh', usable: true }),
  event('gac/evidence-recorded', 11, { evidence_id: 'ev-2', tool: 'pwsh', usable: false }),
  event('gac/task-completed', 12, { task_id: 'R', status: 'completed' }),
]

describe('事件词表', () => {
  it('每个类型都有声明好的形状', () => {
    for (const type of GAC_EVENT_TYPES) {
      assert.ok(GAC_EVENT_SHAPES[type], `${type} 必须有形状`)
      assert.ok(type.startsWith('gac/'), `${type} 必须以 gac/ 开头`)
    }
  })

  it('类型名不重复', () => {
    assert.equal(new Set(GAC_EVENT_TYPES).size, GAC_EVENT_TYPES.length)
  })
})

describe('compileGacEvent —— 追加之前先校验', () => {
  it('接受形状正确的载荷并冻结它', () => {
    const data = compileGacEvent('gac/task-created', {
      task_id: 'R', mode: 'standard_task', project_id: 'p', node_count: 2,
    })
    assert.equal(data.task_id, 'R')
    assert.equal(Object.isFrozen(data), true)
  })

  it('拒绝不是 GAC 的类型', () => {
    assert.throws(
      () => compileGacEvent('user/message', {}),
      (error) => error.code === GAC_EVENT_CODES.UNKNOWN_TYPE,
    )
  })

  it('拒绝缺少必填字段的载荷', () => {
    assert.throws(
      () => compileGacEvent('gac/task-created', { task_id: 'R' }),
      (error) => {
        assert.equal(error.code, GAC_EVENT_CODES.MALFORMED)
        assert.match(error.message, /缺少字段/u)
        return true
      },
    )
  })

  it('拒绝类型不对的字段', () => {
    assert.throws(
      () => compileGacEvent('gac/task-created', {
        task_id: 'R', mode: 'standard_task', project_id: 'p', node_count: '2',
      }),
      /应当是 number/u,
    )
  })

  it('拒绝字符串数组里混进非字符串', () => {
    assert.throws(
      () => compileGacEvent('gac/requirement-frozen', { task_id: 'R', rounds: 1, criteria: ['AC1', 2] }),
      /应当是 string\[\]/u,
    )
  })

  it('接受省略的可选字段', () => {
    const data = compileGacEvent('gac/scope-declared', { scope: [] })
    assert.deepEqual([...data.scope], [])
  })

  it('拒绝未声明的字段，而不是放过', () => {
    // 放过的字段会被写进不可改的历史，而它究竟是有意的扩展还是拼错了名字，事后无法分辨。
    assert.throws(
      () => compileGacEvent('gac/task-created', {
        task_id: 'R', mode: 'standard_task', project_id: 'p', node_count: 2, extra: 1,
      }),
      (error) => {
        assert.equal(error.code, GAC_EVENT_CODES.MALFORMED)
        assert.match(error.message, /未声明的字段：extra/u)
        return true
      },
    )
  })

  it('拒绝非对象的载荷', () => {
    assert.throws(() => compileGacEvent('gac/task-created', []), GacEventError)
    assert.throws(() => compileGacEvent('gac/task-created', null), GacEventError)
  })
})

describe('reduceGacEvents —— 可重放', () => {
  it('同一份日志两次归约完全一致', () => {
    // 「重启后 reduce 出同一状态」的落点：这里没有任何依赖当前时刻的输入。
    assert.equal(
      JSON.stringify(reduceGacEvents(FULL_LOG)),
      JSON.stringify(reduceGacEvents(FULL_LOG)),
    )
  })

  it('归约出模式声明', () => {
    const view = reduceGacEvents(FULL_LOG)
    assert.equal(view.mode.mode, 'standard_task')
    assert.equal(view.mode.risk, 'medium')
    assert.equal(view.mode.escalated, false)
  })

  it('归约出任务的生命周期', () => {
    const task = reduceGacEvents(FULL_LOG).tasks.R
    assert.equal(task.mode, 'standard_task')
    assert.equal(task.plan_id, 'plan-1')
    assert.equal(task.plan_cases, 4)
    assert.equal(task.contract_id, 'contract-1')
    assert.equal(task.contract_operations, 2)
    assert.deepEqual(task.requirement, { rounds: 2, criteria: ['AC1'] })
    assert.deepEqual(task.review, { review_id: 'review-1', blocking_issues: 1, violations: 0 })
    assert.equal(task.status, 'completed')
  })

  it('归约出节点状态，且回报覆盖派遣', () => {
    const node = reduceGacEvents(FULL_LOG).tasks.R.nodes.T1
    assert.equal(node.dispatch_id, 'R-T1-A1')
    assert.equal(node.status, 'completed')
    assert.equal(node.classification, 'accepted')
  })

  it('归约出证据计数与不可用计数', () => {
    assert.deepEqual(reduceGacEvents(FULL_LOG).evidence, { count: 2, unusable: 1 })
  })

  it('记下最后一个事件的序号', () => {
    assert.equal(reduceGacEvents(FULL_LOG).last_seq, 12)
  })

  it('作用域被清除后从视图里消失', () => {
    // 只记声明不记清除，重放出来就会以为一个早已解除的作用域还在生效。
    const log = [
      event('gac/scope-declared', 1, { task_id: 'R', node_id: 'T1', scope: ['lib/a.js'] }),
      event('gac/scope-declared', 2, { task_id: 'R', node_id: 'T1', scope: [], cleared: true }),
    ]
    assert.deepEqual([...reduceGacEvents(log).scopes], [])
  })

  it('非 GAC 事件被忽略', () => {
    const log = [event('user/message', 1, { role: 'user' }), event('turn/start', 2, { turn: 1 })]
    const view = reduceGacEvents(log)
    assert.equal(view.last_seq, undefined)
    assert.deepEqual(view.tasks, {})
  })

  it('不认识的 gac/ 事件被忽略，而不是抛错', () => {
    // 日志里可能有比本版本更新的事件；让旧版本读不动新日志，会把升级变成一次数据丢失。
    const log = [
      event('gac/from-the-future', 1, { anything: true }),
      event('gac/task-created', 2, { task_id: 'R', mode: 'm', project_id: 'p', node_count: 1 }),
    ]
    const view = reduceGacEvents(log)
    assert.equal(view.tasks.R.task_id, 'R')
  })

  it('空日志与缺参都给出空视图，而不是抛错', () => {
    for (const input of [[], undefined, null]) {
      const view = reduceGacEvents(input)
      assert.deepEqual(view.tasks, {})
      assert.deepEqual(view.scopes, [])
    }
  })

  it('对同一任务的多次派遣按顺序累积', () => {
    const log = [
      event('gac/task-created', 1, { task_id: 'R', mode: 'm', project_id: 'p', node_count: 1 }),
      event('gac/node-dispatched', 2, { task_id: 'R', node_id: 'T1', attempt: 1, dispatch_id: 'R-T1-A1' }),
      event('gac/node-dispatched', 3, { task_id: 'R', node_id: 'T1', attempt: 2, dispatch_id: 'R-T1-A2' }),
    ]
    const node = reduceGacEvents(log).tasks.R.nodes.T1
    assert.equal(node.attempt, 2)
    assert.equal(node.dispatch_id, 'R-T1-A2')
  })
})

describe('gacEventsFrom —— 把工具结果翻译成事件', () => {
  /**
   * 一个只读的假存储：翻译只从盘上的记录取事实，因此这里给出什么，事件里就该出现什么。
   *
   * @param {object} [records]
   * @returns {object}
   */
  function storeOf(records = {}) {
    return {
      load: () => records.task,
      loadPlan: () => records.plan,
      loadContract: () => records.contract,
      loadGrilling: () => records.grilling,
      loadReview: () => records.review,
    }
  }

  /**
   * @param {object} [records]
   * @param {object} [adapter]
   * @returns {object}
   */
  function contextFor(records = {}, adapter = { project: { id: 'demo' } }) {
    return { root: '/p', storeFor: () => storeOf(records), adapterFor: () => adapter }
  }

  /** 一份盘上的任务记录，字段形状与 TaskStore.load 的产出一致。 */
  const TASK = { task_id: 'R', mode: 'standard_task', nodes: new Map([['T1', {}], ['T2', {}]]) }

  /**
   * 一次 `gac_task` 调用的结果。
   *
   * @param {object} value
   * @returns {object}
   */
  function taskResult(value) {
    return { isError: false, value: { task_id: 'R', ...value } }
  }

  it('错误结果不产出事件', () => {
    assert.deepEqual(
      gacEventsFrom('gac_task', { isError: true, value: { action: 'created' } }, contextFor()),
      [],
    )
  })

  it('value 不是对象时不产出事件', () => {
    for (const value of [undefined, null, 'ok', 42, []]) {
      assert.deepEqual(gacEventsFrom('gac_task', { isError: false, value }, contextFor()), [])
    }
  })

  it('gac_project 的模式声明', () => {
    const events = gacEventsFrom('gac_project', {
      value: { mode: 'direct_edit', declared_mode: 'read_only', escalated: true, risk: 'medium' },
    }, contextFor())
    assert.deepEqual(events, [{
      type: 'gac/mode-declared',
      data: { mode: 'direct_edit', declared_mode: 'read_only', escalated: true, risk: 'medium' },
    }])
  })

  it('没有模式的 gac_project 结果不产出事件', () => {
    assert.deepEqual(gacEventsFrom('gac_project', { value: { project: 'x' } }, contextFor()), [])
  })

  it('direct_edit 只产出模式声明，不产出任务创建 —— E2E-1 的那条断言', () => {
    // 「无 gac/task-created 事件」此前只在构造上成立（direct_edit 属 NON_TASK_MODES，不建任务），
    // 没有作为断言测过。现在翻译是纯函数，这条断言就能钉在这里：一次 direct_edit 声明只该
    // 产出 mode-declared 一条。
    const events = gacEventsFrom('gac_project', {
      value: { mode: 'direct_edit', declared_mode: 'direct_edit', escalated: false, risk: 'low' },
    }, contextFor({ task: TASK }))
    assert.deepEqual(events.map((entry) => entry.type), ['gac/mode-declared'])
  })

  it('gac_scope 的声明与清除', () => {
    assert.deepEqual(
      gacEventsFrom('gac_scope', { value: { scope: ['src/'], task_id: 'R', node_id: 'T1' } }, contextFor()),
      [{ type: 'gac/scope-declared', data: { scope: ['src/'], cleared: false, task_id: 'R', node_id: 'T1' } }],
    )
    // 空作用域就是「清除」：只记声明不记清除，重放出来会以为它还在生效。
    assert.deepEqual(
      gacEventsFrom('gac_scope', { value: { scope: [] } }, contextFor()),
      [{ type: 'gac/scope-declared', data: { scope: [], cleared: true } }],
    )
  })

  it('gac_task create 从盘上的任务取事实，而不是从返回里猜', () => {
    const events = gacEventsFrom('gac_task', taskResult({ action: 'created' }), contextFor({ task: TASK }))
    assert.deepEqual(events, [{
      type: 'gac/task-created',
      data: { task_id: 'R', mode: 'standard_task', project_id: 'demo', node_count: 2 },
    }])
  })

  it('任务读不出来时仍然记一条，但如实报 0 个节点与 unknown 模式', () => {
    // 事件说「建了个任务」是真的（工具自己报的），而任务记录读不出来是另一件事——把它报成
    // 0 个节点与 unknown，比凭返回里的字段猜一个更像事实。
    const events = gacEventsFrom('gac_task', taskResult({ action: 'created' }), contextFor())
    assert.deepEqual(events[0].data, { task_id: 'R', mode: 'unknown', project_id: 'demo', node_count: 0 })
  })

  it('gac_task plan 从盘上的计划取用例数', () => {
    const events = gacEventsFrom('gac_task', taskResult({ action: 'planned', plan_id: 'plan-9' }), contextFor({
      plan: { cases: [{ id: 'V1' }, { id: 'V2' }], criteria: ['AC1'] },
    }))
    assert.deepEqual(events, [{
      type: 'gac/plan-registered',
      data: { task_id: 'R', plan_id: 'plan-9', case_count: 2, criteria: ['AC1'] },
    }])
  })

  it('计划读不出来时不产出事件', () => {
    assert.deepEqual(
      gacEventsFrom('gac_task', taskResult({ action: 'planned' }), contextFor()),
      [],
    )
  })

  it('gac_task contract 从盘上的契约取操作数', () => {
    const events = gacEventsFrom('gac_task', taskResult({ action: 'contract_frozen', plan_id: 'contract-3' }), contextFor({
      contract: { operations: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    }))
    assert.deepEqual(events, [{
      type: 'gac/contract-frozen',
      data: { task_id: 'R', contract_id: 'contract-3', operation_count: 3 },
    }])
  })

  it('gac_task grill confirm 从盘上的访谈取轮数与验收标准', () => {
    const events = gacEventsFrom('gac_task', taskResult({ action: 'requirement_frozen' }), contextFor({
      grilling: { rounds: [{}, {}, {}], acceptance_criteria: ['AC1', 'AC2'] },
    }))
    assert.deepEqual(events, [{
      type: 'gac/requirement-frozen',
      data: { task_id: 'R', rounds: 3, criteria: ['AC1', 'AC2'] },
    }])
  })

  it('gac_task review 的阻塞问题数取自盘上的报告，命中门禁数取自本次回报', () => {
    // 两个数来自两处，因为它们是两件事：报告里写下了几个阻塞问题（产物），这次登记命中了
    // 几条门禁（刚发生的事）。
    const events = gacEventsFrom('gac_task', taskResult({
      action: 'reviewed',
      review_id: 'review-7',
      blockers: ['GAC_REVIEW_INDEPENDENCE_FAILED', 'GAC_REVIEW_BLOCKING_ISSUES'],
    }), contextFor({ review: { blocking_issues: ['a', 'b', 'c'] } }))
    assert.deepEqual(events, [{
      type: 'gac/review-registered',
      data: { task_id: 'R', review_id: 'review-7', blocking_issues: 3, violations: 2 },
    }])
  })

  it('复核报告读不出来时不产出事件', () => {
    assert.deepEqual(
      gacEventsFrom('gac_task', taskResult({ action: 'reviewed', review_id: 'review-7' }), contextFor()),
      [],
    )
  })

  it('gac_task complete', () => {
    assert.deepEqual(
      gacEventsFrom('gac_task', taskResult({ action: 'completed' }), contextFor()),
      [{ type: 'gac/task-completed', data: { task_id: 'R', status: 'completed' } }],
    )
  })

  it('逐条迁移 transitions —— 它存在的理由就是精确说出刚才派遣了谁', () => {
    const events = gacEventsFrom('gac_task', taskResult({
      action: 'dispatch',
      transitions: [
        { kind: 'dispatched', node_id: 'T1', attempt: 2, dispatch_id: 'R-T1-A2' },
        { kind: 'reported', node_id: 'T1', status: 'completed', classification: 'accepted' },
        { kind: 'something-else', node_id: 'T2' },
      ],
    }), contextFor())
    assert.deepEqual(events.map((entry) => entry.type), ['gac/node-dispatched', 'gac/node-reported'])
    assert.deepEqual(events[0].data, { task_id: 'R', node_id: 'T1', attempt: 2, dispatch_id: 'R-T1-A2' })
    assert.deepEqual(events[1].data, {
      task_id: 'R', node_id: 'T1', status: 'completed', classification: 'accepted',
    })
  })

  it('不认识的动作、别的工具、缺 task_id 的结果都不产出事件', () => {
    assert.deepEqual(gacEventsFrom('gac_task', taskResult({ action: 'await' }), contextFor()), [])
    assert.deepEqual(gacEventsFrom('gac_metrics', { value: { action: 'created' } }, contextFor()), [])
    assert.deepEqual(gacEventsFrom('write', { value: { action: 'created' } }, contextFor()), [])
    assert.deepEqual(gacEventsFrom('gac_task', { value: { action: 'created' } }, contextFor()), [])
    assert.deepEqual(gacEventsFrom(undefined, { value: { action: 'created' } }, contextFor()), [])
  })

  it('翻译出来的每一条都过得了 compileGacEvent —— 否则它会静默地记不进去', () => {
    // 这是本组最要紧的一条：翻译与词表分处两个地方时，形状对不上不会当场报错，只会让事件在
    // append 之前被校验拦下——而那条链路只写一条 report，模型与用户什么都看不到。
    const cases = [
      ['gac_project', { value: { mode: 'm', declared_mode: 'm', escalated: false, risk: 'low' } }, {}],
      ['gac_scope', { value: { scope: ['a/'], task_id: 'R', node_id: 'T1' } }, {}],
      ['gac_task', taskResult({ action: 'created' }), { task: TASK }],
      ['gac_task', taskResult({ action: 'planned', plan_id: 'p' }), { plan: { cases: [{}], criteria: ['AC1'] } }],
      ['gac_task', taskResult({ action: 'contract_frozen', plan_id: 'c' }), { contract: { operations: [{}] } }],
      ['gac_task', taskResult({ action: 'requirement_frozen' }), { grilling: { rounds: [{}], acceptance_criteria: [] } }],
      ['gac_task', taskResult({ action: 'reviewed', review_id: 'r', blockers: [] }), { review: { blocking_issues: [] } }],
      ['gac_task', taskResult({ action: 'completed' }), {}],
      ['gac_task', taskResult({
        transitions: [{ kind: 'dispatched', node_id: 'T1', attempt: 1, dispatch_id: 'd' }],
      }), {}],
      ['gac_task', taskResult({
        transitions: [{ kind: 'reported', node_id: 'T1', status: 'completed', classification: 'accepted' }],
      }), {}],
    ]
    for (const [toolName, result, records] of cases) {
      const events = gacEventsFrom(toolName, result, contextFor(records))
      assert.ok(events.length > 0, `${toolName} 的这一种结果应当产出事件`)
      for (const entry of events) {
        assert.doesNotThrow(
          () => compileGacEvent(entry.type, entry.data),
          `${entry.type} 的载荷过不了词表校验：${JSON.stringify(entry.data)}`,
        )
      }
    }
  })
})

describe('createGacProjection —— 模型实际读到什么', () => {
  it('产出的消息带 id 与 source', () => {
    // MessageBase 要求这两个字段，而 deriveEventMessage 对投影结果**不做任何校验**：
    // 少写字段不会当场报错，而是让形状不全的消息流进对话。
    const projection = createGacProjection('gac/task-created')
    const messages = projection.project(event('gac/task-created', 7, {
      task_id: 'R', mode: 'standard_task', project_id: 'p', node_count: 2,
    }))
    const message = messages.get(7)
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0)
    assert.equal(message.source.kind, 'user')
    assert.equal(message.role, 'user')
    assert.equal(Array.isArray(message.content), true)
    assert.equal(message.content[0].type, 'text')
  })

  it('id 跨次派生稳定', () => {
    // 不稳定的话，同一条事件每次派生出的消息都是新身份，按 id 索引的消费方会认不出来。
    const projection = createGacProjection('gac/task-created')
    const input = event('gac/task-created', 42, { task_id: 'R', mode: 'm', project_id: 'p', node_count: 1 })
    assert.equal(projection.project(input).get(42).id, projection.project(input).get(42).id)
  })

  it('消息挂在事件的序号上', () => {
    const projection = createGacProjection('gac/mode-declared')
    const messages = projection.project(event('gac/mode-declared', 9, {
      mode: 'read_only', declared_mode: 'read_only', escalated: false, risk: 'low',
    }))
    assert.deepEqual([...messages.keys()], [9])
  })

  it('文本里带 [GAC] 前缀，让它一眼可辨不是用户说的话', () => {
    // 平台的来源词表里没有「运行时自己」这一格，因此事件必然被归到别人名下；
    // 前缀是这条失真的可见标记。
    const projection = createGacProjection('gac/task-completed')
    const text = projection.project(event('gac/task-completed', 1, { task_id: 'R', status: 'completed' }))
      .get(1).content[0].text
    assert.match(text, /^\[GAC\]/u)
  })

  it('拒绝不是 GAC 的类型', () => {
    assert.throws(
      () => createGacProjection('user/message'),
      (error) => error.code === GAC_EVENT_CODES.UNKNOWN_TYPE,
    )
  })

  it('每个 GAC 类型都能造出投影，且都能产出消息', () => {
    // 逐项跑一遍：只测其中一个时，恰好漏掉的就是没被选中的那些。
    for (const type of GAC_EVENT_TYPES) {
      const projection = createGacProjection(type)
      assert.equal(projection.type, type)
      assert.equal(typeof projection.project, 'function')
    }
  })

  it('每种事件的最小载荷都能讲出一句话', () => {
    const samples = {
      'gac/mode-declared': { mode: 'm', declared_mode: 'm', escalated: false, risk: 'low' },
      'gac/scope-declared': { scope: ['lib/a.js'] },
      'gac/task-created': { task_id: 'R', mode: 'm', project_id: 'p', node_count: 1 },
      'gac/requirement-frozen': { task_id: 'R', rounds: 1, criteria: ['AC1'] },
      'gac/contract-frozen': { task_id: 'R', contract_id: 'c', operation_count: 1 },
      'gac/plan-registered': { task_id: 'R', plan_id: 'pl', case_count: 1, criteria: ['AC1'] },
      'gac/review-registered': { task_id: 'R', review_id: 'review-1', blocking_issues: 1, violations: 2 },
      'gac/node-dispatched': { task_id: 'R', node_id: 'T1', attempt: 1, dispatch_id: 'd' },
      'gac/node-reported': { task_id: 'R', node_id: 'T1', status: 'completed', classification: 'accepted' },
      'gac/task-completed': { task_id: 'R', status: 'completed' },
      'gac/evidence-recorded': { evidence_id: 'ev-1', tool: 'pwsh', usable: true },
    }
    for (const [type, data] of Object.entries(samples)) {
      const messages = createGacProjection(type).project(event(type, 1, data))
      assert.equal(messages.size, 1, `${type} 应当产出一条消息`)
      const text = messages.get(1).content[0].text
      assert.ok(text.length > 0, `${type} 的文本不能为空`)
    }
  })
})
