/**
 * 子会话的权限绑定：**授权必须由运行时绑定，绝不由执行者自报。**
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

  it('**子会话的回报通道必须放行**：绑了作用域之后 structured_output 仍然能用', () => {
    // 活体验收抓到的第二个坑：绑定写作用域之后，子会话的结构化回报被按「未知工具」拒了
    // （`GAC_UNGUARDABLE_WRITE_DENIED`），于是它把两件事都做对了却因为回报不上去被判 failed。
    // 「失败即拒」这条规则是对的，代价是每一个子会话要用的非写入类工具都必须被显式归类。
    const { core, bindings } = governed()
    bindWriter(bindings)

    assert.deepEqual(
      core.preExecute(execution({
        sessionId: CHILD,
        name: 'structured_output',
        args: { status: 'completed', summary: '做完了' },
      })),
      { kind: 'allow' },
    )
    assert.deepEqual(
      core.preExecute(execution({ sessionId: CHILD, name: 'todo_write', args: { todos: [] } })),
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

  it('回报失败的分支也要给出可追溯信息（子会话 id + 绑了什么）', async () => {
    // 活体验收里，子会话两件事都做对了、只是结构化回报被门禁拒了；而当时失败分支不返回 `detail`，
    // 于是 `advance` 返回里连子会话 id 都没有——父会话无从知道该去查谁。
    const { bindings } = governed()
    const { service } = fakeSubagents(bindings, { result: { stopReason: 'completed' } })
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    const outcome = await executor.run(runInput())

    assert.equal(outcome.status, 'failed')
    assert.match(outcome.detail, /子会话 child-session-1/u)
    assert.match(outcome.detail, /已绑定写作用域 \[src\/\]/u)
  })

  it('返回文本里带出结论节选 —— 父会话不必去翻证据才知道子会话说了什么', async () => {
    const { bindings } = governed()
    const long = '很长的结论。'.repeat(60)
    const { service } = fakeSubagents(bindings, {
      result: { structured: { status: 'completed', summary: long }, stopReason: 'completed' },
    })
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    const outcome = await executor.run(runInput())

    assert.match(outcome.detail, /结论：/u)
    assert.match(outcome.detail, /（截断）/u, '超长要明说截断了，而不是让读者以为那就是全部')
    assert.ok(outcome.detail.length < long.length, '节选必须真的短于全文')
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

describe('语义角色登记：只读节点也要有身份', () => {
  /**
   * 守卫 + 绑定 + 角色来源，三者接在同一条线上（与 `lib/index.js` 的接线同构）。
   *
   * `childRoleFor` 晚绑定：门禁只在工具调用时执行，那时 `bindings` 早已赋值——真实接线里也是这个
   * 形状（`apply` 里先声明 `childRoleOf`，再在运行时把角色来源填进去）。
   *
   * @returns {{core: object, bindings: object}}
   */
  function roleGoverned() {
    let bindings
    const core = createGacCore({
      resolveRoot: () => ROOT,
      childRoleFor: (sessionId) => bindings?.roleOf(sessionId),
    })
    bindings = createChildBindings({ registry: core.registry })
    return { core, bindings }
  }

  /** 登记一个只读设计子会话的角色（没有写范围）。 */
  function declareDesigner(bindings, overrides = {}) {
    return bindings.declareRole({
      child_session_id: CHILD,
      role: 'verification_design',
      write_scope: [],
      dispatch_id: 'REQ-1-D1-A1',
      ...overrides,
    })
  }

  it('childRoleFor 返回裸角色名时也按那个角色判定，而不是退化成「谁都不许读」', () => {
    // 接线少包一层（只回角色名、不回登记条目）曾经会让 `roleEntry.role` 读成 `undefined`，
    // 于是**每个**子会话都落到最保守的那一档，连实现节点的 `read` 一起被拒——方向 fail-closed，
    // 理由完全错。这条盯着那个退化：裸名字只丢治理身份，不丢角色。
    const designer = createGacCore({ resolveRoot: () => ROOT, childRoleFor: () => 'verification_design' })
    const denied = designer.preExecute(execution({ sessionId: CHILD, name: 'read', args: { file_path: 'x.txt' } }))
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.info.code, GAC_CODES.ROLE_TOOL_DENIED)

    const builder = createGacCore({ resolveRoot: () => ROOT, childRoleFor: () => 'implementation' })
    assert.equal(
      builder.preExecute(execution({ sessionId: CHILD, name: 'read', args: { file_path: 'x.txt' } })).kind,
      'allow',
      '实现节点仍然读得到',
    )
  })

  it('空写范围不绑写作用域，但角色登记得上', () => {
    const bindings = newBindings()
    assert.equal(bindings.bind({
      child_session_id: CHILD,
      task_id: 'REQ-1',
      node_id: 'D1',
      dispatch_id: 'REQ-1-D1-A1',
      role: 'verification_design',
      write_scope: [],
    }), undefined, '空写范围仍然不绑')
    assert.equal(bindings.roleOf(CHILD), undefined)

    declareDesigner(bindings)
    assert.equal(bindings.roleOf(CHILD).role, 'verification_design')
    assert.deepEqual(bindings.roleOf(CHILD).write_scope, [])
    assert.deepEqual(bindings.inspectRoles().length, 1)
  })

  it('角色登记带上任务与节点 —— 委派拒因里不再渲染成「任务 undefined／节点 undefined」', () => {
    // 活体验收实测到这一幕：子会话调 `subagent` **确实被拒了**，但拒因写的是「任务 undefined／
    // 节点 undefined／派遣 REQ-DELEG-1-P1-A1」。根因是角色登记条目只冻结了 role / write_scope /
    // dispatch_id，而 `childRoleOf` 先返回这条条目，于是 `roleDenyReason` 拿到的绑定缺 task_id /
    // node_id。拦截方向是对的，拒绝记录却归因不到具体节点——审计里少了一半身份。
    const { core, bindings } = roleGoverned()
    const entry = bindings.declareRole({
      child_session_id: CHILD,
      task_id: 'REQ-1',
      node_id: 'D1',
      role: 'verification_design',
      write_scope: [],
      dispatch_id: 'REQ-1-D1-A1',
    })
    assert.equal(entry.task_id, 'REQ-1')
    assert.equal(entry.node_id, 'D1')

    const denied = core.preExecute(execution({ sessionId: CHILD, name: 'subagent', args: { prompt: 'x' } }))
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.info.code, GAC_CODES.CHILD_DELEGATION_DENIED)
    assert.match(denied.reason, /任务 REQ-1/u)
    assert.match(denied.reason, /节点 D1/u)
    assert.doesNotMatch(denied.reason, /undefined/u)
  })

  it('**设计子会话的 read 在执行前被拒** —— 独立性来自结构，不来自提示词', () => {
    // 真实 `REQ-HR-5` 里设计子会话启动时确实没被推入实现信息，但它自己把实现产物读了过来
    // （`hr5-artifact.txt` 的 `Length=3`）。工具还在，模型就仍有能力读；只有工具不在才算隔离。
    const { core, bindings } = roleGoverned()
    declareDesigner(bindings)

    const denied = core.preExecute(execution({ sessionId: CHILD, name: 'read', args: { file_path: 'src/a.c' } }))
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.info.code, GAC_CODES.ROLE_TOOL_DENIED)
    assert.equal(denied.info.child_session_id, CHILD)
    assert.equal(denied.info.dispatch_id, 'REQ-1-D1-A1')
    assert.match(denied.reason, /verification_design/u)
    assert.match(denied.reason, /read/u)
  })

  it('grep / glob / pwsh 同样被拒 —— 少拒一个，那条路就还在', () => {
    const { core, bindings } = roleGoverned()
    declareDesigner(bindings)
    for (const name of ['grep', 'glob', 'pwsh', 'read_image', 'web_fetch']) {
      const denied = core.preExecute(execution({ sessionId: CHILD, name, args: {} }))
      assert.equal(denied.kind, 'deny', `${name} 应当被拒`)
      assert.equal(denied.info.code, GAC_CODES.ROLE_TOOL_DENIED)
    }
  })

  it('PTC 传输 `run_code` 也拒 —— 收权点名它会抛错，只剩守卫这一层', () => {
    const { core, bindings } = roleGoverned()
    declareDesigner(bindings)
    const denied = core.preExecute(execution({ sessionId: CHILD, name: 'run_code', args: { code: 'x' } }))
    assert.equal(denied.kind, 'deny')
    assert.equal(denied.info.code, GAC_CODES.ROLE_TOOL_DENIED)
  })

  it('回报通道不能被误伤：设计子会话仍能交结构化产出', () => {
    const { core, bindings } = roleGoverned()
    declareDesigner(bindings)
    assert.deepEqual(
      core.preExecute(execution({
        sessionId: CHILD,
        name: 'structured_output',
        args: { status: 'completed', summary: '方案' },
      })),
      { kind: 'allow' },
    )
  })

  it('委派类拒绝用独立的码：那是编排权问题，不是这个角色的读写权限', () => {
    const { core, bindings } = roleGoverned()
    declareDesigner(bindings)
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'send_message', 'team_task_create']) {
      const denied = core.preExecute(execution({ sessionId: CHILD, name, args: {} }))
      assert.equal(denied.kind, 'deny', `${name} 应当被拒`)
      assert.equal(denied.info.code, GAC_CODES.CHILD_DELEGATION_DENIED)
      assert.match(denied.reason, /编排权归 GAC/u)
    }
  })

  it('实现子会话不受角色档限制：读、写、shell 照旧', () => {
    const { core, bindings } = roleGoverned()
    bindWriter(bindings, { write_scope: ['a.txt'] })
    bindings.declareRole({
      child_session_id: CHILD,
      role: 'implementation',
      write_scope: ['a.txt'],
      dispatch_id: 'REQ-1-T1-A1',
    })

    assert.deepEqual(
      core.preExecute(execution({ sessionId: CHILD, name: 'read', args: { file_path: 'a.txt' } })),
      { kind: 'allow' },
    )
    assert.deepEqual(
      core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: 'a.txt' } })),
      { kind: 'allow' },
    )
    // 越界写仍按写作用域拒（角色档没有把它放宽）。
    assert.equal(
      core.preExecute(execution({ sessionId: CHILD, name: 'write', args: { file_path: 'b.txt' } })).info.code,
      GAC_CODES.WRITE_SCOPE_DENIED,
    )
  })

  it('角色登记按 dispatch 释放，迟到的释放不得动摇新 attempt', () => {
    const bindings = newBindings()
    declareDesigner(bindings, { dispatch_id: 'REQ-1-D1-A1' })
    declareDesigner(bindings, { dispatch_id: 'REQ-1-D1-A2', role: 'verification_execution' })

    assert.equal(bindings.releaseRole('REQ-1-D1-A1'), false, '旧 dispatch 已不是当前登记')
    assert.equal(bindings.roleOf(CHILD).role, 'verification_execution')
    assert.equal(bindings.releaseRole('REQ-1-D1-A2'), true)
    assert.equal(bindings.roleOf(CHILD), undefined)
    assert.equal(bindings.releaseRole('REQ-1-D1-A2'), false, '释放是幂等的')
  })

  it('释放之后不再受角色管 —— 收权必须能撤销，否则等于把会话永久关在门外', () => {
    const { core, bindings } = roleGoverned()
    declareDesigner(bindings)
    assert.equal(core.preExecute(execution({ sessionId: CHILD, name: 'read', args: {} })).kind, 'deny')

    bindings.releaseRole('REQ-1-D1-A1')
    assert.deepEqual(core.preExecute(execution({ sessionId: CHILD, name: 'read', args: {} })), { kind: 'allow' })
  })

  it('按会话释放要把两张表一起清干净（角色表不会漏在内存里）', () => {
    const { bindings } = governed()
    bindWriter(bindings)
    bindings.declareRole({
      child_session_id: CHILD,
      role: 'implementation',
      write_scope: ['a.txt'],
      dispatch_id: 'REQ-1-T1-A1',
    })

    assert.equal(bindings.releaseSession(CHILD), true)
    assert.equal(bindings.get(CHILD), undefined)
    assert.equal(bindings.roleOf(CHILD), undefined)
    assert.equal(bindings.releaseSession(CHILD), false, '都清掉了，第二次什么也不动')
  })

  it('只有角色登记（没有写绑定）时，按会话释放同样生效', () => {
    const bindings = newBindings()
    declareDesigner(bindings)
    assert.equal(bindings.releaseSession(CHILD), true)
    assert.equal(bindings.roleOf(CHILD), undefined)
  })

  it('执行者派遣只读节点时登记角色，跑完连角色一起释放', async () => {
    const { bindings } = governed()
    const seen = { during: undefined }
    const service = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
      start: async () => ({
        id: 'child-session-1',
        result: new Promise((resolve) => {
          setTimeout(() => {
            seen.during = bindings.roleOf('child-session-1')
            resolve({ structured: { status: 'completed', summary: '做完了' }, stopReason: 'completed' })
          }, 0)
        }),
        dispose: async () => {},
      }),
    }
    const executor = createChildExecutor({ subagentsFor: () => service, bindings })

    await executor.run({
      node: {
        id: 'D1',
        role: 'verification_design',
        objective: '推导验证方案',
        write_scope: [],
        depends_on: [],
        expected_artifacts: [],
        execution: { attempt: 1 },
      },
      task: { task_id: 'REQ-1', mode: 'standard_task' },
      root: ROOT,
      dispatchId: 'REQ-1-D1-A1',
      agent: { id: 'agent-1', session: { id: 'parent-session', header: { delegationDepth: 0 } } },
      signal: new AbortController().signal,
    })

    assert.equal(seen.during?.role, 'verification_design', '跑的时候角色登记必须在场')
    assert.equal(bindings.get('child-session-1'), undefined, '只读节点没有写绑定')
    assert.equal(bindings.roleOf('child-session-1'), undefined, '角色登记也要在 finally 里释放')
  })
})
