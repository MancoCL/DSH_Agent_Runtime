import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { writeJsonAtomic } from './json-store.js'
import {
  DISPATCH_FAILURE_CODES,
  markDispatchProgress,
  orphanDispatch,
  recordFailure,
} from './coordinator.js'

/**
 * 后台派遣的登记、收敛与通知账本。
 *
 * 三条不变量，都是活体故障换来的：
 *
 *  1. **内存里没有这次 run，不等于子 Agent 已经停了。** 插件重载、宿主仍在执行、
 *     甚至只是换了一个 Tracker 实例，都会让 `this.runs` 变空。据此判 `failed` 是在编造
 *     一个从未被观察到的死因，并且会顺手释放节点的写范围，让第二个写者入场。
 *     恢复只允许标「阻塞 + 状态未知」，身份留在 `execution.last_failure` 里，由协调会话显式 `reopen`。
 *  2. **结算与通知各归各。** 结算失败要记在节点上，并且必须保证有人收到通知；
 *     通知失败只让账本条目留着重投，**绝不回头改写已经结算好的节点状态**。
 *  3. **身份优先于状态。** 任何一次进度或孤儿登记都先核对 `active_dispatch_id`：
 *     旧 attempt 的迟到结果改不动新 attempt，重复恢复也不会写出第二份诊断。
 *
 * 本类只负责「登记 + 通知」；状态的合法性由 `lib/coordinator.js` 判定（它抛出 CoordinatorError，
 * 这里不吞也不改）。于是「谁有权改任务状态」始终只有一个答案。
 */
export class DispatchTracker {
  /**
   * @param {object} options
   * @param {string} options.root - 工程根（账本落在 `<root>/.dsh/gac/dispatch/outbox.json`）。
   * @param {object} options.store - 任务存储（`createTaskStore`）。
   * @param {(probe: object) => ('running'|'absent'|undefined)} [options.livenessFor] -
   *   宿主提供的子会话状态查询（问题 A ④）。语义必须是三态：`'running'` 表示**确认**执行者还在跑；
   *   `'absent'` 表示这一进程里已经查不到这个子会话；`undefined` 表示**查不到**（没有接缝、
   *   或记录里没有子会话 id）。三者区别对待：只有后两种才走孤儿处置，且都不判失败。
   * @param {() => number} [options.now]
   */
  constructor({ root, store, livenessFor, now } = {}) {
    this.store = store
    this.livenessFor = livenessFor
    this.now = now ?? (() => Date.now())
    this.path = join(root, '.dsh/gac/dispatch/outbox.json')
    this.outbox = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}
    this.runs = new Map()
    this.queues = new Map()
    this.deliveries = new Map()
    // 账本自身的故障（登记失败、通知失败）留在这里：它们不该掀翻正在执行的派遣，
    // 但也不允许静默消失，`diagnostics()` 是它们的出口。
    this.faults = []
  }

  /**
   * 恢复扫描（问题 A ③④⑤）。
   *
   * 只处理「本进程没有登记、但任务记录里写着正在执行」的节点，并且**绝不写 failed**：
   *  - 宿主能确认执行者仍在运行 → 保留执行态，只把生命周期推进到 `running`；
   *  - 宿主说查不到、或根本没有查询接缝 → 标 `blocked` + `GAC_DISPATCH_ORPHANED`
   *    （状态未知、不可自动重试、现场保留）。
   *
   * 幂等：同一个 `dispatch_id` 重复恢复不会产生第二份诊断，也不会再落一次盘。
   *
   * @param {object} task
   * @returns {object} 恢复后的任务（未变化时返回原对象，调用方据此决定是否落盘）。
   */
  recover(task) {
    const at = this.now()
    let current = task
    for (const node of task.nodes.values()) {
      if (node.status !== 'in_progress') continue
      const dispatchId = node.execution.active_dispatch_id
      if (typeof dispatchId !== 'string' || dispatchId === '') continue
      // 本进程登记着这次派遣：宿主的回报还在路上，什么都不用做，更不该改写它的状态。
      if (this.runs.has(dispatchId)) continue
      const liveness = this.probe(node, task.task_id, dispatchId)
      if (liveness === 'running') {
        current = markDispatchProgress(current, node.id, dispatchId, 'running', { last_progress_at: at })
        continue
      }
      current = orphanDispatch(current, node.id, dispatchId, {
        at,
        detail: this.orphanDetail(node, liveness),
      })
    }
    if (current !== task) this.store.save(current)
    return current
  }

  /**
   * 把一次生命周期推进落盘（问题 A ①②）。
   *
   * 登记失败只记进账本诊断，不抛出：它是诊断通道，不能让自身的异常掀翻真正在执行的派遣。
   *
   * @param {string} taskId
   * @param {string} nodeId
   * @param {string} dispatchId
   * @param {string} state - {@link EXECUTION_LIFECYCLE} 之一。
   * @param {object} [patch]
   */
  record(taskId, nodeId, dispatchId, state, patch = {}) {
    this.update(taskId, (task) => markDispatchProgress(task, nodeId, dispatchId, state, patch))
  }

  /**
   * 子会话 id 一到手就落盘（问题 A ①/⑥）：没有它，重启后连「该去问哪一个子会话」都无从谈起。
   */
  noteChildSession({ taskId, nodeId, dispatchId, childSessionId }) {
    if (typeof childSessionId !== 'string' || childSessionId === '') return
    this.record(taskId, nodeId, dispatchId, 'started', {
      child_session_id: childSessionId,
      last_progress_at: this.now(),
    })
  }

  /**
   * 只登记失败诊断，不动节点状态（问题 C 的第 ⑤/⑥/⑦ 类）。
   *
   * @param {string} taskId
   * @param {string} nodeId
   * @param {string} dispatchId
   * @param {object} diagnosis
   */
  diagnose(taskId, nodeId, dispatchId, diagnosis) {
    this.update(taskId, (task) => {
      const node = task.nodes.get(nodeId)
      // 身份不符说明这份诊断属于一次已经作废的执行：记上去只会给新执行编造死因。
      if (node === undefined || node.execution.active_dispatch_id !== dispatchId) return undefined
      return recordFailure(task, node, {
        ...diagnosis,
        at: typeof diagnosis.at === 'number' ? diagnosis.at : this.now(),
      })
    })
  }

  /**
   * 账本故障登记（有界，只保留最近 20 条）。
   */
  noteFault(code, detail, extra = {}) {
    this.faults.push({
      code,
      detail: String(detail ?? '').slice(0, 300),
      at: this.now(),
      ...extra,
    })
    if (this.faults.length > 20) this.faults.splice(0, this.faults.length - 20)
  }

  /**
   * @returns {object[]} 账本自身留下的诊断（登记失败、通知失败）。
   */
  diagnostics() {
    return [...this.faults]
  }

  /**
   * 派遣一次后台执行，并保证「结果 → 结算 → 通知」这条链上每一环的失败都留痕且不互相篡改。
   *
   * @param {object} options
   * @param {string} options.taskId
   * @param {string} options.nodeId
   * @param {string} options.dispatchId
   * @param {string} options.owner - 协调会话 id（通知只发给它）。
   * @param {AbortSignal} [options.signal] - 派遣方的取消信号。
   * @param {(signal: AbortSignal) => Promise<object>} options.run
   * @param {(outcome: object) => (string|undefined)} options.settle
   * @param {(message: string, id: string) => Promise<void>} options.notify
   */
  submit({ taskId, nodeId, dispatchId, owner, signal, run, settle, notify }) {
    if (this.runs.has(dispatchId)) return
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const record = { controller, owner }
    this.runs.set(dispatchId, record)

    const work = Promise.resolve()
      .then(() => {
        this.record(taskId, nodeId, dispatchId, 'starting')
        return run(controller.signal)
      })
      .catch((error) => ({
        status: 'failed',
        // ①/②/③ 类的码由执行者自己带上来（见 lib/child-executor.js）；
        // 没有码的异常落到兜底码，但摘要一定保留——码可以粗，死因不能丢。
        blocked_by: [typeof error?.code === 'string' && error.code !== ''
          ? error.code
          : DISPATCH_FAILURE_CODES.DISPATCH_FAILED],
        note: String(error?.message ?? error),
        detail: typeof error?.detail === 'string' ? error.detail : undefined,
        retryable: error?.retryable === true,
        at: this.now(),
      }))
      .then((outcome) => {
        const previous = this.queues.get(taskId) ?? Promise.resolve()
        const next = previous.catch(() => {}).then(async () => {
          const cancelled = controller.signal.aborted
          const settled = cancelled
            ? {
              status: 'failed',
              note: '派遣已取消。',
              blocked_by: [DISPATCH_FAILURE_CODES.CANCELLED],
              retryable: false,
              at: this.now(),
            }
            : outcome
          this.record(taskId, nodeId, dispatchId, 'result_returned', {
            child_session_id: settled?.child_session_id ?? undefined,
            last_progress_at: this.now(),
          })
          let message
          try {
            message = settle(settled)
          } catch (error) {
            // ⑥ 状态结算失败：这次派遣已经结束了，但结果没能落盘。既要把死因记在节点上，
            // 也必须让协调会话收到一条通知——否则任务会停在 in_progress 而无人被告知。
            const detail = `状态结算失败：${String(error?.message ?? error)}`
            this.noteFault(DISPATCH_FAILURE_CODES.SETTLE_FAILED, detail, {
              task_id: taskId,
              node_id: nodeId,
              dispatch_id: dispatchId,
            })
            this.diagnose(taskId, nodeId, dispatchId, {
              code: DISPATCH_FAILURE_CODES.SETTLE_FAILED,
              detail,
              stage: 'settlement',
              retryable: true,
            })
            message = `GAC 节点 ${nodeId} 的派遣结果无法结算（${DISPATCH_FAILURE_CODES.SETTLE_FAILED}）：`
              + `${detail}。任务 ${taskId} 的节点状态未变，请读取任务，确认现场后用 action "reopen" 重新打开该节点。`
          }
          if (!message) return
          this.outbox[dispatchId] = { owner, message, delivered: false }
          writeJsonAtomic(this.path, this.outbox)
          if (cancelled) return
          try {
            await this.flush(owner, notify)
          } catch (error) {
            // ⑦ 通知失败：账本条目留在盘上（`delivered` 仍为 false），下一次 flush 会重投。
            // **不碰节点状态**：结算已经成功，通知只是投递，投递失败不是执行失败。
            this.noteFault(DISPATCH_FAILURE_CODES.NOTIFY_FAILED, `通知失败：${String(error?.message ?? error)}`, {
              task_id: taskId,
              node_id: nodeId,
              dispatch_id: dispatchId,
            })
          }
        })
        this.queues.set(taskId, next)
        return next
      })
      .finally(() => {
        this.runs.delete(dispatchId)
        signal?.removeEventListener('abort', cancel)
      })

    record.done = work.catch((error) => {
      record.error = String(error)
      this.noteFault(DISPATCH_FAILURE_CODES.SETTLE_FAILED, `后台派遣收敛失败：${String(error?.message ?? error)}`, {
        task_id: taskId,
        node_id: nodeId,
        dispatch_id: dispatchId,
      })
    })
    return work
  }

  /**
   * 把某个会话的待投递通知按序投完。条目只有在**投递成功之后**才标记为已投，
   * 所以中途失败不会丢消息，重投也不会重复计数（问题 C 第 ⑦ 类的重试路径）。
   *
   * @param {string} owner
   * @param {(message: string, id: string) => Promise<void>} notify
   */
  async flush(owner, notify) {
    const previous = this.deliveries.get(owner) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      for (const [id, entry] of Object.entries(this.outbox)) {
        if (entry.owner !== owner || entry.delivered) continue
        try {
          await notify(entry.message, id)
        } catch (error) {
          this.noteFault(DISPATCH_FAILURE_CODES.NOTIFY_FAILED, `通知投递失败（${id}）：${String(error?.message ?? error)}`, { dispatch_id: id })
          throw error
        }
        entry.delivered = true
        writeJsonAtomic(this.path, this.outbox)
      }
    })
    this.deliveries.set(owner, next)
    return next
  }

  /**
   * 由非派遣路径产生的通知（如专家帮助）也走同一个账本：只保留一份投递真相。
   */
  publishNotification(owner, message, id, notify) {
    const entry = this.outbox[id]
    if (!entry) {
      this.outbox[id] = { owner, message, delivered: false }
      writeJsonAtomic(this.path, this.outbox)
    }
    return this.flush(owner, notify)
  }

  /**
   * 取消某个会话派出的执行。**取消信号被受理不等于执行者已经停下**——
   * 真正的终态仍由结算路径写（`cancelled`），这里只负责把信号送到。
   */
  cancel(owner) {
    for (const record of this.runs.values()) {
      if (owner && record.owner !== owner) continue
      record.controller.abort()
    }
  }

  /**
   * 落盘一次任务改写；`mutate` 返回 `undefined` 表示「这次不改」（身份不符等），
   * 抛出则记为账本诊断而不是让派遣本身失败。
   */
  update(taskId, mutate) {
    try {
      const task = this.store.load(taskId)
      if (task === undefined) return
      const next = mutate(task)
      if (next !== undefined && next !== task) this.store.save(next)
    } catch (error) {
      this.noteFault(DISPATCH_FAILURE_CODES.SETTLE_FAILED, `执行状态登记失败（${taskId}）：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 问一次宿主的真实执行状态；没有接缝、或记录里没有子会话 id 时返回 `undefined`
   * （**查不到**，与「查到了、已经不在」严格区分）。
   */
  probe(node, taskId, dispatchId) {
    if (typeof this.livenessFor !== 'function') return undefined
    const childSessionId = node.execution.child_session_id
    if (typeof childSessionId !== 'string' || childSessionId === '') return undefined
    try {
      const verdict = this.livenessFor({
        taskId,
        nodeId: node.id,
        dispatchId,
        attempt: node.execution.attempt,
        childSessionId,
        ownerSessionId: node.execution.owner_session_id ?? null,
      })
      return verdict === 'running' || verdict === 'absent' ? verdict : undefined
    } catch (error) {
      // 查询接缝自己坏了：这是「查不到」，不是「已停止」。
      this.noteFault(DISPATCH_FAILURE_CODES.ORPHANED, `查询子会话状态失败：${String(error?.message ?? error)}`, {
        task_id: taskId,
        node_id: node.id,
        dispatch_id: dispatchId,
      })
      return undefined
    }
  }

  orphanDetail(node, liveness) {
    const child = node.execution.child_session_id
    const who = typeof child === 'string' && child !== '' ? `子会话 ${child}` : '这次派遣没有留下子会话 id'
    const why = liveness === 'absent'
      ? `恢复时宿主里已经查不到${who}`
      : `恢复时无法查询子会话的真实状态（${who}）`
    return `${why}；不能断言它已经停止，也不能保证它没有留下写入。`
  }
}
