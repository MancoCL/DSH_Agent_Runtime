/**
 * 指标：从证据日志与任务记录里归约出可核对的数。
 *
 * @module dsh-gac-runtime/metrics
 *
 * 只从已经落盘的事实里算
 * ----------------------
 * 每个指标都必须能追到一个具体的记录。这样得到的数可能比「全都要」少，但它是可复核的：
 * 拿同一个日志重算一次会得到同一个结果，而凭猜测补出来的比例不会。
 *
 * 算不出来的要说出来
 * ------------------
 * 有几个大纲 §55 想要的指标在这里算不出来，原因写在 `unavailable` 里而不是悄悄省略。省掉
 * 一个指标会让人以为它没问题；写明「为什么算不出来」才会让人知道该补什么前置数据。
 *
 * 最要紧的一个数是「越权写入尝试」
 * ------------------------------
 * 它**应当恒为 0**。非零不代表门禁失效（门禁拦住了它），而代表提示词与说明有问题：模型在
 * 试图做一件本就不该尝试的事。把「拦住了」当成成功会让这个信号被永远忽略。
 */

import { TOOL_RESULT_SOURCE } from './evidence.js'

/** 越权写入被拒的结构化码。 */
export const DENIED_WRITE_CODE = 'GAC_WRITE_SCOPE_DENIED'

/** 在作用域生效时被拒的 shell 调用。 */
export const DENIED_SHELL_CODE = 'GAC_SHELL_DENIED_UNDER_SCOPE'

/**
 * 统计证据日志里的观测。
 *
 * 工具调用的统计与工作区观测的统计分开：前者数的是「调了什么」，后者数的是「改了什么、越界
 * 多少」。合并进一个总数会让「越权写入尝试」这个应当恒为 0 的数，被工作区观测的条数冲淡。
 *
 * `witness` 块里的三个数各自回答一个问题：观测到了几轮、这些轮里一共发现几个越界改动、其中
 * 有几轮的摘要本身就是不完整的。第三个数是前两个数的可信度：覆盖不完整的轮次越多，「这一轮
 * 没有越界」这句话能覆盖的范围就越小。
 *
 * **还有第四件事：这一层到底在不在。** 源缺席时上面三个数会全是 0，而「0 轮观测」与「真的没有
 * 越界改动」在读数上完全分不开——那是这份报告最危险的读法，因为 0 恰好是想要的那个数。所以
 * `available` 必须一起报出来，而它由调用方给（观测源在不在是环境事实，不是能从证据里算出来的
 * 东西）。缺省 `undefined` 表示调用方没给这个事实：那时不宣称可用，也不宣称不可用。
 *
 * @param {readonly Readonly<object>[]} evidence
 * @param {object} [options]
 * @param {boolean} [options.observationAvailable] - 工作区观测源此刻在不在。
 * @returns {object}
 */
export function summarizeEvidence(evidence, options = {}) {
  const byTool = new Map()
  let errors = 0
  let deniedWrites = 0
  let deniedShells = 0
  let witnessObservations = 0
  let witnessOutOfScope = 0
  let witnessPartial = 0
  for (const record of evidence) {
    const tool = typeof record?.tool === 'string' ? record.tool : '<unknown>'
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1)
    if (record?.is_error === true) errors += 1
    if (record?.error_code === DENIED_WRITE_CODE) deniedWrites += 1
    if (record?.error_code === DENIED_SHELL_CODE) deniedShells += 1
    if (record?.source !== TOOL_RESULT_SOURCE && record?.source !== undefined) {
      witnessObservations += 1
      if (Array.isArray(record.workspace?.out_of_scope)) {
        witnessOutOfScope += record.workspace.out_of_scope.length
      }
      if (record.workspace?.coverage === 'partial') witnessPartial += 1
    }
  }
  return {
    total: evidence.length,
    errors,
    denied_writes: deniedWrites,
    denied_shells: deniedShells,
    witness: {
      // 三态：true 在场、false 不在场、**null 调用方没给这个事实**。不要用 `!== false` 把它压成
      // 二值——「不知道」与「在场」是两件事，压掉之后报告会在最需要谨慎的地方显得笃定。
      //
      // 用 `null` 而不是 `undefined`：这份对象是**工具的出口**，而 `undefined` 不是合法 JSON——
      // 活体踩到过，宿主把整份结果判成 `value is not lossless JSON`（单测直接调 `execute()`、
      // 从没经过序列化，所以没抓到；`test/evidence.test.js` 里那条无损断言就是那次事故的钉子）。
      available: options.observationAvailable === undefined ? null : options.observationAvailable === true,
      observations: witnessObservations,
      out_of_scope: witnessOutOfScope,
      partial_coverage: witnessPartial,
    },
    by_tool: Object.fromEntries([...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
}

/**
 * 重复读同一路径的比例。
 *
 * 判据是「同一会话内、同一读工具、参数摘要相同」出现两次以上。参数摘要相同意味着读的是
 * 同一个路径同一个范围——重复读是上下文复用的反例，而它与「第二次读了别的范围」在数据上
 * 完全不同，不该混在一个数里。
 *
 * @param {readonly Readonly<object>[]} evidence
 * @returns {{duplicate_reads: number, total_reads: number, ratio: number}}
 */
export function duplicateReadRatio(evidence) {
  const seen = new Map()
  let totalReads = 0
  let duplicates = 0
  for (const record of evidence) {
    const tool = record?.tool
    if (tool !== 'read' && tool !== 'read_file') continue
    totalReads += 1
    const key = `${record?.session_id ?? ''}\u0000${tool}\u0000${record?.arguments_digest ?? ''}`
    const count = seen.get(key) ?? 0
    if (count > 0) duplicates += 1
    seen.set(key, count + 1)
  }
  return {
    duplicate_reads: duplicates,
    total_reads: totalReads,
    ratio: totalReads === 0 ? 0 : duplicates / totalReads,
  }
}

/**
 * 独立验证覆盖率：验证计划覆盖了几条验收标准。
 *
 * @param {Readonly<object>|undefined} plan
 * @param {readonly string[]} criteria
 * @returns {{covered: number, total: number, ratio: number}}
 */
export function verificationCoverage(plan, criteria) {
  const total = criteria.length
  if (plan === undefined || total === 0) return { covered: 0, total, ratio: 0 }
  const covered = criteria.filter(
    (criterion) => plan.cases.some((entry) => entry.covers.includes(criterion)),
  ).length
  return { covered, total, ratio: covered / total }
}

/**
 * 修复尝试次数：同一节点尝试序号的最大值。
 *
 * 取最大值而不是平均值：一个需要修三次的节点与三个各修一次的节点，前者才是信号。
 *
 * @param {readonly object[]} tasks
 * @returns {{max_attempts: number, by_node: Record<string, number>}}
 */
export function repairAttempts(tasks) {
  const byNode = {}
  let max = 0
  for (const task of tasks) {
    const nodes = task?.nodes
    const entries = nodes instanceof Map ? nodes.entries() : Object.entries(nodes ?? {})
    for (const [id, node] of entries) {
      const attempt = node?.execution?.attempt ?? 0
      if (typeof attempt !== 'number') continue
      byNode[`${task.task_id ?? task.taskId}/${id}`] = attempt
      if (attempt > max) max = attempt
    }
  }
  return { max_attempts: max, by_node: byNode }
}

/**
 * 大纲 §55 里本模块**算不出来**的指标，以及原因。
 *
 * 写明原因而不是省略：省掉会让人以为它没问题。
 */
export const UNAVAILABLE_METRICS = Object.freeze([
  {
    metric: 'Agent Call Amplification',
    reason: '需要按需求数分母；运行时尚不记录「一个需求」的边界，只有会话与工具调用。',
  },
  {
    metric: 'Token Usage / Context Reuse Ratio',
    reason: '需要 tokenMeter 读数；证据日志只记工具调用，不含 token 计量。',
  },
  {
    metric: 'False-positive Escalation',
    reason: '需要「实际是否真的需要升级」这个事后判断作为分母，而它不是运行时事实。',
  },
  {
    metric: 'Critical Path Duration',
    reason: '需要任务级的起止事件；证据带时间戳，但任务本身的开始与结束尚未作为事件记录。',
  },
])

/**
 * 汇出一份指标报告。
 *
 * @param {object} input
 * @param {readonly Readonly<object>[]} [input.evidence]
 * @param {readonly object[]} [input.tasks]
 * @param {Readonly<object>} [input.plan]
 * @param {readonly string[]} [input.criteria]
 * @returns {object}
 */
export function buildReport({ evidence = [], tasks = [], plan, criteria = [], observationAvailable } = {}) {
  return {
    evidence: summarizeEvidence(evidence, { observationAvailable }),
    reads: duplicateReadRatio(evidence),
    verification: verificationCoverage(plan, criteria),
    repairs: repairAttempts(tasks),
    unavailable: UNAVAILABLE_METRICS,
  }
}
