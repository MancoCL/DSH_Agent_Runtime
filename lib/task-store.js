/**
 * 任务持久化：一任务一文件。
 *
 * @module dsh-gac-runtime/task-store
 *
 * 为什么必须落盘
 * --------------
 * 协调器的全部保证都建立在「状态只按显式迁移前进」之上，而这些保证在进程重载面前
 * 一文不值：一个执行中的节点若在重载后 attempt 归零（或干脆消失），那么一份迟到的
 * 旧结果会重新看起来像当前结果，而这正是身份不复用要防的事。插件在本机是链接安装、
 * 启用 HMR，重载是常态而非例外，所以「状态只在内存里」不是一个可以拖到以后再说的
 * 取舍。
 *
 * 复用的是写声明那一套做法，不是新发明：一任务一文件、写入即完整覆盖、读取时重新
 * 校验。区别在于并发语义——两个会话抢同一个 task_id 是错误而不是竞争，所以创建用
 * 独占标志，已存在即报错。
 *
 * 索引放在任务文件里，而不是单独维护一份清单：一份清单会与它索引的文件漂移，而
 * 「某个任务还在不在」这个问题，列目录就能回答。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { CoordinatorError, deserializeTask, serializeTask } from './coordinator.js'

/** 任务目录，相对项目根。 */
export const TASKS_RELATIVE_DIR = '.dsh/gac/tasks'

/** 结构化错误码。 */
export const TASK_STORE_CODES = Object.freeze({
  EXISTS: 'GAC_TASK_ALREADY_EXISTS',
  NOT_FOUND: 'GAC_TASK_NOT_FOUND',
  MALFORMED: 'GAC_TASK_MALFORMED',
})

/**
 * 拼出 `/` 分隔的路径。
 *
 * @param {...string} parts
 * @returns {string}
 */
function join(...parts) {
  const [first, ...rest] = parts
  return [first, ...rest]
    .map((part) => part.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/\/+$/u, ''))
    .filter((part, index) => part !== '' || index === 0)
    .join('/')
}

/**
 * 转成本平台文件系统 API 期待的写法。
 *
 * @param {string} path
 * @returns {string}
 */
function toNativePath(path) {
  return process.platform === 'win32' ? path.replace(/\//gu, '\\') : path
}

/**
 * 把 task_id 变成安全文件名。
 *
 * 与写声明同样的理由：task_id 通常由调用方给出，不能假设它不含路径分隔符，否则一个
 * 构造出来的 id 会写到任务目录之外。原 id 存在文件内部，因此编码是可逆且可核对的。
 *
 * @param {string} taskId
 * @returns {string}
 */
function taskFileName(taskId) {
  return `${taskId.replace(/[^A-Za-z0-9._-]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}.json`
}

/**
 * 一个项目的任务存储。
 */
export class TaskStore {
  /**
   * @param {object} options
   * @param {string} options.root - 项目根绝对路径。
   */
  constructor(options) {
    if (typeof options?.root !== 'string' || options.root === '') {
      throw new TypeError('TaskStore 需要一个项目根路径')
    }
    this.root = options.root
    this.directory = join(options.root, TASKS_RELATIVE_DIR)
    /** 读不出来的任务文件，供诊断。 */
    this.unreadable = []
  }

  /**
   * 目录是否可用。
   *
   * @returns {boolean}
   */
  #rootReadable() {
    try {
      return statSync(toNativePath(this.root)).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * 保存一个任务，整体覆盖。
   *
   * @param {object} task
   * @param {{create?: boolean}} [options] - `create` 为真时要求任务尚不存在。
   * @returns {object} 落盘后的任务。
   * @throws {CoordinatorError}
   */
  save(task, options = {}) {
    const path = join(this.directory, taskFileName(task.task_id))
    if (options.create === true && this.exists(task.task_id)) {
      throw new CoordinatorError(
        `任务 ${task.task_id} 已存在；同 ID 拒绝覆盖，新的交付目标请另建任务`,
        TASK_STORE_CODES.EXISTS,
        { task: task.task_id },
      )
    }
    mkdirSync(toNativePath(this.directory), { recursive: true })
    writeFileSync(toNativePath(path), `${JSON.stringify(serializeTask(task), null, 2)}\n`, 'utf8')
    return task
  }

  /**
   * 任务文件是否存在。
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  exists(taskId) {
    try {
      return statSync(toNativePath(join(this.directory, taskFileName(taskId)))).isFile()
    } catch {
      return false
    }
  }

  /**
   * 读回一个任务，恢复时重新校验结构。
   *
   * @param {string} taskId
   * @returns {object|undefined} 不存在时为 undefined。
   * @throws {CoordinatorError} 文件存在但读不动或结构非法。
   */
  load(taskId) {
    const path = join(this.directory, taskFileName(taskId))
    let text
    try {
      text = readFileSync(toNativePath(path), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw new CoordinatorError(
        `任务 ${taskId} 的记录读不出来：${error?.code ?? error}`,
        TASK_STORE_CODES.MALFORMED,
        { task: taskId },
      )
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new CoordinatorError(
        `任务 ${taskId} 的记录不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        TASK_STORE_CODES.MALFORMED,
        { task: taskId },
      )
    }
    return deserializeTask(parsed, path)
  }

  /**
   * 列出全部任务的 id。
   *
   * 读不出来的文件记进 `unreadable` 而不是静默跳过：跳过会让「某个任务不见了」看起来
   * 像「从来没建过」，而这两件事的处理方式完全不同。
   *
   * @returns {string[]}
   */
  list() {
    this.unreadable = []
    if (!this.#rootReadable()) {
      this.unreadable.push({ file: this.root, reason: '项目根目录不可读' })
      return []
    }
    let names
    try {
      names = readdirSync(toNativePath(this.directory))
    } catch (error) {
      // 根目录在、任务目录不在，是「还没有任务」，不是问题。
      if (error?.code === 'ENOENT') return []
      this.unreadable.push({ file: this.directory, reason: String(error?.code ?? error) })
      return []
    }
    const ids = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.directory, name)
      try {
        const parsed = JSON.parse(readFileSync(toNativePath(path), 'utf8'))
        if (typeof parsed?.task_id !== 'string' || taskFileName(parsed.task_id) !== name) {
          this.unreadable.push({ file: path, reason: '文件名与 task_id 不一致' })
          continue
        }
        ids.push(parsed.task_id)
      } catch (error) {
        this.unreadable.push({ file: path, reason: String(error?.code ?? error) })
      }
    }
    return ids.sort()
  }

  /**
   * 删除一个任务记录。
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  remove(taskId) {
    try {
      rmSync(toNativePath(join(this.directory, taskFileName(taskId))), { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 诊断视图。
   *
   * @returns {{directory: string, tasks: string[], unreadable: object[]}}
   */
  inspect() {
    const tasks = this.list()
    return { directory: this.directory, tasks, unreadable: [...this.unreadable] }
  }
}
