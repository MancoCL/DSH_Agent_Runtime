/**
 * 临时诊断脚本：既解析又导入一个 DSH 包，逐阶段报告。
 *
 * 解析与导入会因为不同的原因失败，而把两者混为一谈，正是早先那份「不可解析」报告
 * 具有误导性的原因。本脚本把两者都打印出来。
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
  console.log('import   : OK，导出 =', Object.keys(imported).slice(0, 12).join(', '))
  console.log('defineTool:', typeof imported.defineTool)
} catch (error) {
  console.log('import   : FAILED')
  console.log('  name   :', error?.name)
  console.log('  code   :', error?.code)
  console.log('  message:', error?.message)
  console.log('')
  console.log('改用 pathToFileURL 重试……')
  try {
    const imported = await import(pathToFileURL(resolved).href)
    console.log('  pathToFileURL import: OK, defineTool =', typeof imported.defineTool)
  } catch (retryError) {
    console.log('  pathToFileURL import: FAILED', retryError?.message)
  }
}
