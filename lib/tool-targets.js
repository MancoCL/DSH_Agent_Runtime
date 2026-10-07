/**
 * 哪些工具调用会写入哪些路径。
 *
 * @module dsh-gac-runtime/tool-targets
 *
 * 本模块回答一个问题——「这次工具调用会碰到哪些文件？」——并且它依据的是工具的
 * *已声明参数*，而绝不是它的名字或描述文本。有两个后果是刻意为之的：
 *
 *  1. 分类是一张封闭的表，外加一个显式的未知情形。这张表不认识的工具**不会**被
 *     假定为安全。扩宽运行时绝不能悄悄扩宽它的权限（架构大纲 §20、§22），因此
 *     无法识别的工具会被报告为 `unknown`，由调用方决定。
 *
 *  2. shell 执行器（`pwsh`、`bash`）被归类为 `shell`，而不是 `write`，并且不产出
 *     任何路径。这是对适配计划 §7 所确立的 DSH 边界的如实陈述：工具管道上的守卫
 *     看不到埋在命令字符串里的重定向目标。把它们报告为「无目标」而不是凭空发明
 *     一套解析，就会让本模块声称一个它无法提供的保证。
 *
 * 对 `shell` 和 `unknown`，调用方绝不能把空的目标列表当作无害的证明；见
 * `classifyCall`，它把结论命名出来，这样下游读者就不必从一个空数组去推断。
 */

/**
 * 会修改文件的工具，映射到承载路径的参数名。
 *
 * 只要某个工具族的任一拼写为人所知，`file_path` 和 `path` 就会都被列出。列出一个
 * 给定工具并不使用的名字毫无代价（该参数只是不存在而已）；漏掉一个却会丢失对该
 * 工具的强制执行，而那才是代价高昂的方向。
 */
const WRITE_TOOLS = Object.freeze({
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace: ['file_path', 'path'],
  apply_patch: ['file_path', 'path'],
  create_file: ['file_path', 'path'],
  delete_file: ['file_path', 'path'],
  move_file: ['file_path', 'path', 'destination', 'to'],
})

/**
 * 不碰任何文件的工具，列出来是为了让未知情形仍然有意义。
 *
 * `gac_scope` 属于这里，而它当初的缺席是一个真实的缺陷：一个无法被检视或释放的
 * 作用域是个陷阱，而守卫偏偏拒绝了那个能够释放它的工具。它只会改动内存中的注册表，
 * 因此没有任何文件系统影响需要管束。
 *
 * 任何加进这里的工具都在断言「它不能写入」，这比「它是只读的」这个说法更强——
 * 一个能修改文件的工具绝不能被列进来，不管它的名字看起来多无害。
 */
const READ_TOOLS = Object.freeze([
  'read',
  'glob',
  'grep',
  'read_image',
  'list_dir',
  'search',
  'web_fetch',
  'web_search',
  'ask_user_question',
  'todo_write',
  'list_agents',
  'job_list',
  'job_output',
  // GAC 自己的两个**只读**出口：证据列表与指标。它们只读盘上的日志与任务记录，
  // 因此既能被门禁放行，也能留给一个被收权的执行者。
  'gac_evidence',
  'gac_metrics',
])

/**
 * 运行时平面的工具：它们可以写盘，但写的**不是产品文件**——是运行时/宿主自己的记账。
 *
 * `gac_*` 三个确实会写 `.dsh/gac/` 下的任务记录、占用声明与证据日志；把 `gac_task` 归进 `unknown`
 * 曾经是一个真实的陷阱：写作用域一生效，**推进任务的那个工具就被自己的门禁拒了**，与 `gac_scope`
 * 当初踩的是同一个坑。归进 `write` 同样不对：任务记录几乎不会落在工程声明的写范围里，于是照样被拒。
 *
 * `structured_output` 与 `todo_write` 是**活体验收抓到的第二个同类坑**（2026-10-05，子会话写作用域
 * 绑定上线当天）：给写文件的子会话绑上作用域之后，它的**回报通道本身**被拒了——
 *
 *   GAC_UNGUARDABLE_WRITE_DENIED: "structured_output" 不是本运行时知道如何对照写作用域检查的工具
 *
 * 于是子会话把两件事都做对了（边界内写入成功、越界写入被拒），却因为回报不上去而被判 `failed`。
 * 两者都碰不到产品文件：`structured_output` 是子会话把结论交回父会话的通道，`todo_write` 写的是
 * 会话自己的待办。**「失败即拒」这条规则本身是对的**（它挡住的是未知的写工具），代价是每一个子
 * 会话要用的非写入类工具都必须被显式归类——这一条以前没人做过，因为以前没有工具在作用域下跑过。
 *
 * 调用方按**用途**决定怎么对待这一类：门禁放行（运行时自己的账本与回报通道不能被它自己执行的
 * 作用域挡在外面），而「只读执行者」也放行（一个验证者要能汇报结论、要能记自己的待办；它不该做的
 * 是推进任务、声明模式或占用路径——那几样由角色那一层的名单另行决定）。
 */
const RUNTIME_TOOLS = Object.freeze([
  'gac_project',
  'gac_scope',
  'gac_task',
  'structured_output',
  'todo_write',
])

/** 执行命令字符串、因而能隐形写入的工具。 */
const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'shell', 'run_terminal'])

/**
 * PTC（programmatic tool calling）的传输工具：`run_code`。
 *
 * 内核把它的名字导出为 `RUN_CODE_NAME`（实测取值就是 `"run_code"`，`dsh-tools/lib/index.js:898`）。
 * 本模块**不**从 `@deepseek-ai/dsh-tools` 静态导入那个常量：`lib/` 里的模块不能在模块作用域裸
 * 导入 `@deepseek-ai/*`（`test/entry.test.js` 会红），而在函数内导入又会让这张纯函数表依赖运行时。
 * 代价写清楚：内核若改名，这里认不出来，`run_code` 会退回 `unknown`——在作用域生效时被拒绝，
 * 也就是**失败即拒绝**这个安全方向，而不是悄悄放行。
 *
 * 为什么它单独一类：**外层传输自己不碰文件，动手的是它派发的内层子调用**。内核保证每一次内层
 * 子调用都会各自走到 `tools/pre-execute`（`dsh-tools` 的 `ToolExecution.parent` 注释：「every
 * started PTC inner call is reviewed once before its body」；子调用带 `parent` 令牌，模型直呼的
 * 原生工具名在内核那一层就已经被判为 `UNKNOWN_TOOL`）。因此正确的做法是放行外层、按名字守卫内层，
 * 而不是去解析 `run_code` 的参数里的代码文本——解析代码文本是在猜，而子调用是现成的结构化事实。
 */
const PTC_TRANSPORT_TOOLS = Object.freeze(['run_code'])

/** 一次已分类调用可能携带的结论。 */
export const CALL_KINDS = Object.freeze({
  WRITE: 'write',
  READ: 'read',
  SHELL: 'shell',
  RUNTIME: 'runtime',
  PTC: 'ptc',
  UNKNOWN: 'unknown',
})

/**
 * 把一个已声明参数强制转换为路径字符串。
 *
 * 非字符串会被丢弃而不是字符串化：对对象做 `${value}` 会得到 "[object Object]"，
 * 它随后会被规范化并当作一个路径来比较——这是一个悄悄错误的答案，而不是一处
 * 可见的缺口。
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function asPath(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 从一次工具调用中提取每一个路径参数。
 *
 * @param {string} name - 注册表所知道的工具名。
 * @param {unknown} args - 已解析的参数对象。
 * @returns {string[]} 已声明的路径，按参数声明顺序。
 */
function extractPaths(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const keys = WRITE_TOOLS[name]
  if (keys === undefined) return []
  const found = []
  for (const key of keys) {
    const value = asPath(args[key])
    if (value !== undefined && !found.includes(value)) found.push(value)
  }
  return found
}

/**
 * 对一次工具调用进行分类。
 *
 * @param {string} name - 工具名。
 * @param {unknown} args - 已解析的参数。
 * @param {object} [options]
 * @param {boolean} [options.nested] - 这次调用是不是 PTC 传输派发的**内层子调用**（内核在
 *   `exec.parent` 上给出令牌）。内层调用按自己的名字分类；只有外层传输才是 `ptc`。
 * @returns {{
 *   kind: string,
 *   name: string,
 *   paths: readonly string[],
 *   guarded: boolean,
 *   reason?: string
 * }}
 *   `guarded` 说明写作用域检查是否能有意义地施加：只有 `write` 调用携带守卫
 *   可以检视的路径。`shell` 与 `unknown` 被显式标记为不受守卫，调用方应当把这一
 *   缺口暴露出来，而不是把它掩盖过去。
 */
export function classifyCall(name, args, options = {}) {
  const toolName = typeof name === 'string' ? name : ''

  if (PTC_TRANSPORT_TOOLS.includes(toolName)) {
    if (options.nested === true) {
      // 传输派发传输：内层子调用的名字应当是它真正要用的工具。真出现这种调用，说明我对内核
      // 的理解有偏差，那就按未知处理（失败即拒绝），而不是把它当成外层传输放过去。
      return {
        kind: CALL_KINDS.UNKNOWN,
        name: toolName,
        paths: [],
        guarded: false,
        reason: `"${toolName}" 出现在一次 PTC 子调用里；传输不该由传输派发，因此按未知处理`,
      }
    }
    return {
      kind: CALL_KINDS.PTC,
      name: toolName,
      paths: [],
      guarded: false,
      reason: `"${toolName}" 是 PTC 的传输工具：它自己不写文件，派发出的内层子调用会各自`
        + '到达守卫并按自己的名字受管',
    }
  }

  if (WRITE_TOOLS[toolName] !== undefined) {
    const paths = extractPaths(toolName, args)
    if (paths.length === 0) {
      // 一个已知的写工具却没有可用的路径参数。如果上游某层重命名了字段，这个
      // 分支就会走到；把它当作无害，恰恰是本模块存在所要防止的那种悄悄扩宽失败。
      return {
        kind: CALL_KINDS.WRITE,
        name: toolName,
        paths: [],
        guarded: false,
        reason: `工具 "${toolName}" 是一个写工具，但没有携带可读的路径参数`,
      }
    }
    return { kind: CALL_KINDS.WRITE, name: toolName, paths, guarded: true }
  }

  if (SHELL_TOOLS.includes(toolName)) {
    return {
      kind: CALL_KINDS.SHELL,
      name: toolName,
      paths: [],
      guarded: false,
      reason:
        `工具 "${toolName}" 执行的是命令字符串；它内部的重定向或生成目标`
        + '对工具管道上的守卫不可见',
    }
  }

  if (RUNTIME_TOOLS.includes(toolName)) {
    return { kind: CALL_KINDS.RUNTIME, name: toolName, paths: [], guarded: false }
  }

  if (READ_TOOLS.includes(toolName)) {
    return { kind: CALL_KINDS.READ, name: toolName, paths: [], guarded: false }
  }

  return {
    kind: CALL_KINDS.UNKNOWN,
    name: toolName,
    paths: [],
    guarded: false,
    reason: `工具 "${toolName}" 不在已知表中，因此它的写入行为未知`,
  }
}

/**
 * 从一个执行者当前可见的工具里挑出**该被收权收掉**的那些。
 *
 * 它走的是与门禁**同一张表**，因此收权不会与门禁漂移：门禁认得的写入面，收权就收得掉。
 * 方向是失败即收回——表里没有的工具一律算可疑，所以运行时升级带来的新工具不会悄悄落进
 * 一个只读执行者的手里。
 *
 * 四条刻意的取舍，每一条都有理由：
 *
 *  1. **运行时自己的工具留着。** `gac_task`、`gac_scope`、`gac_project` 被收掉的话，一个只读
 *     角色就再也**回报不了结果、也清不掉自己的作用域**——那是把角色变成陷阱，与 `gac_scope`
 *     当初被自己的门禁拒掉是同一个形状（见上面 RUNTIME_TOOLS 的注释）。只读的意思是「不写产品
 *     文件」，不是「不能说话」。
 *  2. **`shell` 默认留着。** 验证者要逐条执行计划用例才能留下证据（适配计划 §4.4 阶段 3），而
 *     执行用例靠的就是 shell。把 shell 也收掉会让「每条用例都要有独立证据」的收口门禁永远过不
 *     去——那是拿掉验证者的能力，不是收窄它的权限。项目可以在适配器里声明连 shell 一起收回
 *     （`execution.revoke_shell_for_read_only_roles`），那时越界的 shell 写入只剩事后观测。
 *  3. **PTC 传输收掉。** 它自己不写文件，但它能派发写入的内层子调用；留着它等于给只读角色留了
 *     一条通往写入面的通道。
 *  4. **未知工具收掉。** 与门禁对 `unknown` 的处置同一条推理，只是后果不同：门禁拒绝一次调用，
 *     收权少给一个工具。代价是只读角色也会丢掉一些无害的新工具（例如委派类），而那正是想要的
 *     方向——一个只读角色不该能再委派一个不受限的子 Agent。
 *
 * @param {readonly unknown[]} names - 某个作用域当前可见的工具名。
 * @param {object} [options]
 * @param {boolean} [options.includeShell] - 连 shell 一起收回，缺省不收。
 * @returns {string[]} 应当收回的工具名，按输入顺序。
 */
export function roleRevokedToolNames(names, options = {}) {
  if (!Array.isArray(names)) return []
  const includeShell = options.includeShell === true
  const found = []
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue
    const { kind } = classifyCall(name, {})
    if (kind === CALL_KINDS.READ) continue
    if (kind === CALL_KINDS.RUNTIME) continue
    if (kind === CALL_KINDS.SHELL && !includeShell) continue
    found.push(name)
  }
  return found
}

/**
 * 本模块所识别的工具名，供测试和诊断视图使用。
 *
 * @returns {{write: readonly string[], read: readonly string[], shell: readonly string[], runtime: readonly string[], ptc: readonly string[]}}
 */
export function knownTools() {
  return {
    write: Object.keys(WRITE_TOOLS),
    read: [...READ_TOOLS],
    shell: [...SHELL_TOOLS],
    runtime: [...RUNTIME_TOOLS],
    ptc: [...PTC_TRANSPORT_TOOLS],
  }
}
