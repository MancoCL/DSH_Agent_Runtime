/**
 * 写占用声明的冲突检测。
 *
 * @module dsh-gac-runtime/claims
 *
 * 本模块的用途
 * ------------
 * 架构大纲（§24、§45）要求把两个会写同一批文件的会话*物理上*隔开，而不只是
 * 发出警告。DSH 并不提供这一点：`agentTeams` 会规范化 `writeScopes` 并发出
 * 重叠警告，但它自己的 README 声明它「永远不会拦截占用声明或授权写入」。
 * 所以这是一个真实的缺口，本模块把它补上。
 *
 * 占用声明按**作用域前缀**比较，绝不按字面路径字符串比较。`src/` 与
 * `src/deep/a.c` 这两条声明在文本上并不冲突，但对后者的一次写入显然落在
 * 前者之内——按字符串比较恰好会漏掉最值得抓的那类冲突。
 *
 * 规则是前缀重叠，而且是刻意保守的
 * --------------------------------
 * 当一方的目录前缀处于另一方之上、之下或与之相等时，两个作用域冲突。这在一处
 * 会过度上报：`src/*.c` 与 `src/*.h` 共享前缀 `src`，尽管两个集合不相交，
 * 仍会被报成冲突。
 *
 * 这种不对称是选择的结果，不是疏漏。误报只让某个会话损失一点并行度；漏报
 * 则让两个写入者撞在同一个文件上，而这正是本模块存在所要防止的失败，且事后
 * 无法修复——第二个写入者的工作无法与第一个的分离。大纲自己的 §33（「最小
 * 必要复杂度」）允许在精化后的规则换不来重要收益时采用粗粒度规则。
 *
 * 作用域条目取自写作用域守卫所用的同一份声明，因此占用声明覆盖的范围绝不会
 * 小于其会话被允许写入的范围。
 */

import { normalizePath } from './write-scope.js'

/** 结构化的错误码，好让调用方按码分支，而不是按消息文本分支。 */
export const CLAIM_CODES = Object.freeze({
  CONFLICT: 'GAC_WRITE_SCOPE_BUSY',
  MALFORMED: 'GAC_CLAIM_MALFORMED',
})

/**
 * 存储形态的占用声明：某次派发声明了什么，以及声明于何时。
 *
 * @typedef {object} Claim
 * @property {string} dispatch_id
 * @property {string} session_id
 * @property {string} task_id
 * @property {string} node_id
 * @property {readonly string[]} write_scope
 * @property {number} created_at
 * @property {number} heartbeat_at
 */

/**
 * 把一个作用域条目归约为它所覆盖的目录前缀。
 *
 * `src/` 变成 `src`；`src/a.c` 变成 `src/a.c`（文件作用域就是自己的前缀，
 * 因此等值的路径会与之重叠）；`src/*.c` 变成 `src`；`src/**` 变成 `src`。
 * 裸写的 `mod.c` 保持为 `mod.c`，正是这一点让它不会匹配 `src/mod.c`——
 * 与写作用域守卫所做的区分相同。
 *
 * @param {string} entry
 * @param {{foldCase?: boolean}} [options]
 * @returns {string} 规范化后的前缀；覆盖根目录的作用域返回 ''。
 * @throws {TypeError} 条目不是字符串或为空时抛出。
 */
export function scopePrefix(entry, options = {}) {
  if (typeof entry !== 'string') {
    throw new TypeError(`claims: 作用域条目必须是字符串，收到的是 ${typeof entry}`)
  }
  const trimmed = entry.trim()
  if (trimmed === '') {
    throw new TypeError('claims: 作用域条目不能为空')
  }

  // 去掉子树标记，它描述的是覆盖范围而不是名字。
  const withoutSubtree = trimmed.replace(/[\\/]\*\*$/u, '')
  const unified = withoutSubtree.replace(/\\/gu, '/')

  // 只保留第一个含 glob 元字符的段之前的所有段——那段字面量就是每次匹配
  // 都共享的前缀。
  const literalSegments = []
  for (const segment of unified.split('/')) {
    if (/[*?[\]]/u.test(segment)) break
    literalSegments.push(segment)
  }
  const literal = literalSegments.join('/')
  if (literal === '') return ''
  return normalizePath(literal, options)
}

/**
 * 一个作用域条目的覆盖范围是否与另一个的重叠？
 *
 * @param {string} leftPrefix - `scopePrefix` 的输出。
 * @param {string} rightPrefix - `scopePrefix` 的输出。
 * @returns {boolean}
 */
function prefixesOverlap(leftPrefix, rightPrefix) {
  const left = leftPrefix.replace(/\/+$/u, '')
  const right = rightPrefix.replace(/\/+$/u, '')

  // 空前缀是根级作用域，包含一切。
  if (left === '' || right === '') return true
  if (left === right) return true

  // 双向的包含判定。分隔符守卫正是阻止 `src` 吞掉 `src2` 的东西。
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * 一个已声明的作用域是否与已被占用的作用域重叠？
 *
 * @param {readonly string[]} scope - 候选的作用域条目。
 * @param {readonly string[]} claimed - 已有占用声明的作用域条目。
 * @param {{foldCase?: boolean}} [options]
 * @returns {{conflict: boolean, scope?: string, claimed?: string}}
 *   冲突时给出这两个条目，好让拒绝信息能说清是哪两条路径不一致，而不只是
 *   说「有东西冲突了」。
 */
export function findScopeOverlap(scope, claimed, options = {}) {
  for (const entry of scope) {
    const entryPrefix = scopePrefix(entry, options)
    for (const existing of claimed) {
      if (prefixesOverlap(entryPrefix, scopePrefix(existing, options))) {
        return { conflict: true, scope: entry, claimed: existing }
      }
    }
  }
  return { conflict: false }
}

/**
 * 找出第一条与候选声明冲突的占用声明。
 *
 * 存活状态是调用方的事：会话已经死掉的那条占用声明必须在本函数运行之前被
 * 清理掉，否则一个死会话会永远挡住一个活会话。这种分离是刻意的——本函数是
 * 纯函数，而「那个会话是否还活着」只有宿主能回答。
 *
 * @param {object} input
 * @param {readonly string[]} input.scope - 候选方声明的作用域。
 * @param {readonly Claim[]} input.claims - 要与之比对的占用声明。
 * @param {string} [input.exclude_dispatch] - 忽略这条占用声明（自身重入）。
 * @param {{foldCase?: boolean}} [options]
 * @returns {{conflict: false} | {conflict: true, claim: Claim, scope: string, claimed: string}}
 */
export function findClaimConflict(input, options = {}) {
  const { scope, claims } = input
  if (!Array.isArray(scope)) {
    throw new TypeError('claims: scope 必须是路径字符串数组')
  }
  if (!Array.isArray(claims)) {
    throw new TypeError('claims: claims 必须是数组')
  }

  for (const claim of claims) {
    if (claim === null || typeof claim !== 'object') continue
    if (input.exclude_dispatch !== undefined && claim.dispatch_id === input.exclude_dispatch) {
      continue
    }
    if (!Array.isArray(claim.write_scope)) continue
    const overlap = findScopeOverlap(scope, claim.write_scope, options)
    if (overlap.conflict) {
      return { conflict: true, claim, scope: overlap.scope, claimed: overlap.claimed }
    }
  }
  return { conflict: false }
}

/**
 * 校验一条从存储中读出的占用声明。
 *
 * 格式错误的占用声明文件要上报，而不是跳过。悄悄忽略它，会让一份损坏的或
 * 被手工编辑过的占用声明为它所列的路径关掉冲突保护——保护看起来还在，实际
 * 已经不在。
 *
 * @param {unknown} raw
 * @param {string} source - 用于错误信息。
 * @returns {Claim}
 * @throws {Error} 携带 {@link CLAIM_CODES}.MALFORMED。
 */
export function validateClaim(raw, source = '<memory>') {
  const fail = (detail) => {
    const error = new Error(`位于 ${source} 的占用声明无效：${detail}`)
    error.code = CLAIM_CODES.MALFORMED
    throw error
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('必须是 JSON 对象')
  }
  for (const field of ['dispatch_id', 'session_id', 'task_id', 'node_id']) {
    if (typeof raw[field] !== 'string' || raw[field] === '') {
      fail(`"${field}" 必须是非空字符串`)
    }
  }
  if (!Array.isArray(raw.write_scope)) fail('"write_scope" 必须是数组')
  for (const entry of raw.write_scope) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      fail('"write_scope" 的条目必须是非空字符串')
    }
  }
  return {
    dispatch_id: raw.dispatch_id,
    session_id: raw.session_id,
    task_id: raw.task_id,
    node_id: raw.node_id,
    write_scope: Object.freeze([...raw.write_scope]),
    created_at: typeof raw.created_at === 'number' ? raw.created_at : 0,
    heartbeat_at: typeof raw.heartbeat_at === 'number' ? raw.heartbeat_at : 0,
  }
}

/**
 * 把一次冲突渲染成一条模型可以据以行动的消息。
 *
 * 不指名持有者的拒绝会变成重试循环，而一次重试循环的代价比它避免掉的那次
 * 撞车还要大。
 *
 * @param {{claim: Claim, scope: string, claimed: string}} conflict
 * @returns {string}
 */
export function describeConflict(conflict) {
  const { claim, scope, claimed } = conflict
  return `已声明的写作用域 "${scope}" 与任务 ${claim.task_id} 节点 ${claim.node_id} `
    + `（会话 ${claim.session_id}，派遣 ${claim.dispatch_id}）持有的 "${claimed}" 重叠。`
    + '该路径已归另一个写入者所有，因此这次声明被拒绝，而不是放任两个写入者都去写它。'
}
