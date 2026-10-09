import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeJsonAtomic } from './json-store.js'
import { roleDenyFor } from './role-tools.js'

const EXPERT_ROLES = ['software_design', 'test_design', 'verification_design']

/** 助手属于父派遣，结果只通知父专家；父授权失效后不接受成功结果。 */
export class ExpertHelpers {
  constructor({ root, bindings, surface, subagentsFor, namesFor, isCurrent, notify }) {
    Object.assign(this, { root, bindings, surface, subagentsFor, namesFor, isCurrent, notify })
    this.parents = new Map()
  }
  openParent(id, identity, signal, context) {
    this.parents.set(id, { identity, signal, context, total: 0, helpers: new Map() })
  }
  parentFor(agent) {
    const id = agent?.session?.id
    const parent = this.parents.get(id)
    const bound = this.bindings.roleOf(id)
    if (!parent || !bound || !EXPERT_ROLES.includes(bound.role) || bound.dispatch_id !== parent.identity.dispatch_id || agent.session.header?.delegationDepth !== 1 || parent.signal?.aborted || !this.isCurrent(parent.identity)) throw new Error('GAC_EXPERT_PARENT_INVALID：需要有效的直属专家派遣')
    return parent
  }
  start(agent, { question, expected_artifact }) {
    const parent = this.parentFor(agent)
    if (typeof question !== 'string' || !question.trim() || typeof expected_artifact !== 'string' || !expected_artifact.trim()) throw new Error('GAC_EXPERT_INPUT_INVALID')
    if (parent.total >= 4 || [...parent.helpers.values()].filter((helper) => helper.status === 'running').length >= 2) throw new Error('GAC_EXPERT_BUDGET_EXCEEDED')
    const subagents = this.subagentsFor()
    if (typeof subagents?.start !== 'function') throw new Error('GAC_EXPERT_SEAM_UNAVAILABLE')
    const id = randomUUID()
    const controller = new AbortController()
    const cancel = () => controller.abort(parent.signal?.reason)
    parent.signal?.addEventListener('abort', cancel, { once: true })
    const helper = { id, status: 'running', controller }
    parent.total++
    parent.helpers.set(id, helper)
    const role = `${parent.identity.role}_assistant`
    const persist = () => writeJsonAtomic(join(this.root, '.dsh/gac/experts', `${id}.json`), { id, status: helper.status, parent: parent.identity, result: helper.result, error: helper.error })
    persist()
    helper.done = (async () => {
      let run
      try {
        const names = this.namesFor(agent)
        if (!Array.isArray(names)) throw new Error('GAC_EXPERT_SURFACE_UNAVAILABLE')
        run = await subagents.start('spawn', { parent: agent, signal: controller.signal, maxDepth: 2, label: `专家助手/${id}`, persona: '只完成专业子问题，不写文件、不审批、不创建任务、不再次委派。', prompt: [{ type: 'text', text: `父专家获授权的需求侧上下文：\n${parent.context}\n专业子问题：${question}\n预期产物：${expected_artifact}` }], toolFilter: { deny: names.filter((name) => name !== 'run_code' && roleDenyFor({ role, name, write_scope: [] })) }, outputSchema: { type: 'object', additionalProperties: false, required: ['status', 'summary', 'artifact'], properties: { status: { type: 'string', enum: ['completed', 'blocked', 'failed'] }, summary: { type: 'string' }, artifact: { type: 'string' } } } })
        const identity = { ...parent.identity, child_session_id: run.id, parent_session_id: agent.session.id, role, write_scope: [], dispatch_id: `helper:${id}` }
        this.bindings.declareRole(identity)
        this.surface.bind({ ...identity, binding: identity, agent: run.localAgent })
        const result = (await run.result)?.structured
        if (controller.signal.aborted || this.parents.get(agent.session.id) !== parent || !this.isCurrent(parent.identity)) helper.status = 'cancelled'
        else if (!result || !['completed', 'blocked', 'failed'].includes(result.status) || typeof result.summary !== 'string' || typeof result.artifact !== 'string') throw new Error('GAC_EXPERT_OUTPUT_INVALID')
        else { helper.status = result.status; helper.result = result }
      } catch (error) { helper.status = controller.signal.aborted ? 'cancelled' : 'failed'; helper.error = String(error) }
      finally {
        parent.signal?.removeEventListener('abort', cancel)
        if (run) { this.bindings.releaseRole(`helper:${id}`); this.surface.unbind(run.id); try { await run.dispose?.() } catch {} }
        persist()
      }
      if (this.parents.get(agent.session.id) === parent && !parent.signal?.aborted) {
        try { await this.notify(agent, `专家助手 ${id} 已${helper.status}。${helper.result?.summary ?? helper.error ?? ''}请用 gac_expert status 读取产物并综合。`, `helper-${id}`) } catch (error) { helper.error = String(error); persist() }
      }
    })()
    return { helper_id: id, status: 'running' }
  }
  status(agent, id) {
    const helper = this.parentFor(agent).helpers.get(id)
    if (!helper) throw new Error('GAC_EXPERT_OWNER_MISMATCH')
    return { helper_id: id, status: helper.status, result: helper.result, error: helper.error }
  }
  cancelStale() {
    for (const [id, parent] of this.parents) if (!this.isCurrent(parent.identity) || parent.signal?.aborted) void this.closeParent(id).catch(() => {})
  }
  async closeParent(id) {
    const parent = this.parents.get(id)
    if (!parent) return
    this.parents.delete(id)
    for (const helper of parent.helpers.values()) helper.controller.abort()
    await Promise.all([...parent.helpers.values()].map((helper) => helper.done))
  }
}

export function createExpertTool({ defineTool, helpersFor, rootFor }) {
  return defineTool({ name: 'gac_expert', description: '直属设计专家启动或读取一层只读助手。start 返回运行标识，结果到达后通知父专家。', parameters: { action: { type: 'string', required: true, enum: ['start', 'status'] }, question: { type: 'string' }, expected_artifact: { type: 'string' }, helper_id: { type: 'string' } }, output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, async execute(args, exec) {
    const helpers = helpersFor(rootFor(exec?.agent?.session?.id))
    if (args.action === 'start') return helpers.start(exec.agent, args)
    if (args.action === 'status') return helpers.status(exec.agent, args.helper_id)
    throw new Error('GAC_EXPERT_ACTION_INVALID')
  } })
}
