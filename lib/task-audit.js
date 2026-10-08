/**
 * 任务审计视图：把一次任务的完整链条**从已经落盘的产物与追加日志里派生出来**。
 *
 * @module dsh-gac-runtime/task-audit
 *
 * 为什么是派生而不是新存储
 * ----------------------
 * 真相已经在盘上了：任务记录、需求冻结记录、契约、验证计划、验证报告、复核报告，加上
 * `.dsh/gac/events/events.jsonl` 那份只追加的审计日志。再引入一份「任务审计存储」只会得到第二份
 * 会漂移的真相源——而本仓库反复吃亏的正是「两处各自维护同一件事」。
 *
 * 因此这个模块是**纯函数**：给它已经读出来的东西，它只做三件在这一层才看得见的事——
 *
 *  1. **把时间线拼起来**：从追加日志里挑出属于这个任务的事件，按发生顺序讲一遍谁在什么时候
 *     派遣了谁、谁回报了什么。日志本身没有「任务视图」，只有一串事件。
 *  2. **核对产物之间的身份**：验证报告写的是不是**当前**那份计划？复核报告审的是不是同一份？
 *     这类错配单看任何一份产物都发现不了——每一份自己都是合法的。
 *  3. **把缺口说出来**：缺什么、什么没冻、哪条引用的证据号不存在。审计的价值在缺口上，而不在
 *     复述已有的东西；一句「一切正常」如果是从「读不到就当没有」推出来的，比不说更坏。
 *
 * 刻意不做的事：不判「这次做得对不对」（那是复核与门禁的事），不修改任何状态，不猜缺的东西。
 */

import { DESIGN_CODES, designId, evaluateDesignApproval } from './design.js'

/**
 * 事件类型到一行说明的映射。认不出的类型原样报出类型名——审计不该假装自己认识一切。
 *
 * @param {object} record - 追加日志里的一条。
 * @returns {string}
 */
function describeEvent(record) {
  const data = record?.data !== null && typeof record.data === 'object' ? record.data : {}
  switch (record?.type) {
    case 'gac/mode-declared':
      return `声明模式 ${data.mode ?? '未知'}（风险 ${data.risk ?? '未知'}）`
    case 'gac/scope-declared':
      return `声明写作用域 [${(Array.isArray(data.write_scope) ? data.write_scope : []).join(', ')}]`
    case 'gac/task-created':
      return `建立任务（模式 ${data.mode ?? '未知'}）`
    case 'gac/requirement-frozen':
      return `冻结需求（${data.criteria_count ?? '?'} 条验收标准）`
    case 'gac/contract-frozen':
      return `冻结接口契约 ${data.contract_id ?? ''}`
    case 'gac/plan-registered':
      return `登记验证计划 ${data.plan_id ?? ''}（${data.cases ?? '?'} 条用例）`
    case 'gac/review-registered':
      return `登记复核报告 ${data.review_id ?? ''}`
    case 'gac/node-dispatched':
      return `派遣 ${data.node_id ?? '?'}（第 ${data.attempt ?? '?'} 次，${data.dispatch_id ?? ''}）`
    case 'gac/node-reported':
      return `${data.node_id ?? '?'} 回报 ${data.status ?? '?'}（${data.classification ?? '?'}）`
    case 'gac/task-completed':
      return `收口（${data.status ?? '?'}）`
    default:
      return String(record?.type ?? '未知事件')
  }
}

/**
 * 一条证据引用里的号（`ev-123#明细` → `ev-123`）。
 *
 * @param {unknown} ref
 * @returns {string|undefined}
 */
function evidenceIdOf(ref) {
  if (typeof ref !== 'string') return undefined
  const id = ref.split('#')[0].trim()
  return id === '' ? undefined : id
}

/**
 * 拼出一次任务的审计视图。
 *
 * @param {object} input
 * @param {object} input.task - 已恢复的任务记录。
 * @param {object|undefined} input.grilling - 需求冻结记录。
 * @param {object|undefined} input.contract - 接口契约。
 * @param {object|undefined} input.plan - 验证计划。
 * @param {object|undefined} input.verification - 验证报告。
 * @param {object|undefined} input.review - 复核报告。
 * @param {object|undefined} input.design - 冻结的设计包。
 * @param {object|undefined} input.designApproval - 主会话对设计包作出的裁决。
 * @param {readonly object[]} [input.events] - 该任务的审计事件（已按任务筛过）。
 * @param {readonly string[]} [input.issuedEvidence] - 运行时签发过的证据号。
 * @param {(plan: object) => string} input.planIdOf - 计划 id 的计算方式（内容寻址，不在计划对象里）。
 * @param {boolean} [input.contractRequired] - 这个模式是否要求接口契约。
 * @param {boolean} [input.reviewRequired] - 这次收口是否要求独立复核报告。
 * @param {boolean} [input.designRequired] - 这个模式是否要求先有一份被批准的设计。
 * @returns {{ok: boolean, gaps: string[], artifacts: object, timeline: object[], text: string}}
 */
export function composeTaskAudit(input) {
  const task = input?.task
  const plan = input?.plan
  const verification = input?.verification
  const review = input?.review
  const grilling = input?.grilling
  const contract = input?.contract
  const planIdOf = input?.planIdOf
  const issued = new Set(Array.isArray(input?.issuedEvidence) ? input.issuedEvidence : [])

  const gaps = []
  const criteria = Array.isArray(grilling?.acceptance_criteria) ? grilling.acceptance_criteria : []
  const frozenRequirement = grilling?.frozen_at !== null && grilling?.frozen_at !== undefined
  if (!frozenRequirement) {
    gaps.push('需求未冻结：没有登记验收标准，因此「每条标准都有证据」这句话无从核对')
  } else if (criteria.length === 0) {
    gaps.push('需求已冻结但验收标准为空：计划覆盖不到任何东西')
  }
  if (input?.contractRequired === true && contract === undefined) {
    gaps.push('这个模式要求接口契约，但盘上没有冻结的契约')
  }

  // 设计门禁：高风险任务在实现之前必须先有一份**被批准**的设计。这里记的是两类不同的缺口——
  // 「还没有设计包」与「有设计包但没批准」对调用方意味着不同的事，而审计的价值正在于事后能分辨
  // 「当时是设计没做出来」还是「做出来了没人批」。
  const design = input?.design
  const designApproval = input?.designApproval
  const designIdentity = design === undefined ? undefined : designId(design)
  const designVerdict = design === undefined
    ? undefined
    : evaluateDesignApproval(designApproval, design)
  if (input?.designRequired === true) {
    if (design === undefined) {
      gaps.push('这个模式要求先有一份被批准的设计，但盘上没有冻结的设计包')
    } else {
      for (const violation of designVerdict.violations) {
        if (violation?.code === DESIGN_CODES.STALE_APPROVAL) {
          gaps.push(
            `设计批准已失效：批准的是 ${JSON.stringify(violation.detail?.approved)}，`
            + `而当前设计是 ${JSON.stringify(violation.detail?.current)}`,
          )
        } else if (violation?.code === DESIGN_CODES.NOT_APPROVED) {
          gaps.push(
            violation.detail?.decision === undefined
              ? '设计包已冻结但还没有任何裁决'
              : `设计包的裁决是 ${violation.detail.decision}：${violation.detail.reason ?? ''}`,
          )
        } else {
          gaps.push(`设计包有问题：${violation?.code}`)
        }
      }
    }
  }

  const planIdentity = plan === undefined ? undefined : planIdOf(plan)
  if (plan === undefined) {
    gaps.push('没有验证计划：没有计划就没有可执行的用例，收口的证据门禁也无从核对')
  }

  const cases = Array.isArray(plan?.cases) ? plan.cases : []
  const falsification = cases.filter((entry) => entry?.type === 'falsification').length
  if (plan !== undefined && falsification === 0) {
    gaps.push('计划里没有反例（falsification）：只有正例的方案证明不了「错误的实现会被抓住」')
  }

  if (plan !== undefined && verification === undefined) {
    gaps.push('没有验证报告：计划存在但没有任何逐条执行结论落盘')
  }
  if (verification !== undefined) {
    if (verification.plan_id !== planIdentity) {
      gaps.push(
        `验证报告对不上当前计划：报告写的是 ${JSON.stringify(verification.plan_id)}，`
        + `当前计划是 ${JSON.stringify(planIdentity)}`,
      )
    }
    const executions = Array.isArray(verification.executions) ? verification.executions : []
    const covered = new Set(executions.map((entry) => entry?.case_id))
    const missing = cases.filter((entry) => !covered.has(entry?.id)).map((entry) => entry?.id)
    if (missing.length > 0) gaps.push(`这些用例没有执行结论：${missing.join('、')}`)
    const failed = executions.filter((entry) => entry?.outcome !== 'passed')
    if (failed.length > 0) {
      gaps.push(`这些用例没通过：${failed.map((entry) => `${entry.case_id}(${entry.outcome})`).join('、')}`)
    }
    const cited = executions.map((entry) => evidenceIdOf(entry?.evidence_ref)).filter((id) => id !== undefined)
    const forged = cited.filter((id) => !issued.has(id))
    if (forged.length > 0) gaps.push(`这些引用的证据号运行时从未签发过：${forged.join('、')}`)
  }

  if (input?.reviewRequired === true && review === undefined) {
    gaps.push('这次收口要求独立复核报告，但盘上没有')
  }
  if (review !== undefined) {
    if (review.reviewed_plan_id !== planIdentity) {
      gaps.push(
        `复核报告审的不是当前计划：报告写的是 ${JSON.stringify(review.reviewed_plan_id)}，`
        + `当前计划是 ${JSON.stringify(planIdentity)}`,
      )
    }
    const blocking = Array.isArray(review.blocking_issues) ? review.blocking_issues : []
    if (blocking.length > 0) gaps.push(`复核留下 ${blocking.length} 个阻塞问题`)
    const cited = (Array.isArray(review.evidence) ? review.evidence : [])
      .map((entry) => evidenceIdOf(entry))
      .filter((id) => id !== undefined)
    const forged = cited.filter((id) => !issued.has(id))
    if (forged.length > 0) gaps.push(`复核引用的证据号里有运行时从未签发过的：${forged.join('、')}`)
  }

  const nodes = [...(task?.nodes?.values?.() ?? [])].map((node) => ({
    id: node.id,
    role: node.role,
    status: node.status,
    attempt: node.execution?.attempt ?? 0,
    last_result_ref: node.execution?.last_result_ref ?? null,
  }))
  const unfinished = nodes.filter((node) => node.status !== 'completed')
  if (unfinished.length > 0) {
    gaps.push(`这些节点没有完成：${unfinished.map((node) => `${node.id}(${node.status})`).join('、')}`)
  }

  // 收口时对「能力缺项」的显式豁免：它**不是缺口**（那是有意接受的，因此不该让审计报「不 ok」），
  // 但**必须出现在链条里**——「这个高风险结论是在缺口下作出的」若只存在于当时那次调用的返回文本里，
  // 事后就查不到。所以它进 `artifacts` 与正文，不进 `gaps`。
  const ack = task?.capability_ack
  const capabilityAck = ack === null || typeof ack !== 'object'
    ? null
    : {
      at: ack.at ?? null,
      reason: ack.reason ?? '',
      missing: Array.isArray(ack.missing) ? [...ack.missing] : [],
    }

  const timeline = (Array.isArray(input?.events) ? input.events : []).map((record) => ({
    at: record?.at,
    type: record?.type,
    summary: describeEvent(record),
  }))

  const artifacts = {
    requirement_frozen: frozenRequirement === true,
    acceptance_criteria: criteria.length,
    contract: contract === undefined ? null : (contract.name ?? contract.contract_id ?? '(未命名)'),
    design: designIdentity ?? null,
    design_approved: designVerdict === undefined ? null : designVerdict.ok === true,
    design_unresolved_issues: Array.isArray(design?.unresolved_issues) ? design.unresolved_issues.length : 0,
    plan: planIdentity ?? null,
    plan_cases: cases.length,
    plan_falsification: falsification,
    verification: verification === undefined ? null : (verification.plan_id ?? null),
    verification_executions: Array.isArray(verification?.executions) ? verification.executions.length : 0,
    review: review === undefined ? null : (review.reviewed_plan_id ?? null),
    review_subject: review === undefined ? null : (review.subject ?? 'implementation'),
    review_blocking_issues: Array.isArray(review?.blocking_issues) ? review.blocking_issues.length : 0,
    evidence_issued: issued.size,
    capability_ack: capabilityAck,
  }

  const lines = [
    `任务 ${task?.task_id ?? '?'}（模式 ${task?.mode ?? '?'}，状态 ${task?.status ?? '?'}）：`
    + `${nodes.length} 个节点，${nodes.filter((node) => node.status === 'completed').length} 个已完成。`,
    `需求：${frozenRequirement ? `已冻结，${criteria.length} 条验收标准` : '未冻结'}；`
    + `契约：${artifacts.contract ?? '无'}；设计：${artifacts.design ?? '无'}`
    + `${designVerdict === undefined
      ? ''
      : `（${designVerdict.ok ? '已批准' : '未批准'}，${artifacts.design_unresolved_issues} 条未解决事项）`}；`
    + `计划：${artifacts.plan ?? '无'}`
    + `${plan === undefined ? '' : `（${cases.length} 条用例，其中 ${falsification} 条反例）`}。`,
    `验证：${artifacts.verification ?? '无'}；复核：${artifacts.review ?? '无'}；`
    + `运行时签发过的证据：${issued.size} 条。`,
    `审计事件：${timeline.length} 条。`,
    ...(capabilityAck === null
      ? []
      : [`收口时接受了能力缺口（${capabilityAck.missing.join('、') || '未记明'}）：`
        + `${capabilityAck.reason || '未写理由'}。这不是缺口，是有意接受的条件。`]),
    gaps.length === 0 ? '未发现缺口。' : `发现 ${gaps.length} 个缺口：\n- ${gaps.join('\n- ')}`,
  ]

  return {
    ok: gaps.length === 0,
    gaps,
    artifacts,
    nodes,
    timeline,
    text: lines.join('\n'),
  }
}
