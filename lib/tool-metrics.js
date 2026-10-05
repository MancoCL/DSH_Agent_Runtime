/**
 * `gac_metrics`：把工程里已经落盘的事实归约成一份可核对的读数。
 *
 * @module dsh-gac-runtime/tool-metrics
 *
 * 这是一个**只读**工具：它不写任何文件、不改变任何状态、也不发放货物。之所以要有它，是因为
 * 指标如果只能靠读文件得到，它就不会被读——而写好了却没人调用的代码与没写是一样的，这个
 * 仓库已经因此修过好几处。
 *
 * 它同时是「越权写入尝试」这个信号的出口。那个数**应当恒为 0**：非零不代表门禁失效（门禁
 * 拦住了它），而代表提示词与说明有问题——模型在试图做一件本就不该尝试的事。没有出口，这个
 * 信号就会被永远忽略。
 */

import { buildReport } from './metrics.js'

/** 工具名。 */
export const METRICS_TOOL_NAME = 'gac_metrics'

/**
 * 组装只读指标工具的选项。
 *
 * @param {object} deps
 * @param {(root: string) => import('./task-store.js').TaskStore} deps.taskStoreFor
 * @param {(root: string) => readonly Readonly<object>[]} deps.evidenceFor
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @returns {object}
 */
export function metricsToolOptions({ taskStoreFor, evidenceFor, sessionRootFor }) {
  return {
    name: METRICS_TOOL_NAME,
    description:
      '只读：把本工程已经落盘的事实归约成一份可核对的读数——工具调用数、被拒的越权写入、'
      + '工作区观测（这一轮实际改了哪些文件、其中越界几个）、重复读比例、验证覆盖率、'
      + '修复尝试次数。每个数都能追到一条具体记录，因此拿同一份日志重算会得到同一个结果。'
      + '**`evidence.denied_writes` 应当恒为 0**：非零不代表门禁失效（门禁拦住了它），'
      + '而代表提示词与说明有问题，模型在试图做一件本就不该尝试的事。'
      + '工作区观测的越界数则是**已经发生**的改动（门禁拦不住 shell 重定向与生成器写出的文件），'
      + '发现它要修的是改动本身，而不是提示词。'
      + '算不出来的指标会连同原因一并列出，而不是省略——省掉一个会让人以为它没问题。',
    parameters: {
      task_id: {
        type: 'string',
        description: '可选：只看某个任务（用于验证覆盖率与修复尝试）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          task_ids: { type: 'array', required: true, items: { type: 'string' } },
          evidence: { type: 'object', required: true, additionalProperties: true },
          reads: { type: 'object', required: true, additionalProperties: true },
          verification: { type: 'object', required: true, additionalProperties: true },
          repairs: { type: 'object', required: true, additionalProperties: true },
          unavailable: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },

    /**
     * @param {object} args
     * @param {object} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      const root = typeof sessionId === 'string' ? sessionRootFor?.(sessionId) : undefined
      if (typeof root !== 'string' || root === '') {
        throw new Error(
          'gac_metrics: 这个会话没有可解析的项目根目录。指标按项目存放，请在项目工作目录内的会话中使用本工具。',
        )
      }

      const store = taskStoreFor(root)
      const evidence = evidenceFor?.(root) ?? []

      // 任务来源有两种：指定了一个，或把盘上现有的都读一遍。后者才是默认，因为
      // 「这个工程现在怎么样」通常正是想问的问题。
      let tasks = []
      if (typeof args.task_id === 'string' && args.task_id !== '') {
        const task = store.load(args.task_id)
        if (task === undefined) {
          throw new Error(`gac_metrics: 找不到任务 ${args.task_id}。`)
        }
        tasks = [task]
      } else {
        tasks = store.list().map((id) => store.load(id)).filter((task) => task !== undefined)
      }

      // 计划属于本任务；没指定任务时取不到，于是覆盖率留空而不是拿别人的计划充数。
      const plan = typeof args.task_id === 'string' && args.task_id !== ''
        ? store.loadPlan(args.task_id)
        : undefined
      const criteria = Array.isArray(plan?.criteria) ? plan.criteria : []

      const report = buildReport({ evidence, tasks, plan, criteria })
      return {
        root,
        task_ids: tasks.map((task) => task.task_id),
        ...report,
        summary: describeReport(report),
      }
    },
  }
}

/**
 * 把一份指标报告讲成一句人能读的话。
 *
 * 越权写入尝试单独用一句说：那个数应当恒为 0，非零时它需要被看见，而不是混在一串数字里。
 *
 * 工作区观测也单独说一句，理由相同但方向相反：`denied_writes` 数的是**被拦住的尝试**，而
 * 工作区观测里的越界数的是**已经发生的改动**——门禁拦不住 shell 重定向与代码生成器写出的
 * 文件，那一类只能事后看见。一个「0 轮观测」同样值得说出来：它说明观测源没有产出，而不是
 * 「一切正常」。
 *
 * @param {object} report
 * @returns {string}
 */
function describeReport(report) {
  const { evidence, reads, verification, repairs } = report
  const witness = evidence.witness ?? { observations: 0, out_of_scope: 0, partial_coverage: 0 }
  const parts = [
    `工具调用 ${evidence.total} 次（其中报错 ${evidence.errors} 次）`,
    `重复读 ${reads.duplicate_reads}/${reads.total_reads}`,
    `验证覆盖 ${verification.covered}/${verification.total}`,
    `单节点最大修复尝试 ${repairs.max_attempts}`,
    `工作区观测 ${witness.observations} 轮（越界改动 ${witness.out_of_scope} 个`
      + `${witness.partial_coverage > 0 ? `，其中 ${witness.partial_coverage} 轮未列全` : ''}）`,
  ]
  if (evidence.denied_writes > 0) {
    parts.push(
      `**越权写入尝试 ${evidence.denied_writes} 次**——门禁拦住了它们，`
      + '但这个数应当为 0，非零说明提示词与说明需要修正',
    )
  } else {
    parts.push('越权写入尝试 0 次')
  }
  parts.push(`另有 ${report.unavailable.length} 项指标在这里算不出来，原因见 unavailable`)
  return `${parts.join('；')}。`
}

/**
 * 用宿主提供的 `defineTool` 造出真实工具。
 *
 * @param {object} deps
 * @param {object} deps.defineTool
 * @param {(root: string) => import('./task-store.js').TaskStore} deps.taskStoreFor
 * @param {(root: string) => readonly Readonly<object>[]} deps.evidenceFor
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @returns {object}
 */
export function createMetricsTool({ defineTool, taskStoreFor, evidenceFor, sessionRootFor }) {
  return defineTool(metricsToolOptions({ taskStoreFor, evidenceFor, sessionRootFor }))
}
