/**
 * `gac_evidence`：列出本工程的证据记录，让验证报告能引用真实存在的证据号。
 *
 * @module dsh-gac-runtime/tool-evidence
 *
 * 为什么需要它
 * ------------
 * 收口门禁要求验证报告引用「运行时发出过的证据号」，但在它之前，**没有任何东西能让模型
 * 知道有哪些号**。模型只能去手读 `.dsh/gac/evidence/evidence.jsonl`，而那是 JSONL——门禁
 * 因此在实际使用中不可用：规则要求引用真号，而真号无从得知。
 *
 * 这是一个**只读**工具：它不写文件、不改变状态、不发放证据。它只是把已经落盘的事实摊开，
 * 好让「引用一条真证据」成为一件做得到的事。
 *
 * 判定不在这里重新实现
 * --------------------
 * 「这条证据能不能充当通过凭据」由 `lib/evidence.js` 的 `isPassingEvidence` 给出，本模块
 * 只调用它。判定规则只允许有一个定义处：两处实现迟早会不一致，而不一致时门禁与展示会对
 * 同一条证据给出相反结论，那种矛盾比没有展示更难查。
 */

import { TOOL_RESULT_SOURCE, isPassingEvidence } from './evidence.js'

/** 工具名。 */
export const EVIDENCE_TOOL_NAME = 'gac_evidence'

/** 默认列出多少条。 */
export const DEFAULT_LIMIT = 20

/**
 * 把一条原始证据记录投影成给模型看的一条。
 *
 * 保留参数前缀与产出前缀，是因为模型要靠它们判断该不该引用这条证据：对命令类证据，参数就是
 * 命令本身，不看参数的话「ev-2 | pwsh | exit 0」等于什么都没说。
 *
 * `exit_code` 只在原记录确实有该字段时才带上——缺失是诚实的，补一个 0 是编的。
 *
 * 工作区观测走另一条分支：它没有「哪个工具、什么参数」，也没有「产出了什么」，因此那两个字段
 * 对它一律不出现，改由 `workspace` 给出这一轮的变更事实。把观测套进工具调用的形状，就等于把
 * 「改了什么」说成了「调了哪个工具」。
 *
 * @param {Readonly<object>} record
 * @returns {object}
 */
export function projectEvidence(record) {
  const verdict = isPassingEvidence(record)
  const source = typeof record.source === 'string' ? record.source : TOOL_RESULT_SOURCE
  const isWorkspace = source !== TOOL_RESULT_SOURCE
  return {
    id: record.id,
    tool: record.tool,
    source,
    at: record.at,
    session_id: record.session_id,
    is_error: record.is_error,
    ...(record.exit_code === undefined ? {} : { exit_code: record.exit_code }),
    ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
    ...(isWorkspace
      ? {}
      : {
        arguments_preview: record.arguments_preview,
        output_preview: record.output_preview,
      }),
    usable: verdict.usable,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
  }
}

/**
 * 把 limit 归一成一个可用的条数。
 *
 * 不是正整数就退回默认值，而不是返回空或全部：一个写错的 limit 应当退化成合理行为，而不是
 * 让调用方拿到一份看起来正常、实际含义完全不同的列表。
 *
 * @param {unknown} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT
}

/**
 * 从证据集合里选出要列出的一批。
 *
 * 纯函数：不读盘、不碰 DSH，因此可以脱离运行时被穷尽测试。
 *
 * `available` 与 `total` 是两个不同的数，不能合并：前者是本工程证据总条数、**不受过滤
 * 影响**，后者是过滤后匹配的条数。合并之后，「过滤后没有匹配」与「这个工程还没有证据」
 * 会给出同一个读数，而它们是两种完全不同的诊断。
 *
 * @param {readonly Readonly<object>[]} records
 * @param {object} [options]
 * @param {number} [options.limit] - 最多列出多少条，缺省 20。
 * @param {string} [options.tool] - 按工具名过滤。
 * @param {string} [options.session_id] - 按会话过滤；**不给就列全部会话**，因为验证者
 *   往往在另一个会话里干活，而它要引用的正是实现者那个会话跑出来的证据。
 * @returns {{available: number, total: number, listed: number, records: object[]}}
 */
export function selectEvidence(records, options = {}) {
  const all = Array.isArray(records) ? records : []
  const matched = all.filter((record) => {
    if (typeof options.tool === 'string' && options.tool !== '' && record.tool !== options.tool) return false
    if (typeof options.session_id === 'string' && options.session_id !== ''
      && record.session_id !== options.session_id) return false
    return true
  })

  // 倒序取，最新在前：刚跑完的命令排在前面，直接就能引用。用展开复制而不是就地 reverse，
  // 就地倒序会把调用方的数据改掉，那是难以追查的一类副作用。
  const newestFirst = [...matched].reverse()
  const selected = newestFirst.slice(0, normalizeLimit(options.limit))

  return {
    available: all.length,
    total: matched.length,
    listed: selected.length,
    records: selected.map(projectEvidence),
  }
}

/**
 * 把一次选出的结果讲成一句人能读的话。
 *
 * 被截断时必须说明还有多少条没列出：被截掉却不说，会让人以为这就是全部，而「没找到」与
 * 「没显示」是两件事。
 *
 * @param {object} selection - {@link selectEvidence} 的结果。
 * @returns {string}
 */
function describeSelection(selection) {
  const { available, total, listed } = selection
  if (available === 0) return '本工程还没有任何证据记录。'
  if (total === 0) {
    return `本工程共有 ${available} 条证据，但按当前筛选条件一条也没有匹配——`
      + '这不是「没有证据」，而是「筛选没筛到」。'
  }
  const base = `本工程共有 ${available} 条证据，匹配 ${total} 条，本次列出 ${listed} 条（最新在前）。`
  if (total > listed) {
    return `${base}还有 ${total - listed} 条未列出；如需更多请调大 limit，或用 tool / session_id 收窄范围。`
  }
  return base
}

/**
 * 组装只读证据列表工具的选项。
 *
 * @param {object} deps
 * @param {(root: string) => readonly Readonly<object>[]} deps.evidenceFor
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @returns {object}
 */
export function evidenceToolOptions({ evidenceFor, sessionRootFor }) {
  return {
    name: EVIDENCE_TOOL_NAME,
    description:
      '只读：列出本工程的证据记录（运行时记下的观测），供验证报告引用。'
      + '每条给出证据号、工具、参数前缀、产出前缀，并标出它能否充当「通过」凭据'
      + '（退出码非零、调用报错、或这一轮有越界改动的标为不可用）。'
      + '证据有两种：工具调用的结果，以及一轮工作区变更观测（那一轮实际改了哪些文件、'
      + '其中哪些落在已声明的写范围之外）。后者会写明本轮列出的文件数与总数、覆盖是否完整、'
      + '越界个数。'
      + '引用格式是 `证据号#明细`：同一次运行支撑多条用例时，用不同明细区分各自成立的部分；'
      + '同号配相同明细会被判为取证摊薄。'
      + '默认列出最近 20 条且**跨全部会话**——验证者往往在另一个会话里跑，而它要引用的正是'
      + '实现者那个会话的证据。',
    parameters: {
      limit: {
        type: 'number',
        description: `最多列出多少条，缺省 ${DEFAULT_LIMIT}。`,
      },
      tool: {
        type: 'string',
        description: '可选：只列某个工具的证据，例如 `pwsh`。',
      },
      session_id: {
        type: 'string',
        description: '可选：只列某个会话的证据。不给则列本工程全部会话。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          available: { type: 'number', required: true },
          total: { type: 'number', required: true },
          listed: { type: 'number', required: true },
          records: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          summary: { type: 'string', required: true },
        },
      },
      // render 决定**模型实际读到什么**，因此它和数据结构一样是接口的一部分。
      //
      // 这里一度只渲染 summary，于是工具在数据上完全正确、却毫无用处：模型看得到「共有 8 条
      // 证据」，看不到任何证据号，而「让模型知道有哪些证据号」正是这个工具存在的唯一理由。
      // 数据对了不等于目的达到了——两者之间隔着的就是这一段。
      render: (_args, value) => {
        const lines = value.records.map((item) => {
          const verdict = item.usable ? '可用于收口' : `不可用：${item.reason ?? '原因未说明'}`
          // 工作区观测要能一眼看出四件事：这是观测而不是工具调用、本轮列出的文件数与总数、
          // 覆盖是否完整、越界的个数（含工程之外）。少了任何一件，模型就得去读 JSONL 才能
          // 判断——而「让模型知道有哪些证据号、各是什么」正是这个工具存在的全部理由。
          if (item.source !== undefined && item.source !== 'tool-result') {
            const workspace = item.workspace ?? {}
            const coverage = workspace.coverage === 'partial'
              ? `覆盖不完整（本轮未列全：${workspace.listed ?? '?'}/${workspace.total ?? '?'}）`
              : `覆盖完整（${workspace.listed ?? '?'} 个文件）`
            return [
              `- ${item.id} | 工作区观测 | ${verdict}`,
              `    第 ${workspace.turn ?? '?'} 轮改动：${coverage}`,
              `    越界 ${workspace.out_of_scope?.length ?? 0} 个`
                + `（其中工程之外 ${workspace.outside_project?.length ?? 0} 个）`,
            ].join('\n')
          }
          return [
            `- ${item.id} | ${item.tool} | ${verdict}`,
            `    参数：${item.arguments_preview ?? '(无)'}`,
            `    产出：${item.output_preview ?? '(无)'}`,
          ].join('\n')
        })
        const body = lines.length > 0 ? lines.join('\n') : '（没有匹配的证据）'
        return [{ type: 'text', text: `${value.summary}\n${body}` }]
      },
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
        // 抛错而不是返回空列表：空列表会被读成「这个工程没有证据」，而实际是
        // 「不知道在哪个工程」——两者必须能区分。
        throw new Error(
          'gac_evidence: 这个会话没有可解析的项目根目录。证据按项目存放，'
          + '请在项目工作目录内的会话中使用本工具。',
        )
      }

      const selection = selectEvidence(evidenceFor?.(root) ?? [], {
        limit: args.limit,
        tool: args.tool,
        session_id: args.session_id,
      })
      return {
        root,
        ...selection,
        summary: describeSelection(selection),
      }
    },
  }
}

/**
 * 用宿主提供的 `defineTool` 造出真实工具。
 *
 * @param {object} deps
 * @param {object} deps.defineTool
 * @param {(root: string) => readonly Readonly<object>[]} deps.evidenceFor
 * @param {(sessionId: string) => string|undefined} deps.sessionRootFor
 * @returns {object}
 */
export function createEvidenceTool({ defineTool, evidenceFor, sessionRootFor }) {
  return defineTool(evidenceToolOptions({ evidenceFor, sessionRootFor }))
}
