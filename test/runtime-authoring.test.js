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
import { ProjectState } from '../lib/project-state.js'
import { importDshPackage } from '../lib/resolve-dsh.js'
import { TaskStore } from '../lib/task-store.js'
import { METRICS_TOOL_NAME, createMetricsTool } from '../lib/tool-metrics.js'
import { PROJECT_TOOL_NAME, createProjectTool } from '../lib/tool-project.js'
import { SCOPE_TOOL_NAME, createScopeTool, scopeToolOptions } from '../lib/tool-scope.js'
import { TASK_TOOL_NAME, createTaskTool } from '../lib/tool-task.js'

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
})

describe('每一个登记的工具都要过真实 defineTool 这一关', { skip: !canRun }, () => {
  /**
   * 造出全部工具，键为工具名。
   *
   * 刻意**不写死清单**：写死清单会在新增工具时静默漏掉它，而本组断言存在的唯一理由就是
   * 「新增的工具也得过这一关」。这条路是踩出来的——`gac_metrics` 第一次加进来时漏了
   * `output`，测试全绿而插件在真实加载时报
   * `Cannot read properties of undefined (reading 'render')`，于是四个工具一个都没注册上。
   * 当时本文件只检查了 `gac_scope` 一个工具。
   *
   * @returns {Record<string, object>}
   */
  function buildAllTools() {
    const core = createGacCore()
    const root = process.cwd()
    const store = new TaskStore({ root })
    const state = new ProjectState({ resolveRoot: () => root })
    const defineTool = toolsPackage.defineTool
    return {
      [SCOPE_TOOL_NAME]: createScopeTool({ core, defineTool }),
      [PROJECT_TOOL_NAME]: createProjectTool({ state, defineTool }),
      [TASK_TOOL_NAME]: createTaskTool({ defineTool, taskStoreFor: () => store, sessionRootFor: () => root }),
      [METRICS_TOOL_NAME]: createMetricsTool({ defineTool, taskStoreFor: () => store, sessionRootFor: () => root, evidenceFor: () => [] }),
    }
  }

  const built = buildAllTools()

  it('造出了每一个已在工具模块里导出了名字的工具', () => {
    // 双向核对：这里造出的集合，与各模块导出的工具名集合必须一致。少造一个就漏检一个。
    assert.deepEqual(
      Object.keys(built).sort(),
      [METRICS_TOOL_NAME, PROJECT_TOOL_NAME, SCOPE_TOOL_NAME, TASK_TOOL_NAME].sort(),
    )
  })

  for (const [name, tool] of Object.entries(built)) {
    describe(name, () => {
      it('defineTool 接受它的选项', () => {
        assert.equal(tool.name, name)
      })

      it('声明了运行时期待的全部成员', () => {
        assert.equal(typeof tool.description, 'string')
        assert.equal(typeof tool.parameters, 'object')
        assert.equal(typeof tool.execute, 'function')
        // 漏掉 output 时 defineTool 会在读 `.render` 上抛错，而那时工具**一个都**注册不上。
        assert.ok(tool.output, '每个工具都必须声明 output')
        assert.equal(typeof tool.output.render, 'function')
        assert.equal(typeof tool.output.schema, 'object')
      })

      it('编译出的参数是真正的 JSON Schema', () => {
        assert.equal(tool.parameters.type, 'object')
        assert.ok(tool.parameters.properties, '参数必须编译出 properties')
      })

      it('没有把可选参数写成 required: false', () => {
        // 创作 DSL 接受 `required: true` 或该键缺失，并以 UNSUPPORTED_SCHEMA 拒绝
        // `required: false`；写成 false 会让工具根本注册不上。
        for (const [param, spec] of Object.entries(tool.parameters.properties ?? {})) {
          if (spec === null || typeof spec !== 'object') continue
          assert.notEqual(spec.required, false, `${name}.${param} 不应把 required 写成 false`)
        }
      })
    })
  }
})

describe('defineTool 拒绝创作错误：让它在这里响，而不是在加载时静默', { skip: !canRun }, () => {
  it('an authoring mistake fails loudly here rather than silently at load', () => {
    const core = createGacCore()
    const broken = scopeToolOptions({ core })
    broken.parameters.scope.required = false
    assert.throws(
      () => toolsPackage.defineTool(broken),
      (error) => error?.code === 'UNSUPPORTED_SCHEMA',
    )
  })

  it('缺少 output 时必须抛错，而不是让整批工具都注册不上', () => {
    // 这正是 gac_metrics 第一次加进来时的样子：漏了 output，测试全绿，插件在真实加载时
    // 抛 `Cannot read properties of undefined (reading 'render')`。
    const core = createGacCore()
    const broken = scopeToolOptions({ core })
    delete broken.output
    assert.throws(() => toolsPackage.defineTool(broken))
  })
})

describe('the scope tool survives the runtime authoring helper', { skip: !canRun }, () => {
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

describe('每个工具都要过运行时那套编写校验', { skip: !canRun }, () => {
  // 参数 DSL 属于运行时而不是本仓库，所以「defineTool 会不会接受它」只能靠把每个工具
  // 都跑一遍来回答。已经踩过两次：`required: false` 与对象型参数缺
  // `additionalProperties` 都会让 defineTool 抛错，而工具会静默地根本不注册。
  it('gac_task 通过 defineTool，且对象型参数显式声明 additionalProperties', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { TaskStore } = await import('../lib/task-store.js')
    const { createTaskTool, taskToolOptions } = await import('../lib/tool-task.js')

    const root = mkdtempSync(join(tmpdir(), 'gac-authoring-'))
    try {
      const store = new TaskStore({ root })
      const deps = { taskStoreFor: () => store, sessionRootFor: () => root }
      assert.doesNotThrow(() => createTaskTool({ ...deps, defineTool: toolsPackage.defineTool }))

      const tool = createTaskTool({ ...deps, defineTool: toolsPackage.defineTool })
      assert.equal(typeof tool.execute, 'function')
      assert.ok(tool.parameters.properties.plan, 'plan 必须存活于编译后的 schema')
      for (const [name, spec] of Object.entries(taskToolOptions(deps).parameters)) {
        if (spec.type !== 'object') continue
        assert.equal(
          typeof spec.additionalProperties,
          'boolean',
          `${name} 是对象型参数，必须显式声明 additionalProperties`,
        )
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
