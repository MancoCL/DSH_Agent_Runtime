/**
 * `gac_scope` tool tests.
 *
 * The tool is the only scope source in v0.1, so these tests guard a real
 * property rather than a convenience: whatever this tool declares is exactly
 * what the guard enforces. The suite therefore drives the tool and the guard
 * together, and fails if the two ever disagree about what a scope means.
 *
 * `defineTool` is stubbed to the identity: this suite tests the tool's own
 * behaviour (declaration, inspection, release, refusal), not the runtime's
 * argument validation, which belongs to DSH.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createGacCore } from '../lib/plugin.js'
import { SCOPE_TOOL_NAME, createScopeTool } from '../lib/tool-scope.js'

const identityDefineTool = (options) => options

/**
 * Build a core plus its scope tool, sharing one agent session.
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
    /** Build a tool call as DSH presents it, for the guard to judge. */
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
    // A guard the model does not understand becomes a retry loop, so the
    // description has to name what is actually refused.
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

    // The outline's E2E-4, driven end to end through the tool that declares
    // the scope and the guard that enforces it.
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
