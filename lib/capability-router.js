/**
 * 能力路由：按节点所需能力选出执行者。
 *
 * @module dsh-gac-runtime/capability-router
 *
 * 大纲 §9 明确不要「Builder 永远写代码、Verifier 永远测试」这种固定岗位，节点用
 * `required_capabilities` 表达需要什么能力，由路由决定谁承载。本模块只做这一个判断，
 * 且是纯函数：执行者与能力词表都由工程适配器声明，运行时不认识任何具体执行者名称。
 *
 * 规则是确定性的，而且顺序本身就是优先级（照搬被替换的那套 Python 运行时，它在这些
 * 规则上踩过坑）：
 *
 *   1. 必须覆盖全部所需能力——覆盖不全的执行者直接出局，而不是「差不多就行」；
 *   2. 在覆盖得住的里面，选**额外覆盖最少**的那个；
 *   3. 并列时按工程在 `executors` 里的书写顺序；
 *   4. 再并列时按名称排序。
 *
 * 第 2 条是关键：若只按「能覆盖」来选，一个声称什么都会的执行者会赢下所有节点，
 * 于是能力声明形同虚设、独立性也无从谈起。选额外覆盖最少的，等于偏好**刚好合适**
 * 的那一个。
 *
 * 覆盖不全时不硬凑：返回空结果，由调用方拆节点（把 implementation 与 verification
 * 分成两个节点），而不是把执行者声明成全能——大纲 §9 与协议都要求拆，不要凑。
 *
 * 能力词表可校验但**不强制**：`required_capabilities` 是否取自工程词表由校验层决定。
 * 路由只回答「谁能做」，不回答「这个能力名合不合法」——那是适配器校验的事，混在一起
 * 会让一个能力名笔误表现为「找不到执行者」，把人引向错误的方向。
 */

import { CoordinatorError } from './coordinator.js'

/** 结构化错误码。 */
export const ROUTER_CODES = Object.freeze({
  UNSCHEDULABLE: 'GAC_UNSCHEDULABLE_CAPABILITIES',
})

/**
 * 把适配器的 `executors` 归一成便于比较的结构。
 *
 * @param {object} executors - 适配器里的 `executors` 映射。
 * @returns {{name: string, capabilities: Set<string>, order: number}[]}
 */
function normalizeExecutors(executors) {
  if (executors === null || typeof executors !== 'object' || Array.isArray(executors)) {
    throw new TypeError('capability-router: executors 必须是 能力→执行者列表 的对象')
  }
  const byName = new Map()
  let order = 0
  for (const [capability, names] of Object.entries(executors)) {
    if (!Array.isArray(names)) {
      throw new TypeError(`capability-router: executors.${capability} 必须是数组`)
    }
    for (const name of names) {
      if (typeof name !== 'string' || name === '') {
        throw new TypeError(`capability-router: executors.${capability} 里的执行者名必须是非空字符串`)
      }
      const existing = byName.get(name)
      if (existing === undefined) {
        // 首次出现的位置决定书写顺序：一个执行者出现在多个能力下时，取最早那次。
        byName.set(name, { name, capabilities: new Set([capability]), order: order++ })
      } else {
        existing.capabilities.add(capability)
      }
    }
  }
  return [...byName.values()]
}

/**
 * 为一个节点选出执行者。
 *
 * @param {readonly string[]} requiredCapabilities
 * @param {object} executors - 适配器里的 `executors` 映射。
 * @returns {{
 *   executor?: string,
 *   reason: string,
 *   candidates: {name: string, covers: boolean, extra: string[]}[],
 *   missing: string[]
 * }}
 *   `executor` 缺席表示没有单一执行者能承载这组能力，`missing` 给出缺口以供拆节点。
 * @throws {TypeError} 入参形状不对。
 */
export function routeCapabilities(requiredCapabilities, executors) {
  if (!Array.isArray(requiredCapabilities)) {
    throw new TypeError('capability-router: requiredCapabilities 必须是数组')
  }
  const required = [...new Set(requiredCapabilities)]
  if (required.length === 0) {
    // 没有能力要求就没有路由依据；这属于计划缺陷，交由 compileTask 拒绝，这里如实说明。
    return { reason: '节点未声明所需能力，无法路由', candidates: [], missing: [] }
  }

  const all = normalizeExecutors(executors)
  const candidates = all.map((executor) => {
    const missing = required.filter((capability) => !executor.capabilities.has(capability))
    const extra = [...executor.capabilities].filter((capability) => !required.includes(capability))
    return {
      name: executor.name,
      order: executor.order,
      covers: missing.length === 0,
      extra,
      missing,
    }
  })

  const covering = candidates.filter((candidate) => candidate.covers)
  if (covering.length === 0) {
    // 报出「没有任何执行者能覆盖」的那部分能力——即各候选缺口的交集，而不是并集。
    // 并集会把别的执行者其实覆盖得了的能力也算进来（例如没人同时会写与部署时，
    // 「实现」会被误列为缺口，而它并不缺），从而把拆节点的方向指错。
    const nobodyCovers = required.filter((capability) =>
      candidates.every((candidate) => candidate.missing.includes(capability)))
    return {
      reason:
        `没有单一执行者能承载 [${required.join(', ')}]；`
        + `没有任何执行者覆盖 [${nobodyCovers.join(', ') || '（能力组合本身）'}]。`
        + '应当拆节点，而不是把执行者声明成全能。',
      candidates: candidates.map(stripOrder),
      missing: nobodyCovers,
    }
  }

  // 额外覆盖最少优先；并列按书写顺序；再并列按名称，使结果与输入顺序无关。
  const winner = [...covering].sort((left, right) =>
    left.extra.length - right.extra.length
    || left.order - right.order
    || left.name.localeCompare(right.name))[0]

  return {
    executor: winner.name,
    reason: winner.extra.length === 0
      ? `${winner.name} 恰好覆盖 [${required.join(', ')}]`
      : `${winner.name} 覆盖 [${required.join(', ')}]，额外能力 `
        + `[${winner.extra.join(', ')}] 最少的可选者`,
    candidates: candidates.map(stripOrder),
    missing: [],
  }
}

/**
 * 去掉内部排序字段，只把有意义的部分交给调用方。
 *
 * @param {object} candidate
 * @returns {object}
 */
function stripOrder(candidate) {
  const { order: _order, missing: _missing, ...rest } = candidate
  return rest
}

/**
 * 为一个任务里的每个节点预先算好执行者。
 *
 * 一次算完而不是派遣时才算：一个覆盖不了的节点应当在**动手之前**就暴露，纳入拆节点的
 * 讨论，而不是等前几个节点已经改过文件才发现。
 *
 * @param {object} task - {@link import('./coordinator.js').compileTask} 的结果。
 * @param {object} executors
 * @returns {Map<string, object>} 节点 id → 路由结果。
 * @throws {CoordinatorError} 任一节点无法调度。
 */
export function routeTask(task, executors) {
  const routes = new Map()
  const unschedulable = []
  for (const node of task.nodes.values()) {
    const route = routeCapabilities(node.required_capabilities, executors)
    routes.set(node.id, route)
    if (route.executor === undefined) {
      unschedulable.push({ node: node.id, missing: route.missing, reason: route.reason })
    }
  }
  if (unschedulable.length > 0) {
    throw new CoordinatorError(
      `任务 ${task.task_id} 有 ${unschedulable.length} 个节点无法调度：`
      + unschedulable.map((entry) => `节点 ${entry.node} 缺口 [${entry.missing.join(', ') || '全部'}]`).join('；')
      + '。应当把这些节点拆开，而不是把执行者声明成全能。',
      ROUTER_CODES.UNSCHEDULABLE,
      { unschedulable },
    )
  }
  return routes
}
