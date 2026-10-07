/**
 * 工程状态：已加载的工程适配器，以及解析后的执行模式，
 * 按会话持有。
 *
 * @module dsh-gac-runtime/project-state
 *
 * 运行时正是在这里得知自己身处哪个工程。有两个事实只存在于此，
 * 别处没有：
 *
 *  1. **适配器**，每个工程根目录加载一次，来自
 *     `<root>/.dsh/gac/project.json`，由 `lib/project.js` 校验。
 *  2. **执行模式**，由某个会话声明，且已与
 *     该适配器声明的高风险路径做过交叉核对。
 *
 * 为什么模式要交叉核对而不是直接信任
 * ------------------------------------------------
 * 架构大纲（§5、§6）把模式定为一项语义判断：运行时无法分辨
 * 一处改动是否触及认证边界，所以由模型来声明。但声明不能
 * 自我认证，否则「从最低的充分级别开始」就会变成「声称最低级别」。于是
 * 声明要对照代码*能够*核对的那一件事——某条目标路径是否落在
 * 工程声明的高风险路径内——并在落在其中时升级。
 *
 * 注意刻意缺席的东西：对需求文本的任何解析。
 * 对意图做关键词匹配，正是那种看似合理、却会在自己没预料到的
 * 措辞上失败即放行的门禁，前身运行时正因如此在自己的策略里禁掉了它。
 *
 * 没有适配器不是错误
 * --------------------------
 * 尚未纳管的工程没有适配器；它只是不受治理而已。
 * 没有适配器就拒绝干活，会让插件在任何地方都用不了；而
 * 硬造一个默认适配器，则会悄悄套用工程从未声明过的策略。
 * `adapter: undefined` 是一种真实状态，就按真实状态上报。
 *
 * 缓存失败不会被缓存：缺失的文件可能就在下一刻
 * 因为纳管该工程这一动作本身而被创建出来。
 */

import { readFileSync } from 'node:fs'

import { toNativePath } from './path-utils.js'
import { ProjectAdapterError, modeToRisk, resolveExecutionMode, validateProjectAdapter } from './project.js'

/** 适配器路径，相对于工程根目录。 */
export const ADAPTER_RELATIVE_PATH = '.dsh/gac/project.json'

/**
 * 把路径片段拼接成一条以 `/` 分隔的路径。
 *
 * 本模块以稳定的、以 `/` 分隔的形式上报路径，以便按
 * `lib/write-scope.js` 规范化到的同一约定做比较。文件系统操作必须先
 * 用 {@link toNativePath} 转换：Node 在 Windows 上接受 `/`，
 * 但只有把这件事写明，才能让上报路径与
 * 文件系统路径不会悄悄漂移开。
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
 * 活跃会话的工程适配器与执行模式状态。
 */
export class ProjectState {
  /**
   * @param {object} [options]
   * @param {(sessionId: string) => string|undefined} [options.resolveRoot]
   *   为某个会话提供工程根目录。以注入方式传入而非在此读取，
   *   以便本模块不牵扯 DSH 的会话服务，并保持可做单元测试。
   * @param {boolean} [options.foldCase]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    /** @type {Map<string, {status: string, adapter?: object, note?: string, path: string}>} */
    this.adapters = new Map()
    /** @type {Map<string, object>} */
    this.modes = new Map()
    this.resolveRoot = options.resolveRoot ?? (() => undefined)
    this.foldCase = options.foldCase !== false
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 治理某个会话的工程根目录；无法解析时为 `undefined`。
   *
   * @param {string} sessionId
   * @returns {string|undefined}
   */
  rootFor(sessionId) {
    return this.resolveRoot(sessionId)
  }

  /**
   * 为某个工程根目录加载并校验适配器，并缓存结果。
   *
   * @param {string} root - 绝对工程根目录。
   * @returns {{status: 'loaded', adapter: object, path: string}
   *   | {status: 'absent', path: string, note: string}
   *   | {status: 'invalid', path: string, note: string}}
   */
  loadAdapter(root) {
    const path = join(root, ADAPTER_RELATIVE_PATH)
    const cached = this.adapters.get(root)
    if (cached !== undefined) return cached

    let outcome
    let text
    try {
      text = readFileSync(toNativePath(path), 'utf8')
    } catch (error) {
      const code = error instanceof Error ? error.code : undefined
      outcome = {
        status: 'absent',
        path,
        note: code === 'ENOENT'
          ? '这个工程没有 GAC 适配器，因此不受治理'
          : `无法读取适配器（${code ?? '未知错误'}）`,
      }
      // 「不存在」会被缓存：每次调用都重新探测，等于白做 I/O。
      // 工程在会话中途纳管自身时，改调 `forget()`。
      this.adapters.set(root, outcome)
      return outcome
    }

    try {
      outcome = { status: 'loaded', adapter: loadAdapterText(text, path), path }
      this.adapters.set(root, outcome)
    } catch (error) {
      // 无效适配器故意**不**缓存：这是一处转瞬即逝的
      // 编写失误，用户很可能此刻正在修，而缓存下来的
      // 失败需要重启才能清除。
      outcome = {
        status: 'invalid',
        path,
        note: error instanceof Error ? error.message : String(error),
      }
    }
    return outcome
  }

  /**
   * 丢弃缓存的适配器状态，让下一次读取反映磁盘上的内容。
   *
   * @param {string} [root] - 省略则清空每个工程。
   * @returns {void}
   */
  forget(root) {
    if (root === undefined) {
      this.adapters.clear()
      return
    }
    this.adapters.delete(root)
  }

  /**
   * 在交叉核对之后，记录某个会话声明的执行模式。
   *
   * @param {object} input
   * @param {string} input.session_id
   * @param {string} input.root - 工程根目录，用于查找适配器。
   * @param {string} input.declared_mode
   * @param {string} [input.reason]
   * @param {readonly string[]} [input.target_paths]
   * @param {boolean} [input.irreversible]
   * @param {boolean} [input.ambiguous]
   * @returns {object} 已记录的模式决策。
   * @throws {ProjectAdapterError} 模式未知时抛出。
   */
  declareMode(input) {
    const loaded = this.loadAdapter(input.root)
    const adapter = loaded.status === 'loaded' ? loaded.adapter : undefined

    const resolved = adapter === undefined
      // 没有适配器，就没有声明过的高风险路径可供核对，
      // 因此该声明自行成立，并如实说明这一点。
      ? {
        mode: input.declared_mode,
        declared_mode: input.declared_mode,
        escalated: false,
        risk: modeToRisk(input.declared_mode),
        reason: input.reason ?? '未记录依据',
        unchecked: true,
      }
      : resolveExecutionMode({
        declared_mode: input.declared_mode,
        reason: input.reason,
        target_paths: input.target_paths,
        irreversible: input.irreversible,
        ambiguous: input.ambiguous,
        adapter,
      }, { foldCase: this.foldCase })

    const record = {
      ...resolved,
      session_id: input.session_id,
      project_id: adapter?.project.id ?? null,
      adapter_path: loaded.path,
      declared_at: this.now(),
    }
    this.modes.set(input.session_id, record)
    return record
  }

  /**
   * 某个会话已声明的模式（若有）。
   *
   * @param {string} sessionId
   * @returns {object|undefined}
   */
  modeFor(sessionId) {
    return this.modes.get(sessionId)
  }

  /**
   * 丢弃某个会话的模式，例如其任务收口时。
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  clearMode(sessionId) {
    return this.modes.delete(sessionId)
  }

  /**
   * 某个会话工程状态的诊断视图。
   *
   * @param {string} sessionId
   * @param {string|undefined} root
   * @returns {object}
   */
  inspect(sessionId, root) {
    if (root === undefined) {
      return {
        governed: false,
        note: '这个会话没有可解析的工程根目录，因此没有读取任何适配器',
        mode: this.modes.get(sessionId) ?? null,
      }
    }
    const loaded = this.loadAdapter(root)
    return {
      governed: loaded.status === 'loaded',
      root,
      adapter_path: loaded.path,
      adapter_status: loaded.status,
      adapter: loaded.status === 'loaded' ? loaded.adapter : null,
      adapter_note: loaded.note ?? null,
      mode: this.modes.get(sessionId) ?? null,
    }
  }
}

/**
 * 从文本加载适配器，把校验器的错误转换成一条普通说明。
 *
 * @param {string} text
 * @param {string} path
 * @returns {object}
 */
function loadAdapterText(text, path) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ProjectAdapterError(`${path} 不是合法 JSON：${detail}`, 'GAC_PROJECT_ADAPTER_INVALID')
  }
  return validateProjectAdapter(parsed, path)
}
