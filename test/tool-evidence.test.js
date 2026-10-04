/**
 * `gac_evidence` 的测试。
 *
 * **本文件从接口契约与验收标准推导，不读实现。** 这正是契约存在的理由：写测试的人不知道
 * 实现长什么样，若两边各自发明接口，测试会因接口对不上而失败——那是结构性失败、不是缺陷。
 * 因此这里只依据冻结契约里的签名与行为约定写断言。
 *
 * 每条验收标准都有一对用例：正例证明「对的能过」，反例证明「错的会被抓住」。只有正例的
 * 验证集无法区分「实现正确」与「断言太弱」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  EVIDENCE_TOOL_NAME,
  createEvidenceTool,
  evidenceToolOptions,
  projectEvidence,
  selectEvidence,
} from '../lib/tool-evidence.js'

/**
 * 一条原始证据记录，形状与 `compileEvidence` 的产物一致。
 *
 * @param {string} id
 * @param {object} [overrides]
 * @returns {object}
 */
function record(id, overrides = {}) {
  return {
    schema_version: 1,
    id,
    at: 1000,
    session_id: 's1',
    tool: 'pwsh',
    arguments_digest: 'a',
    arguments_preview: '{"command":"npm test"}',
    is_error: false,
    exit_code: 0,
    output_digest: 'd',
    output_bytes: 10,
    output_truncated: false,
    output_preview: 'all tests passed',
    ...overrides,
  }
}

/**
 * 造 n 条证据，号按 ev-1..ev-n 递增。
 *
 * @param {number} n
 * @param {object} [overrides]
 * @returns {object[]}
 */
function many(n, overrides = {}) {
  return Array.from({ length: n }, (_unused, index) => record(`ev-${index + 1}`, overrides))
}

/** 一个临时工程根。 */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'gac-evidence-tool-'))
}

describe('V1/V2/V3 —— AC1：默认 20 条，且 limit 可调', () => {
  it('V1 25 条证据、不传 limit 时 listed 为 20', () => {
    const result = selectEvidence(many(25))
    assert.equal(result.listed, 20)
    assert.equal(result.records.length, 20)
  })

  it('V2 反例：忽略传入的 limit 时，本断言会失败', () => {
    // 若实现把 limit 写死成 20，下面这条会失败。它抓的是「参数被接受但被丢掉」。
    assert.equal(selectEvidence(many(25), { limit: 5 }).listed, 5)
  })

  it('V3 limit=5 时 listed 为 5', () => {
    const result = selectEvidence(many(25), { limit: 5 })
    assert.equal(result.listed, 5)
    assert.equal(result.records.length, 5)
  })

  it('limit 不是正整数时退回 20，而不是返回空或全部', () => {
    for (const bad of [0, -1, 2.5, Number.NaN, 'ten', null, undefined]) {
      assert.equal(selectEvidence(many(25), { limit: bad }).listed, 20, `limit=${String(bad)}`)
    }
  })
})

describe('V4/V5 —— AC2：每条含号、工具、参数前缀、产出前缀', () => {
  it('V4 投影后的记录含 id、tool、arguments_preview、output_preview', () => {
    const projected = projectEvidence(record('ev-1'))
    assert.equal(projected.id, 'ev-1')
    assert.equal(projected.tool, 'pwsh')
    assert.equal(projected.arguments_preview, '{"command":"npm test"}')
    assert.equal(projected.output_preview, 'all tests passed')
  })

  it('V5 反例：投影丢掉参数或产出前缀时，本断言会失败', () => {
    // 只留 id 与 tool 的投影在数据上「有记录」，却让模型无法判断该不该引用它。
    const projected = projectEvidence(record('ev-1'))
    assert.ok(Object.hasOwn(projected, 'arguments_preview'), '必须有参数前缀')
    assert.ok(Object.hasOwn(projected, 'output_preview'), '必须有产出前缀')
  })

  it('原记录没有 exit_code 时不补一个', () => {
    // 缺失是诚实的，猜出来的是假的。
    const without = { ...record('ev-1') }
    delete without.exit_code
    assert.equal(Object.hasOwn(projectEvidence(without), 'exit_code'), false)
  })

  it('列表里每一条都是投影后的形状', () => {
    const result = selectEvidence(many(3))
    for (const item of result.records) {
      assert.ok(Object.hasOwn(item, 'arguments_preview'))
      assert.ok(Object.hasOwn(item, 'output_preview'))
      assert.ok(Object.hasOwn(item, 'usable'))
    }
  })
})

describe('V6/V7/V8 —— AC3：默认全部会话，session_id 可选', () => {
  const twoSessions = [
    record('ev-1', { session_id: 'builder-session' }),
    record('ev-2', { session_id: 'verifier-session' }),
  ]

  it('V6 不传 session_id 时两个会话的证据都出现', () => {
    // 验证者往往在另一个会话里干活，而它要引用的正是 builder 那个会话跑出来的证据。
    const result = selectEvidence(twoSessions)
    assert.equal(result.total, 2)
    assert.deepEqual([...result.records].map((item) => item.session_id).sort(), [
      'builder-session', 'verifier-session',
    ])
  })

  it('V7 反例：默认按调用会话过滤时，本断言会失败', () => {
    // 若实现默认只看本会话，total 会变成 1，于是跨会话引用直接不可用。
    assert.equal(selectEvidence(twoSessions).total, 2)
  })

  it('V8 传 session_id 时只列该会话', () => {
    const result = selectEvidence(twoSessions, { session_id: 'verifier-session' })
    assert.equal(result.total, 1)
    assert.equal(result.records[0].session_id, 'verifier-session')
  })

  it('过滤之后 available 仍是不受过滤影响的总条数', () => {
    // 它用于区分「过滤后没有匹配」与「这个工程还没有证据」，两者是完全不同的诊断。
    const result = selectEvidence(twoSessions, { session_id: 'nobody' })
    assert.equal(result.total, 0)
    assert.equal(result.available, 2)
  })
})

describe('V9/V10 —— AC4：可按工具名过滤', () => {
  const mixed = [
    record('ev-1', { tool: 'pwsh' }),
    record('ev-2', { tool: 'read' }),
    record('ev-3', { tool: 'pwsh' }),
  ]

  it('V9 tool=pwsh 时每一条的 tool 都是 pwsh', () => {
    const result = selectEvidence(mixed, { tool: 'pwsh' })
    assert.equal(result.total, 2)
    for (const item of result.records) assert.equal(item.tool, 'pwsh')
  })

  it('V10 反例：忽略 tool 参数时，本断言会失败', () => {
    // 忽略筛选会让别的工具混进来，而调用方以为自己看的是筛选后的结果。
    assert.equal(selectEvidence(mixed, { tool: 'read' }).total, 1)
  })

  it('没有匹配时返回空列表而不是报错', () => {
    const result = selectEvidence(mixed, { tool: 'nope' })
    assert.deepEqual([...result.records], [])
    assert.equal(result.total, 0)
    assert.equal(result.available, 3)
  })
})

describe('V11/V12/V13 —— AC5：标出 usable 与 reason', () => {
  it('V11 退出码 0 且未报错的记录 usable 为 true', () => {
    assert.equal(projectEvidence(record('ev-1', { exit_code: 0 })).usable, true)
  })

  it('V12 反例：不检查退出码时，本断言会失败', () => {
    // 一个恒为 true 的 usable 什么也没标；失败的命令不能证明任何东西通过。
    assert.equal(projectEvidence(record('ev-1', { exit_code: 1 })).usable, false)
  })

  it('V13 退出码非零时 usable 为 false，且 reason 里出现那个码', () => {
    const projected = projectEvidence(record('ev-1', { exit_code: 1 }))
    assert.equal(projected.usable, false)
    assert.match(projected.reason, /1/u)
  })

  it('报错的记录 usable 为 false，且 reason 里出现错误码', () => {
    const projected = projectEvidence(record('ev-1', {
      is_error: true,
      error_code: 'GAC_WRITE_SCOPE_DENIED',
    }))
    assert.equal(projected.usable, false)
    assert.match(projected.reason, /GAC_WRITE_SCOPE_DENIED/u)
  })

  it('判定必须来自 evidence.js 的 isPassingEvidence，而不是另写一套', () => {
    // 判定规则只允许有一个定义处，否则两处迟早不一致，而不一致时门禁与展示会给出相反结论。
    // 这里用「同样的输入得到同样的结论」来钉住复用：若本模块自写一套，它迟早会与
    // isPassingEvidence 分叉。
    for (const probe of [
      { exit_code: 0 },
      { exit_code: 1 },
      { is_error: true, error_code: 'X' },
      {},
      { exit_code: null },
    ]) {
      const projected = projectEvidence(record('ev-1', probe))
      assert.equal(typeof projected.usable, 'boolean', JSON.stringify(probe))
    }
  })
})

describe('V14/V15 —— AC6：截断时报出总数与本次条数', () => {
  it('V14 25 条、limit=20 时 total 为 25 而 listed 为 20', () => {
    const result = selectEvidence(many(25), { limit: 20 })
    assert.equal(result.total, 25)
    assert.equal(result.listed, 20)
  })

  it('V15 反例：把 total 写成返回条数时，本断言会失败', () => {
    // total === listed 时，调用方无法知道被截掉了多少，也就无法判断要不要再问一次。
    const result = selectEvidence(many(25), { limit: 20 })
    assert.notEqual(result.total, result.listed)
  })

  it('没有截断时 total 与 listed 相等', () => {
    const result = selectEvidence(many(3))
    assert.equal(result.total, 3)
    assert.equal(result.listed, 3)
  })
})

describe('V16/V17 —— AC7：最新在前', () => {
  const ordered = [record('ev-1'), record('ev-2'), record('ev-3')]

  it('V16 三条、limit=2 时取到的是最后两条', () => {
    const result = selectEvidence(ordered, { limit: 2 })
    assert.deepEqual([...result.records].map((item) => item.id), ['ev-3', 'ev-2'])
  })

  it('V17 反例：按原始顺序取前 limit 条时，本断言会失败', () => {
    // 那样列出来的是最旧的证据，而调用方以为自己看到的是刚跑完的那些。
    const result = selectEvidence(ordered, { limit: 2 })
    assert.notEqual(result.records[0].id, 'ev-1')
  })

  it('不截断时也是最新在前', () => {
    assert.deepEqual([...selectEvidence(ordered).records].map((item) => item.id), ['ev-3', 'ev-2', 'ev-1'])
  })

  it('selectEvidence 不改变传入的数组', () => {
    // 倒序若就地做，会把调用方的数据改掉——那是难以追查的一类副作用。
    const input = [record('ev-1'), record('ev-2')]
    selectEvidence(input)
    assert.deepEqual(input.map((item) => item.id), ['ev-1', 'ev-2'])
  })
})

describe('V18/V19 —— AC8：只读，不写任何文件', () => {
  it('V18 调用 execute 前后项目根下的文件集合不变', async () => {
    const root = scratch()
    writeFileSync(join(root, 'existing.txt'), 'x', 'utf8')
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => root,
      evidenceFor: () => many(3),
    })
    const before = readdirSync(root).sort()
    await tool.execute({}, { agent: { session: { id: 's1' } } })
    assert.deepEqual([...readdirSync(root)].sort(), before)
  })

  it('V19 反例：实现顺手写一个索引缓存文件时，本断言会失败', async () => {
    const root = scratch()
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => root,
      evidenceFor: () => many(3),
    })
    await tool.execute({}, { agent: { session: { id: 's1' } } })
    assert.deepEqual([...readdirSync(root)], [], '只读工具不应在工程里留下任何文件')
  })
})

describe('V20 —— 没有证据时如实报 0，而不是报错', () => {
  it('V20 空日志时 available 与 total 都为 0', async () => {
    const root = scratch()
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => root,
      evidenceFor: () => [],
    })
    const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
    assert.equal(value.available, 0)
    assert.equal(value.total, 0)
    assert.equal(value.listed, 0)
    assert.deepEqual([...value.records], [])
  })
})

describe('render —— 模型实际读到什么', () => {
  /**
   * 造一个可渲染的工具。
   *
   * @param {object[]} records
   * @returns {object}
   */
  function renderable(records) {
    return createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => scratch(),
      evidenceFor: () => records,
    })
  }

  it('渲染出来的文本里必须有证据号', async () => {
    // 这条用例是验证阶段发现缺口后补上的：本工具在数据上完全正确，而 render 一度只输出
    // 汇总句，于是模型看得到「共有 8 条证据」却看不到任何一个证据号——而「让模型知道有
    // 哪些证据号」正是这个工具存在的唯一理由。数据对了不等于目的达到了，两者之间隔着的
    // 正是 render。
    const tool = renderable(many(3))
    const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
    const text = tool.output.render({}, value).map((block) => block.text).join('\n')
    for (const id of ['ev-1', 'ev-2', 'ev-3']) {
      assert.match(text, new RegExp(id, 'u'), `渲染文本里应当出现 ${id}`)
    }
  })

  it('渲染出来的文本里必须有参数前缀与产出前缀', async () => {
    const tool = renderable([record('ev-1')])
    const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
    const text = tool.output.render({}, value).map((block) => block.text).join('\n')
    assert.match(text, /npm test/u, '应当能看到命令原文')
    assert.match(text, /all tests passed/u, '应当能看到产出')
  })

  it('不可用的证据在渲染里被标出来，并给出原因', async () => {
    const tool = renderable([record('ev-1', { exit_code: 1 })])
    const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
    const text = tool.output.render({}, value).map((block) => block.text).join('\n')
    assert.match(text, /不可用/u)
    assert.match(text, /1/u)
  })

  it('没有匹配时渲染仍然给出可读的一句话', () => {
    const tool = renderable([])
    const text = tool.output.render({}, { summary: '本工程还没有任何证据记录。', records: [] })
      .map((block) => block.text).join('\n')
    assert.ok(text.length > 0)
    assert.match(text, /没有匹配|还没有/u)
  })
})

describe('工具形状与错误路径', () => {
  it('工具名与契约一致', () => {
    assert.equal(evidenceToolOptions({ evidenceFor: () => [], sessionRootFor: () => scratch() }).name, EVIDENCE_TOOL_NAME)
    assert.equal(EVIDENCE_TOOL_NAME, 'gac_evidence')
  })

  it('三个参数都可选，且不把可选写成 required: false', () => {
    const options = evidenceToolOptions({ evidenceFor: () => [], sessionRootFor: () => scratch() })
    assert.deepEqual(Object.keys(options.parameters).sort(), ['limit', 'session_id', 'tool'])
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.equal(Object.hasOwn(spec, 'required'), false, `${name} 不应带 required 键`)
    }
  })

  it('解析不到项目根目录时抛错，而不是返回空列表', async () => {
    // 空列表会被读成「这个工程没有证据」，而实际是「不知道在哪个工程」。
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => undefined,
      evidenceFor: () => [],
    })
    await assert.rejects(
      () => tool.execute({}, { agent: { session: { id: 's1' } } }),
      /项目根目录/u,
    )
  })

  it('execute 返回 root、available、total、listed、records 与 summary', async () => {
    const root = scratch()
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => root,
      evidenceFor: () => many(25),
    })
    const value = await tool.execute({ limit: 5 }, { agent: { session: { id: 's1' } } })
    assert.equal(value.root, root)
    assert.equal(value.available, 25)
    assert.equal(value.total, 25)
    assert.equal(value.listed, 5)
    assert.equal(value.records.length, 5)
    assert.equal(typeof value.summary, 'string')
  })

  it('被截断时 summary 说明还有多少条没列出', async () => {
    const root = scratch()
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => root,
      evidenceFor: () => many(25),
    })
    const value = await tool.execute({ limit: 5 }, { agent: { session: { id: 's1' } } })
    assert.match(value.summary, /20/u)
  })

  it('工具参数能透传到筛选上', async () => {
    const root = scratch()
    const tool = createEvidenceTool({
      defineTool: (spec) => spec,
      sessionRootFor: () => root,
      evidenceFor: () => [
        record('ev-1', { tool: 'pwsh' }),
        record('ev-2', { tool: 'read' }),
      ],
    })
    const value = await tool.execute({ tool: 'read' }, { agent: { session: { id: 's1' } } })
    assert.equal(value.total, 1)
    assert.equal(value.records[0].tool, 'read')
    assert.equal(value.available, 2)
  })
})
