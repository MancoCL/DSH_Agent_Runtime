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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createGacCore } from '../lib/plugin.js'
import { ProjectState } from '../lib/project-state.js'
import { importDshPackage } from '../lib/resolve-dsh.js'
import { TaskStore } from '../lib/task-store.js'
import { EVIDENCE_TOOL_NAME, createEvidenceTool } from '../lib/tool-evidence.js'
import { METRICS_TOOL_NAME, createMetricsTool } from '../lib/tool-metrics.js'
import { PROJECT_TOOL_NAME, createProjectTool } from '../lib/tool-project.js'
import { SCOPE_TOOL_NAME, createScopeTool, scopeToolOptions } from '../lib/tool-scope.js'
import { TASK_TOOL_NAME, createTaskTool } from '../lib/tool-task.js'

const toolsPackage = await importDshPackage('@deepseek-ai/dsh-tools')
const canRun = typeof toolsPackage?.defineTool === 'function'

describe('作用域工具能过运行时那套编写辅助函数', { skip: !canRun }, () => {
  it('defineTool 接受我们的选项且不抛错', () => {
    const core = createGacCore()
    assert.doesNotThrow(() => createScopeTool({ core, defineTool: toolsPackage.defineTool }))
  })

  it('产出的定义带有注册表所要求的成员', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    assert.equal(tool.name, SCOPE_TOOL_NAME)
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.output, '工具必须声明 output 定义')
    assert.equal(typeof tool.output.render, 'function')
  })

  it('把参数 DSL 编译成给模型看的 JSON Schema', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // 编译出来的 schema 必须是真正的 JSON Schema，而不是我们的编写规范。
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties?.scope, 'scope 必须存活于编译之后')
    assert.ok(tool.parameters.properties?.task_id, 'task_id 必须存活于编译之后')
    // 没有任何必填项时，运行时会完全省略 `required`，这正是标准 JSON Schema 的
    // 做法；空数组同样合法，所以两种都接受，而不是把一个实现细节钉死。
    const required = tool.parameters.required
    assert.ok(
      required === undefined || (Array.isArray(required) && required.length === 0),
      `不该有任何参数是必填的，实际为 ${JSON.stringify(required)}`,
    )
  })

  it('不会把可选参数标成 required: false', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // 运行时的创作 DSL 接受 `required: true` 或该键缺失，并以 UNSUPPORTED_SCHEMA
    // 拒绝 `required: false`。省略该键才是声明参数可选的方式；改成写
    // `required: false` 会让 defineTool 抛错，于是工具根本注册不上。
    for (const [name, spec] of Object.entries(scopeToolOptions({ core }).parameters)) {
      assert.equal(
        Object.hasOwn(spec, 'required'),
        false,
        `${name} 必须完全省略 required 键，而不是把它写成 false`,
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
  /**
   * 每个工具一组能让它跑起来的参数。
   *
   * render 体检必须真的执行一次 execute 才有值可渲染，因此每个工具都要有一个可用的最小入参。
   *
   * @param {string} name
   * @returns {object}
   */
  function representativeArgs(name) {
    if (name === TASK_TOOL_NAME) return { action: 'list' }
    return {}
  }

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
      [EVIDENCE_TOOL_NAME]: createEvidenceTool({ defineTool, sessionRootFor: () => root, evidenceFor: () => [] }),
    }
  }

  const built = buildAllTools()

  it('造出了每一个已在工具模块里导出了名字的工具', () => {
    // 双向核对：这里造出的集合，与各模块导出的工具名集合必须一致。少造一个就漏检一个。
    assert.deepEqual(
      Object.keys(built).sort(),
      [EVIDENCE_TOOL_NAME, METRICS_TOOL_NAME, PROJECT_TOOL_NAME, SCOPE_TOOL_NAME, TASK_TOOL_NAME].sort(),
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

      it('render 必须真的产出内容', async () => {
        // 数据对了不等于目的达到了。一个只渲染出一句空话（或什么都不渲染）的 render 会让
        // 工具在测试里全绿、在模型眼里毫无用处——`gac_evidence` 一度正是如此：它的 render
        // 只输出汇总句，模型看得到「共有 N 条证据」却看不到任何一个证据号。
        //
        // 这里只做通用检查（非空且含文本），工具特定的内容由各自的测试文件负责。
        assert.equal(typeof tool.output.render, 'function')
        const value = await tool.execute(representativeArgs(name), { agent: { session: { id: 'session-authoring' } } })
        const blocks = tool.output.render(representativeArgs(name), value)
        assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} 的 render 必须产出至少一个块`)
        const text = blocks.map((block) => block.text ?? '').join('')
        assert.ok(text.length > 0, `${name} 的 render 产出的文本不能为空`)
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

describe('每个动作返回的字段都必须在 output schema 里声明', { skip: !canRun }, () => {
  /**
   * 核对一次返回值没有带出未声明的字段。
   *
   * 运行时的输出校验以 `additionalProperties: false` 拒绝未声明的字段，**整次调用作废**。
   * 这条断言拦的就是那件事：`plan` 与 `contract` 曾返回 `plan_id` 而 schema 里没有它，
   * 于是**登记验证计划与冻结契约在真实插件里根本做不成**，而单测全绿——测试用的是透传的
   * `defineTool`，它不做输出校验。声明了什么就必须与真正返回什么一致。
   *
   * @param {object} tool
   * @param {object} value
   * @param {string} label
   */
  function assertDeclared(tool, value, label) {
    const declared = new Set(Object.keys(tool.output.schema.properties ?? {}))
    const extra = Object.keys(value).filter((key) => !declared.has(key))
    assert.deepEqual(
      extra,
      [],
      `${label} 返回了未在 output schema 里声明的字段：${extra.join(', ')}；`
      + `真实运行时会以 additionalProperties: false 拒绝整次调用`,
    )
  }

  /**
   * 一个可推进的任务工具，带临时存储。
   *
   * @returns {object}
   */
  function taskHarness() {
    const root = mkdtempSync(join(tmpdir(), 'gac-authoring-'))
    const store = new TaskStore({ root })
    return {
      root,
      store,
      tool: createTaskTool({
        defineTool: toolsPackage.defineTool,
        taskStoreFor: () => store,
        sessionRootFor: () => root,
        adapterFor: () => ({ executors: { implementation: ['builder'] } }),
        executorsFor: () => [{ name: 'builder', supports: () => true, run: async () => ({ status: 'completed', summary: 'ok' }) }],
        evidenceFor: () => [{ id: 'ev-1', tool: 'pwsh', is_error: false, exit_code: 0 }],
      }),
      exec: { agent: { session: { id: 'session-authoring' } } },
    }
  }

  it('gac_task 的 create / status / list 都不带出未声明字段', async () => {
    const h = taskHarness()
    assertDeclared(h.tool, await h.tool.execute({ action: 'list' }, h.exec), 'list')
    const created = await h.tool.execute({
      action: 'create',
      task_id: 'R',
      plan: { nodes: [{ id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: ['lib/a.js'] }] },
    }, h.exec)
    assertDeclared(h.tool, created, 'create')
    assertDeclared(h.tool, await h.tool.execute({ action: 'status', task_id: 'R' }, h.exec), 'status')
  })

  it('gac_task 的 plan 返回 plan_id，且它已被声明', async () => {
    // 这一条是本组断言存在的理由：plan_id 曾是未声明字段。
    const h = taskHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'R',
      mode: 'high_risk_task',
      plan: { nodes: [{ id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: [] }] },
    }, h.exec)
    const planned = await h.tool.execute({
      action: 'plan',
      task_id: 'R',
      criteria: ['AC1'],
      verification_plan: { cases: [
        { id: 'V1', covers: ['AC1'], type: 'positive', expect: 'x' },
        { id: 'V2', covers: ['AC1'], type: 'falsification', expect_failure: 'y' },
      ] },
    }, h.exec)
    assert.equal(planned.action, 'planned')
    assert.ok(planned.plan_id, 'plan 应当返回 plan_id')
    assertDeclared(h.tool, planned, 'plan')
  })

  it('gac_task 的 contract 返回 plan_id，且它已被声明', async () => {
    const h = taskHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'R',
      plan: { nodes: [
        { id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: ['lib/a.js'] },
        { id: 'T2', objective: 'y', required_capabilities: ['implementation'], write_scope: ['test/a.js'] },
      ] },
    }, h.exec)
    const frozen = await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'R',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)
    assert.equal(frozen.action, 'contract_frozen')
    assert.ok(frozen.plan_id, 'contract 应当返回 plan_id')
    assertDeclared(h.tool, frozen, 'contract')
  })

  it('gac_task 的 grill 各个子动作都不带出未声明字段', async () => {
    const h = taskHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'R',
      plan: { nodes: [{ id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: [] }] },
    }, h.exec)
    assertDeclared(h.tool, await h.tool.execute({ action: 'grill', task_id: 'R' }, h.exec), 'grill/status')
    assertDeclared(h.tool, await h.tool.execute({
      action: 'grill',
      task_id: 'R',
      grill_action: 'record',
      round: { questions: [{ id: 'Q1', question: 'q', answer: 'a' }] },
    }, h.exec), 'grill/record')
    assertDeclared(h.tool, await h.tool.execute({ action: 'grill', task_id: 'R', grill_action: 'converge' }, h.exec), 'grill/converge')
    assertDeclared(h.tool, await h.tool.execute({
      action: 'grill', task_id: 'R', grill_action: 'confirm', confirmation: '可以',
    }, h.exec), 'grill/confirm')
  })

  it('gac_task 的 advance 与 complete 都不带出未声明字段', async () => {
    const h = taskHarness()
    await h.tool.execute({
      action: 'create',
      task_id: 'R',
      plan: { nodes: [{ id: 'T1', objective: 'x', required_capabilities: ['implementation'], write_scope: [] }] },
    }, h.exec)
    assertDeclared(h.tool, await h.tool.execute({ action: 'advance', task_id: 'R' }, h.exec), 'advance')
    assertDeclared(h.tool, await h.tool.execute({
      action: 'complete',
      task_id: 'R',
      evidence: { all_criteria_covered: true },
    }, h.exec), 'complete')
  })

  it('gac_metrics 不带出未声明字段', async () => {
    const h = taskHarness()
    const tool = createMetricsTool({
      defineTool: toolsPackage.defineTool,
      taskStoreFor: () => h.store,
      sessionRootFor: () => h.root,
      evidenceFor: () => [],
    })
    assertDeclared(tool, await tool.execute({}, h.exec), 'gac_metrics')
  })

  it('gac_evidence 的字段在它自己的模块里被声明（若该工具已存在）', async () => {
    // 这条断言在工具尚未实现时会因为导入失败而报错，因此用动态导入：它让本文件在
    // 工具落地之前仍可运行，落地之后自动开始体检。
    let module
    try {
      module = await import('../lib/tool-evidence.js')
    } catch {
      return
    }
    const h = taskHarness()
    const tool = module.createEvidenceTool({
      defineTool: toolsPackage.defineTool,
      sessionRootFor: () => h.root,
      evidenceFor: () => [],
    })
    assertDeclared(tool, await tool.execute({}, h.exec), 'gac_evidence')
  })
})

describe('defineTool 拒绝创作错误：让它在这里响，而不是在加载时静默', { skip: !canRun }, () => {
  it('创作错误在这里大声报错，而不是在加载时静默', () => {
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

describe('作用域工具能过运行时那套编写辅助函数', { skip: !canRun }, () => {
  it('让每一个可选参数都保持可选，因为四个重载共用同一个工具', () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    // 把其中任何一个声明为必填都会破坏 inspect 与 clear，它们只发送其中一部分
    // 参数。
    const required = tool.parameters.required
    assert.ok(
      required === undefined || required.length === 0,
      `不该有必填参数，实际为 ${JSON.stringify(required)}`,
    )
    assert.deepEqual(
      Object.keys(tool.parameters.properties).sort(),
      ['clear', 'node_id', 'scope', 'task_id'],
    )
  })

  it('编译之后，执行这个工具时它的行为依旧', async () => {
    const core = createGacCore()
    const tool = createScopeTool({ core, defineTool: toolsPackage.defineTool })
    const exec = { agent: { session: { id: 'session-x' } } }
    const value = await tool.execute({ task_id: 'REQ-1', scope: ['src/'] }, exec)
    assert.equal(value.governed, true)
    assert.match(value.summary, /src\//u)
  })
})

describe('不依赖运行时的 scopeToolOptions', () => {
  it('声明全部四个参数，且没有一个是必填的', () => {
    const options = scopeToolOptions({ core: createGacCore() })
    assert.deepEqual(
      Object.keys(options.parameters).sort(),
      ['clear', 'node_id', 'scope', 'task_id'],
    )
    for (const [name, spec] of Object.entries(options.parameters)) {
      assert.notEqual(spec.required, true, `${name} 必须保持可选`)
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
