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
import { toNativePath } from './path-utils.js'

/** 任务目录，相对项目根。 */
export const TASKS_RELATIVE_DIR = '.dsh/gac/tasks'

/** 验证计划目录，相对项目根。 */
const PLANS_RELATIVE_DIR = '.dsh/gac/plans'

/** 访谈记录目录，相对项目根。 */
const GRILLING_RELATIVE_DIR = '.dsh/gac/grilling'

/** 接口契约目录，相对项目根。 */
const CONTRACTS_RELATIVE_DIR = '.dsh/gac/contracts'

/** 复核报告目录，相对项目根。 */
const REVIEWS_RELATIVE_DIR = '.dsh/gac/reviews'

/** 验证报告目录，相对项目根（逐条用例的执行结论与证据引用）。 */
const VERIFICATIONS_RELATIVE_DIR = '.dsh/gac/verifications'

/** 结构化错误码。 */
export const TASK_STORE_CODES = Object.freeze({
  EXISTS: 'GAC_TASK_ALREADY_EXISTS',
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
 * 把 task_id 变成安全的计划文件名。
 *
 * 与任务记录同一套编码：两者都以调用方给出的 id 命名，若只在一处做转义，另一处就会成为
 * 绕过点。
 *
 * @param {string} taskId
 * @returns {string}
 */
function planFileName(taskId) {
  return `plan-${taskFileName(taskId)}`
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
    this.planDirectory = join(options.root, PLANS_RELATIVE_DIR)
    this.grillingDirectory = join(options.root, GRILLING_RELATIVE_DIR)
    this.contractDirectory = join(options.root, CONTRACTS_RELATIVE_DIR)
    this.reviewDirectory = join(options.root, REVIEWS_RELATIVE_DIR)
    this.verificationDirectory = join(options.root, VERIFICATIONS_RELATIVE_DIR)
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
   * 保存一份验证计划。
   *
   * 与任务记录分开存放，因为两者的生命周期不同：计划一经冻结就不再改写（大纲 §27），
   * 而任务状态每一轮都在动。混在一个文件里会让「这份计划有没有被改过」难以回答。
   *
   * @param {string} taskId
   * @param {object} plan - 已编译的验证计划。
   * @returns {object} 落盘的计划。
   * @throws {CoordinatorError} 计划已存在时拒绝覆盖。
   */
  savePlan(taskId, plan) {
    if (this.hasPlan(taskId)) {
      throw new CoordinatorError(
        `任务 ${taskId} 的验证计划已存在，拒绝覆盖；如需修订，请显式删除后重建并说明原因`,
        TASK_STORE_CODES.EXISTS,
        { task: taskId },
      )
    }
    mkdirSync(toNativePath(this.planDirectory), { recursive: true })
    writeFileSync(
      toNativePath(join(this.planDirectory, planFileName(taskId))),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8',
    )
    return plan
  }

  /**
   * 读回一份验证计划。
   *
   * @param {string} taskId
   * @returns {object|undefined}
   */
  loadPlan(taskId) {
    try {
      const text = readFileSync(toNativePath(join(this.planDirectory, planFileName(taskId))), 'utf8')
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  /**
   * 一份验证计划是否已经存在。
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  hasPlan(taskId) {
    try {
      return statSync(toNativePath(join(this.planDirectory, planFileName(taskId)))).isFile()
    } catch {
      return false
    }
  }

  /**
   * 保存访谈记录。
   *
   * 每轮覆盖写：访谈是一个逐步收敛的过程，中间态没有保留价值，而「最后一轮说了什么」才是
   * 后续推导的依据。
   *
   * @param {string} taskId
   * @param {object} state
   * @returns {object}
   */
  saveGrilling(taskId, state) {
    mkdirSync(toNativePath(this.grillingDirectory), { recursive: true })
    writeFileSync(
      toNativePath(join(this.grillingDirectory, planFileName(taskId))),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    )
    return state
  }

  /**
   * 读回访谈记录。
   *
   * @param {string} taskId
   * @returns {object|undefined}
   */
  loadGrilling(taskId) {
    try {
      return JSON.parse(
        readFileSync(toNativePath(join(this.grillingDirectory, planFileName(taskId))), 'utf8'),
      )
    } catch {
      return undefined
    }
  }

  /**
   * 保存接口契约。
   *
   * 与验证计划同样拒绝覆盖：冻结之后再改，就等于让已经照它开工的两条分支对着一份不存在
   * 的约定干活。
   *
   * @param {string} taskId
   * @param {object} contract
   * @returns {object}
   * @throws {CoordinatorError} 契约已存在时。
   */
  saveContract(taskId, contract) {
    if (this.hasContract(taskId)) {
      throw new CoordinatorError(
        `任务 ${taskId} 的接口契约已冻结，拒绝覆盖；如需修订，请显式删除后重建并说明原因`,
        TASK_STORE_CODES.EXISTS,
        { task: taskId },
      )
    }
    mkdirSync(toNativePath(this.contractDirectory), { recursive: true })
    writeFileSync(
      toNativePath(join(this.contractDirectory, planFileName(taskId))),
      `${JSON.stringify(contract, null, 2)}\n`,
      'utf8',
    )
    return contract
  }

  /**
   * 读回接口契约。
   *
   * @param {string} taskId
   * @returns {object|undefined}
   */
  loadContract(taskId) {
    try {
      return JSON.parse(
        readFileSync(toNativePath(join(this.contractDirectory, planFileName(taskId))), 'utf8'),
      )
    } catch {
      return undefined
    }
  }

  /**
   * 接口契约是否已冻结。
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  hasContract(taskId) {
    try {
      return statSync(toNativePath(join(this.contractDirectory, planFileName(taskId)))).isFile()
    } catch {
      return false
    }
  }

  /**
   * 保存一份复核报告。
   *
   * **与计划、契约相反，这里允许覆盖。** 这不是疏忽：计划与契约是**开工的输入**，它们被改写会
   * 让已经照着它们做出来的东西对着一份不存在的约定；而复核是**对已完成的活儿的一次观察**，
   * 后来的观察取代先前的观察，不会让任何东西失效。修复之后重新复核，正是这个回路应有的样子——
   * 若在这里拒绝覆盖，唯一的出路就是把「发现了问题的报告」删掉再写一份好看的，那恰好是门禁
   * 想要防住的行为。
   *
   * @param {string} taskId
   * @param {object} report - 已编译的复核报告（外加 task_id、reviewed_at、plan_id）。
   * @returns {object}
   */
  saveReview(taskId, report) {
    mkdirSync(toNativePath(this.reviewDirectory), { recursive: true })
    writeFileSync(
      toNativePath(join(this.reviewDirectory, planFileName(taskId))),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    )
    return report
  }

  /**
   * 保存一份**验证报告**（逐条用例的执行结论与证据引用）。
   *
   * 与计划、复核报告分开存放，理由相同：生命周期不同。计划一经冻结不变；验证报告是**一次执行**的
   * 结论，可以重跑、可以有多份；而收口门禁要核对的正是「这份结论对应的是当前那份计划吗」。
   *
   * 为什么要落盘而不是让父会话每次手工交：真实 `REQ-HR-1` 里四个节点全部 completed，而收口两次被
   * 拒——缺的就是这份载荷。子会话产出结论、运行时校验并持久化，父会话不该再解释一遍。
   *
   * @param {string} taskId
   * @param {object} report
   * @returns {object}
   */
  saveVerification(taskId, report) {
    mkdirSync(toNativePath(this.verificationDirectory), { recursive: true })
    writeFileSync(
      toNativePath(join(this.verificationDirectory, planFileName(taskId))),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    )
    return report
  }

  /**
   * 读回一份验证报告。
   *
   * @param {string} taskId
   * @returns {object|undefined}
   */
  loadVerification(taskId) {
    try {
      return JSON.parse(
        readFileSync(toNativePath(join(this.verificationDirectory, planFileName(taskId))), 'utf8'),
      )
    } catch {
      return undefined
    }
  }

  /**
   * 是否已登记验证报告。
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  hasVerification(taskId) {
    try {
      return statSync(toNativePath(join(this.verificationDirectory, planFileName(taskId)))).isFile()
    } catch {
      return false
    }
  }

  /**
   * 读回一份复核报告。
   *
   * @param {string} taskId
   * @returns {object|undefined}
   */
  loadReview(taskId) {
    try {
      return JSON.parse(
        readFileSync(toNativePath(join(this.reviewDirectory, planFileName(taskId))), 'utf8'),
      )
    } catch {
      return undefined
    }
  }

  /**
   * 是否已登记复核报告。
   *
   * @param {string} taskId
   * @returns {boolean}
   */
  hasReview(taskId) {
    try {
      return statSync(toNativePath(join(this.reviewDirectory, planFileName(taskId)))).isFile()
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
