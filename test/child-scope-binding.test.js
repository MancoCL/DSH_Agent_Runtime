/**
 * 子会话的权限绑定：**Authority must be bound by the Runtime, never self-declared by the executor.**
 *
 * 为什么这个文件存在
 * ------------------
 * 阶段 2 把 `gac_*` 从子会话工具面里收掉（子会话不该碰父会话的协调状态），但**没有补上运行时那一侧的绑定**：
 * 全仓库 `declareScope` 只从 `lib/tool-scope.js`（也就是 `gac_scope` 工具）调用，而 `lib/plugin.js`
 * 的守卫在「这个会话没有声明」时是 `{kind: 'allow'}`。于是**严格写作用域管不到子会话的写入**——
 * 子会话只被 persona 的措辞与工具面约束，写 `b.txt` 与写 `a.txt` 一样畅通。活体验收里那个
 * `write` 探针能落地，正是这条缺口的表现。
 *
 * 设计要点：绑定不是守卫旁边的第二张表
 * ----------------------------------
 * 守卫的判定逻辑（PTC 外层放行、shell 整体拒绝、运行时工具放行、未知工具失败即拒、按路径查作用域）
 * 已经齐了，而且以**会话**为键读 `SessionScopeRegistry`。所以绑定做的是「运行时代替子会话调一次
 * `registry.declare`」——两条来源（运行时绑定 / 会话自报）走同一条判定，差别只在 `origin` 与拒因里
 * 的身份字段。本文件因此让守卫与绑定**共用同一张注册表**。
 *
 * 一条必须写下来的语义（对照 `lib/plugin.js`）
 * ------------------------------------------
 * 「生效中的写作用域会整体拒绝 shell」。因此**只给 `write_scope` 非空的节点绑**：把空 scope 绑给
 * 验证者，会顺手把它的 shell 拿走，而独立验证要靠 shell 逐条执行计划用例——那是把验证者的能力
 * 拿掉，不是收窄它的权限。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createChildBindings } from '../lib/child-binding.js'
import { createChildExecutor } from '../lib/child-executor.js'
import { GAC_CODES, createGacCore } from '../lib/plugin.js'
import { SessionScopeRegistry } from '../lib/session-scope.js'

const ROOT = 'D:/work/proj'
const CHILD = 'child-session-1'

/**
 * 一份只带注册表的绑定（注册表级的用例用它）。
 *
 * @returns {object}
 */
function newBindings() {
  return createChildBindings({ registry: new SessionScopeRegistry() })
}

/**
 * 守卫 + 绑定，共用同一张作用域注册表。
 *
 * @returns {{core: object, bindings: object}}
 */
function governed() {
  const core = createGacCore({ resolveRoot: () => ROOT })
  const bindings = createChildBindings({ registry: core.registry })
  return { core, bindings }
}

/**
 * 构造一个 `ToolExecution` 形状的对象（与 `dsh-tools` 在 pre-execute 时呈现的一致）。
 *
 * @param {object} input
 * @returns {object}
 */
function execution({ sessionId, name, args }) {
  return { agent: { session: { id: sessionId } }, name, arguments: args }
}

/**
 * 绑一个写文件的子会话。
 *
 * @param {object} bindings
 * @param {object} [overrides]
 * @returns {object|undefined}
 */
function bindWriter(bindings, overrides = {}) {
  return bindings.bind({
    child_session_id: CHILD,
    parent_session_id: 'parent-session',
    task_id: 'REQ-1',
    node_id: 'T1',
    dispatch_id: 'REQ-1-T1-A1',
    attempt: 1,
    role: 'implementation',
    write_scope: ['a.txt'],
    ...overrides,
  })
}

describe('绑定注册表：只绑写者，读得回，放得掉', () => {
  it('写者绑得上，字段一字不改地读回来', () => {
    const bindings = newBindings()
    const bound = bindWriter(bindings)

    assert.deepEqual(bound.write_scope, ['a.txt'])
    assert.deepEqual(bindings.get(CHILD), {
      child_session_id: CHILD,
      parent_session_id: 'parent-session',
      task_id: 'REQ-1',
      node_id: 'T1',
      dispatch_id: 'REQ-1-T1-A1',
      attempt: 1,
      role: 'implementation',
      write_scope: ['a.txt'],
    })
  })

  it('绑定落进的是**守卫读的那张**注册表，且带上 origin 与身份', () => {
    const { core, bindings } = governed()
    bindWriter(bindings)

    const declaration = core.registry.get(CHILD)
    assert.equal(declaration.origin, 'runtime')
    assert.equal(declaration.child_session_id, CHILD)
    assert.equal(declaration.dispatch_id, 'REQ-1-T1-A1')
    assert.equal(declaration.attempt, 1)
  })

  it('**空**写范围不绑 —— 绑上去只会把 shell 一起拒掉，而验证者要用 shell 执行用例', () => {
    const bindings = newBindings()
    assert.equal(bindWriter(bindings, { write_scope: [] }), undefined)
    assert.equal(bindings.get(CHILD), undefined)
  })

  it('没绑过的会话读回 undefined', () => {
    assert.equal(newBindings().get('别的会话'), undefined)
  })

  it('按 dispatch 释放；释放是幂等的，不存在的 dispatch 返回 false', () => {
    const bindings = newBindings()
    bindWriter(bindings)
    assert.equal(bindings.release('REQ-1-T1-A1'), true)
    assert.equal(bindings.get(CHILD), undefined)
    assert.equal(bindings.release('REQ-1-T1-A1'), false)
  })

  it('按会话释放（子会话没起来就崩时用得上）', () => {
    const bindings = newBindings()
    bindWriter(bindings)
    assert.equal(bindings.releaseSession(CHILD), true)
    assert.equal(bindings.get(CHILD), undefined)
  })

  it('旧 attempt 的释放不得动摇新 attempt 的绑定（AC8 / I6）', () => {
    const bindings = newBindings()
    bindWriter(bindings, { child_session_id: 'child-A', dispatch_id: 'REQ-1-T1-A1', write_scope: ['src/a.c'] })
    bindWriter(bindings, { child_session_id: 'child-B', dispatch_id: 'REQ-1-T1-A2', attempt: 2, write_scope: ['src/b.c'] })

    // 迟到的释放：attempt 1 的收尾不该把 attempt 2 的绑定收走。
    assert.equal(bindings.release('REQ-1-T1-A1'), true)
    assert.equal(bindings.get('child-B').write_scope[0], 'src/b.c')
    assert.equal(bindings.get('child-A'), undefined)
  })

  it('同一个会话被重新绑定后，旧 dispatch 的迟到释放什么也不动', () => {
    const bindings = newBindings()
    bindWriter(bindings, { dispatch_id: 'REQ-1-T1-A1', write_scope: ['src/a.c'] })
    bindWriter(bindings, { dispatch_id: 'REQ-1-T1-A2', attempt: 2, write_scope: ['src/b.c'] })

    assert.equal(bindings.release('REQ-1-T1-A1'), false, '旧 dispatch 已不是当前绑定，释放不该生效')
    assert.deepEqual(bindings.get(CHILD).write_scope, ['src/b.c'])
  })
})

describe('守卫查绑定：子会话的越界写在执行前被拒', () => {
  it('绑了 scope 的子会话：边界内允许、越界拒绝', () => {
    const { core, bindings } = governed()
    bindWriter(bindings, { write_scope: ['a.txt'] })

    assert.deepEqual(
      core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: 'a.txt' } })),
      { kind: 'allow' },
    )
    const denied = core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: 'b.txt' } }))
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.info.code, GAC_CODES.WRITE_SCOPE_DENIED)
  })

  it('拒因带齐身份：task_id / node_id / dispatch_id / attempt / child_session_id（AC6）', () => {
    const { core, bindings } = governed()
    bindWriter(bindings)

    const denied = core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: 'b.txt' } }))
    assert.match(denied.reason, /REQ-1/)
    assert.match(denied.reason, /T1/)
    assert.equal(denied.info.child_session_id, CHILD)
    assert.equal(denied.info.dispatch_id, 'REQ-1-T1-A1')
    assert.equal(denied.info.attempt, 1)
    assert.equal(denied.info.task_id, 'REQ-1')
    assert.equal(denied.info.node_id, 'T1')
  })

  it('绑定生效期间 shell 与父会话同一语义：整体拒绝', () => {
    const { core, bindings } = governed()
    bindWriter(bindings)

    const denied = core.preExecute(execution({ sessionId: CHILD, name: 'pwsh', args: { command: 'echo x > b.txt' } }))
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.info.code, GAC_CODES.SHELL_DENIED_UNDER_SCOPE)
    assert.equal(denied.info.dispatch_id, 'REQ-1-T1-A1')
  })

  it('释放之后不再受管 —— 收权必须能撤销，否则等于把子会话永久关在门外', () => {
    const { core, bindings } = governed()
    bindWriter(bindings)
    bindings.release('REQ-1-T1-A1')

    assert.deepEqual(
      core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: 'b.txt' } })),
      { kind: 'allow' },
    )
  })

  it('没绑定的会话照旧放行（这条记录的是**现状**，也是绑定的存在理由）', () => {
    const { core } = governed()
    assert.deepEqual(
      core.preExecute(execution({ sessionId: 'unbound-session', name: 'write', args: { file_path: 'b.txt' } })),
      { kind: 'allow' },
    )
  })
})

describe('对抗矩阵：绑定之后语义与父会话写作用域完全一致', () => {
  const matrix = [
    { scope: ['a.txt'], path: 'a.txt', allow: true },
    { scope: ['a.txt'], path: 'dir/a.txt', allow: false },
    { scope: ['a.txt'], path: 'b.txt', allow: false },
    { scope: ['src/'], path: 'src/a.txt', allow: true },
    { scope: ['src/'], path: 'other/a.txt', allow: false },
    { scope: ['src/*.c'], path: 'src/a.c', allow: true },
    { scope: ['src/*.c'], path: 'other/a.c', allow: false },
  ]

  for (const entry of matrix) {
    it(`scope=${JSON.stringify(entry.scope)} 写 ${entry.path} → ${entry.allow ? '允许' : '拒绝'}`, () => {
      const { core, bindings } = governed()
      bindWriter(bindings, { write_scope: entry.scope })
      const verdict = core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: entry.path } }))
      assert.equal(verdict.kind === 'allow', entry.allow, `实际：${JSON.stringify(verdict)}`)
    })
  }

  const edges = [
    { scope: ['a.txt'], path: 'A.TXT', allow: true, why: 'Windows 大小写折叠' },
    { scope: ['src/**'], path: 'SRC/A.C', allow: true, why: '折叠 + 目录前缀' },
    // `src/sub/../other/a.txt` 归一化之后是 `src/other/a.txt`——**在作用域之内**，允许才对。
    // 真正越界的 `..` 是这种：归一化之后落到了作用域外面。
    { scope: ['src/'], path: 'src/../b.txt', allow: false, why: '.. 归一化后越出作用域' },
  ]

  for (const entry of edges) {
    it(`${entry.why}：写 ${entry.path} → ${entry.allow ? '允许' : '拒绝'}`, () => {
      const { core, bindings } = governed()
      bindWriter(bindings, { write_scope: entry.scope })
      const verdict = core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: entry.path } }))
      assert.equal(verdict.kind === 'allow', entry.allow, `实际：${JSON.stringify(verdict)}`)
    })
  }
})

describe('子会话执行者：起会话时绑、结束时放', () => {
  /**
   * 一个假的子会话服务：**在子会话「运行期间」**读一次绑定，用来证明绑定不是事后补的。
   *
   * @param {object} bindings
   * @param {object} [options]
   * @returns {{service: object, seen: object}}
   */
  function fakeSubagents(bindings, { result = { structured: { status: 'completed', summary: '做完了' }, stopReason: 'completed' } } = {}) {
    const seen = { during: undefined, request: undefined }
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      start: async (_provider, request) => {
        seen.request = request
        return {
          id: 'child-session-1',
          // 用**宏任务**而不是微任务：真实子会话要跑几秒，而 `Promise.resolve().then(...)` 会在
          // `start()` 返回之前就排进微任务队列，比执行者绑定的那一步还早跑——那样测的是假件的时序，
          // 不是绑定是否真的在子会话运行期间生效。
          result: new Promise((resolve) => {
            setTimeout(() => {
              seen.during = bindings.get('child-session-1')
              resolve(result)
            }, 0)
          }),
          dispose: async () => {},
        }
      },
    }
    return { service, seen }
  }

  /**
   * @param {object} [overrides]
   * @returns {object}
   */
  function runInput(overrides = {}) {
    return {
      node: {
        id: 'T1',
        objective: '写 src/a.c',
        write_scope: ['src/'],
        depends_on: [],
        expected_artifacts: [],
        execution: { attempt: 1 },
      },
      task: { task_id: 'REQ-1', mode: 'standard_task' },
      root: ROOT,
      dispatchId: 'REQ-1-T1-A1',
      agent: { id: 'agent-1', session: { id: 'parent-session', header: { delegationDepth: 0 } } },
      signal: new AbortController().signal,
      ...overrides,
    }
  }

  it('子会话跑的时候绑定在，跑完就放掉（AC7）', async () => {
    const { bindings } = governed()
    const { service, seen } = fakeSubagents(bindings)
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    await executor.run(runInput())

    assert.deepEqual(seen.during?.write_scope, ['src/'])
    assert.equal(seen.during?.dispatch_id, 'REQ-1-T1-A1')
    assert.equal(seen.during?.task_id, 'REQ-1')
    assert.equal(seen.during?.node_id, 'T1')
    assert.equal(seen.during?.attempt, 1)
    assert.equal(bindings.get('child-session-1'), undefined, '跑完必须释放')
  })

  it('返回文本里写明这次绑了什么（可追溯性，不靠猜）', async () => {
    const { bindings } = governed()
    const { service } = fakeSubagents(bindings)
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    const outcome = await executor.run(runInput())
    assert.match(outcome.detail, /已绑定写作用域 \[src\/\]/u)
  })

  it('执行者抛错时也要释放（finally 不是装饰）', async () => {
    const { bindings } = governed()
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      start: async () => ({
        id: 'child-session-1',
        result: Promise.reject(new Error('宿主内部错误')),
        dispose: async () => {},
      }),
    }
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    await assert.rejects(() => executor.run(runInput()))
    assert.equal(bindings.get('child-session-1'), undefined, '抛错也必须释放，否则那个会话永远写不了')
  })

  it('只读节点不绑 —— 空写范围不登记（同一条策略的第二处体现）', async () => {
    const { bindings } = governed()
    const { service, seen } = fakeSubagents(bindings)
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    await executor.run(runInput({
      node: {
        id: 'T2',
        objective: '独立验证',
        write_scope: [],
        depends_on: [],
        expected_artifacts: [],
        execution: { attempt: 1 },
      },
      dispatchId: 'REQ-1-T2-A1',
    }))

    assert.equal(seen.during, undefined, '只读节点不该有绑定')
  })
})
