/**
 * Runtime-authoring integration test.
 *
 * This is the one test in the suite that runs against the real DSH runtime
 * rather than a stub, and it exists because the parameter DSL `defineTool`
 * accepts is the runtime's own: a mistake in it cannot be found by reading our
 * code, only by running it through the real helper.
 *
 * The alternative — restarting the harness to find out — was tried, and it cost
 * two restart cycles for one wrong field. This test is the cheap version.
 *
 * Skipped when DSH is not installed, so the unit suite still runs anywhere.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createGacCore } from '../lib/plugin.js'
import { importDshPackage } from '../lib/resolve-dsh.js'
import { SCOPE_TOOL_NAME, createScopeTool, scopeToolOptions } from '../lib/tool-scope.js'

const toolsPackage = await importDshPackage('@deepseek-ai/dsh-tools')
const canRun = typeof toolsPackage?.defineTool === 'function'

describe('the scope tool survives the runtime authoring helper', { skip: !canRun }, () => {
  it('defineTool accepts our options without throwing', () => {
    const core = createGacCore()
    assert.doesNotThrow(() => createScopeTool({ core, defineTool: toolsPackage.defineTool }))
  })

  it('produces a definition with the members the registry requires', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    assert.equal(tool.name, SCOPE_TOOL_NAME)
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output, 'a tool must declare an output definition')
    assert.equal(typeof tool.output.render, 'function')
  })

  it('compiles the parameter DSL into the JSON Schema the model is shown', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // The compiled schema must be real JSON Schema, not our authoring spec.
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties?.scope, 'scope must survive compilation')
    assert.ok(tool.parameters.properties?.task_id, 'task_id must survive compilation')
    // The runtime omits `required` entirely when nothing is mandatory, which is
    // what standard JSON Schema does; an empty array would also be valid, so
    // accept either rather than pinning an implementation detail.
    const required = tool.parameters.required
    assert.ok(
      required === undefined || (Array.isArray(required) && required.length === 0),
      `no parameter should be mandatory, got ${JSON.stringify(required)}`,
    )
  })

  it('does not mark optional parameters with required: false', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // The runtime's authoring DSL accepts `required: true` or the key's absence,
    // and REJECTS `required: false` with UNSUPPORTED_SCHEMA. Omitting the key is
    // how a parameter is declared optional; writing `required: false` instead
    // makes defineTool throw, so the tool never registers at all.
    for (const [name, spec] of Object.entries(scopeToolOptions({ core }).parameters)) {
      assert.equal(
        Object.hasOwn(spec, 'required'),
        false,
        `${name} must omit the required key entirely, not set it false`,
      )
    }
  })

  it('an authoring mistake fails loudly here rather than silently at load', () => {
    const core = createGacCore()
    const broken = scopeToolOptions({ core })
    broken.parameters.scope.required = false
    assert.throws(
      () => toolsPackage.defineTool(broken),
      (error) => error?.code === 'UNSUPPORTED_SCHEMA',
    )
  })

  it('keeps every optional parameter optional, since all four overload one tool', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // Declaring any of them required would break inspect and clear, which send
    // only a subset.
    const required = tool.parameters.required
    assert.ok(
      required === undefined || required.length === 0,
      `expected no required parameters, got ${JSON.stringify(required)}`,
    )
    assert.deepEqual(
      Object.keys(tool.parameters.properties).sort(),
      ['clear', 'node_id', 'scope', 'task_id'],
    )
  })

  it('the executed tool still behaves after compilation', async () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    const exec = { agent: { session: { id: 'session-x' } } }
    const value = await tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, exec)
    assert.equal(value.governed, true)
    assert.match(value.summary, /src\//u)
  })
})

describe('scopeToolOptions without the runtime', () => {
  it('declares all four parameters and no required ones', () => {
    const options = scopeToolOptions({ core: createGacCore() })
    assert.deepEqual(
      Object.keys(options.parameters).sort(),
      ['clear', 'node_id', 'scope', 'task_id'],
    )
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.notEqual(spec.required, true, `${name} must stay optional`)
    }
  })
})
