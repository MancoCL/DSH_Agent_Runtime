/**
 * 系统提示段落：把 GAC 的门禁与当前状态放进模型视野。
 *
 * @module dsh-gac-runtime/prompt-section
 *
 * 这一段补的是哪一道缺口
 * -------------------------
 * 在此之前插件从不注入任何提示文本，于是模型只能靠**被拒绝**来发现门禁存在。
 * 一个事先不知道边界的模型会反复撞上去，而每次撞上都是一轮浪费：它在试探，而
 * 运行时在拒绝，两边都没在干活。
 *
 * 段落只讲**状态**，不讲规则
 * ------------------------------
 * 模式阶梯在 `gac_project` 的描述里，写范围语义在 `gac_scope` 的描述里。段落
 * 若把它们再抄一遍，就有了两处会各自漂移的副本，而漂移的那一份是模型读到的那
 * 一份。所以这里只回答工具描述回答不了的问题：**此刻**声明了什么、正在执行什么。
 *
 * 什么时候它整段消失
 * ----------------------
 * 未纳管的工程里渲染成空串（提示装配会丢弃空段落）。插件的门禁对没有声明纳管
 * 的工程本来就是惰性的，让它在每个会话里都占一段提示词是不诚实的。判定依据是
 * **盘上的事实**（`.dsh/gac/project.json` 在不在），而不是会话里的内存状态：后者
 * 一插件重载就没了，用它判定会让段落忽隐忽现，而忽隐忽现的提示比没有提示更糟。
 *
 * 这个函数永远不能抛
 * ----------------------
 * 段落的 `text` 由提示装配管线直接调用（`dsh-system-prompt` 的 `assemble()` 里就是
 * `section.text(context)`，没有 try）。它一旦抛错，**每一个模型步进**都会失败——
 * 包括模型拿来修复它的那一步，于是这个会话再也递不出任何工具调用。所以 provider
 * 整个包在 try 里，且对任何输入都只返回字符串。这不是防御性编程的习惯动作，这是
 * 一个会把自己锁在门外的动作。
 *
 * 同理，注册方会给段落带 `interpolate: false`（见 {@link createPromptSection}）：
 * 本段文本是生成的，工程路径里恰好出现一个 `{{` 就会让渲染期抛错——正是上一条要
 * 避免的那种失败。
 */

import { GAC_CODES } from './plugin.js'
import { ADAPTER_RELATIVE_PATH } from './project-state.js'

/** 注册到 `systemPrompt` 上的段落名。 */
export const PROMPT_SECTION_NAME = 'gac:protocol'

/**
 * 段落顺序。
 *
 * 取 700：在第一方策略段（`PLAN_POLICY` 500、`TEAM_POLICY` 600）之后、工具指引段
 * （`PTC_ONLY` 800 起）之前。GAC 讲的是「这段工作要走多少流程」，属于策略，但又
 * 必须在模型读到工具用法之前就摆在那里。
 */
export const PROMPT_SECTION_ORDER = 700

/**
 * 每一级模式给模型带来的**义务**，用一句陈述句说清。
 *
 * 覆盖是机器强制的：`test/prompt-section.test.js` 拿它对 `EXECUTION_MODES` 逐项核对，
 * 新增一级模式却忘了写义务句时测试会红。这是本仓库踩过的老坑——`MODE_TO_RISK` 曾经
 * 漏了 `read_only`，于是排在最前的那个模式根本声明不了。
 */
export const MODE_OBLIGATIONS = Object.freeze({
  read_only: '这一级别不写入任何东西：不创建任务记录，也没有校验者运行。',
  direct_edit:
    '这一级别不创建任务记录，也没有独立校验者运行：把改动保持在局部，'
    + '并且可以立即验证。',
  standard_task: '预期由一个独立校验者检查结果。',
  high_risk_task:
    '必须在实现之前登记一份由需求推导出的验证计划，'
    + '之后跟随一次独立复核。',
})

/**
 * 渲染段落文本。纯函数：没有 IO，不读时钟，不做判断以外的事。
 *
 * @param {object} [input]
 * @param {object|null} [input.adapter] - 已加载的工程适配器；未纳管时为 `null`。
 * @param {object|null} [input.mode] - 本会话已声明的模式记录（`ProjectState#modeFor`）。
 * @param {object|null} [input.scope] - 本会话已声明的写作用域（`SessionScopeRegistry#get`）。
 * @param {boolean} [input.child] - 这是不是一个**被派遣的子会话**。子会话要的是另一套话：
 *   它的授权由派遣者绑定、不能自报，协调类工具也不在它的工具面里（见下方注释里的实测记录）。
 * @returns {string} 段落文本；未纳管且什么都没声明时为空串。
 */
export function gacPromptText(input = {}) {
  // 默认参数只兜 `undefined`，兜不住 `null`：装配管线之外还有人（测试、探针）直接调它，
  // 而「调用方传了个空值」不该变成一次异常。
  const source = asRecord(input) ?? {}
  const adapter = asRecord(source.adapter)
  const mode = asRecord(source.mode)
  const scope = asRecord(source.scope)

  // 未纳管且无任何声明：这里没有任何 GAC 的事可说，整段消失。
  if (adapter === null && mode === null && scope === null) return ''

  const lines = []

  if (adapter === null) {
    lines.push(
      `GAC 运行时：本会话声明了${mode === null ? '写作用域' : `模式 \`${readString(mode.mode) ?? '未知'}\``}，`
      + `但这个工程没有 GAC 适配器（${ADAPTER_RELATIVE_PATH}），因此该声明没有`
      + '与已声明的高风险路径做过核对。',
    )
  } else {
    lines.push(
      `GAC 运行时：${projectLabel(adapter)} 受 ${ADAPTER_RELATIVE_PATH} 治理。`,
    )
  }

  // **子会话要的是另一套话，而且必须**替换**掉下面那两段，不能追加在后面。** 活体验收实测到的：
  // 被派遣的子会话里也装着这段提示，于是它读到「先用 `gac_project` 声明模式、用 `gac_scope` 声明
  // 路径」——可它的写作用域**已经由派遣者绑定**（不需要也无法自行声明），而那两个工具根本不在它的
  // 工具面里。子会话自己都在推理里记下了这处冲突（「runtime context snapshot says no scope is
  // enforced」）。门禁行为是对的，但这段话在**主动误导**它，并且推荐了它拿不到的工具。
  if (source.child === true) {
    lines.push(
      '**你是被派遣的子会话**：权限在创建时由派遣者定下，不能从会话内部扩大。'
      + '不要去找 `gac_project` / `gac_scope` / `gac_task` / `gac_evidence` / `gac_metrics` 这些'
      + '协调类工具——它们不在你的工具面里，你也不该声明或改写任何授权。',
    )
    if (scope !== null) {
      const bound = Array.isArray(scope.write_scope) ? scope.write_scope : []
      lines.push(
        `本次派遣的写作用域（**由派遣者绑定**，不是你自报的）：[${bound.join(', ')}]。`
        + '越界的写入会在执行前被拒绝；写作用域生效期间 shell 也被整体拒绝，'
        + '请改用结构化的 write/edit 工具。',
      )
    } else {
      lines.push('本会话没有写作用域在强制执行；只读角色的写入工具也不在你的工具面里。')
    }
    return lines.join(' ')
  }

  if (mode === null) {
    if (adapter !== null) {
      lines.push(
        '本会话还没有声明执行模式，因此没有任务记录，也没有任何写作用域在强制执行。'
        + '在改动任何东西之前，先用 gac_project 声明最低的充分模式；在编辑文件之前，'
        + '用 gac_scope 声明这项任务可以修改的确切路径；这两个工具的描述说明了'
        + '每一级别给你带来的义务。',
      )
    }
  } else {
    lines.push(describeMode(mode))
  }

  if (scope !== null) {
    lines.push(describeScope(scope))
  } else if (adapter !== null && mode !== null) {
    lines.push('没有写作用域生效，因此没有任何写入正在被检查。')
  }

  // 这条是本插件发出的号与模型可能引用的号之间的唯一接口：收口门禁只认运行时发过的号，
  // 而模型无从凭空知道有哪些号。它属于「不写下来就只能靠被拒绝才发现」的那一类事实。
  if (adapter !== null) {
    lines.push(
      '证据 id 由运行时签发：在任务报告里引用某个 id 之前，先用 gac_evidence 列出它们——'
      + '运行时从未签发过的 id 会在收口时被拒绝。',
    )
  }

  return lines.join(' ')
}

/**
 * 构造一个可直接交给 `ctx.systemPrompt.section()` 的段落定义。
 *
 * 「永不抛错」与「不插值」这两条性质跟着文本一起放在这里，而不是留给接线处去记得：
 * 少了任何一条，失败面都是整个会话的每一个模型步进。
 *
 * @param {object} deps
 * @param {(sessionId: string) => object|undefined} [deps.modeFor] - 该会话的模式记录。
 * @param {(sessionId: string) => object|undefined} [deps.scopeFor] - 该会话的写作用域。
 * @param {(sessionId: string) => object|undefined} [deps.adapterFor] - 该会话所属工程的适配器。
 * @param {(sessionId: string, agent: object|undefined) => boolean} [deps.childFor] - 这个会话是不是
 *   被派遣的子会话（宿主会话头里有 `parentSession` / `origin: 'subagent'`）。它决定这段话说哪一套：
 *   子会话的授权由派遣者绑定，不能自报。
 * @param {(error: unknown) => void} [deps.onError] - 状态读取失败时的诊断出口，自身出错会被吞掉。
 * @returns {{name: string, order: number, interpolate: boolean, text: (context: object) => string}}
 */
export function createPromptSection({ modeFor, scopeFor, adapterFor, childFor, onError } = {}) {
  const text = (context) => {
    try {
      const sessionId = context?.agent?.session?.id
      // 没有会话就无从查状态：全局装配（不属于任何 agent）时本段落不发声。
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      const rendered = gacPromptText({
        adapter: adapterFor?.(sessionId),
        mode: modeFor?.(sessionId),
        scope: scopeFor?.(sessionId),
        child: childFor?.(sessionId, context?.agent) === true,
      })
      // 装配管线随后会对返回值取 `.length`：返回非字符串与抛错是同一类事故。
      return typeof rendered === 'string' ? rendered : ''
    } catch (error) {
      try {
        onError?.(error)
      } catch {
        // 诊断出口自己出错，也不改变「装配必须拿到一个字符串」这个结果。
      }
      return ''
    }
  }

  return Object.freeze({
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    // 本段文本是生成的：工程路径里出现 `{{` 就会让渲染期抛错，而那是整步失败。
    interpolate: false,
    text,
  })
}

/**
 * 渲染「当前模式」那一行。
 *
 * @param {object} mode
 * @returns {string}
 */
function describeMode(mode) {
  const name = readString(mode.mode) ?? '未知'
  const risk = readString(mode.risk) ?? '未知'
  const reason = readString(mode.reason) ?? '未记录依据'
  const escalatedFrom = readString(mode.escalated_from)
  const parts = [
    `本会话声明的模式：\`${name}\`（风险 ${risk}）`
    + `${escalatedFrom === undefined ? '' : `，从 \`${escalatedFrom}\` 升级而来`}——${reason}。`,
  ]
  const obligation = MODE_OBLIGATIONS[name]
  if (obligation !== undefined) parts.push(obligation)
  if (mode.unchecked === true) {
    parts.push('它被记录下来了，但没有做过交叉核对，因为读不到任何适配器。')
  }
  return parts.join(' ')
}

/**
 * 渲染「当前写作用域」那一行。
 *
 * 三个错误码从 {@link GAC_CODES} 取，不在这里另抄一份：抄一份就等于给「拒绝码」这个
 * 契约开了第二个定义点，而模型据以自我纠正的正是这个码。
 *
 * @param {object} scope
 * @returns {string}
 */
function describeScope(scope) {
  const paths = Array.isArray(scope.write_scope)
    ? scope.write_scope.filter((entry) => typeof entry === 'string')
    : []
  const taskId = readString(scope.task_id) ?? '未知'
  const nodeId = readString(scope.node_id) ?? taskId
  return `任务 \`${taskId}\` 节点 \`${nodeId}\` 的写作用域生效中：`
    + `[${paths.join(', ') || '无'}]。落在它之外的写入、shell 命令，以及本运行时`
    + `无法检查的工具，都会在派发之前被拒绝（${GAC_CODES.WRITE_SCOPE_DENIED} / `
    + `${GAC_CODES.SHELL_DENIED_UNDER_SCOPE} / ${GAC_CODES.UNGUARDABLE_WRITE_DENIED}）；`
    + '这样的拒绝正是这份声明在被强制执行，而不是要绕开的障碍。'
}

/**
 * 工程的自我介绍片段。
 *
 * @param {object} adapter
 * @returns {string}
 */
function projectLabel(adapter) {
  const id = readString(adapter.project?.id)
  return id === undefined ? '这个工程' : `工程 \`${id}\``
}

/**
 * 只接受真正的对象：数组、字符串、数字都不算「有状态」。
 *
 * @param {unknown} value
 * @returns {object|null}
 */
function asRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return /** @type {object} */ (value)
}

/**
 * 只接受非空字符串。
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function readString(value) {
  if (typeof value !== 'string' || value === '') return undefined
  return value
}
