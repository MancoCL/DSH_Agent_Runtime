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

describe('工具形状', () => {
  it('名字便于模型找到它', () => {
    assert.equal(PROJECT_TOOL_NAME, 'gac_project')
    assert.equal(harness(scratch(), VALID_ADAPTER).tool.name, 'gac_project')
  })

  it('恰好提供四种执行模式，因此这架阶梯是闭合的', () => {
    const options = projectToolOptions({ state: new ProjectState() })
    assert.deepEqual([...options.parameters.mode.enum], [...EXECUTION_MODES])
  })

  it('陈述每一级的后果，而不只是它的名字', () => {
    const { tool } = harness(scratch(), VALID_ADAPTER)
    // 「standard_task」单独一个词说明不了什么；「由独立验证者检查结果」才是模型
    // 能据以推理的东西。
    assert.match(tool.description, /不创建任务记录/u)
    assert.match(tool.description, /独立验证者/u)
    assert.match(tool.description, /验证计划/u)
    assert.match(tool.description, /最低\*\*的够用模式/u)
  })

  it('告诉模型不要去抢先规避升级门禁', () => {
    const { tool } = harness(scratch(), VALID_ADAPTER)
    assert.match(tool.description, /不要试图抢先规避/u)
  })

  it('声明了它读取的每一个参数，且没有一个是必填的', () => {
    const options = projectToolOptions({ state: new ProjectState() })
    assert.deepEqual(
      Object.keys(options.parameters).sort(),
      ['ambiguous', 'irreversible', 'mode', 'reason', 'target_paths'],
    )
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.equal(Object.hasOwn(spec, 'required'), false, `${name} 必须省略 required 键`)
    }
  })
})

describe('检视', () => {
  it('呈现适配器、它的高风险路径与它的能力', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({}, exec)
    assert.equal(value.governed, true)
    assert.equal(value.project_id, 'proj')
    assert.deepEqual(value.high_risk_paths, ['src/auth/'])
    assert.deepEqual(value.capabilities, ['implementation'])
    assert.match(value.summary, /Proj/u)
  })

  it('直白说明没有适配器的工程处于无管辖状态', async () => {
    const { tool, exec } = harness(scratch(), undefined)
    const value = await tool.execute({}, exec)
    assert.equal(value.governed, false)
    assert.equal(value.adapter_status, 'absent')
    assert.match(value.summary, /无管辖状态/u)
  })

  it('把无效适配器报成无效，而不是假装根本没有适配器', async () => {
    const { tool, exec } = harness(scratch(), '{ broken')
    const value = await tool.execute({}, exec)
    assert.equal(value.adapter_status, 'invalid')
    assert.match(value.summary, /不是合法 JSON/u)
  })

  it('在声明了模式时报告当前模式', async () => {
    const root = scratch()
    const { tool, exec } = harness(root, VALID_ADAPTER)
    await tool.execute({ mode: 'standard_task', reason: '普通缺陷修复' }, exec)
    const value = await tool.execute({}, exec)
    assert.equal(value.mode, 'standard_task')
    assert.match(value.summary, /当前模式：standard_task/u)
  })
})

describe('声明模式', () => {
  it('记录一次声明，并说明它承诺了什么', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({
      mode: 'standard_task',
      reason: '普通缺陷修复',
      target_paths: ['src/feature.c'],
    }, exec)
    assert.equal(value.mode, 'standard_task')
    assert.equal(value.escalated, false)
    assert.match(value.summary, /独立验证者/u)
  })

  it('把高风险目标升级，并把这件事说出来', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({
      mode: 'direct_edit',
      reason: '调整一处比较',
      target_paths: ['src/auth/token.c'],
    }, exec)
    assert.equal(value.mode, 'high_risk_task')
    assert.equal(value.escalated, true)
    assert.equal(value.escalated_from, 'direct_edit')
    assert.match(value.summary, /已从 direct_edit 升级为 high_risk_task/u)
    assert.match(value.summary, /验证计划/u)
  })

  it('说明 direct_edit 不创建任务记录', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({
      mode: 'direct_edit',
      reason: '改一个常量',
      target_paths: ['config/app.json'],
    }, exec)
    assert.match(value.summary, /这一级别不创建任务记录/u)
  })

  it('标出它无法核对的那次声明，而不是暗示自己核对过了', async () => {
    const { tool, exec } = harness(scratch(), undefined)
    const value = await tool.execute({ mode: 'standard_task', reason: '缺陷修复' }, exec)
    assert.match(value.summary, /没有\*\*与高风险路径做交叉检查/u)
  })

  it('在没有可解析工程根目录时拒绝声明模式', async () => {
    const root = scratch()
    const h = harness(root, VALID_ADAPTER)
    h.setRoot(undefined)
    await assert.rejects(
      () => h.tool.execute({ mode: 'direct_edit' }, h.exec),
      /无法声明模式/u,
    )
  })

  it('用一句话检视没有根目录的会话，而不是抛 TypeError', async () => {
    // 更早的版本在检视时解引用了缺席的适配器，于是把异常抛给模型，而不是把情况
    // 说清楚。
    const root = scratch()
    const h = harness(root, VALID_ADAPTER)
    h.setRoot(undefined)
    const value = await h.tool.execute({}, h.exec)
    assert.equal(value.governed, false)
    assert.equal(value.adapter_status, 'unresolvable')
    assert.deepEqual(value.high_risk_paths, [])
    assert.match(value.summary, /没有可解析出的工程根目录/u)
  })

  it('拒绝未知的模式', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    await assert.rejects(
      () => tool.execute({ mode: 'quick_fix' }, exec),
      (error) => error.code === 'GAC_UNKNOWN_EXECUTION_MODE',
    )
  })

  it('要求一个拥有它的会话', async () => {
    const { tool } = harness(scratch(), VALID_ADAPTER)
    await assert.rejects(() => tool.execute({}, {}), /智能体会话/u)
  })

  it('把空的模式当作检视，而不是当作声明', async () => {
    const { tool, exec } = harness(scratch(), VALID_ADAPTER)
    const value = await tool.execute({ mode: '' }, exec)
    assert.equal(value.mode, undefined)
    assert.equal(value.governed, true)
  })
})

describe('升级会被记录下来以备审计', () => {
  it('把声明的模式与最终解析出的模式并列保留', async () => {
    const { tool, state, exec } = harness(scratch(), VALID_ADAPTER)
    await tool.execute({
      mode: 'direct_edit',
      reason: '改一处比较',
      target_paths: ['src/auth/token.c'],
    }, exec)
    const recorded = state.modeFor('session-1')
    // 两个事实都保留下来：当初声称的是什么，以及它变成了什么。
    assert.equal(recorded.declared_mode, 'direct_edit')
    assert.equal(recorded.mode, 'high_risk_task')
    assert.equal(recorded.escalated, true)
  })
})
