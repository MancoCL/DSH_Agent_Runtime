/**
 * Ad-hoc probe: does the scope tool actually register against the real runtime?
 *
 * This runs the same code path `lib/index.js` runs at load time — resolve the
 * runtime, apply its authoring helper, register nothing — and reports what the
 * agent-facing schema will contain. It answers "will a fresh session see
 * `gac_scope`?" without needing a fresh session.
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

// The tool must survive a round trip through its own compiled schema, because
// the registry validates model-supplied arguments against it before execute.
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
