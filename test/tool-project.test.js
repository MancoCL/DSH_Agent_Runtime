/**
 * `gac_project` 工具测试。
 *
 * 这个工具把执行模式阶梯带到模型面前，所以这些测试检查两类事情：声明是否被正确
 * 记录并升级，以及面向模型的文本是否真的说明了每一级的后果。模型无法据以行动的
 * 模式词汇表，就是一份它只能靠猜的词汇表。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { EXECUTION_MODES } from '../lib/project.js'
import { ProjectState } from '../lib/project-state.js'
import { PROJECT_TOOL_NAME, createProjectTool, projectToolOptions } from '../lib/tool-project.js'

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

const VALID_ADAPTER = JSON.stringify({
  project: { id: 'proj', title: 'Proj' },
  capabilities: ['implementation'],
  executors: { implementation: ['builder'] },
  risk: { high_risk_paths: ['src/auth/'] },
})

/**
 * 用桩掉的编写辅助函数和一个固定的工程根目录构建该工具。
 *
 * @param {string|undefined} root - undefined 表示一个无法解析的根目录。
 * @param {string|undefined} adapterText
 * @returns {{tool: object, exec: object, state: ProjectState}}
 */
function harness(root, adapterText) {
  let resolvedRoot = root
  if (adapterText !== undefined && root !== undefined) {
    mkdirSync(join(root, '.dsh', 'gac'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'gac', 'project.json'), adapterText, 'utf8')
  }
  const state = new ProjectState({ resolveRoot: () => resolvedRoot })
  const tool = createProjectTool({ state, defineTool: (options) => options })
  assert.equal(typeof tool.execute, 'function')
  return {
    tool,
    state,
    exec: { agent: { session: { id: 'session-1' } } },
    setRoot: (next) => { resolvedRoot = next },
  }
}

/** 一个临时工程根目录，测试集结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-tool-project-'))
  scratchRoots.push(root)
  return root
}

describe('tool shape', () => {
  it('is named for the model to find', () => {
    assert.equal(PROJECT_TOOL_NAME, 'gac_project')
    assert.equal(harness(scratch(), VALID_ADAPTER).tool.name, 'gac_project')
  })

  it('offers exactly the four execution modes, so the ladder is closed', () => {
    const options = projectToolOptions({ state: new ProjectState() })
    assert.deepEqual([...options.parameters.mode.enum], [...EXECUTION_MODES])
  })

  it('states the consequence of each mode, not just its name', () => {
    const { tool } = harness(scratch(), VALID_ADAPTER)
    // 「standard_task」单独一个词说明不了什么；「由独立验证者检查结果」才是模型
    // 能据以推理的东西。
    assert.match(tool.description, /no task record is created/iu)
    assert.match(tool.description, /independent verifier/iu)
    assert.match(tool.description, /verification plan/iu)
    assert.match(tool.description, /LOWEST sufficient mode/iu)
  })

  it('tells the model not to pre-empt the escalation gate', () => {
    const { tool } = harness(scratch(), VALID_ADAPTER)
    assert.match(tool.description, /do not try to pre-empt/iu)
  })

  it('declares every parameter it reads, none of them required', () => {
    const options = projectToolOptions({ state: new ProjectState() })
    assert.deepEqual(
      Object.keys(options.parameters).sort(),
      ['ambiguous', 'irreversible', 'mode', 'reason', 'target_paths'],
    )
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.equal(Object.hasOwn(spec, 'required'), false, `${name} must omit the required key`)
    }
  })
})

describe('inspection', () => {
  it('surfaces the adapter, its high-risk paths and its capabilities', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({}, exec)
    assert.equal(value.governed, true)
    assert.equal(value.project_id, 'proj')
    assert.deepEqual(value.high_risk_paths, ['src/auth/'])
    assert.deepEqual(value.capabilities, ['implementation'])
    assert.match(value.summary, /Proj/u)
  })

  it('says plainly that an adapter-less project is ungoverned', async () => {
    const { tool, exec } = harness(scratch(), undefined)
    const value = await tool.execute({}, exec)
    assert.equal(value.governed, false)
    assert.equal(value.adapter_status, 'absent')
    assert.match(value.summary, /ungoverned/u)
  })

  it('reports an invalid adapter rather than pretending there is none', async () => {
    const { tool, exec } = harness(scratch(), '{ broken')
    const value = await tool.execute({}, exec)
    assert.equal(value.adapter_status, 'invalid')
    assert.match(value.summary, /not valid JSON/u)
  })

  it('reports the current mode when one is declared', async () => {
    const root = scratch()
    const { tool, exec } = harness(root, VALID_ADAPTER)
    await tool.execute({ mode: 'standard_task', reason: 'ordinary bugfix' }, exec)
    const value = await tool.execute({}, exec)
    assert.equal(value.mode, 'standard_task')
    assert.match(value.summary, /Current mode: standard_task/u)
  })
})

describe('declaring a mode', () => {
  it('records a declaration and explains what it commits to', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({
      mode: 'standard_task',
      reason: 'ordinary bugfix',
      target_paths: ['src/feature.c'],
    }, exec)
    assert.equal(value.mode, 'standard_task')
    assert.equal(value.escalated, false)
    assert.match(value.summary, /independent verifier/iu)
  })

  it('escalates a high-risk target and says so', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({
      mode: 'direct_edit',
      reason: 'tweak one comparison',
      target_paths: ['src/auth/token.c'],
    }, exec)
    assert.equal(value.mode, 'high_risk_task')
    assert.equal(value.escalated, true)
    assert.equal(value.escalated_from, 'direct_edit')
    assert.match(value.summary, /Escalated from direct_edit/u)
    assert.match(value.summary, /verification plan/iu)
  })

  it('says a direct_edit creates no task record', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({
      mode: 'direct_edit',
      reason: 'one constant',
      target_paths: ['config/app.json'],
    }, exec)
    assert.match(value.summary, /No task record is created/u)
  })

  it('flags a declaration it could not check, rather than implying it did', async () => {
    const { tool, exec } = harness(scratch(), undefined)
    const value = await tool.execute({ mode: 'standard_task', reason: 'bugfix' }, exec)
    assert.match(value.summary, /NOT cross-checked/u)
  })

  it('refuses to declare a mode with no resolvable project root', async () => {
    const root = scratch()
    const h = harness(root, VALID_ADAPTER)
    h.setRoot(undefined)
    await assert.rejects(
      () => h.tool.execute({ mode: 'direct_edit' }, h.exec),
      /no resolvable project root/u,
    )
  })

  it('inspects a rootless session with a sentence, not a TypeError', async () => {
    // 更早的版本在检视时解引用了缺席的适配器，于是把异常抛给模型，而不是把情况
    // 说清楚。
    const root = scratch()
    const h = harness(root, VALID_ADAPTER)
    h.setRoot(undefined)
    const value = await h.tool.execute({}, h.exec)
    assert.equal(value.governed, false)
    assert.equal(value.adapter_status, 'unresolvable')
    assert.deepEqual(value.high_risk_paths, [])
    assert.match(value.summary, /no resolvable project root/u)
  })

  it('rejects an unknown mode', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    await assert.rejects(
      () => tool.execute({ mode: 'quick_fix' }, exec),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('requires an owning session', async () => {
    const { tool } = harness(scratch(), VALID_ADAPTER)
    await assert.rejects(() => tool.execute({}, {}), /session/u)
  })

  it('treats an empty mode as inspection, not as a declaration', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({ mode: '' }, exec)
    assert.equal(value.mode, undefined)
    assert.equal(value.governed, true)
  })
})

describe('escalation is recorded for auditing', () => {
  it('keeps the declared mode alongside the resolved one', async () => {
    const { tool, state, exec } = harness(scratch(), VALID_ADAPTER)
    await tool.execute({
      mode: 'direct_edit',
      reason: 'one comparison',
      target_paths: ['src/auth/token.c'],
    }, exec)
    const recorded = state.modeFor('session-1')
    // 两个事实都保留下来：当初声称的是什么，以及它变成了什么。
    assert.equal(recorded.declared_mode, 'direct_edit')
    assert.equal(recorded.mode, 'high_risk_task')
    assert.equal(recorded.escalated, true)
  })
})
