/**
 * 证据日志：只追加、由运行时发号。
 *
 * @module dsh-gac-runtime/evidence-store
 *
 * 为什么只追加
 * ------------
 * 证据一旦可被改写，它就不再是证据。日志只追加、不覆盖、不删除，因此「这条证据是什么时候
 * 记下的、记的是什么」在事后无法被抹掉。需要作废一条证据时，追加一条作废记录，而不是把
 * 原来那条删掉——被抹掉的痕迹无法复核。
 *
 * 为什么号由这里发
 * ----------------
 * 能被调用方指定的号就也能被编造。号在这里按出现顺序发放，并与记录一起落盘；验证层只认
 * 盘上存在的号。
 *
 * 一行为一条记录（JSONL）而不是一个大 JSON 数组：追加一条不必重写整个文件，因此崩溃最多
 * 损失最后一行，而不会让整份日志变成半截 JSON。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { compileEvidence } from './evidence.js'
import { toNativePath } from './path-utils.js'

/** 证据目录，相对项目根。 */
export const EVIDENCE_RELATIVE_DIR = '.dsh/gac/evidence'

/** 日志文件名。 */
export const EVIDENCE_FILE = 'evidence.jsonl'

/**
 * 项目内的证据日志。
 */
export class EvidenceLog {
  /**
   * @param {object} options
   * @param {string} options.root - 项目根目录。
   * @param {() => number} [options.now]
   */
  constructor({ root, now = () => Date.now() }) {
    this.root = root
    this.directory = join(root, EVIDENCE_RELATIVE_DIR)
    this.path = join(this.directory, EVIDENCE_FILE)
    this.now = now
    /** @type {Readonly<object>[]|undefined} */
    this.cache = undefined
  }

  /**
   * 读回全部证据。
   *
   * 最后一行可能因为崩溃而残缺，解析失败时**跳过它而不是让整份日志不可读**：丢掉最末一条
   * 未完成的记录，比丢掉所有历史要轻。
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
        // 残缺行：跳过，不让它毁掉整份日志的可读性。
      }
    }
    this.cache = Object.freeze(records)
    return this.cache
  }

  /**
   * 记下一条证据，返回落盘后的记录。
   *
   * @param {object} raw - { tool, arguments, value, is_error, error_code, session_id }
   * @returns {Readonly<object>}
   */
  record(raw) {
    const existing = this.load()
    const record = compileEvidence(raw, {
      id: `ev-${existing.length + 1}`,
      at: this.now(),
    })
    mkdirSync(toNativePath(this.directory), { recursive: true })
    appendFileSync(toNativePath(this.path), `${JSON.stringify(record)}\n`, 'utf8')
    // 追加而不是重建：让「已加载」与「盘上」保持一致，同时不必重读整个文件。
    this.cache = Object.freeze([...existing, record])
    return record
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
