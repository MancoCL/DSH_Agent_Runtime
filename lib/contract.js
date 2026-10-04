/**
 * 接口契约：并行实施之前必须先冻结的那一份约定。
 *
 * @module dsh-gac-runtime/contract
 *
 * 为什么它是并行写测试的前提
 * --------------------------
 * 「并行编写功能代码与测试代码」听起来合理，但测试作者在写测试时并不知道实现长什么样。
 * 若两边各自发明接口，测试会因**接口对不上**而失败——那是结构性失败，不是缺陷，测出来的
 * 结果没有信息量。先冻结一份最小接口契约，两个分支都只依赖它，测试才从「凭猜测的赌博」
 * 变成「按契约的独立实现」。
 *
 * 契约冻结同时也是验证独立性真正成立的前提：测试从**契约 + 验收标准**推导（没读实现），
 * 代码从**契约 + 方案**推导（没读测试），两条信息路径分离。
 *
 * 为什么签名之外还要行为约定
 * --------------------------
 * 只有签名时，「这个函数返回什么」仍要靠猜，而猜出来的期望正是两边对不上的地方。行为
 * 约定不必详尽，但必须足以让另一个人据此写出断言。
 *
 * 为什么门禁设在派遣之前
 * ----------------------
 * 契约的意义是「在动手之前对齐」。实现做完之后再补一份契约，它对齐的是已经写好的两份
 * 代码——那时不一致已经发生。
 */

/** 结构化错误码。 */
export const CONTRACT_CODES = Object.freeze({
  MALFORMED: 'GAC_CONTRACT_MALFORMED',
  ALREADY_FROZEN: 'GAC_CONTRACT_ALREADY_FROZEN',
  NOT_FROZEN: 'GAC_CONTRACT_NOT_FROZEN',
  NOT_COVERED: 'GAC_CONTRACT_NOT_COVERED',
})

/**
 * 结构化契约错误。
 */
export class ContractError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 校验并冻结一份接口契约。
 *
 * @param {object} raw
 * @param {object} [options]
 * @param {number} [options.frozenAt]
 * @returns {Readonly<object>}
 * @throws {ContractError}
 */
export function compileContract(raw, options = {}) {
  const fail = (message, code, detail) => {
    throw new ContractError(message, code, detail)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('接口契约必须是一个对象', CONTRACT_CODES.MALFORMED)
  }
  const name = raw.name
  if (typeof name !== 'string' || name.trim() === '') {
    fail('接口契约必须有名字，否则两份契约无法区分', CONTRACT_CODES.MALFORMED)
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    // 空契约等于没有约定，而「没有约定」正是并行写测试会出问题的那种状态。
    fail('接口契约至少要声明一个操作；空契约给不出任何可依赖的约定', CONTRACT_CODES.MALFORMED)
  }

  const seen = new Set()
  const operations = raw.operations.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      fail('每个操作都必须是一个对象', CONTRACT_CODES.MALFORMED)
    }
    const opName = entry.name
    if (typeof opName !== 'string' || opName.trim() === '') {
      fail('每个操作都必须有名字', CONTRACT_CODES.MALFORMED)
    }
    if (seen.has(opName)) {
      fail(`操作名重复：${opName}`, CONTRACT_CODES.MALFORMED, { operation: opName })
    }
    seen.add(opName)
    if (typeof entry.signature !== 'string' || entry.signature.trim() === '') {
      fail(`操作 ${opName} 缺少 signature`, CONTRACT_CODES.MALFORMED, { operation: opName })
    }
    // 只有签名时，「它返回什么」仍要靠猜，而猜出来的期望正是两边对不上的地方。
    if (typeof entry.behavior !== 'string' || entry.behavior.trim() === '') {
      fail(
        `操作 ${opName} 缺少 behavior；签名之外必须写清行为约定，否则另一方只能靠猜，`
        + '而猜出来的期望正是两边对不上的地方',
        CONTRACT_CODES.MALFORMED,
        { operation: opName },
      )
    }
    if (entry.errors !== undefined && !Array.isArray(entry.errors)) {
      fail(`操作 ${opName} 的 errors 必须是数组`, CONTRACT_CODES.MALFORMED, { operation: opName })
    }
    return Object.freeze({
      name: opName,
      signature: entry.signature,
      behavior: entry.behavior,
      errors: Object.freeze([...(entry.errors ?? [])]),
      ...(Array.isArray(entry.covers) ? { covers: Object.freeze([...entry.covers]) } : {}),
    })
  })

  const contract = Object.freeze({
    schema_version: 1,
    name,
    operations: Object.freeze(operations),
    non_goals: Object.freeze([...(raw.non_goals ?? [])]),
    frozen_at: options.frozenAt ?? 0,
  })

  if (Array.isArray(raw.covers)) {
    const gaps = findUncoveredCriteria(contract, raw.covers)
    if (gaps.length > 0) {
      fail(
        `接口契约没有覆盖验收标准：${gaps.join(', ')}；`
        + '有一条验收标准不落在任何操作的约定上，实现与测试就会各自发挥',
        CONTRACT_CODES.NOT_COVERED,
        { uncovered: gaps },
      )
    }
  }
  return contract
}

/**
 * 找出没有任何操作约定覆盖的验收标准。
 *
 * @param {Readonly<object>} contract
 * @param {readonly string[]} criteria
 * @returns {string[]}
 */
export function findUncoveredCriteria(contract, criteria) {
  const covered = new Set(contract.operations.flatMap((operation) => operation.covers ?? []))
  return criteria.filter((criterion) => !covered.has(criterion))
}

/**
 * 契约的内容寻址身份。
 *
 * 与验证计划同理：契约被改写时身份随之改变，于是「测试依据的是哪一版契约」可以被发现。
 * 顺序按操作名排序后取哈希，因为声明顺序不携带语义。
 *
 * @param {Readonly<object>} contract
 * @returns {string}
 */
export function contractId(contract) {
  const canonical = JSON.stringify([
    contract.name,
    [...contract.operations]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((operation) => [
        operation.name,
        operation.signature,
        operation.behavior,
        [...operation.errors].sort(),
      ]),
    [...contract.non_goals].sort(),
  ])
  let hash = 2166136261
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `contract-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 两份契约是否指向同一份约定。
 *
 * @param {Readonly<object>} left
 * @param {Readonly<object>} right
 * @returns {boolean}
 */
export function sameContract(left, right) {
  return contractId(left) === contractId(right)
}

/**
 * 冻结契约，并拒绝覆盖一份已冻结且不同的契约。
 *
 * 与验证计划同样分两步：声明（可改，那是设计阶段）与冻结（不可再改）。冻结之后再改就等于
 * 让已经照它开工的两条分支对着一份不存在的约定干活。
 *
 * @param {Readonly<object>} proposed - 本次声明的契约。
 * @param {Readonly<object>|undefined} existing - 已冻结的契约，若有。
 * @returns {{status: 'frozen'|'unchanged', contract: Readonly<object>, id: string}}
 * @throws {ContractError} 已有不同契约时。
 */
export function freezeContract(proposed, existing) {
  const id = contractId(proposed)
  if (existing === undefined) {
    return { status: 'frozen', contract: proposed, id }
  }
  const existingId = contractId(existing)
  if (existingId === id) {
    return { status: 'unchanged', contract: existing, id }
  }
  throw new ContractError(
    `接口契约已冻结（${existingId}），拒绝以另一份（${id}）覆盖。`
    + '契约必须在动手之前定稿；若确实需要修订，请显式删除它并说明原因，'
    + '而不是在实现与测试都已开工之后悄悄改掉它——那正是并行两边对不上的来源。',
    CONTRACT_CODES.ALREADY_FROZEN,
    { expected: existingId, proposed: id },
  )
}

/**
 * 一份契约是否可用于派遣需要写代码或写测试的节点。
 *
 * @param {Readonly<object>|undefined} contract
 * @returns {boolean}
 */
export function isFrozen(contract) {
  return contract !== undefined && contract !== null
}

/**
 * 深冻结，供交接点使用。
 *
 * @param {Readonly<object>} contract
 * @returns {Readonly<object>}
 */
export function deepFreezeContract(contract) {
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return value
    for (const child of Object.values(value)) walk(child)
    return Object.freeze(value)
  }
  return walk(contract)
}
