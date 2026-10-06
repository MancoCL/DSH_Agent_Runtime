/**
 * 工作区差异观测：把「这一轮到底改了哪些文件」变成一条可核对的证据。
 *
 * @module dsh-gac-runtime/workspace-witness
 *
 * 为什么需要它（适配计划 §3.3、§7 边界 6）
 * --------------------------------------
 * 证据层在此之前只记工具调用：哪个工具、什么参数、退出码几。那是**意图**层面的记录，而
 * 「实际改动了什么」是另一件事。两者会在最要紧的地方分叉——一条 `pwsh` 命令里可以藏着
 * 重定向目标，一次代码生成器可以写出没人声明过的文件，而工具调用本身的参数里看不出这些。
 * 原 Python 运行时有一个 `witness.py` 专门做这件事（git 增量比对、写范围归属、文件数上限），
 * 适配计划判定它整体退役，改由宿主的现成观测源替代。本模块就是那个替代品。
 *
 * 三条性质是结构性的
 * ----------------
 *  1. **观测，不是阻断。** 本模块只产出事实与归属判定，绝不参与任何工具调用的放行或拒绝。
 *     越界发现走「证据 + 报告 + 指标」三个出口——一条越界改动已经发生，此时拒绝那次调用
 *     既拦不住它，还会把「事后可查」变成「事后不可查」。
 *  2. **未受治理时不产出越界结论。** 没有声明写作用域的会话里，每一个改动都「不在任何作用域
 *     内」。照此报告，每一轮都会产出一堆越界——那不是发现，那是噪声，而噪声会让真正的越界
 *     被淹掉。所以未受治理时三个列表全空，只如实记下这一轮列了多少、总共多少。
 *  3. **包含判定只有一份实现。** 复用 `lib/write-scope.js` 的 `createWriteScope`，否则
 *     「`src/*.c` 覆盖不覆盖 `src/deep/a.c`」会在这里与门禁给出两个答案，而门禁那个答案才是
 *     权限边界。第二份实现迟早漂移，漂移的那一份会以「观测说越界了、门禁说没越界」的形式
 *     出现，那比没有观测更难查。
 *
 * 覆盖不完整必须说出来
 * ------------------
 * 宿主按 `maxFiles` 截断时，摘要里只有「列出的」那几条。`truncated = total > listed` 是这种
 * 截断在数据上的**唯一**痕迹，因此它必须一路带到证据里：一份被截断的摘要如果被当成完整
 * 观测来读，「这一轮没有越界」这句话就不再成立——它只是「列出来的那些没有越界」。
 *
 * 实测边界（本机 core-020 profile）
 * ------------------------------
 * `workspaceChanges` 服务由 `@deepseek-ai/dsh-workspace-changes` 提供，而该包**不在本机
 * profile 的 bundles 里**：事件类型 `workspace/changes` 是已知类型（`dsh-session` 声明了它），
 * 但没有任何东西会追加它。因此这一层在当前 profile 下是**惰性**的——它照常加载、照常订阅，
 * 只是没有事件到达。`lib/index.js` 用 `ctx.inject` 降级，缺失时插件照常加载。
 *
 * 契约核实（2026-10-06，对着真包的类型声明逐字段比对，`dsh-workspace-changes@0.2.0-rc.2`）
 * ---------------------------------------------------------------------------------
 * 本模块假设的服务与摘要形状**不是猜的**，是拿桌面安装里那份包声明核过的（包解析不到，
 * 但类型声明在盘上）：
 *
 *  - 服务接口 `WorkspaceChanges.summary(sessionId, seq)`——**两个参数**。包里另有一个
 *    单参数的 `summary(seq)`，那是**内部 recorder**，不是服务；只按它写会取不到摘要，
 *    于是 witness 证据永远不落，而假件测试因为跟着错的签名写，测不出来。
 *  - `WorkspaceChangesSummary = { turn, cwd, files, total, added, deleted, snapshot? }`。
 *  - `WorkspaceChangedFile = { path, display, added, deleted, binary?: true, oversized?: true }`
 *    ——`binary` / `oversized` 是**可选的真值标记**，不是 `kind` 判别联合（后者是
 *    `WorkspaceFileDiff` 的形状，容易看串）。
 *
 * 这三条与 `compileWitnessSummary` 逐字段一致，因此「真包接上之后这一层能不能读懂」不再依赖运气。
 * 仍然**未做**的是真机活体：那需要把提供者插件装进 profile（见 ADR §17 的代价与步骤）。
 */

import { WORKSPACE_SOURCE, digest } from './evidence.js'
import { isAbsolutePath, relativize } from './path-utils.js'
import { createWriteScope, normalizePath } from './write-scope.js'

/**
 * 工作区观测的来源标识。
 *
 * 它同时是证据记录里的 `tool` 字段与 `source` 字段的取值。取值本身定义在
 * `lib/evidence.js`——那里是校验 `source` 闭集的地方，本模块只是把它按契约规定的名字
 * 再导出一次。定义两份字符串会漂移，而漂移的后果是工作区观测在指标与渲染里被当成一次
 * 普通工具调用。
 */
export const WITNESS_SOURCE = WORKSPACE_SOURCE

/** 结构化错误码。 */
export const WITNESS_CODES = Object.freeze({
  MALFORMED: 'GAC_WITNESS_MALFORMED',
})

/**
 * 结构化观测错误。
 *
 * 与其它模块同一形状：`name`、`code`、`detail` 三个字段，便于调用方按码分支，而不必去匹配
 * 一句随时可能被改写的提示文本。
 */
export class WitnessError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [detail]
   */
  constructor(message, code, detail = {}) {
    super(message)
    this.name = 'WitnessError'
    this.code = code
    this.detail = detail
  }
}

/** 上溯先代会话时默认最多走几步。 */
export const DEFAULT_MAX_HOPS = 8

/**
 * 一个有限的数字，否则退回缺省值。
 *
 * 用它而不是 `Number(value)`：后者会把 `null` 变成 0、把 `'3'` 变成 3，于是「宿主没给这个
 * 数」与「宿主给了 0」在两份不同的摘要上得到同一个读数。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 往列表里放一个还没出现过的值，保持原顺序。
 *
 * @param {string[]} list
 * @param {string} value
 * @returns {void}
 */
function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value)
}

/**
 * 把宿主给出的一份 turn 变更摘要折成可直接比较的记录。
 *
 * 折的动作本身就是容错策略：宿主给的字段可能缺、可能类型不对，而**缺失与零是两件事**。
 * 这里只做「能读出来就用，读不出来就退回一个不会误导的缺省值」，判断留给调用方——把容错
 * 与判断混在一起，会让「这一轮真的什么都没改」与「这份摘要读不动」看起来一样。
 *
 * @param {unknown} summary - `workspaceChanges.summary(sessionId, seq)` 的产出。
 * @returns {Readonly<object>} `{turn, cwd, listed, total, truncated, added, deleted, files}`。
 * @throws {WitnessError} 摘要不是对象，或 `files` 不是数组时。
 */
export function compileWitnessSummary(summary) {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new WitnessError(
      `工作区变更摘要必须是一个对象，收到的是 ${Array.isArray(summary) ? '数组' : typeof summary}`,
      WITNESS_CODES.MALFORMED,
    )
  }
  if (!Array.isArray(summary.files)) {
    throw new WitnessError(
      '工作区变更摘要必须带一个 files 数组；把读不动的摘要当成「这一轮什么都没改」，'
      + '恰好是会放过越界改动的那个方向',
      WITNESS_CODES.MALFORMED,
    )
  }

  const files = summary.files.map((entry) => {
    const raw = entry !== null && typeof entry === 'object' ? entry : {}
    const path = typeof raw.path === 'string' ? raw.path : ''
    return Object.freeze({
      path,
      // display 只是给人看的排序标签；缺失时退回 path，好过留一个空标签。
      display: typeof raw.display === 'string' ? raw.display : path,
      added: finiteOr(raw.added, 0),
      deleted: finiteOr(raw.deleted, 0),
      // 一个文件同时是二进制与超限时，超限优先：它才是「为什么没有行数」的原因。
      kind: raw.oversized === true ? 'oversized' : raw.binary === true ? 'binary' : 'text',
    })
  })

  const listed = files.length
  const total = finiteOr(summary.total, listed)
  return Object.freeze({
    turn: finiteOr(summary.turn, 0),
    cwd: typeof summary.cwd === 'string' ? summary.cwd : '',
    files: Object.freeze(files),
    listed,
    total,
    // 宿主按 maxFiles 截断过的唯一痕迹。见模块头「覆盖不完整必须说出来」。
    truncated: total > listed,
    added: finiteOr(summary.added, files.reduce((sum, file) => sum + file.added, 0)),
    deleted: finiteOr(summary.deleted, files.reduce((sum, file) => sum + file.deleted, 0)),
  })
}

/**
 * 调一个回调，把「没给」「抛错」与「返回非法值」一律折叠成「没有」。
 *
 * 这段代码跑在会话事件的发布路径上：一个读不出来的会话头绝不能变成一次工具调用失败，更不能
 * 变成一个抛到发布链上的异常。
 *
 * @param {unknown} callback
 * @param {string} id
 * @returns {unknown}
 */
function callSafely(callback, id) {
  if (typeof callback !== 'function') return undefined
  try {
    return callback(id)
  } catch {
    return undefined
  }
}

/**
 * 读摘要最多试几次。
 *
 * 生产者（`dsh-workspace-changes`）的摘要在 `session.append("workspace/changes", …)` **返回之后**
 * 才存进它的记录表，而 `Session.append` 会**同步**发布 `session/event`——也就是说订阅者正跑在
 * 「事件已存在、摘要还没存」的那一瞬间。所以读摘要要等它几步。
 */
export const SUMMARY_READ_STEPS = 4

/**
 * 让出一步。用宏任务而不是微任务：生产者存摘要的那几行是同步的，微任务同样排在它们之后，但宏任务
 * 对「中间还有没有 await」更不敏感。
 */
function yieldTick() {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * 等生产者的摘要就绪，然后读它。
 *
 * 为什么要等（这是实测出来的，不是推理）：本插件的 `session/event` 处理函数跑在
 * `Session.append` 的发布路径上，而生产者是这样写的——
 *
 * ```text
 * const event = this.session.append("workspace/changes", { turn });  // ← 同步发布本事件
 * this.records.set(event.seq, { summary: {…} });                     // ← 摘要在这之后才存
 * ```
 *
 * 于是**每一次**同步读到的都是空。真实事故：会话日志里 seq 8560 的 `workspace/changes` 确实存在，
 * 而加载报告对**同一个 seq** 记的是 `witness-summary-missing`——不是没有变更，是读得太早。
 *
 * 为什么是**有界**等待而不是无限等：读不到就是读不到，那必须如实记成 `witness-summary-missing`，
 * 既不能假装成功，也不能把会话的事件发布卡住。`read` 抛错按「还没就绪」处理——观测是旁观行为，
 * 它出问题时不该让会话的事件发布跟着失败。
 *
 * @param {object} options
 * @param {() => unknown} options.read - 读一次摘要；返回 `undefined` 表示还没就绪。
 * @param {number} [options.steps] - 最多试几次，缺省 {@link SUMMARY_READ_STEPS}。
 * @param {() => Promise<void>} [options.defer] - 让出一步；注入以便测试。
 * @returns {Promise<{summary: unknown, attempts: number}|undefined>} 读不到时为 `undefined`。
 */
export async function readWitnessSummary({ read, steps = SUMMARY_READ_STEPS, defer = yieldTick } = {}) {
  for (let attempt = 0; attempt < steps; attempt += 1) {
    let summary
    try {
      summary = typeof read === 'function' ? read() : undefined
    } catch {
      summary = undefined
    }
    if (summary !== undefined) return { summary, attempts: attempt }
    if (attempt + 1 < steps) await defer()
  }
  return undefined
}

/**
 * 从某个会话出发，找出「谁在治理这次改动」。
 *
 * 为什么要上溯：写作用域声明保存在**会话**的内存注册表里，而子会话（子 Agent）对同一个工程
 * 的改动属于同一次任务。子会话自己没有声明时，若不上溯，它产出的每一次变更都会被算成未受
 * 治理，越界也就无从发现。
 *
 * 借用是有边界的：这里只在**判定时**读先代的声明，绝不给子会话施加父作用域，也绝不改动任何
 * 注册表。判定与授权是两件事，把它们合成一件事，会让一次观测变成一次授权。
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @param {(sessionId: string) => unknown} [options.headerFor] - 给出会话头（含 `parentSession`）。
 * @param {(sessionId: string) => unknown} [options.scopeFor] - 给出该会话已声明的写作用域。
 * @param {number} [options.maxHops] - 最多上溯几步，缺省 {@link DEFAULT_MAX_HOPS}。
 * @returns {Readonly<{session_id: string, hops: number, scope: object|undefined}>}
 */
export function resolveGoverningSession(sessionId, options = {}) {
  const start = typeof sessionId === 'string' ? sessionId : ''
  const maxHops = Number.isInteger(options.maxHops) && options.maxHops >= 0
    ? options.maxHops
    : DEFAULT_MAX_HOPS
  const visited = new Set()
  let current = start
  let hops = 0

  while (current !== '' && !visited.has(current)) {
    visited.add(current)
    const scope = callSafely(options.scopeFor, current)
    if (scope !== null && typeof scope === 'object' && !Array.isArray(scope)) {
      return Object.freeze({ session_id: current, hops, scope })
    }
    if (hops >= maxHops) break
    const header = callSafely(options.headerFor, current)
    const parent = header !== null && typeof header === 'object' ? header.parentSession : undefined
    // 先看再走：环形的先代链必须在这里停住，而不是靠 `visited` 在下一圈兜住——那会让
    // 「实际上溯了几步」在环形链上虚高一格。
    if (typeof parent !== 'string' || parent === '' || visited.has(parent)) break
    current = parent
    hops += 1
  }

  return Object.freeze({ session_id: start, hops, scope: undefined })
}

/**
 * 把一个文件路径折算成可以对照写作用域比较的形式。
 *
 * 宿主给出的 `path` 有两种形态：相对会话工作目录，或者（在工程之外的改动）一个绝对路径。
 * 因此先把它变成绝对路径，再相对工程根折算；折算不出来，就是落在工程之外。
 *
 * @param {string} path
 * @param {string|undefined} cwd - 会话工作目录，绝对路径。
 * @param {string|undefined} root - 工程根，绝对路径。
 * @returns {{comparable: string, outside_project: boolean}}
 */
function locatePath(path, cwd, root) {
  const absolute = isAbsolutePath(path)
    ? normalizePath(path)
    : cwd === undefined ? normalizePath(path) : normalizePath(`${cwd}/${path}`)
  if (root === undefined) return { comparable: absolute, outside_project: false }
  const comparable = relativize(absolute, root)
  // 折算不动的意思是这个路径不在工程根之下——那就是「工程之外」，而不是一个叫
  // `C:/...` 的工程相对路径。
  return { comparable, outside_project: isAbsolutePath(comparable) }
}

/**
 * 把一份变更集按已声明的写作用域分到三个列表里。
 *
 * 三个列表的关系是**包含**而不是并列：`outside_project` 是 `out_of_scope` 的子集标记。在工程
 * 之外的改动必然不在已声明的写作用域内，但它值得单独指出——那已经越出了工程边界，而不只是
 * 越出了一次任务的范围。
 *
 * @param {Readonly<object>} compiled - {@link compileWitnessSummary} 的结果。
 * @param {object} [options]
 * @param {readonly string[]} [options.scope] - 已声明的写作用域条目。
 * @param {string} [options.root] - 工程根；缺失时不产出 `outside_project` 结论。
 * @param {string} [options.cwd] - 会话工作目录；缺失或不是绝对路径时按工程根处理。
 * @returns {Readonly<object>}
 */
export function classifyWitnessChanges(compiled, options = {}) {
  const declared = Array.isArray(options.scope)
    ? options.scope.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : []
  const root = typeof options.root === 'string' && options.root.trim() !== ''
    ? options.root
    : undefined
  const cwd = isAbsolutePath(options.cwd) ? options.cwd : undefined
  const files = Array.isArray(compiled?.files) ? compiled.files : []
  const coverage = compiled?.truncated === true ? 'partial' : 'complete'
  const listed = finiteOr(compiled?.listed, files.length)
  const total = finiteOr(compiled?.total, listed)

  // 未受治理：三个列表全空。这里不做「每个改动都不在作用域内」的推论——见模块头第 2 点。
  if (declared.length === 0) {
    return Object.freeze({
      governed: false,
      scope: Object.freeze([]),
      in_scope: Object.freeze([]),
      out_of_scope: Object.freeze([]),
      outside_project: Object.freeze([]),
      coverage,
      listed,
      total,
    })
  }

  // 包含判定复用安全边界那一份实现；没有工程根时不做前缀折算，交给它按相对路径比较。
  const matcher = createWriteScope(declared, root === undefined ? {} : { rootPrefix: root })
  const inScope = []
  const outOfScope = []
  const outside = []

  for (const file of files) {
    if (file.path === '') {
      // 宿主没给出可用的路径：不可归属的改动**绝不**被声称落在作用域内，但它也不至于被说成
      // 在工程之外——那两句话都超出了手头的事实。
      pushUnique(outOfScope, '')
      continue
    }
    const { comparable, outside_project: outsideProject } = locatePath(file.path, cwd, root)
    if (outsideProject) pushUnique(outside, comparable)
    if (matcher.allows(comparable)) pushUnique(inScope, comparable)
    else pushUnique(outOfScope, comparable)
  }

  return Object.freeze({
    governed: true,
    scope: Object.freeze([...declared]),
    in_scope: Object.freeze(inScope),
    out_of_scope: Object.freeze(outOfScope),
    outside_project: Object.freeze(outside),
    coverage,
    listed,
    total,
  })
}

/**
 * 把判定结果压成扁平、可长期留存的字段。
 *
 * 为什么不直接存判定结果：证据要能长期留存，而三个完整列表会随工程规模增长。这里只留计数、
 * 越界的**路径清单**（那正是要事后复核的东西）与一个文件摘要——摘要让「两次观测是不是同一
 * 份产出」可比对，而不必把整份摘要复制进日志。
 *
 * @param {Readonly<object>} classification - {@link classifyWitnessChanges} 的结果。
 * @param {Readonly<object>} compiled - {@link compileWitnessSummary} 的结果。
 * @returns {Readonly<object>}
 */
export function witnessFacts(classification, compiled, identity = {}) {
  const files = Array.isArray(compiled?.files) ? compiled.files : []
  const facts = {
    turn: finiteOr(compiled?.turn, 0),
    listed: finiteOr(compiled?.listed, files.length),
    total: finiteOr(compiled?.total, files.length),
    truncated: classification.coverage === 'partial',
    coverage: classification.coverage,
    // 清单而不只是计数：收口门禁要核对的是「哪些文件被判在范围内」，只有计数时那份判断无法复核。
    in_scope: Object.freeze([...classification.in_scope]),
    in_scope_count: classification.in_scope.length,
    // 副本而不是原数组：共享会让后来的一次改动同时改到「判定结果」与「已落盘的证据」，
    // 而证据的含义是「当时观察到的事实」。
    out_of_scope: Object.freeze([...classification.out_of_scope]),
    outside_project: Object.freeze([...classification.outside_project]),
    files_digest: digest(JSON.stringify(
      files.map((file) => [file.display, file.added, file.deleted, file.kind]),
    )),
  }
  // 身份字段**只在有的时候出现**：工作区载荷的键是闭集，写一个 `undefined` 会被编译器拒掉，
  // 而「没有治理会话」是真实情形（未受治理的改动），不该被记成一个空字符串。
  if (typeof identity.governing_session_id === 'string' && identity.governing_session_id !== '') {
    facts.governing_session_id = identity.governing_session_id
  }
  if (typeof identity.task_id === 'string' && identity.task_id !== '') facts.task_id = identity.task_id
  if (typeof identity.node_id === 'string' && identity.node_id !== '') facts.node_id = identity.node_id
  return Object.freeze(facts)
}

/**
 * 把「判定 + 事实 + 要写进加载报告的那几条」收在一处。
 *
 * 单独抽出来是为了让 `lib/index.js` 只做连接（读服务、落证据、写报告），而不含判断。本仓库
 * 吃过「决定散在宿主形状里」的亏：那种代码只能在活的 harness 里验，而它恰恰是最不该带着
 * 未验证判断上线的地方。抽成纯函数之后，报告出口本身也有测试。
 *
 * @param {Readonly<object>} compiled - {@link compileWitnessSummary} 的结果。
 * @param {object} [options] - 同 {@link classifyWitnessChanges}，另加身份字段。
 * @param {string} [options.governingSessionId] - 谁在治理这次改动（子会话借先代作用域时尤其重要）。
 * @param {string} [options.taskId] - 这次改动属于哪个任务。
 * @param {string} [options.nodeId] - 属于哪个节点。
 * @returns {Readonly<{classification: object, facts: object, reports: object[]}>}
 */
export function composeWitnessRecord(compiled, options = {}) {
  const classification = classifyWitnessChanges(compiled, options)
  const facts = witnessFacts(classification, compiled, {
    governing_session_id: options.governingSessionId,
    task_id: options.taskId,
    node_id: options.nodeId,
  })
  const reports = [{
    event: 'witness-turn',
    turn: facts.turn,
    listed: facts.listed,
    total: facts.total,
    coverage: facts.coverage,
    out_of_scope: facts.out_of_scope.length,
    outside_project: facts.outside_project.length,
  }]
  if (facts.out_of_scope.length > 0) {
    reports.push({
      event: 'witness-out-of-scope',
      turn: facts.turn,
      files: facts.out_of_scope.length,
      outside_project: facts.outside_project.length,
    })
  }
  return Object.freeze({
    classification,
    facts,
    reports: Object.freeze(reports.map((entry) => Object.freeze(entry))),
  })
}
