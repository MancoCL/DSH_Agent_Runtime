/**
 * 「核心 + 收权器」这条接线的测试。
 *
 * 为什么它必须存在
 * --------------
 * 这两件东西曾经各自都在，却**没有连上**：`createGacCore` 没拿到 `roleGuard`，于是收权降级到
 * `guard-only`（工具收不掉，只剩守卫兜底）时，兜底那一层根本不存在——`write` 照写不误。914 条单测
 * 全绿，因为没有任何一条走到这条接线上。
 *
 * 暴露它的是一次**活体实测**（由子 agent 在真实会话里跑）：两次本该被拦的写入都成功了，`write`
 * 从未离开工具面；插件报告里只有 `role-revocation-failed` + `role-restricted`，`denied_writes` 仍是 0。
 * 这条测试把那一幕钉住：**只要核心没接到收权器，它就会红。**
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRuntime } from '../lib/index.js'

/** 本文件里所有用例共用的会话 id。 */
const SESSION = 'session-live-e2e'

/** 一份够用的工具视野：全局与 agent 视野相同（差别另有用例覆盖）。 */
const NAMES = ['read', 'write', 'edit', 'pwsh', 'gac_task', 'gac_scope']

/**
 * 造一套核心 + 收权器，工具视野是假的，其余走真代码。
 *
 * @returns {{runtime: object, events: object[]}}
 */
function runtimeOf() {
  const events = []
  const runtime = createRuntime({
    rootOf: () => 'D:/work/proj',
    toolsFor: () => ({
      schemas: () => NAMES.map((name) => ({ name })),
      restrict: () => () => {},
    }),
    onEvent: (record) => events.push(record),
  })
  return { runtime, events }
}

/**
 * 一次工具调用。
 *
 * @param {string} name
 * @param {object} [args]
 * @returns {object}
 */
function exec(name, args = {}) {
  return { callId: 'c1', name, arguments: args, agent: { session: { id: SESSION } } }
}

describe('createRuntime —— 收权器必须真的接在核心上', () => {
  it('只读角色在飞时，守卫拒绝写入', () => {
    // 这一条就是活体实测里失掉的那一步：收权没生效、兜底也不存在，于是写入成功。
    const { runtime } = runtimeOf()
    runtime.roleGuard.sync({
      sessionId: SESSION,
      taskId: 'REQ-LIVE',
      readOnlyNodes: ['T1'],
      agent: {},
    })
    const verdict = runtime.core.preExecute(exec('write', { file_path: 'src/a.c' }))
    assert.equal(verdict.kind, 'deny')
    assert.equal(verdict.info.code, 'GAC_READ_ONLY_ROLE_DENIED')
    assert.match(verdict.reason, /T1/u)
  })

  it('收权期间运行时工具仍可用：只读的意思是「不写产品文件」，不是「不能说话」', () => {
    const { runtime } = runtimeOf()
    runtime.roleGuard.sync({ sessionId: SESSION, taskId: 'REQ-LIVE', readOnlyNodes: ['T1'], agent: {} })
    for (const name of ['gac_task', 'gac_scope', 'read']) {
      assert.equal(runtime.core.preExecute(exec(name)).kind, 'allow', `${name} 必须仍可用`)
    }
  })

  it('shell 默认仍可用（验证者要靠它跑用例留证据）', () => {
    const { runtime } = runtimeOf()
    runtime.roleGuard.sync({ sessionId: SESSION, taskId: 'REQ-LIVE', readOnlyNodes: ['T1'], agent: {} })
    assert.equal(runtime.core.preExecute(exec('pwsh', { command: 'npm test' })).kind, 'allow')
  })

  it('节点回报之后收权解除，写入立刻放行', () => {
    // 撤不掉就是「把用户关在门外」。这里的路径就是 tool-task 在每次状态变化时走的那一条。
    const { runtime } = runtimeOf()
    runtime.roleGuard.sync({ sessionId: SESSION, taskId: 'REQ-LIVE', readOnlyNodes: ['T1'], agent: {} })
    assert.equal(runtime.core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'deny')
    runtime.roleGuard.sync({ sessionId: SESSION, taskId: 'REQ-LIVE', readOnlyNodes: [], agent: {} })
    assert.equal(runtime.core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'allow')
  })

  it('别的会话不受影响', () => {
    const { runtime } = runtimeOf()
    runtime.roleGuard.sync({ sessionId: SESSION, taskId: 'REQ-LIVE', readOnlyNodes: ['T1'], agent: {} })
    const other = {
      callId: 'c2',
      name: 'write',
      arguments: { file_path: 'src/a.c' },
      agent: { session: { id: 'session-other' } },
    }
    assert.equal(runtime.core.preExecute(other).kind, 'allow')
  })
})
