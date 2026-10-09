import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { planId } from './verification.js'

/** 仅注入声明过的测试事实，不读取实现推导预期。 */
export function verificationInputs(adapter, store) {
  return {
    engineeringFactsFor: () => {
      const facts = adapter?.verification_context
      return facts?.test_entry && facts?.capabilities ? JSON.stringify(facts) : undefined
    },
    testDetailFor: (taskId) => (store.loadDesign(taskId) ?? store.loadDesignDraft(taskId))?.artifacts?.test_detail,
    planCasesFor: (taskId) => store.loadPlan(taskId)?.cases,
  }
}

/** 不完整指纹不复用；忽略运行数据及依赖目录，哈希实际相关文件内容。 */
export function verificationFingerprint(task, store, adapter, root) {
  const plan = store.loadPlan(task.task_id)
  const environment = adapter?.verification_context?.environment_id
  if (!plan || !environment) return undefined
  const hash = createHash('sha256').update(JSON.stringify([task.task_id, planId(plan), store.loadDesign(task.task_id)?.ref, adapter.verification_context]))
  let scanned = 0
  let covered = 0
  const walk = (directory, relative = '') => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++scanned > 10000 || item.isSymbolicLink()) throw new Error('指纹覆盖不完整')
      if (['.git', '.dsh', 'node_modules'].includes(item.name)) continue
      const path = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) walk(join(directory, item.name), path)
      else { covered++; hash.update(JSON.stringify(path)).update(readFileSync(join(directory, item.name))) }
    }
  }
  try { walk(root); return covered ? hash.digest('hex') : undefined } catch { return undefined }
}
