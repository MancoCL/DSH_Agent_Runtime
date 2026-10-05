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
console.log('DSH_HOME       :', process.env.DSH_HOME ?? '（未设置）')
console.log('USERPROFILE    :', process.env.USERPROFILE ?? '（未设置）')
console.log('')

const { anchors, notes } = anchorReport()
console.log('锚点列表是如何推导出来的：')
for (const note of notes) console.log(`  - ${note}`)
console.log('')
console.log(`锚点，按顺序（${anchors.length}）：`)

const { attempts, resolved, anchor: succeededAt } = resolveWithDiagnostics(SPECIFIER, anchors)
for (const { anchor, reason } of attempts) {
  console.log(`  ${reason === '锚点不存在' ? 'MISSING' : 'tried  '} ${anchor} [${reason}]`)
}
// 成功的那一个要单独打出来：`attempts` 里只有失败的锚点，早先这段代码因此把成功的那个当成
// 「未走到」打印，正好指错了地方——诊断里最要紧的一条信息就是「它是在哪儿找到的」。
if (resolved !== undefined && succeededAt !== undefined) {
  console.log(`  OK      ${succeededAt}`)
  // 成功那个之后的锚点从未被走到。
  const reached = new Set([...attempts.map((a) => a.anchor), succeededAt])
  for (const anchor of anchors.filter((a) => !reached.has(a))) {
    console.log(`  （未走到）${anchor}`)
  }
}

console.log('')
console.log('resolved       :', resolved ?? describeResolutionFailure(SPECIFIER))
