/**
 * 临时诊断脚本：打印解析锚点，以及每个锚点为什么失败。
 *
 * 之所以留成一个文件、而不是一条 shell 单行命令，是因为要诊断的故障取决于环境，
 * 而一个会打印出完整锚点列表的脚本，正是让环境变得可见的东西。运行方式：
 *
 *     node scripts/diagnose-resolution.js
 */

import {
  anchorReport,
  describeResolutionFailure,
  resolveWithDiagnostics,
} from '../lib/resolve-dsh.js'

const SPECIFIER = '@deepseek-ai/dsh-tools'

console.log('cwd            :', process.cwd())
console.log('execPath       :', process.execPath)
console.log('DSH_HOME       :', process.env.DSH_HOME ?? '(unset)')
console.log('USERPROFILE    :', process.env.USERPROFILE ?? '(unset)')
console.log('')

const { anchors, notes } = anchorReport()
console.log('how the anchor list was derived:')
for (const note of notes) console.log(`  - ${note}`)
console.log('')
console.log(`anchors, in order (${anchors.length}):`)

const { attempts, resolved } = resolveWithDiagnostics(SPECIFIER, anchors)
for (const { anchor, reason } of attempts) {
  console.log(`  ${reason === 'anchor does not exist' ? 'MISSING' : 'tried  '} ${anchor} [${reason}]`)
}
// 成功那个锚点之后的锚点从未被走到。
if (resolved !== undefined) {
  const reached = new Set(attempts.map((a) => a.anchor))
  for (const anchor of anchors.filter((a) => !reached.has(a))) {
    console.log(`  (not reached) ${anchor}`)
  }
}

console.log('')
console.log('resolved       :', resolved ?? describeResolutionFailure(SPECIFIER))
