/**
 * 输出契约测试：**每个工具真正返回的对象，必须与它自己声明的 `output.schema` 相符**。
 *
 * 为什么非有不可
 * ------------
 * DSH 在运行时按 `output.schema` 校验工具返回值，而**单测用的是透传的 `defineTool`，不做这个
 * 校验**。于是「返回了一个没声明的字段」在测试里永远看不见，在真实会话里却是**整次调用被判非法**
 * ——本仓库为此吃过两次亏：`gac_task` 返回未声明的 `plan_id`（登记验证计划、冻结契约因此做不成），
 * 以及 `gac_scope` 返回未声明的 `claim`（作用域其实生效了，模型收到的却是「invalid output」，
 * 声明看起来失败，生效期间连自己的作用域都查不了）。两次都是**活体验收**发现的，两次的单测全绿。
 *
 * 这个文件把这类缺陷变成单测能抓的东西：它按声明逐字段核对（`additionalProperties: false` 的
 * 含义是「没声明的键一个都不许出现」），顺带核对必填项、类型与渲染出口。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createGacCore } from '../lib/plugin.js'
import { ProjectState } from '../lib/project-state.js'
import { TaskStore } from '../lib/task-store.js'
import { createEvidenceTool } from '../lib/tool-evidence.js'
import { createMetricsTool } from '../lib/tool-metrics.js'
import { createProjectTool } from '../lib/tool-project.js'
import { createScopeTool } from '../lib/tool-scope.js'
import { createTaskTool } from '../lib/tool-task.js'

const roots = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时工程根。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-output-'))
  roots.push(root)
  return root
}

/** 透传的 `defineTool`：单测里不注入宿主行为，只把定义原样交回。 */
const identityDefineTool = (options) => options

/**
 * 一个够用的占用声明存储替身。
 *
 * `claim` 那个字段就是这么进来的：占用存储可用时，`gac_scope` 的声明与状态两个分支都会多返回
 * 一个 `claim`。所以这个测试必须让存储**在场**——缺席时那条分支根本不执行，缺陷也就看不见。
 *
 * @returns {object}
 */
function fakeClaimStore() {
  const held = new Map()
  return {
    acquire: ({ session_id: sessionId, task_id: taskId, node_id: nodeId }) => {
      held.set(sessionId, { dispatch_id: `${taskId}-${nodeId}-A1` })
      return { acquired: true }
    },
    get: (sessionId) => held.get(sessionId),
    release: (sessionId) => held.delete(sessionId),
  }
}

/**
 * 按声明核对一个返回值。
 *
 * @param {object} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]} 违规说明；空数组表示相符。
 */
function violations(value, schema, path = 'value') {
  const found = []
  const type = schema?.type
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} 应当是对象，实际是 ${Array.isArray(value) ? 'array' : typeof value}`]
    }
    const declared = schema.properties ?? {}
    // `additionalProperties` 缺省是**允许**多余键——宿主就是这么读的。只有声明成 false 时，
    // 没写进 properties 的键才是违规（这正是 `gac_scope` 的 `claim` 与 `gac_task` 的 `plan_id`
    // 两次事故的形态）。这里必须与宿主对齐，否则测试会用一份更严的规则造出假失败。
    const closed = schema.additionalProperties === false
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(declared, key)) {
        if (closed) {
          found.push(`${path}.${key} 没有在 output.schema 里声明（additionalProperties: false）`)
        }
        continue
      }
      if (value[key] === undefined) {
        found.push(`${path}.${key} 的值是 undefined —— 未声明的空洞不该出现在返回值里`)
        continue
      }
      found.push(...violations(value[key], declared[key], `${path}.${key}`))
    }
    for (const [key, propertySchema] of Object.entries(declared)) {
      if (propertySchema?.required === true && !Object.hasOwn(value, key)) {
        found.push(`${path}.${key} 声明为必填，返回值里没有`)
      }
    }
    return found
  }
  if (value === undefined || value === null) return found
  if (type === 'boolean' && typeof value !== 'boolean') found.push(`${path} 应当是 boolean`)
  if (type === 'string' && typeof value !== 'string') found.push(`${path} 应当是 string`)
  if (type === 'number' && typeof value !== 'number') found.push(`${path} 应当是 number`)
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path} 应当是 array`]
    if (schema.items !== undefined) {
      value.forEach((item, index) => found.push(...violations(item, schema.items, `${path}[${index}]`)))
    }
  }
  return found
}

/**
 * 造出五个工具，每个都配一个够它走到**主要分支**的依赖。
 *
 * @returns {{name: string, definition: object, args: object}[]}
 */
function allTools() {
  const root = scratch()
  const store = new TaskStore({ root })
  const claimStore = fakeClaimStore()
  const core = createGacCore({ resolveRoot: () => root })
  const state = new ProjectState({ resolveRoot: () => root })
  const evidenceFor = () => []
  return [
    {
      name: 'gac_project',
      definition: createProjectTool({ state, defineTool: identityDefineTool }),
      args: {},
    },
    {
      name: 'gac_scope',
      definition: createScopeTool({
        core,
        defineTool: identityDefineTool,
        claimStoreFor: () => claimStore,
        sessionRootFor: () => root,
      }),
      // 声明分支：占用存储在场时它会多返回 `claim`，正是漏声明过的那条路径。
      args: { task_id: 'REQ-OUTPUT', scope: ['src/'] },
    },
    {
      name: 'gac_task',
      definition: createTaskTool({
        defineTool: identityDefineTool,
        taskStoreFor: () => store,
        sessionRootFor: () => root,
        adapterFor: () => undefined,
        executorsFor: () => [],
        evidenceFor,
      }),
      args: { action: 'list' },
    },
    {
      name: 'gac_metrics',
      definition: createMetricsTool({
        defineTool: identityDefineTool,
        taskStoreFor: () => store,
        sessionRootFor: () => root,
        evidenceFor,
      }),
      args: {},
    },
    {
      name: 'gac_evidence',
      definition: createEvidenceTool({
        defineTool: identityDefineTool,
        sessionRootFor: () => root,
        evidenceFor,
      }),
      args: {},
    },
  ]
}

/** 一次调用的最小执行上下文。 */
const exec = { agent: { session: { id: 'session-output-contract' } } }

describe('输出契约：返回值必须与 output.schema 相符', () => {
  it('五个工具都声明了 output.schema 与渲染出口', () => {
    for (const { name, definition } of allTools()) {
      assert.ok(definition.output?.schema, `${name} 必须声明 output.schema`)
      assert.equal(typeof definition.output.render, 'function', `${name} 必须有渲染出口`)
    }
  })

  it('每个工具的主要分支返回值都逐字段相符', async () => {
    for (const { name, definition, args } of allTools()) {
      const value = await definition.execute(args, exec)
      const found = violations(value, definition.output.schema)
      assert.deepEqual(found, [], `${name} 的返回值与声明不符：\n${found.join('\n')}`)
    }
  })

  it('渲染出口吃得下自己的返回值 —— 渲染抛错同样是整次调用失败', async () => {
    for (const { name, definition, args } of allTools()) {
      const value = await definition.execute(args, exec)
      const rendered = definition.output.render(args, value)
      assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} 的渲染结果不能为空`)
      assert.equal(typeof rendered[0].text, 'string', `${name} 的渲染结果应当是文本`)
    }
  })

  it('占用存储在场时 gac_scope 声明分支会多返回 claim —— 这条路径必须仍然相符', async () => {
    // 单独钉一次：这正是活体验收抓到的那条。上面那条通用用例已经覆盖它，但把「claim 必须在场」
    // 写出来，是为了不让将来的重构把它悄悄去掉、从而又让这条路径失去覆盖。
    const scope = allTools().find((entry) => entry.name === 'gac_scope')
    const value = await scope.definition.execute(scope.args, exec)
    assert.equal(typeof value.claim, 'string', '占用存储在场时应当返回 claim')
    assert.ok(Object.hasOwn(scope.definition.output.schema.properties, 'claim'))
  })

  it('gac_scope 的状态分支（不声明、只查看）同样相符', async () => {
    const root = scratch()
    const claimStore = fakeClaimStore()
    const core = createGacCore({ resolveRoot: () => root })
    core.declareScope({
      session_id: 'session-output-contract',
      task_id: 'REQ-OUTPUT',
      node_id: 'REQ-OUTPUT',
      write_scope: ['src/'],
    })
    const definition = createScopeTool({
      core,
      defineTool: identityDefineTool,
      claimStoreFor: () => claimStore,
      sessionRootFor: () => root,
    })
    const value = await definition.execute({}, exec)
    assert.deepEqual(violations(value, definition.output.schema), [])
  })
})
