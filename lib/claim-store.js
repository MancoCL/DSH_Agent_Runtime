/**
 * 持久化的写占用声明存储。
 *
 * @module dsh-gac-runtime/claim-store
 *
 * 占用声明的寿命长于创建它的进程，而且必须对每个进程里的每个会话都可见，因为
 * 它要防止的撞车发生在彼此一无所知的写入者之间。所以它们落在磁盘上，一条占用
 * 声明一个文件，位于 `<project>/.dsh/gac/claims/` 之下。
 *
 * 一条占用声明一个文件，以独占方式创建
 * ------------------------------------
 * 单个注册表文件需要读-改-写，两个会话在它上面竞争就会丢掉一条占用声明——正是
 * 本层存在所要防止的失败模式。每个会话一个文件、以独占创建标志打开，把互斥交给
 * 文件系统去做：谁创建了这个文件，谁就持有这条占用声明。
 *
 * 占用声明以会话为键，而不是以派发为键
 * ------------------------------------
 * 自然的键会是派发 id，但作用域是在工作开始*之前*声明的，而且往往在派发存在
 * 之前就已声明。以会话为键符合作用域实际被持有的方式——每个会话一个存活作用域
 * ——也让释放授权变得平凡：只有持有它的那个会话才能释放自己的占用声明。没有这
 * 项检查，一份伪造的或过期的声明就能释放掉另一个写入者的守卫，这正是前身运行时
 * 在自己的笔记里记下的错误。
 *
 * 存活状态是宿主的问题
 * --------------------
 * 会话已经死掉的占用声明会永远挡住写入者。因此清理需要知道哪些会话存活，而本
 * 模块无法判定这一点，所以要注入一个判定函数。没有可用的判定函数时，占用声明
 * 被保留，而不是靠猜丢掉：挡住一个写入者是可以恢复的，让两个写入者写同一个文件
 * 则不可恢复。同理，单凭时间久远永远不算作死亡。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { findClaimConflict, validateClaim } from './claims.js'

/** 存放占用声明文件的目录，相对于项目根。 */
export const CLAIMS_RELATIVE_DIR = '.dsh/gac/claims'

/**
 * 把若干路径片段拼成一条以 `/` 分隔的路径。
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
 * 把一条以 `/` 分隔的路径转换成当前平台期望的分隔符。
 *
 * @param {string} path
 * @returns {string}
 */
function toNativePath(path) {
  return process.platform === 'win32' ? path.replace(/\//gu, '\\') : path
}

/**
 * 让会话 id 可以安全地用作文件名。
 *
 * 会话 id 由宿主铸造，通常对文件名是安全的，但本存储不能这样假设：一个内含
 * 分隔符的精心构造的 id 会逃出占用声明目录。安全集合之外的一切都做百分号编码，
 * 而原始 id 仍保存在文件内部，因此往返是无损的、可验证的。
 *
 * @param {string} sessionId
 * @returns {string}
 */
function claimFileName(sessionId) {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}.json`
}

/**
 * 某个项目根对应的写占用声明存储。
 */
export class ClaimStore {
  /**
   * @param {object} options
   * @param {string} options.root - 绝对的项目根。
   * @param {() => readonly string[]} [options.liveSessions]
   *   返回当前存活的会话 id。之所以要注入，是因为只有宿主知道。缺失时，任何
   *   占用声明都不会被当作死亡而被清理。
   * @param {() => number} [options.now]
   * @param {boolean} [options.foldCase]
   */
  constructor(options) {
    if (typeof options?.root !== 'string' || options.root === '') {
      throw new TypeError('ClaimStore 需要一个项目根目录')
    }
    this.root = options.root
    this.directory = join(options.root, CLAIMS_RELATIVE_DIR)
    this.liveSessions = options.liveSessions
    this.now = options.now ?? (() => Date.now())
    this.foldCase = options.foldCase !== false
    /** 文件无法读取或解析的占用声明，供诊断视图使用。 */
    this.unreadable = []
  }

  /**
   * 读取每一条可读的占用声明，并上报那些读不了的。
   *
   * 格式错误的文件要上报，而不是跳过，因为跳过它会悄悄丢掉它为所涉路径提供的
   * 冲突保护——保护看起来还在，实际已经不在。它也不会被删除：一份读不了的占用
   * 声明是证据，为了把目录收拾整齐而销毁证据是笔不划算的交易。
   *
   * @returns {import('./claims.js').Claim[]}
   */
  list() {
    this.unreadable = []

    // 先校验根。在 Windows 上，列举一个非目录路径之下的内容会报 ENOENT，这与
    // 「还没有占用声明」无法区分——所以一个指向虚假根的存储会自称是空的，并让
    // 写入者对着未知的持有者继续干活。显式检查根，把「这里还什么都没有」与
    // 「看不到这里有什么」区分开。
    try {
      if (!statSync(toNativePath(this.root)).isDirectory()) {
        this.unreadable.push({ file: this.root, reason: '项目根目录不是目录' })
        return []
      }
    } catch (error) {
      this.unreadable.push({
        file: this.root,
        reason: `项目根目录不可读（${String(error?.code ?? error)}）`,
      })
      return []
    }

    let names
    try {
      names = readdirSync(toNativePath(this.directory))
    } catch (error) {
      // 根存在但没有占用声明目录：这是还没有任何占用声明被做出之前的正常
      // 状态，不是问题。
      if (error instanceof Error && error.code === 'ENOENT') return []
      this.unreadable.push({ file: this.directory, reason: String(error?.code ?? error) })
      return []
    }

    const claims = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.directory, name)
      let parsed
      try {
        parsed = JSON.parse(readFileSync(toNativePath(path), 'utf8'))
      } catch (error) {
        this.unreadable.push({ file: path, reason: String(error?.code ?? error) })
        continue
      }
      try {
        const claim = validateClaim(parsed, path)
        // 文件名必须与它承载的占用声明一致，否则一个手工放进去的文件就能宣称
        // 自己是别人的会话。
        if (claimFileName(claim.session_id) !== name) {
          this.unreadable.push({ file: path, reason: '文件名与 session_id 不一致' })
          continue
        }
        claims.push(claim)
      } catch (error) {
        this.unreadable.push({ file: path, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return claims
  }

  /**
   * 未被任何存活会话持有的占用声明。
   *
   * 返回 `undefined` 的判定函数是在说「我不知道谁存活」——这与返回 `[]` 不同，
   * 后者说的是「没有一个人存活」。存活状态未知时保留每一条占用声明，理由与判定
   * 函数缺失时相同：挡住一个写入者可以恢复，让两个写入者写同一个文件则不行。
   *
   * @param {readonly import('./claims.js').Claim[]} [claims]
   * @returns {import('./claims.js').Claim[]}
   */
  orphans(claims = this.list()) {
    if (typeof this.liveSessions !== 'function') return []
    let live
    try {
      live = this.liveSessions()
    } catch {
      // 判定函数抛错决不能被解读成「全都死了」。
      return []
    }
    if (live === undefined) return []
    const living = new Set(live)
    return claims.filter((claim) => !living.has(claim.session_id))
  }

  /**
   * 删除会话已经消失的占用声明。
   *
   * @returns {{removed: string[], failed: string[]}}
   */
  pruneOrphans() {
    const removed = []
    const failed = []
    for (const claim of this.orphans()) {
      if (this.remove(claim.session_id)) removed.push(claim.session_id)
      else failed.push(claim.session_id)
    }
    return { removed, failed }
  }

  /**
   * 某个会话持有的占用声明，如果有的话。
   *
   * @param {string} sessionId
   * @returns {import('./claims.js').Claim|undefined}
   */
  get(sessionId) {
    const path = join(this.directory, claimFileName(sessionId))
    try {
      return validateClaim(JSON.parse(readFileSync(toNativePath(path), 'utf8')), path)
    } catch {
      return undefined
    }
  }

  /**
   * 尝试为某个会话获取一条占用声明。
   *
   * @param {object} input
   * @param {string} input.session_id
   * @param {string} input.task_id
   * @param {string} input.node_id
   * @param {readonly string[]} input.write_scope
   * @returns {{acquired: true, claim: import('./claims.js').Claim}
   *   | {acquired: false, conflict: object}}
   * @throws {Error} 占用声明文件完全无法写入时抛出。
   */
  acquire(input) {
    const { session_id: sessionId, write_scope: writeScope } = input
    // 在裁定冲突之前先清理死者：离场的会话不该继续占着它留下的路径。清理只在
    // 存活状态确实**已知**时才运行——判定函数未知或缺失时，「每条占用声明都是
    // 孤儿」会 DELETE 掉存活的占用声明，并悄悄关掉冲突保护，而这正是本模块
    // 存在所要防止的那个失败。
    if (this.orphans().length > 0) this.pruneOrphans()

    const existing = this.list().filter((claim) => claim.session_id !== sessionId)
    const conflict = findClaimConflict(
      { scope: writeScope, claims: existing },
      { foldCase: this.foldCase },
    )
    if (conflict.conflict) return { acquired: false, conflict }

    const timestamp = this.now()
    const claim = validateClaim({
      dispatch_id: `${sessionId}:${renderScopeKey(writeScope)}`,
      session_id: sessionId,
      task_id: input.task_id,
      node_id: input.node_id,
      write_scope: writeScope,
      created_at: timestamp,
      heartbeat_at: timestamp,
    })

    mkdirSync(toNativePath(this.directory), { recursive: true })
    // 以独占方式创建就是互斥本身：如果文件已存在，说明有个兄弟进程赢下了这个
    // 会话槽位的竞争。
    writeFileSync(toNativePath(join(this.directory, claimFileName(sessionId))), `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    })

    // 写入之后再检查一遍。写前检查与写入不是原子的，否则在两者之间出现的占用
    // 声明会被完全漏掉。
    const after = this.list().filter((claim_) => claim_.session_id !== sessionId)
    const raced = findClaimConflict(
      { scope: writeScope, claims: after },
      { foldCase: this.foldCase },
    )
    if (raced.conflict) {
      this.remove(sessionId)
      return { acquired: false, conflict: raced }
    }
    return { acquired: true, claim }
  }

  /**
   * 释放一条占用声明，但只允许持有它的那个会话来释放。
   *
   * @param {string} sessionId
   * @param {string} [requireSessionId] - 给定时，占用声明必须属于它。
   * @returns {boolean} 是否删掉了一条占用声明。
   */
  release(sessionId, requireSessionId) {
    if (requireSessionId !== undefined && requireSessionId !== sessionId) return false
    return this.remove(sessionId)
  }

  /**
   * 删除一个占用声明文件。
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  remove(sessionId) {
    try {
      rmSync(toNativePath(join(this.directory, claimFileName(sessionId))), { force: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 刷新一条占用声明的心跳。
   *
   * @param {string} sessionId
   * @returns {boolean} 是否刷新了一条占用声明。
   */
  heartbeat(sessionId) {
    const claim = this.get(sessionId)
    if (claim === undefined) return false
    try {
      writeFileSync(
        toNativePath(join(this.directory, claimFileName(sessionId))),
        `${JSON.stringify({ ...claim, heartbeat_at: this.now() }, null, 2)}\n`,
        'utf8',
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * 每条占用声明加上读不了的那些文件的诊断视图。
   *
   * @returns {{claims: object[], orphans: string[], unreadable: {file: string, reason: string}[], directory: string}}
   */
  inspect() {
    const claims = this.list()
    return {
      directory: this.directory,
      claims: claims.map((claim) => ({
        session_id: claim.session_id,
        task_id: claim.task_id,
        node_id: claim.node_id,
        write_scope: [...claim.write_scope],
        heartbeat_at: claim.heartbeat_at,
      })),
      orphans: this.orphans(claims).map((claim) => claim.session_id),
      unreadable: [...this.unreadable],
    }
  }
}

/**
 * 一个稳定、便于人读的键，用来描述某段作用域，作为占用声明的展示 id。
 *
 * @param {readonly string[]} scope
 * @returns {string}
 */
function renderScopeKey(scope) {
  const rendered = scope.join(',')
  return rendered.length <= 80 ? rendered : `${rendered.slice(0, 77)}...`
}
