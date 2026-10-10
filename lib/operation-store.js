import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { writeJsonAtomic } from './json-store.js'
import { createWriteScope } from './write-scope.js'

export const CORE_IMPACTS = Object.freeze(['boot_recovery', 'flash_boundary', 'security_access', 'persistence_format', 'public_contract', 'project_invariant'])
export const COMPLEXITY_REASONS = Object.freeze(['multiple_causes', 'cross_module', 'specialist_work', 'context_volume'])

/** 语义由主 Agent 评估，运行时只认可完整、可追溯的结构。 */
export function assessOperation(raw, adapter) {
  if (!raw || !['read_only', 'comment', 'document', 'behavior'].includes(raw.change_kind)) throw new Error('GAC_ASSESSMENT_INVALID: 缺少 change_kind')
  if (typeof raw.behavior_summary !== 'string' || !raw.behavior_summary.trim()) throw new Error('GAC_ASSESSMENT_INVALID: 缺少行为依据')
  const target_paths = raw.target_paths ?? []
  if (!Array.isArray(target_paths)) throw new Error('GAC_ASSESSMENT_INVALID: target_paths 必须为数组')
  createWriteScope(target_paths)
  const complexity_reasons = raw.complexity_reasons ?? []
  const core_impacts = raw.core_impacts ?? []
  for (const [items, kinds] of [[complexity_reasons, COMPLEXITY_REASONS], [core_impacts, CORE_IMPACTS]]) {
    if (!Array.isArray(items)) throw new Error('GAC_ASSESSMENT_INVALID: 评估理由必须为数组')
    for (const item of items) {
      if (!kinds.includes(item?.kind) || typeof item.basis !== 'string' || !item.basis.trim()) throw new Error('GAC_ASSESSMENT_INVALID: 理由必须包含合法 kind 和 basis')
      if (item.kind === 'project_invariant' && !adapter?.risk?.core_invariants?.some((entry) => entry.id === item.invariant_id)) throw new Error('GAC_ASSESSMENT_INVALID: 未登记核心不变量')
    }
  }
  if (raw.change_kind !== 'behavior' && core_impacts.length) throw new Error('GAC_ASSESSMENT_INVALID: 非行为改动不能自称核心行为变更')
  return { change_kind: raw.change_kind, behavior_summary: raw.behavior_summary, target_paths: [...target_paths], complexity_reasons, core_impacts }
}

/** 轻量操作授权与任务记录分开持久化。 */
export class OperationStore {
  constructor({ root, claims, activeTasks = () => [] }) {
    this.directory = join(root, '.dsh/gac/operations')
    this.claims = claims
    this.activeTasks = activeTasks
  }
  path(id) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(id ?? '')) throw new Error('GAC_OPERATION_ID_INVALID')
    return join(this.directory, `${id}.json`)
  }
  load(id) {
    try { return JSON.parse(readFileSync(this.path(id), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  save(record) { writeJsonAtomic(this.path(record.operation_id), record); return record }
  current(sessionId) {
    let names
    try { names = readdirSync(this.directory) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    return names.filter((name) => name.endsWith('.json')).map((name) => this.load(name.slice(0, -5)))
      .filter((entry) => entry.session_id === sessionId && !['ended', 'cancelled'].includes(entry.status))
      .sort((a, b) => b.created_at - a.created_at)[0]
  }
  assertOwner(record, sessionId) {
    if (!record || record.session_id !== sessionId) throw new Error('GAC_OPERATION_OWNER_DENIED')
  }
  assertIdle(sessionId) {
    if (this.activeTasks().some((task) => task?.owner_session_id === sessionId && task.status !== 'completed')) throw new Error('GAC_ACTIVE_TASK_MODE_LOCKED')
  }
  begin(sessionId, reason = '') {
    this.assertIdle(sessionId)
    const previous = this.current(sessionId)
    if (previous) this.end(previous.operation_id, sessionId)
    return this.save({ operation_id: randomUUID(), session_id: sessionId, created_at: Date.now(), mode: 'direct_edit', status: 'active_direct', reason, revision: 0 })
  }
  assess(id, sessionId, input, adapter) {
    this.assertIdle(sessionId)
    const previous = this.load(id)
    this.assertOwner(previous, sessionId)
    const assessment = assessOperation(input, adapter)
    const fingerprint = createHash('sha256').update(JSON.stringify(assessment)).digest('hex')
    if (previous.assessment_ref === fingerprint) return previous
    const suggested_mode = assessment.core_impacts.length ? 'high_risk_task' : assessment.complexity_reasons.length ? 'standard_task' : 'direct_edit'
    if (suggested_mode === 'direct_edit' && assessment.target_paths.length && this.claims) {
      const claimed = this.claims.acquire({ session_id: sessionId, task_id: `direct:${id}`, node_id: 'direct', write_scope: assessment.target_paths })
      if (!claimed.acquired) throw new Error('GAC_DIRECT_CLAIM_CONFLICT')
    } else this.claims?.release(sessionId, sessionId)
    return this.save({ ...previous, assessment, assessment_ref: fingerprint, revision: previous.revision + 1, mode: 'direct_edit', suggested_mode, status: suggested_mode === 'direct_edit' ? 'active_direct' : 'upgrade_pending', approval: undefined })
  }
  async requestUpgrade(id, sessionId, ask) {
    const initial = this.load(id)
    this.assertOwner(initial, sessionId)
    if (initial.approval?.assessment_ref === initial.assessment_ref && initial.mode === initial.suggested_mode) return initial
    if (initial.status !== 'upgrade_pending') throw new Error('GAC_UPGRADE_NOT_PENDING')
    if (!ask) throw new Error('GAC_USER_QUESTIONS_UNAVAILABLE')
    const answer = await ask(initial)
    const current = this.load(id)
    if (current.assessment_ref !== initial.assessment_ref || current.status !== 'upgrade_pending') throw new Error('GAC_UPGRADE_APPROVAL_STALE')
    const agreed = answer?.selected?.length === 1 && answer.selected[0] === '同意升级' && !answer.custom
    return this.save({ ...current, status: agreed ? `active_${current.suggested_mode === 'standard_task' ? 'standard' : 'high_risk'}` : 'upgrade_rejected', mode: agreed ? current.suggested_mode : 'direct_edit', approval: agreed ? { assessment_ref: current.assessment_ref, at: Date.now(), answer_ref: answer.answer_ref } : undefined })
  }
  end(id, sessionId) {
    this.assertIdle(sessionId)
    const record = this.load(id)
    this.assertOwner(record, sessionId)
    this.claims?.release(sessionId, sessionId)
    return this.save({ ...record, status: 'ended' })
  }
  forTask(id, sessionId, mode) {
    const record = this.load(id)
    this.assertOwner(record, sessionId)
    if (!record.approval || !['active_standard', 'active_high_risk'].includes(record.status) || record.approval.assessment_ref !== record.assessment_ref) throw new Error('GAC_TASK_UPGRADE_APPROVAL_REQUIRED')
    if (mode && mode !== record.mode) throw new Error('GAC_TASK_MODE_MISMATCH')
    return record
  }
}
