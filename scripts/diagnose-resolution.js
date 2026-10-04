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
  candidateAnchors,
  describeResolutionFailure,
  resolveWithDiagnostics,
} from '../lib/resolve-dsh.js'

const SPECIFIER = '@deepseek-ai/dsh-tools'

console.log('cwd            :', process.cwd())
console.log('execPath       :', process.execPath)
console.log('DSH_HOME       :', process.env.DSH_HOME ?? '(unset)')
console.log('USERPROFILE    :', process.env.USERPROFILE ?? '(unset)')
console.log('')
console.log('anchors, in order:')

const { attempts } = resolveWithDiagnostics(SPECIFIER)
for (const { anchor, reason } of attempts) {
  console.log(`  ${reason === 'anchor does not exist' ? 'MISSING' : 'tried  '} ${anchor} [${reason}]`)
}

console.log('')
const resolved = resolveWithDiagnostics(SPECIFIER).resolved
console.log('resolved       :', resolved ?? describeResolutionFailure(SPECIFIER))
