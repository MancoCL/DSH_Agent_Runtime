/**
 * 临时探针：作用域工具是否真的对真实运行时注册成功？
 *
 * 它跑的是 `lib/index.js` 在加载时跑的同一段代码路径——解析运行时、应用其编写
 * 辅助函数、不注册任何东西——并报告面向 agent 的 schema 里会有什么。它回答的是
 * 「一个新会话会看到 `gac_scope` 吗？」，而不需要真的开一个新会话。
 *
 *     node scripts/probe-scope-tool.js
 */

import { createGacCore } from '../lib/plugin.js'
import { importDshPackage } from '../lib/resolve-dsh.js'
import { createScopeTool } from '../lib/tool-scope.js'

const tools = await importDshPackage('@deepseek-ai/dsh-tools')
if (tools === undefined) {
  console.log('FAIL: could not import @deepseek-ai/dsh-tools')
  process.exit(1)
}

const core = createGacCore()
const tool = createScopeTool({ core, defineTool: tools.defineTool })

console.log('name      :', tool.name)
console.log('parameters:', JSON.stringify(tool.parameters, null, 2))
console.log('output    :', JSON.stringify(tool.output.schema, null, 2))
console.log('execute   :', typeof tool.execute)

// 工具必须能在自己编译出的 schema 上完整走一个来回，因为注册表会在 execute 之前
// 依据它校验模型提供的参数。
const cases = [
  ['inspect', {}],
  ['declare', { task_id: 'REQ-1', scope: ['src/'] }],
  ['declare + node', { task_id: 'REQ-1', node_id: 'T2', scope: ['docs/a.md'] }],
  ['clear', { clear: true }],
]
const exec = { agent: { session: { id: 'probe-session' } } }
for (const [label, args] of cases) {
  const value = await tool.execute(args, exec)
  console.log(`  ${label.padEnd(14)} governed=${String(value.governed).padEnd(5)} scope=${JSON.stringify(value.scope)}`)
}

console.log('')
console.log('OK: the tool builds, compiles and executes.')
