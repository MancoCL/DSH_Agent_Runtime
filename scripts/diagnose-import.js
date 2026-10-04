/**
 * Ad-hoc diagnostic: resolve AND import a DSH package, reporting each stage.
 *
 * Resolution and import fail for different reasons, and conflating them is what
 * made the earlier "not resolvable" report misleading. This script prints both.
 *
 *     node scripts/diagnose-import.js
 */

import { pathToFileURL } from 'node:url'

import { describeResolutionFailure, resolveWithDiagnostics } from '../lib/resolve-dsh.js'

const SPECIFIER = '@deepseek-ai/dsh-tools'

const { resolved, attempts } = resolveWithDiagnostics(SPECIFIER)
console.log('attempts:')
for (const { anchor, reason } of attempts) {
  console.log(`  ${anchor} [${reason}]`)
}

if (resolved === undefined) {
  console.log('')
  console.log(describeResolutionFailure(SPECIFIER))
  process.exit(1)
}

console.log('')
console.log('resolved :', resolved)

try {
  const imported = await import(resolved)
  console.log('import   : OK, exports =', Object.keys(imported).slice(0, 12).join(', '))
  console.log('defineTool:', typeof imported.defineTool)
} catch (error) {
  console.log('import   : FAILED')
  console.log('  name   :', error?.name)
  console.log('  code   :', error?.code)
  console.log('  message:', error?.message)
  console.log('')
  console.log('retrying via pathToFileURL...')
  try {
    const imported = await import(pathToFileURL(resolved).href)
    console.log('  pathToFileURL import: OK, defineTool =', typeof imported.defineTool)
  } catch (retryError) {
    console.log('  pathToFileURL import: FAILED', retryError?.message)
  }
}
