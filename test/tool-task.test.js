/**
 * `gac_task` 工具测试。
 *
 * 这里最要紧的一条是接口层能不能守住协调器的核心保证：**执行者不宣告完成**。所以测试
 * 不只检查「回报后被接受」，更要检查「没带执行身份的回报不会推进状态」——那是这条
 * 保证在工具边界上唯一的落点。
 *
 * `defineTool` 用恒等替身：本套件测的是工具自身行为，运行时那套参数校验另有专门测试。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { TaskStore } from '../lib/task-store.js'
import { TASK_TOOL_NAME, createTaskTool, taskToolOptions } from '../lib/tool-task.js'

const identityDefineTool = (options) => options

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时项目根，套件结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-task-tool-'))
  scratchRoots.push(root)
  return root
}

/** 一份两节点的标准计划：实现随后验证。 */
function standardPlan() {
  return {
    nodes: [
      {
        id: 'T1',
        objective: '实现功能',
        required_capabilities: ['implementation'],
        write_scope: ['src/'],
      },
      {
        id: 'T2',
        objective: '独立验证',
        depends_on: ['T1'],
        required_capabilities: ['verification'],
        write_scope: [],
      },
    ],
  }
}

/**
 * 一个接在临时项目上的工具实例。
 *
 * @returns {{tool: object, store: TaskStore, exec: object}}
 */
function harness() {
  const store = new TaskStore({ root: scratch() })
  const tool = createTaskTool({
    defineTool: identityDefineTool,
    taskStoreFor: () => store,
    sessionRootFor: () => store.root,
  })
  return { tool, store, exec: { agent: { session: { id: 'session-1' } } } }
}

/**
 * 建一个标准任务并返回工具返回体。
 *
 * @param {object} h
 * @returns {Promise<object>}
 */
async function createStandard(h) {
  return h.tool.execute({
    action: 'create',
    task_id: 'REQ-1',
    mode: 'standard_task',
    plan: standardPlan(),
  }, h.exec)
}

describe('工具形状', () => {
  it('名字固定', () => {
    assert.equal(TASK_TOOL_NAME, 'gac_task')
    assert.equal(harness().tool.name, 'gac_task')
  })

  it('把「你不能宣告完成」写进描述，而不是留给模型猜', () => {
    const { tool } = harness()
    assert.match(tool.description, /你不能宣告完成/u)
    assert.match(tool.description, /dispatch_id/u)
    assert.match(tool.description, /终态/u)
  })

  it('列出全部动作，且不声明任何必填参数', () => {
    const store = new TaskStore({ root: scratch() })
    const options = taskToolOptions({ taskStoreFor: () => store, sessionRootFor: () => store.root })
    assert.deepEqual([...options.parameters.action.enum], [
      'create', 'advance', 'reopen', 'status', 'list',
    ])
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.equal(Object.hasOwn(spec, 'required'), false, `${name} 不应带 required 键`)
    }
  })

  it('会话没有可解析的项目根时明确报错，而不是假装记录了任务', async () => {
    // 任务按项目存放；解析不到根目录时，静默失败会让模型以为任务已被记录。
    const tool = createTaskTool({
      defineTool: identityDefineTool,
      taskStoreFor: () => undefined,
      sessionRootFor: () => undefined,
    })
    await assert.rejects(
      () => tool.execute({ action: 'list' }, { agent: { session: { id: 's' } } }),
      /无法定位任务记录/u,
    )
  })
})

describe('create', () => {
  it('建立任务并给出下一步', async () => {
    const h = harness()
    const value = await createStandard(h)
    assert.equal(value.action, 'created')
    assert.equal(value.task_id, 'REQ-1')
    assert.deepEqual(value.nodes, ['T1'], 'T1 无依赖，应当先派')
    assert.match(value.message, /T1/u)
  })

  it('落盘，因此重载后任务仍在', async () => {
    const h = harness()
    await createStandard(h)
    const reloaded = new TaskStore({ root: h.store.root }).load('REQ-1')
    assert.equal(reloaded.task_id, 'REQ-1')
    assert.equal(reloaded.nodes.size, 2)
  })

  it('同 ID 拒绝覆盖', async () => {
    const h = harness()
    await createStandard(h)
    await assert.rejects(() => createStandard(h), /已存在/u)
  })

  it('拒绝缺少 plan', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'create', task_id: 'REQ-1' }, h.exec),
      /需要 plan/u,
    )
  })

  it('拒绝有环的计划', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-1',
        plan: {
          nodes: [
            { id: 'A', objective: 'a', required_capabilities: ['implementation'], write_scope: [], depends_on: ['B'] },
            { id: 'B', objective: 'b', required_capabilities: ['implementation'], write_scope: [], depends_on: ['A'] },
          ],
        },
      }, h.exec),
      (error) => error.code === 'GAC_DAG_CYCLE',
    )
  })
})

describe('advance — 不能宣告完成', () => {
  it('第一次推进给出派遣，并铸造执行身份', async () => {
    const h = harness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'dispatch')
    assert.deepEqual(value.nodes, ['T1'])
    // 派遣身份必须在盘上，因为回报时要拿它对齐。
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, 'REQ-1-T1-A1')
  })

  it('派遣后进入等待，而不是重复派遣', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.action, 'await')
    assert.deepEqual(value.nodes, ['T1'])
  })

  it('带对了执行身份的结果被接受，并推进到下一节点', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    assert.deepEqual(value.classifications, ['accepted'])
    // T1 完成后 T2 就绪，同一轮里应当被派遣。
    assert.equal(value.action, 'dispatch')
    assert.deepEqual(value.nodes, ['T2'])
  })

  it('身份对不上的结果被判过期，且一个字节都不改', async () => {
    // 这条是「执行者不宣告完成」在接口上的落点：没有正确身份，说什么都不推进。
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A0', status: 'completed' },
    }, h.exec)
    assert.deepEqual(value.classifications, ['stale'])
    assert.match(value.message, /未被接受/u)
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').status, 'in_progress', '状态不得被过期结果推进')
  })

  it('完全不传 dispatch_id 也不推进状态', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', status: 'completed' },
    }, h.exec)
    assert.deepEqual(value.classifications, ['stale'])
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'in_progress')
  })

  it('两个节点依次完成后给出收口', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T2', dispatch_id: 'REQ-1-T2-A1', status: 'completed' },
    }, h.exec)
    assert.equal(value.action, 'complete_task')
    assert.match(value.message, /可以收口/u)
  })

  it('节点失败时给出修复', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'failed' },
    }, h.exec)
    assert.equal(value.action, 'repair')
    assert.deepEqual(value.nodes, ['T1'])
  })

  it('终态节点不会被迟到结果动摇', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    const value = await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    assert.notEqual(value.classifications[0], 'accepted')
    assert.equal(h.store.load('REQ-1').nodes.get('T1').status, 'completed')
  })

  it('找不到任务时提示先建任务，而不是自动建一个', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'advance', task_id: 'REQ-absent' }, h.exec),
      /找不到任务/u,
    )
  })
})

describe('reopen', () => {
  it('重新打开已完成的节点，并作废其执行身份', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'completed' },
    }, h.exec)
    const value = await h.tool.execute({
      action: 'reopen',
      task_id: 'REQ-1',
      node_id: 'T1',
      reason: '发现范围需要扩张',
    }, h.exec)
    assert.equal(value.action, 'reopened')
    assert.deepEqual(value.nodes, ['T1'])
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').status, 'pending')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, null)
  })

  it('重新打开后的下一次派遣铸造新身份，不复用旧的', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    await h.tool.execute({
      action: 'advance',
      task_id: 'REQ-1',
      report: { node_id: 'T1', dispatch_id: 'REQ-1-T1-A1', status: 'failed' },
    }, h.exec)
    await h.tool.execute({ action: 'reopen', task_id: 'REQ-1', node_id: 'T1', reason: '换做法' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const task = h.store.load('REQ-1')
    assert.equal(task.nodes.get('T1').execution.active_dispatch_id, 'REQ-1-T1-A2')
  })

  it('拒绝没有原因的重新打开', async () => {
    const h = harness()
    await createStandard(h)
    await assert.rejects(
      () => h.tool.execute({ action: 'reopen', task_id: 'REQ-1', node_id: 'T1' }, h.exec),
      /原因/u,
    )
  })
})

describe('status 与 list', () => {
  it('status 报出每个节点的状态与下一步', async () => {
    const h = harness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'status', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.status, 'pending')
    assert.deepEqual(value.nodes, ['T1:pending', 'T2:pending'])
    assert.match(value.message, /下一步/u)
  })

  it('status 在派遣后反映执行中', async () => {
    const h = harness()
    await createStandard(h)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-1' }, h.exec)
    const value = await h.tool.execute({ action: 'status', task_id: 'REQ-1' }, h.exec)
    assert.equal(value.status, 'in_progress')
    assert.deepEqual(value.nodes, ['T1:in_progress', 'T2:pending'])
  })

  it('list 列出全部任务', async () => {
    const h = harness()
    await createStandard(h)
    const value = await h.tool.execute({ action: 'list' }, h.exec)
    assert.deepEqual(value.tasks, ['REQ-1'])
  })

  it('没有任务时 list 如实说明', async () => {
    const h = harness()
    const value = await h.tool.execute({ action: 'list' }, h.exec)
    assert.deepEqual(value.tasks, [])
    assert.match(value.message, /还没有任务记录/u)
  })

  it('缺少 task_id 时报错，而不是猜一个', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'status' }, h.exec),
      /需要 task_id/u,
    )
  })

  it('未知动作被拒', async () => {
    const h = harness()
    await assert.rejects(
      () => h.tool.execute({ action: 'obliterate', task_id: 'REQ-1' }, h.exec),
      /未知动作/u,
    )
  })
})
