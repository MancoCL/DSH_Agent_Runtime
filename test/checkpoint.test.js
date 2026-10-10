/**
 * 长会话上下文保护：**可恢复检查点**。
 *
 * 主会话的上下文会被压缩、清空，甚至换成另一个会话；任务记录不会。这一组钉的是：
 * `status` 里那段检查点完全从盘上的任务记录派生（因此新会话照旧能续上，不依赖任何内存状态），
 * 而且它把四件事一次讲清楚——已完成什么、还差什么、当前有效派遣是谁、下一步做什么。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '../lib/task-store.js'
import { applyResult, dispatch, markDispatchProgress } from '../lib/coordinator.js'
import { createTaskTool } from '../lib/tool-task.js'

/**
 * 一个最小可用的任务工具：一个项目根、一个存储、一个会话身份。
 *
 * @param {object} [options]
 * @param {string} [options.sessionId]
 * @returns {{root: string, store: object, tool: object, exec: object}}
 */
function fixture({ sessionId = 'owner' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gac-checkpoint-'))
  const store = new TaskStore({ root })
  const tool = createTaskTool({
    defineTool: (value) => value,
    taskStoreFor: () => store,
    sessionRootFor: () => root,
    adapterFor: () => ({}),
    executorsFor: () => [],
  })
  return { root, store, tool, exec: { agent: { session: { id: sessionId } } } }
}

/**
 * 建一个有若干个节点的任务（写范围互不相交，免得被写范围冲突拦下）。
 *
 * @param {object} tool
 * @param {object} exec
 * @param {string} taskId
 * @param {number} [count]
 * @returns {Promise<object>}
 */
function createTask(tool, exec, taskId, count = 3) {
  return tool.execute({
    action: 'create',
    task_id: taskId,
    plan: {
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `n${index + 1}`,
        objective: `实现 n${index + 1}`,
        required_capabilities: ['implementation'],
        write_scope: [`src/n${index + 1}.js`],
      })),
    },
  }, exec)
}

describe('可恢复检查点 —— 新会话依盘上状态继续', () => {
  it('status 把「已完成 / 未完成 / 当前有效派遣 / 下一步」一次讲清', async () => {
    const { root, store, tool, exec } = fixture()
    try {
      await createTask(tool, exec, 'k1')
      // n1：派遣过一次、已完成，留下结果引用（证据 = `child-session:…`）。
      store.save(applyResult(dispatch(store.load('k1'), ['n1'], undefined, null, { ownerSessionId: 'owner', at: 1000 }), {
        node_id: 'n1',
        dispatch_id: 'k1-n1-A1',
        status: 'completed',
        result_ref: 'child-session:c1',
      }).task)
      // n2：正在执行，且有真实的派遣身份与子会话身份（重启后要据它去问宿主）。
      const dispatched = dispatch(store.load('k1'), ['n2'], undefined, null, { ownerSessionId: 'owner', at: 2000 })
      store.save(markDispatchProgress(dispatched, 'n2', 'k1-n2-A1', 'running', { child_session_id: 'child-42' }))

      const status = await tool.execute({ action: 'status', task_id: 'k1' }, exec)
      assert.match(status.message, /检查点：已完成 1\/3（n1\(child-session:c1\)）/u)
      assert.match(status.message, /未完成：n2\(in_progress，A1，dispatch=k1-n2-A1，子会话=child-42\)、n3\(pending，A0\)/u)
      assert.match(status.message, /当前有效派遣 1 个（n2=k1-n2-A1）/u)
      assert.match(status.message, /下一步：/u)
      // 状态数组保持既有形状，检查点只进文本。
      assert.deepEqual(status.nodes, ['n1:completed', 'n2:in_progress', 'n3:pending'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('新会话（另一个 Session、另一个工具实例）读同一份记录就能续上', async () => {
    const first = fixture({ sessionId: 'session-old' })
    try {
      await createTask(first.tool, first.exec, 'k2')
      first.store.save(dispatch(first.store.load('k2'), ['n1'], undefined, null, { ownerSessionId: 'session-old', at: 1000 }))

      // 换会话：新的工具实例、新的 sessionId，没有任何内存状态被带过去。
      const second = { tool: createTaskTool({
        defineTool: (value) => value,
        taskStoreFor: () => first.store,
        sessionRootFor: () => first.root,
        adapterFor: () => ({}),
        executorsFor: () => [],
      }), exec: { agent: { session: { id: 'session-new' } } } }
      const status = await second.tool.execute({ action: 'status', task_id: 'k2' }, second.exec)

      assert.match(status.message, /检查点：已完成 0\/3（无）/u)
      assert.match(status.message, /n1\(in_progress，A1，dispatch=k2-n1-A1\)/u)
      assert.match(status.message, /当前有效派遣 1 个（n1=k2-n1-A1）/u)
      assert.equal(status.status, 'in_progress')
    } finally { rmSync(first.root, { recursive: true, force: true }) }
  })

  it('诊断与检查点并存：失败节点的码同时出现在「已记录的失败」与检查点里', async () => {
    const { root, store, tool, exec } = fixture()
    try {
      await createTask(tool, exec, 'k3')
      store.save(applyResult(dispatch(store.load('k3'), ['n1'], undefined, null, { ownerSessionId: 'owner', at: 1000 }), {
        node_id: 'n1',
        dispatch_id: 'k3-n1-A1',
        status: 'failed',
        blocked_by: ['GAC_CHILD_START_FAILED'],
        detail: '宿主没有可用的 provider',
        stage: 'child_start',
        retryable: true,
        at: 1500,
      }).task)
      const status = await tool.execute({ action: 'status', task_id: 'k3' }, exec)
      assert.match(status.message, /已记录的失败\/未知：n1 GAC_CHILD_START_FAILED/u)
      assert.match(status.message, /未完成：n1\(failed，A1，GAC_CHILD_START_FAILED\)/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('检查点有界：节点多的时候按上限截断，不把整份任务记录塞回上下文', async () => {
    const { root, tool, exec } = fixture()
    try {
      await createTask(tool, exec, 'k4', 10)
      const status = await tool.execute({ action: 'status', task_id: 'k4' }, exec)
      assert.match(status.message, /检查点：已完成 0\/10（无）/u)
      assert.match(status.message, /等共 10 个/u)
      assert.ok(status.message.length < 2000, `检查点必须有界，实际 ${status.message.length} 字符`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
