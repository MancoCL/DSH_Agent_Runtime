/**
 * Ad-hoc diagnostic: print resolution anchors and why each failed.
 *
 * Kept as a file rather than a shell one-liner because the failure being
 * diagnosed is environment-dependent, and a script that prints the whole anchor
 * list is what makes the environment visible. Run with:
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
// Anchors after the one that succeeded were never reached.
if (resolved !== undefined) {
  const reached = new Set(attempts.map((a) => a.anchor))
  for (const anchor of anchors.filter((a) => !reached.has(a))) {
    console.log(`  (not reached) ${anchor}`)
  }
}

console.log('')
console.log('resolved       :', resolved ?? describeResolutionFailure(SPECIFIER))
