/**
 * 运行时编写（runtime-authoring）集成测试。
 *
 * 这是本测试集中唯一对真实 DSH 运行时、而不是对桩件运行的测试；它存在的原因是：
 * `defineTool` 接受的参数 DSL 是运行时自己的东西——其中的错误无法靠阅读我们的代码
 * 发现，只能让真实的辅助函数跑一遍。
 *
 * 另一条路——重启 harness 去查明——已经试过，为一个写错的字段付出了两轮重启的
 * 代价。本测试是那个廉价的版本。
 *
 * DSH 未安装时跳过，因此单元测试集在任何环境下都仍能运行。
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
    // 编译出来的 schema 必须是真正的 JSON Schema，而不是我们的编写规范。
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties?.scope, 'scope must survive compilation')
    assert.ok(tool.parameters.properties?.task_id, 'task_id must survive compilation')
    // 没有任何必填项时，运行时会完全省略 `required`，这正是标准 JSON Schema 的
    // 做法；空数组同样合法，所以两种都接受，而不是把一个实现细节钉死。
    const required = tool.parameters.required
    assert.ok(
      required === undefined || (Array.isArray(required) && required.length === 0),
      `no parameter should be mandatory, got ${JSON.stringify(required)}`,
    )
  })

  it('does not mark optional parameters with required: false', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // 运行时的创作 DSL 接受 `required: true` 或该键缺失，并以 UNSUPPORTED_SCHEMA
    // 拒绝 `required: false`。省略该键才是声明参数可选的方式；改成写
    // `required: false` 会让 defineTool 抛错，于是工具根本注册不上。
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
    // 把其中任何一个声明为必填都会破坏 inspect 与 clear，它们只发送其中一部分
    // 参数。
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
