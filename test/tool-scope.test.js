/**
 * `gac_scope` 工具测试。
 *
 * 在 v0.1 中，这个工具是唯一的作用域来源，所以这些测试守的是一条真实性质，而不是
 * 图个方便：这个工具声明了什么，守卫就恰好执行什么。因此测试集把工具和守卫放在
 * 一起驱动，一旦两者对「作用域是什么意思」有了分歧就会失败。
 *
 * `defineTool` 被桩成恒等函数：本测试集测的是工具自身的行为（声明、检视、释放、
 * 拒绝），而不是运行时的参数校验——那属于 DSH。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { ClaimStore } from '../lib/claim-store.js'
import { createGacCore } from '../lib/plugin.js'
import { SCOPE_TOOL_NAME, createScopeTool } from '../lib/tool-scope.js'

const identityDefineTool = (options) => options

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时工程根目录，测试集结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-scope-tool-'))
  scratchRoots.push(root)
  return root
}

/**
 * 构建一个 core 及其作用域工具，共用同一个 agent 会话。
 *
 * @returns {{core: object, tool: object, exec: (name: string, args: object) => object}}
 */
function harness() {
  const core = createGacCore()
  const tool = createScopeTool({ core, defineTool: identityDefineTool })
  const sessionId = 'session-42'
  const callExec = {
    agent: { id: sessionId, session: { id: sessionId } },
    signal: new AbortController().signal,
  }
  return {
    core,
    tool,
    /** 按 DSH 呈现的样子构建一次工具调用，交给守卫判定。 */
    exec: (toolName, args) => ({ name: toolName, arguments: args, ...callExec }),
    callExec,
  }
}

describe('gac_scope tool shape', () => {
  it('is named for the model to find', () => {
    assert.equal(SCOPE_TOOL_NAME, 'gac_scope')
    assert.equal(harness().tool.name, 'gac_scope')
  })

  it('states the enforcement consequence, so the model can plan within it', () => {
    const { tool } = harness()
    // 模型看不懂的守卫会变成重试循环，所以描述里必须点明究竟是什么被拒绝了。
    assert.match(tool.description, /refused before/iu)
    assert.match(tool.description, /shell/iu)
    assert.match(tool.description, /case-insensitive/iu)
  })

  it('declares every parameter it reads', () => {
    const { tool } = harness()
    assert.deepEqual(
      Object.keys(tool.parameters).sort(),
      ['clear', 'node_id', 'scope', 'task_id'],
    )
  })
})

describe('declaring a scope', () => {
  it('returns a summary naming the permitted paths', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', scope: ['src/a.c'] }, callExec)
    assert.equal(value.governed, true)
    assert.deepEqual(value.scope, ['src/a.c'])
    assert.match(value.summary, /src\/a\.c/u)
  })

  it('warns explicitly when the scope is empty, rather than looking benign', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', scope: [] }, callExec)
    assert.match(value.summary, /EMPTY/u)
    assert.match(value.summary, /every write is now refused/iu)
  })

  it('defaults node_id to the task id', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, callExec)
    assert.equal(value.node_id, 'REQ-1')
  })

  it('accepts an explicit node id', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', node_id: 'T3', scope: ['src/'] }, callExec)
    assert.equal(value.node_id, 'T3')
  })

  it('requires a task id when declaring', async () => {
    const { tool, callExec } = harness()
    await assert.rejects(
      () => tool.execute({ scope: ['src/'] }, callExec),
      /task_id/u,
    )
  })

  it('requires an owning session', async () => {
    const { tool } = harness()
    await assert.rejects(() => tool.execute({ task_id: 'REQ-1', scope: [] }, {}), /session/u)
  })
})

describe('inspecting a scope', () => {
  it('reports ungoverned before anything is declared', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({}, callExec)
    assert.equal(value.governed, false)
    assert.deepEqual(value.scope, [])
    assert.match(value.summary, /no write is being checked/iu)
  })

  it('reports the live declaration after declaring', async () => {
    const { tool, callExec } = harness()
    await tool.execute({ task_id: 'REQ-9', node_id: 'T2', scope: ['docs/'] }, callExec)
    const value = await tool.execute({}, callExec)
    assert.equal(value.governed, true)
    assert.equal(value.task_id, 'REQ-9')
    assert.equal(value.node_id, 'T2')
    assert.deepEqual(value.scope, ['docs/'])
  })
})

describe('releasing a scope', () => {
  it('returns the session to ungoverned', async () => {
    const { tool, core, callExec, exec } = harness()
    await tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, callExec)
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'deny')

    const value = await tool.execute({ clear: true }, callExec)
    assert.equal(value.governed, false)
    assert.match(value.summary, /released/u)
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'allow')
  })

  it('says so plainly when there was nothing to release', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ clear: true }, callExec)
    assert.match(value.summary, /No write scope was declared/u)
  })
})

describe('the tool and the guard agree on one scope', () => {
  it('permits exactly what the tool declared and refuses the rest', async () => {
    const { tool, core, callExec, exec } = harness()
    await tool.execute({ task_id: 'REQ-1', scope: ['mod.c'] }, callExec)

    // 架构大纲的 E2E-4，端到端地经由声明作用域的工具与执行作用域的守卫跑通。
    assert.equal(core.preExecute(exec('write', { file_path: './mod.c' })).kind, 'allow')
    assert.equal(core.preExecute(exec('write', { file_path: 'sub/mod.c' })).kind, 'deny')
    assert.equal(core.preExecute(exec('write', { file_path: 'src/mod.c' })).kind, 'deny')
  })

  it('widens and narrows with re-declaration, never by accumulating', async () => {
    const { tool, core, callExec, exec } = harness()
    await tool.execute({ task_id: 'REQ-1', node_id: 'T1', scope: ['src/'] }, callExec)
    await tool.execute({ task_id: 'REQ-1', node_id: 'T2', scope: ['docs/'] }, callExec)

    assert.equal(core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'deny')
    assert.equal(core.preExecute(exec('write', { file_path: 'docs/a.md' })).kind, 'allow')
  })
})

describe('declaring takes a write claim', () => {
  /**
   * 一个其占用记录在两个会话之间共享的工具，用来模拟占用机制存在的目的——
   * 防止那种冲突。
   *
   * @returns {{root: string, store: ClaimStore, toolFor: (sessionId: string) => object}}
   */
  function claimHarness() {
    const root = scratch()
    const store = new ClaimStore({ root })
    const core = createGacCore()
    const tool = createScopeTool({
      core,
      defineTool: identityDefineTool,
      claimStoreFor: () => store,
      sessionRootFor: () => root,
    })
    return {
      root,
      store,
      tool,
      core,
      execFor: (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } } }),
    }
  }

  it('records a claim when a scope is declared', async () => {
    const h = claimHarness()
    const value = await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    assert.equal(value.governed, true)
    assert.ok(value.claim, 'the declaration should report the claim it took')
    assert.equal(h.store.get('s-1')?.task_id, 'REQ-1')
  })

  it('refuses a declaration that collides with another session, naming the holder', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    await assert.rejects(
      () => h.tool.execute({ task_id: 'REQ-2', scope: ['src/a.c'] }, h.execFor('s-2')),
      (error) => {
        // 一条模型能据此行动的拒绝，必须点明是谁占着那个路径。
        assert.match(error.message, /REQ-1/u)
        assert.match(error.message, /src\/a\.c/u)
        return true
      },
    )
  })

  it('leaves the loser ungoverned rather than half-declared', async () => {
    // 先记录作用域、再检查占用，会让一个会话被它并不拥有的作用域所管辖——
    // 一个守卫在执行该会话从未获得授权的路径。
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    await assert.rejects(
      () => h.tool.execute({ task_id: 'REQ-2', scope: ['src/deep/'] }, h.execFor('s-2')),
      /refused/u,
    )
    assert.equal(h.core.inspect('s-2').governed, false, 'a refused declaration must not govern')
    assert.equal(h.store.get('s-2'), undefined, 'a refused declaration must not leave a claim')
  })

  it('lets a second session take a disjoint scope', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    const value = await h.tool.execute({ task_id: 'REQ-2', scope: ['test/'] }, h.execFor('s-2'))
    assert.equal(value.governed, true)
  })

  it('does not let a session collide with its own earlier claim', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', node_id: 'T1', scope: ['src/'] }, h.execFor('s-1'))
    // 重新声明是一个任务推进到下一个节点的方式。
    const value = await h.tool.execute({ task_id: 'REQ-1', node_id: 'T2', scope: ['src/deep/'] }, h.execFor('s-1'))
    assert.equal(value.governed, true)
    assert.equal(value.node_id, 'T2')
  })

  it('withdraws the claim on clear', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    assert.equal(h.store.get('s-1') !== undefined, true)
    const value = await h.tool.execute({ clear: true }, h.execFor('s-1'))
    assert.match(value.summary, /claim withdrawn/u)
    assert.equal(h.store.get('s-1'), undefined)
  })

  it('releases the paths so another session may then take them', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    await h.tool.execute({ clear: true }, h.execFor('s-1'))
    const value = await h.tool.execute({ task_id: 'REQ-2', scope: ['src/a.c'] }, h.execFor('s-2'))
    assert.equal(value.governed, true)
  })

  it('says plainly when no claim could be taken, instead of implying protection', async () => {
    // 没有可解析的根目录就没有占用声明存储。摘要不能让模型在无法排除其他会话时
    // 以为已经被排除了。
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: identityDefineTool })
    const value = await tool.execute(
      { task_id: 'REQ-1', scope: ['src/'] },
      { agent: { session: { id: 's-1' } } },
    )
    assert.equal(value.claim, undefined)
    assert.match(value.summary, /NOT prevented/u)
  })
})
