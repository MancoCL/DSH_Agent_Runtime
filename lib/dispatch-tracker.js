import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from './json-store.js'
import { applyResult } from './coordinator.js'

/** 后台派遣拥有取消信号；结果按任务串行结算，通知先进入本地持久化账本。 */
export class DispatchTracker {
  constructor({ root, store }) {
    this.store = store
    this.path = join(root, '.dsh/gac/dispatch/outbox.json')
    this.outbox = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}
    this.runs = new Map()
    this.queues = new Map()
    this.deliveries = new Map()
  }
  recover(task) {
    let current = task
    for (const node of task.nodes.values()) {
      const id = node.execution.active_dispatch_id
      if (node.status !== 'in_progress' || this.runs.has(id)) continue
      const applied = applyResult(current, { node_id: node.id, dispatch_id: id, status: 'failed', blocked_by: ['GAC_DISPATCH_INTERRUPTED'] })
      if (applied.classification === 'accepted') current = applied.task
    }
    if (current !== task) this.store.save(current)
    return current
  }
  submit({ taskId, dispatchId, owner, signal, run, settle, notify }) {
    if (this.runs.has(dispatchId)) return
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const record = { controller, owner }
    this.runs.set(dispatchId, record)
    const work = Promise.resolve().then(() => run(controller.signal))
      .catch((error) => ({ status: 'failed', note: String(error), blocked_by: ['GAC_DISPATCH_FAILED'] }))
      .then((outcome) => {
        const previous = this.queues.get(taskId) ?? Promise.resolve()
        const next = previous.catch(() => {}).then(async () => {
          const message = settle(controller.signal.aborted ? { status: 'failed', note: '派遣已取消。', blocked_by: ['GAC_DISPATCH_CANCELLED'] } : outcome)
          if (!message) return
          this.outbox[dispatchId] = { owner, message, delivered: false }
          writeJsonAtomic(this.path, this.outbox)
          if (!controller.signal.aborted) await this.flush(owner, notify)
        })
        this.queues.set(taskId, next)
        return next
      }).finally(() => { this.runs.delete(dispatchId); signal?.removeEventListener('abort', cancel) })
    record.done = work.catch((error) => { record.error = String(error) })
  }
  async flush(owner, notify) {
    const previous = this.deliveries.get(owner) ?? Promise.resolve()
    const delivery = previous.catch(() => {}).then(async () => {
    for (const [id, entry] of Object.entries(this.outbox)) {
      if (entry.owner !== owner || entry.delivered) continue
      await notify(entry.message, id)
      entry.delivered = true
      writeJsonAtomic(this.path, this.outbox)
    }
    })
    this.deliveries.set(owner, delivery)
    return delivery
  }
  async publishNotification(owner, message, id, notify) {
    if (!this.outbox[id]) {
      this.outbox[id] = { owner, message, delivered: false }
      writeJsonAtomic(this.path, this.outbox)
    }
    return this.flush(owner, notify)
  }
  cancel(owner) {
    for (const run of this.runs.values()) if (!owner || run.owner === owner) run.controller.abort()
  }
}
