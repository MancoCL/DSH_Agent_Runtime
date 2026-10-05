/**
 * GAC 审计事件日志：只追加，写在**工程自己**的目录里。
 *
 * @module dsh-gac-runtime/gac-event-log
 *
 * 为什么不写进会话日志 —— 这一条是踩出来的，代价是用户的历史打不开
 * --------------------------------------------------------------
 * 会话日志的事件词表由宿主**构建期生成**（`dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`），外部
 * 插件的类型按构造就不在里面；而 `Session.append()` 只把 `sourceEventSeqs` 与 `surfaceOp` 放进
 * 日志，**没有任何途径**给一条事件打上 `ignorable` 标记。持久化层读回日志时于是直接拒读：
 *
 *   session "<id>" contains event type "gac/…" (seq N) unknown to this harness and not marked
 *   ignorable; refusing to interpret the log — it was likely written by a newer harness
 *   （`dsh-session-persistence/lib/index.js` 的 `validateStoredEvents`）
 *
 * 后果不是「少一条事件」，而是**那份会话再也打不开**。实测：本工程含 GAC 事件的会话全部中招，
 * 界面里表现为「子智能体的历史记录全部显示不出来，点进去全报错」。原因是设计时把「让 GAC 事件
 * 出现在对话历史里」当成了纯收益，却漏掉了「读回日志的人未必装着这个插件」——而审计信息的读者
 * 恰恰包括**没装插件的将来**。
 *
 * 现在审计事件写进本工程的追加文件：既不依赖宿主的词表，也不影响任何会话的可读性。会话日志只
 * 保留宿主自己的事件。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { compileGacEvent } from './gac-events.js'
import { toNativePath } from './path-utils.js'

/** 事件目录，相对项目根。 */
export const GAC_EVENT_RELATIVE_DIR = '.dsh/gac/events'

/** 日志文件名。 */
export const GAC_EVENT_FILE = 'events.jsonl'

/**
 * 工程内的 GAC 审计事件日志。
 */
export class GacEventLog {
  /**
   * @param {object} options
   * @param {string} options.root - 项目根目录。
   * @param {() => number} [options.now]
   */
  constructor({ root, now = () => Date.now() }) {
    this.root = root
    this.directory = join(root, GAC_EVENT_RELATIVE_DIR)
    this.path = join(this.directory, GAC_EVENT_FILE)
    this.now = now
    /** @type {Readonly<object>[]|undefined} */
    this.cache = undefined
  }

  /**
   * 读回全部事件。
   *
   * 最后一行可能因为崩溃而残缺，解析失败时**跳过它**而不是让整份日志不可读：丢掉最末一条未完成
   * 的记录，比丢掉所有历史要轻。
   *
   * @returns {readonly Readonly<object>[]}
   */
  load() {
    if (this.cache !== undefined) return this.cache
    let text
    try {
      text = readFileSync(toNativePath(this.path), 'utf8')
    } catch {
      this.cache = Object.freeze([])
      return this.cache
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(Object.freeze(JSON.parse(line)))
      } catch {
        // 残缺行：跳过。
      }
    }
    this.cache = Object.freeze(records)
    return this.cache
  }

  /**
   * 记下一批 GAC 事件（一次工具调用可能同时声明模式与作用域，因此按批）。
   *
   * 每条都过一遍 `compileGacEvent`：形状不对的事件在这里被拒，而不是写进审计文件才发现。
   *
   * @param {object} raw - { session_id, tool, events: {type, data}[] }
   * @returns {Readonly<object>[]} 落盘后的记录。
   */
  record(raw) {
    const events = Array.isArray(raw?.events) ? raw.events : []
    if (events.length === 0) return []
    const existing = this.load()
    const written = []
    for (const [index, event] of events.entries()) {
      const record = Object.freeze({
        schema_version: 1,
        seq: existing.length + index + 1,
        at: this.now(),
        session_id: raw.session_id,
        tool: raw.tool,
        type: event.type,
        data: compileGacEvent(event.type, event.data),
      })
      written.push(record)
    }
    mkdirSync(toNativePath(this.directory), { recursive: true })
    appendFileSync(
      toNativePath(this.path),
      written.map((record) => `${JSON.stringify(record)}\n`).join(''),
      'utf8',
    )
    // 追加而不是重建：让「已加载」与「盘上」保持一致，同时不必重读整个文件。
    this.cache = Object.freeze([...existing, ...written])
    return written
  }

  /**
   * 日志是否已经存在。
   *
   * @returns {boolean}
   */
  exists() {
    try {
      return statSync(toNativePath(this.path)).isFile()
    } catch {
      return false
    }
  }
}
