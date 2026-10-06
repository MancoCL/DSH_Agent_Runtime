/**
 * 证据层与指标测试。
 *
 * 最要紧的一组断言是：**运行时没发过的证据号不能被当作证据**。在此之前 `evidence_ref` 只是
 * 模型写下的字符串，写下 `ev-1` 与真的跑过一条命令在数据上完全一样，于是「每条用例都有证据」
 * 可以靠编造满足。这一段的存在就是为了让那件事做不到。
 */

import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DIGEST_INPUT_CAP,
  EVIDENCE_CODES,
  EvidenceError,
  compileEvidence,
  createEvidenceResolver,
  digest,
  findEvidence,
  formatEvidenceRef,
  inspectToolValue,
  isPassingEvidence,
  parseEvidenceRef,
} from '../lib/evidence.js'
import { EVIDENCE_FILE, EvidenceLog } from '../lib/evidence-store.js'
import { compileTask } from '../lib/coordinator.js'
import { TaskStore } from '../lib/task-store.js'
import { createMetricsTool } from '../lib/tool-metrics.js'
import {
  DENIED_SHELL_CODE,
  DENIED_WRITE_CODE,
  UNAVAILABLE_METRICS,
  buildReport,
  duplicateReadRatio,
  repairAttempts,
  summarizeEvidence,
  verificationCoverage,
} from '../lib/metrics.js'

/** 一个独立的证据日志根目录。 */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'gac-evidence-'))
}

/**
 * 造一条工具结果。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function toolResult(overrides = {}) {
  return {
    tool: 'pwsh',
    arguments: { command: 'npm test' },
    value: { kind: 'foreground', exitCode: 0 },
    is_error: false,
    ...overrides,
  }
}

describe('digest', () => {
  it('同样的输入给出同样的摘要', () => {
    assert.equal(digest('abc'), digest('abc'))
  })

  it('不同的输入给出不同的摘要', () => {
    assert.notEqual(digest('abc'), digest('abd'))
  })
})

describe('inspectToolValue —— 只在确实是对象时读字段', () => {
  it('读出退出码、信号与超时', () => {
    const facts = inspectToolValue({ exitCode: 1, signal: 'SIGTERM', timedOut: true })
    assert.equal(facts.exit_code, 1)
    assert.equal(facts.signal, 'SIGTERM')
    assert.equal(facts.timed_out, true)
  })

  it('读不到就不写这一项，而不是猜一个', () => {
    // 各工具的输出形状不同；凭猜测读形状会在别的工具上读出错误结论。
    assert.deepEqual(inspectToolValue({}), {})
    assert.deepEqual(inspectToolValue(undefined), {})
    assert.deepEqual(inspectToolValue('exit code 1'), {})
    assert.deepEqual(inspectToolValue([1, 2]), {})
  })

  it('退出码为 null 也如实记下', () => {
    // null 表示「没有退出码」（例如被中断），它与 0 完全不同。
    assert.equal(inspectToolValue({ exitCode: null }).exit_code, null)
  })
})

describe('compileEvidence', () => {
  it('收敛成一条冻结的记录', () => {
    const record = compileEvidence(toolResult(), { id: 'ev-1', at: 123 })
    assert.equal(record.id, 'ev-1')
    assert.equal(record.tool, 'pwsh')
    assert.equal(record.exit_code, 0)
    assert.equal(record.is_error, false)
    assert.equal(Object.isFrozen(record), true)
  })

  it('拒绝由调用方指定的空号', () => {
    // 号由运行时发放：能被指定的号就也能被编造。
    assert.throws(
      () => compileEvidence(toolResult(), { id: '' }),
      (error) => error.code === EVIDENCE_CODES.MALFORMED,
    )
  })

  it('拒绝缺少工具名的记录', () => {
    assert.throws(() => compileEvidence({ arguments: {} }, { id: 'ev-1' }), EvidenceError)
  })

  it('只留参数摘要与前缀，不留整份产出', () => {
    const huge = 'x'.repeat(DIGEST_INPUT_CAP * 3)
    const record = compileEvidence(toolResult({ value: huge }), { id: 'ev-1' })
    // output_bytes 记的是规范化之后那串文本的长度，因此比原始长度多一对引号。
    assert.ok(record.output_bytes > DIGEST_INPUT_CAP)
    assert.equal(record.output_truncated, true)
    assert.equal(record.output_preview.length, 512)
  })

  it('产出未超上限时不标记截断', () => {
    const record = compileEvidence(toolResult({ value: 'short' }), { id: 'ev-1' })
    assert.equal(record.output_truncated, false)
  })

  it('工具报错时记下结构化错误码', () => {
    const record = compileEvidence(
      toolResult({ is_error: true, error_code: DENIED_WRITE_CODE, value: undefined }),
      { id: 'ev-1' },
    )
    assert.equal(record.is_error, true)
    assert.equal(record.error_code, DENIED_WRITE_CODE)
  })
})

describe('证据引用 —— 号与明细', () => {
  it('没有明细时明细为空串', () => {
    assert.deepEqual(parseEvidenceRef('ev-3'), { evidence_id: 'ev-3', detail: '' })
  })

  it('带明细时拆开', () => {
    assert.deepEqual(parseEvidenceRef('ev-3#AC1 越界'), { evidence_id: 'ev-3', detail: 'AC1 越界' })
  })

  it('空引用解析不出来', () => {
    assert.equal(parseEvidenceRef(''), undefined)
    assert.equal(parseEvidenceRef(undefined), undefined)
  })

  it('只在有明细时加井号', () => {
    assert.equal(formatEvidenceRef('ev-3'), 'ev-3')
    assert.equal(formatEvidenceRef('ev-3', ''), 'ev-3')
    assert.equal(formatEvidenceRef('ev-3', 'x'), 'ev-3#x')
  })

  it('无明细与有明细是两条不同的引用', () => {
    // 把「整份产出」与「产出里的某一段」当成同一个东西，会让一次套件运行同时支撑多条用例
    // 这件事变得无法表达。
    assert.notEqual(formatEvidenceRef('ev-1'), formatEvidenceRef('ev-1', 'x'))
  })
})

describe('isPassingEvidence —— 能不能充当「通过」的凭据', () => {
  it('正常退出的调用可用', () => {
    assert.equal(isPassingEvidence({ is_error: false, exit_code: 0 }).usable, true)
  })

  it('没有这个号时不可用', () => {
    const verdict = isPassingEvidence(undefined)
    assert.equal(verdict.usable, false)
    assert.match(verdict.reason, /没有发出过/u)
  })

  it('退出码非零不可用，并报出那个码', () => {
    // 可核对的事实，不是判断：退出码非零的命令跑失败了。
    const verdict = isPassingEvidence({ is_error: false, exit_code: 1 })
    assert.equal(verdict.usable, false)
    assert.match(verdict.reason, /退出码为 1/u)
  })

  it('报错的调用不可用，并报出错误码', () => {
    const verdict = isPassingEvidence({ is_error: true, error_code: DENIED_WRITE_CODE })
    assert.equal(verdict.usable, false)
    assert.match(verdict.reason, new RegExp(DENIED_WRITE_CODE, 'u'))
  })

  it('没有退出码字段时不因缺失而拒绝', () => {
    // 不是每条证据都是命令；缺失是诚实的，不该被当成失败。
    assert.equal(isPassingEvidence({ is_error: false }).usable, true)
  })

  it('工作区观测发现越界改动时不可用 —— 它证明不了这次改动是合规的', () => {
    // 这条分支此前**没有测试**：代码在，但没人断言过。越界证据被当作通过凭据引用的后果，
    // 与「编造一个证据号」是同一类——一条「跑过了」的记录被用来支持「没越界」的结论。
    const verdict = isPassingEvidence({
      is_error: false,
      source: 'workspace',
      workspace: { in_scope: ['src/a.c'], out_of_scope: ['lib/b.c'], coverage: 'complete' },
    })
    assert.equal(verdict.usable, false)
    assert.match(verdict.reason, /1 个越界改动/u)
  })

  it('工作区观测只在范围内有改动时可用', () => {
    const verdict = isPassingEvidence({
      is_error: false,
      source: 'workspace',
      workspace: { in_scope: ['src/a.c'], out_of_scope: [], coverage: 'complete' },
    })
    assert.equal(verdict.usable, true)
  })
})

describe('EvidenceLog —— 只追加、运行时发号', () => {
  it('按出现顺序发号', () => {
    const log = new EvidenceLog({ root: scratch() })
    assert.equal(log.record(toolResult()).id, 'ev-1')
    assert.equal(log.record(toolResult()).id, 'ev-2')
  })

  it('重启后接着已有的号继续，而不是从 1 重来', () => {
    // 从 1 重来会让新旧证据撞号，而撞号就意味着一条引用可能指向两次不同的观测。
    const root = scratch()
    new EvidenceLog({ root }).record(toolResult())
    new EvidenceLog({ root }).record(toolResult())
    const fresh = new EvidenceLog({ root })
    assert.equal(fresh.load().length, 2)
    assert.equal(fresh.record(toolResult()).id, 'ev-3')
  })

  it('落盘成 JSONL，一行一条', () => {
    const root = scratch()
    const log = new EvidenceLog({ root })
    log.record(toolResult())
    log.record(toolResult({ tool: 'read' }))
    const text = readFileSync(join(root, '.dsh', 'gac', 'evidence', EVIDENCE_FILE), 'utf8')
    const lines = text.split('\n').filter((line) => line !== '')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]).tool, 'read')
  })

  it('最后一行残缺时跳过它，而不是让整份日志不可读', () => {
    // 崩溃最多损失最后一条未完成的记录，不该丢掉所有历史。
    const root = scratch()
    const log = new EvidenceLog({ root })
    log.record(toolResult())
    const path = join(root, '.dsh', 'gac', 'evidence', EVIDENCE_FILE)
    appendFileSync(path, '{"id":"ev-2","tool":"p\n', 'utf8')
    const reloaded = new EvidenceLog({ root })
    assert.equal(reloaded.load().length, 1)
    assert.equal(reloaded.load()[0].id, 'ev-1')
  })

  it('没有日志时读出空数组，不抛错', () => {
    const log = new EvidenceLog({ root: scratch() })
    assert.deepEqual([...log.load()], [])
    assert.equal(log.exists(), false)
  })

  it('落盘之后 exists 为真', () => {
    const log = new EvidenceLog({ root: scratch() })
    log.record(toolResult())
    assert.equal(log.exists(), true)
  })
})

describe('createEvidenceResolver', () => {
  it('认得出运行时发过的号', () => {
    const resolver = createEvidenceResolver([{ id: 'ev-1', is_error: false, exit_code: 0 }])
    assert.equal(resolver('ev-1#任何明细').usable, true)
  })

  it('认不出没发过的号', () => {
    const resolver = createEvidenceResolver([{ id: 'ev-1', is_error: false }])
    assert.equal(resolver('ev-2').usable, false)
  })

  it('把记录一并交回，供上层出示原始观测', () => {
    const record = { id: 'ev-1', is_error: false, tool: 'pwsh' }
    assert.equal(createEvidenceResolver([record])('ev-1').record, record)
  })
})

describe('findEvidence', () => {
  it('按号找到，找不到时返回 undefined', () => {
    const records = [{ id: 'ev-1' }]
    assert.equal(findEvidence(records, 'ev-1').id, 'ev-1')
    assert.equal(findEvidence(records, 'ev-9'), undefined)
  })
})

describe('gac_metrics —— 只读，且必须有出口', () => {
  /**
   * 一个接了存储与证据的只读指标工具。
   *
   * @param {object} [options]
   * @returns {{tool: object, store: TaskStore, exec: object}}
   */
  function metricsHarness(options = {}) {
    const store = new TaskStore({ root: scratch() })
    return {
      store,
      exec: { agent: { session: { id: 'session-1' } } },
      tool: createMetricsTool({
        defineTool: (spec) => spec,
        taskStoreFor: () => store,
        sessionRootFor: () => store.root,
        evidenceFor: () => options.evidence ?? [],
      }),
    }
  }

  it('是个只读工具：不声明任何必填参数', () => {
    const h = metricsHarness()
    assert.equal(h.tool.name, 'gac_metrics')
    for (const [name, spec] of Object.entries(h.tool.parameters)) {
      assert.equal(Object.hasOwn(spec, 'required'), false, `${name} 不应带 required 键`)
    }
  })

  it('没有任务时也给出报告，而不是报错', () => {
    // 「这个工程现在怎么样」通常正是想问的问题，而在还没有任务时它同样成立。
    const h = metricsHarness()
    return h.tool.execute({}, h.exec).then((value) => {
      assert.deepEqual(value.task_ids, [])
      assert.equal(value.evidence.total, 0)
      assert.equal(value.unavailable.length > 0, true)
    })
  })

  it('归约证据并给出各工具的调用数', async () => {
    const h = metricsHarness({
      evidence: [
        { tool: 'pwsh', is_error: false, session_id: 's1', arguments_digest: 'a' },
        { tool: 'read', is_error: false, session_id: 's1', arguments_digest: 'r' },
      ],
    })
    const value = await h.tool.execute({}, h.exec)
    assert.equal(value.evidence.total, 2)
    assert.deepEqual(value.evidence.by_tool, { pwsh: 1, read: 1 })
  })

  it('越权写入尝试有专门的出口', async () => {
    // 这个数应当恒为 0；没有出口，这个信号就会被永远忽略。
    const h = metricsHarness({
      evidence: [{ tool: 'write', is_error: true, error_code: DENIED_WRITE_CODE, session_id: 's1' }],
    })
    const value = await h.tool.execute({}, h.exec)
    assert.equal(value.evidence.denied_writes, 1)
  })

  it('指定任务时读出该任务的计划内容', async () => {
    const h = metricsHarness()
    h.store.save(compileTask({ task_id: 'R', nodes: [
      { id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: ['src/'] },
    ] }), { create: true })
    h.store.savePlan('R', { cases: [{ id: 'V1', covers: ['AC1'] }], criteria: ['AC1', 'AC2'] })
    const value = await h.tool.execute({ task_id: 'R' }, h.exec)
    assert.deepEqual(value.task_ids, ['R'])
    assert.deepEqual(value.verification, { covered: 1, total: 2, ratio: 0.5 })
  })

  it('找不到任务时如实报错', async () => {
    const h = metricsHarness()
    await assert.rejects(() => h.tool.execute({ task_id: 'NOPE' }, h.exec), /找不到任务/u)
  })

  it('没有可解析的项目根目录时报错，而不是给一份空报告', async () => {
    // 空报告会被读成「一切正常」，而实际是「算不出来」——两者必须能区分。
    const tool = createMetricsTool({
      defineTool: (spec) => spec,
      taskStoreFor: () => { throw new Error('不该走到这里') },
      sessionRootFor: () => undefined,
      evidenceFor: () => [],
    })
    await assert.rejects(
      () => tool.execute({}, { agent: { session: { id: 's' } } }),
      /没有可解析的项目根目录/u,
    )
  })
})

describe('指标 —— 只从落盘的事实里算', () => {
  /** 一批覆盖多种情形的证据。 */
  const EVIDENCE = [
    { tool: 'pwsh', is_error: false, error_code: undefined, session_id: 's1', arguments_digest: 'a' },
    { tool: 'read', is_error: false, session_id: 's1', arguments_digest: 'r1' },
    { tool: 'read', is_error: false, session_id: 's1', arguments_digest: 'r1' },
    { tool: 'write', is_error: true, error_code: DENIED_WRITE_CODE, session_id: 's1' },
    { tool: 'pwsh', is_error: true, error_code: DENIED_SHELL_CODE, session_id: 's1' },
  ]

  it('数出总数、错误数与越权写入尝试', () => {
    const summary = summarizeEvidence(EVIDENCE)
    assert.equal(summary.total, 5)
    assert.equal(summary.errors, 2)
    assert.equal(summary.denied_writes, 1)
    assert.equal(summary.denied_shells, 1)
  })

  it('按工具分组，且顺序稳定', () => {
    // 顺序不携带语义，却不稳定的话每次跑出来的报告都不一样，无法逐字比对。
    assert.deepEqual(Object.keys(summarizeEvidence(EVIDENCE).by_tool), ['pwsh', 'read', 'write'])
  })

  it('重复读按「同会话 + 同参数摘要」判定', () => {
    const reads = duplicateReadRatio(EVIDENCE)
    assert.equal(reads.total_reads, 2)
    assert.equal(reads.duplicate_reads, 1)
    assert.equal(reads.ratio, 0.5)
  })

  it('同一路径在不同会话里读不算重复', () => {
    const reads = duplicateReadRatio([
      { tool: 'read', session_id: 's1', arguments_digest: 'r1' },
      { tool: 'read', session_id: 's2', arguments_digest: 'r1' },
    ])
    assert.equal(reads.duplicate_reads, 0)
  })

  it('没有读操作时比例为 0 而不是 NaN', () => {
    assert.equal(duplicateReadRatio([{ tool: 'pwsh' }]).ratio, 0)
  })

  it('验证覆盖率按 AC 计', () => {
    const plan = { cases: [
      { id: 'V1', covers: ['AC1'] },
      { id: 'V2', covers: ['AC2'] },
    ] }
    const cover = verificationCoverage(plan, ['AC1', 'AC2', 'AC3'])
    assert.equal(cover.covered, 2)
    assert.equal(cover.total, 3)
  })

  it('没有计划时覆盖率为 0', () => {
    assert.deepEqual(verificationCoverage(undefined, ['AC1']), { covered: 0, total: 1, ratio: 0 })
  })

  it('修复尝试取各节点的最大值，而不是平均值', () => {
    // 一个需要修三次的节点与三个各修一次的节点，前者才是信号。
    const tasks = [{ task_id: 'R', nodes: new Map([
      ['T1', { execution: { attempt: 3 } }],
      ['T2', { execution: { attempt: 1 } }],
    ]) }]
    const repairs = repairAttempts(tasks)
    assert.equal(repairs.max_attempts, 3)
    assert.equal(repairs.by_node['R/T1'], 3)
  })

  it('没有任务时尝试次数为 0', () => {
    assert.equal(repairAttempts([]).max_attempts, 0)
  })

  it('算不出来的指标要写明原因，而不是省略', () => {
    // 省掉一个指标会让人以为它没问题。
    const report = buildReport()
    assert.equal(report.unavailable.length, UNAVAILABLE_METRICS.length)
    for (const entry of report.unavailable) {
      assert.ok(entry.metric)
      assert.ok(entry.reason.length > 0)
    }
  })

  it('报告形状稳定', () => {
    const report = buildReport({ evidence: EVIDENCE, tasks: [], criteria: ['AC1'] })
    assert.deepEqual(Object.keys(report), ['evidence', 'reads', 'verification', 'repairs', 'unavailable'])
  })
})
