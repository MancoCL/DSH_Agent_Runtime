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

describe('gac_scope 工具形状', () => {
  it('名字便于模型找到它', () => {
    assert.equal(SCOPE_TOOL_NAME, 'gac_scope')
    assert.equal(harness().tool.name, 'gac_scope')
  })

  it('陈述强制执行的后果，好让模型能在这条边界之内做计划', () => {
    const { tool } = harness()
    // 模型看不懂的守卫会变成重试循环，所以描述里必须点明究竟是什么被拒绝了。
    assert.match(tool.description, /被拒绝/u)
    assert.match(tool.description, /shell/u)
    assert.match(tool.description, /不区分大小写/u)
  })

  it('声明了它读取的每一个参数', () => {
    const { tool } = harness()
    assert.deepEqual(
      Object.keys(tool.parameters).sort(),
      ['clear', 'node_id', 'scope', 'task_id'],
    )
  })
})

describe('声明作用域', () => {
  it('返回一份点名了允许路径的摘要', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', scope: ['src/a.c'] }, callExec)
    assert.equal(value.governed, true)
    assert.deepEqual(value.scope, ['src/a.c'])
    assert.match(value.summary, /src\/a\.c/u)
  })

  it('在作用域为空时明确警告，而不是显得无害', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', scope: [] }, callExec)
    assert.match(value.summary, /空/u)
    assert.match(value.summary, /任何写入都会被拒绝/u)
  })

  it('把 node_id 默认为任务标识', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, callExec)
    assert.equal(value.node_id, 'REQ-1')
  })

  it('接受显式给出的节点标识', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ task_id: 'REQ-1', node_id: 'T3', scope: ['src/'] }, callExec)
    assert.equal(value.node_id, 'T3')
  })

  it('声明时必须提供任务标识', async () => {
    const { tool, callExec } = harness()
    await assert.rejects(
      () => tool.execute({ scope: ['src/'] }, callExec),
      /task_id/u,
    )
  })

  it('要求一个拥有它的会话', async () => {
    const { tool } = harness()
    await assert.rejects(() => tool.execute({ task_id: 'REQ-1', scope: [] }, {}), /智能体会话/u)
  })
})

describe('检视作用域', () => {
  it('在什么都还没声明时报告处于无管辖状态', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({}, callExec)
    assert.equal(value.governed, false)
    assert.deepEqual(value.scope, [])
    assert.match(value.summary, /不检查任何写入/u)
  })

  it('在声明之后报告当前生效的声明', async () => {
    const { tool, callExec } = harness()
    await tool.execute({ task_id: 'REQ-9', node_id: 'T2', scope: ['docs/'] }, callExec)
    const value = await tool.execute({}, callExec)
    assert.equal(value.governed, true)
    assert.equal(value.task_id, 'REQ-9')
    assert.equal(value.node_id, 'T2')
    assert.deepEqual(value.scope, ['docs/'])
  })
})

describe('释放作用域', () => {
  it('让会话回到无管辖状态', async () => {
    const { tool, core, callExec, exec } = harness()
    await tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, callExec)
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'deny')

    const value = await tool.execute({ clear: true }, callExec)
    assert.equal(value.governed, false)
    assert.match(value.summary, /写作用域已释放/u)
    assert.equal(core.preExecute(exec('write', { file_path: 'outside.c' })).kind, 'allow')
  })

  it('在本来就没有东西可释放时直说', async () => {
    const { tool, callExec } = harness()
    const value = await tool.execute({ clear: true }, callExec)
    assert.match(value.summary, /没有声明过写作用域/u)
  })
})

describe('工具与守卫对同一个作用域达成一致', () => {
  it('恰好允许工具所声明的，其余一律拒绝', async () => {
    const { tool, core, callExec, exec } = harness()
    await tool.execute({ task_id: 'REQ-1', scope: ['mod.c'] }, callExec)

    // 架构大纲的 E2E-4，端到端地经由声明作用域的工具与执行作用域的守卫跑通。
    assert.equal(core.preExecute(exec('write', { file_path: './mod.c' })).kind, 'allow')
    assert.equal(core.preExecute(exec('write', { file_path: 'sub/mod.c' })).kind, 'deny')
    assert.equal(core.preExecute(exec('write', { file_path: 'src/mod.c' })).kind, 'deny')
  })

  it('随重新声明而变宽或变窄，绝不靠累积', async () => {
    const { tool, core, callExec, exec } = harness()
    await tool.execute({ task_id: 'REQ-1', node_id: 'T1', scope: ['src/'] }, callExec)
    await tool.execute({ task_id: 'REQ-1', node_id: 'T2', scope: ['docs/'] }, callExec)

    assert.equal(core.preExecute(exec('write', { file_path: 'src/a.c' })).kind, 'deny')
    assert.equal(core.preExecute(exec('write', { file_path: 'docs/a.md' })).kind, 'allow')
  })
})

describe('声明会取得一份写占用声明', () => {
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

  it('在声明作用域时记录一份占用', async () => {
    const h = claimHarness()
    const value = await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    assert.equal(value.governed, true)
    assert.ok(value.claim, '声明应当报出它取得的占用')
    assert.equal(h.store.get('s-1')?.task_id, 'REQ-1')
  })

  it('拒绝与另一个会话相撞的声明，并点名持有者', async () => {
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

  it('让落败的一方保持无管辖状态，而不是半声明状态', async () => {
    // 先记录作用域、再检查占用，会让一个会话被它并不拥有的作用域所管辖——
    // 一个守卫在执行该会话从未获得授权的路径。
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    await assert.rejects(
      () => h.tool.execute({ task_id: 'REQ-2', scope: ['src/deep/'] }, h.execFor('s-2')),
      /被拒绝/u,
    )
    assert.equal(h.core.inspect('s-2').governed, false, '被拒绝的声明不得产生管辖')
    assert.equal(h.store.get('s-2'), undefined, '被拒绝的声明不得留下占用')
  })

  it('让第二个会话取得一份互不相交的作用域', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    const value = await h.tool.execute({ task_id: 'REQ-2', scope: ['test/'] }, h.execFor('s-2'))
    assert.equal(value.governed, true)
  })

  it('不让一个会话与自己先前的占用相撞', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', node_id: 'T1', scope: ['src/'] }, h.execFor('s-1'))
    // 重新声明是一个任务推进到下一个节点的方式。
    const value = await h.tool.execute({ task_id: 'REQ-1', node_id: 'T2', scope: ['src/deep/'] }, h.execFor('s-1'))
    assert.equal(value.governed, true)
    assert.equal(value.node_id, 'T2')
  })

  it('在 clear 时撤回占用', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    assert.equal(h.store.get('s-1') !== undefined, true)
    const value = await h.tool.execute({ clear: true }, h.execFor('s-1'))
    assert.match(value.summary, /写占用声明也已撤回/u)
    assert.equal(h.store.get('s-1'), undefined)
  })

  it('释放这些路径，好让另一个会话随后可以取得它们', async () => {
    const h = claimHarness()
    await h.tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, h.execFor('s-1'))
    await h.tool.execute({ clear: true }, h.execFor('s-1'))
    const value = await h.tool.execute({ task_id: 'REQ-2', scope: ['src/a.c'] }, h.execFor('s-2'))
    assert.equal(value.governed, true)
  })

  it('在无法取得任何占用时直说，而不是暗示已有保护', async () => {
    // 没有可解析的根目录就没有占用声明存储。摘要不能让模型在无法排除其他会话时
    // 以为已经被排除了。
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: identityDefineTool })
    const value = await tool.execute(
      { task_id: 'REQ-1', scope: ['src/'] },
      { agent: { session: { id: 's-1' } } },
    )
    assert.equal(value.claim, undefined)
    assert.match(value.summary, /不会\*\*被阻止/u)
  })
})
