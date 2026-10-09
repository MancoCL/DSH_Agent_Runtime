/**
 * `gac_task` 的**拆分判据**测试。
 *
 * 本套件只测 `create` 路径上的两条判据，它们与这个仓库里其它门禁有一个根本区别：
 *
 *  - 已有的门禁（契约、设计、计划、证据、复核）都是**拒绝**：命中就停下，任务推不动。
 *  - 拆分判据是**提示**：命中照样建任务，只是把「你这个拆法可能不对」说出来。
 *
 * 为什么提示也要有测试
 * --------------------
 * 提示的性质决定了它最容易被写成两件坏事之一：
 *
 *  1. **从不触发**——字段永远是空的，读的人以为自己的拆分没问题，而实际上没有任何东西在看。
 *     这类缺陷不会让任何一条已有用例变红，因此只能靠「命中时要说什么」的用例钉住。
 *  2. **误伤合法的大任务**——一个真需要十个模块的任务被劝去合并，而合并的代价是并行度与被
 *     隔离的写范围一起丢掉。契约里明确写了「不得为合法大任务设武断的节点数上限」，所以
 *     **足够小 / 已经拆得很干净的任务必须一个字都不提示**，这是本套件里最关键的一条反例方向。
 *
 * 因此本套件两个方向都测：该说的必须说清（并且要指名到节点、给出该怎么改），
 * 不该说的一个字都不许多说。
 *
 * 判据的输入是**已经编译好的任务**：节点数、每个节点的写范围，以及任务上登记的验收标准
 * 与每个节点声明覆盖了哪几条。所以测试通过 `create` 的返回读它——那是模型唯一看得见的地方。
 *
 * 为什么断言写在「返回里的文本」而不是某个字段名上
 * ------------------------------------------------
 * 提示字段的确切名字由实现决定，而 `gac_task` 的输出 schema 是 `additionalProperties: false`：
 * 一个没被声明的字段会让**整条返回**被输出校验拒掉，而单测因为用了透传的 `defineTool` 照样全绿
 * （`plan_id` 那一段注释记着这个坑，同样的形状已经翻版三次）。所以本套件先断言行为
 * （该说的说了、不该说的没说），再单独用一条用例把「返回的每个字段都得在 schema 里声明过」
 * 钉住——绑死字段名会让这条判据的实现细节变成测试的负担，而漏掉那条 schema 断言会让缺陷
 * 只在活体上出现。
 *
 * `defineTool` 用恒等替身：本套件测的是工具自身行为，运行时那套参数校验另有专门测试。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { TaskStore } from '../lib/task-store.js'
import { BUILDER_CODES } from '../lib/builder-scope.js'
import { freezeRequirement as freezeGrilling, proposeConvergence, recordRound, startGrilling } from '../lib/grilling.js'
import { createTaskTool } from '../lib/tool-task.js'

const identityDefineTool = (options) => options

const scratchRoots = []

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

/** 一个临时项目根，套件结束时删除。 */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'gac-worker-split-'))
  scratchRoots.push(root)
  return root
}

/**
 * 一个接了适配器与执行者的工具实例。
 *
 * 适配器在这里只承担两件事：声明测试路径（构建者分类的判据）与声明测试如何运行。
 * 拆分判据本身来自**任务的形状**，不来自工程声明——这与 `needsContractGate` 那条
 * 「决定要不要契约的是任务形状、不是风险档位」是同一个轴。
 *
 * @param {object} [options]
 * @param {readonly string[]} [options.testPaths] - `authority.test_paths`；不传即不声明。
 * @param {readonly object[]} [options.runtimeExecutors] - 可用执行者。
 * @returns {{tool: object, store: TaskStore, exec: object, calls: object[]}}
 */
function splitHarness(options = {}) {
  const store = new TaskStore({ root: scratch() })
  const calls = []
  const make = (name) => ({
    name,
    supports: () => true,
    run: async (input) => {
      calls.push(input)
      return { status: 'completed', summary: `${name} 完成`, artifact: `${name}-artifact` }
    },
  })
  const executors = options.runtimeExecutors ?? [make('builder'), make('verifier')]
  const adapters = {
    capabilities: ['implementation', 'verification'],
    executors: { implementation: ['builder'], verification: ['verifier'] },
    ...(options.testPaths === undefined
      ? {}
      : { authority: { test_paths: [...options.testPaths] } }),
  }
  const tool = createTaskTool({
    defineTool: identityDefineTool,
    taskStoreFor: () => store,
    sessionRootFor: () => store.root,
    adapterFor: () => adapters,
    executorsFor: () => executors,
    evidenceFor: () => [],
  })
  return { tool, store, exec: { agent: { session: { id: 'session-1' } } }, calls }
}

/**
 * 一个实现节点的计划条目。
 *
 * @param {string} id
 * @param {string} path - 这个节点要写的路径（产品代码）。
 * @param {object} [overrides]
 * @returns {object}
 */
function writer(id, path, overrides = {}) {
  return {
    id,
    objective: `写 ${path}`,
    required_capabilities: ['implementation'],
    write_scope: [path],
    ...overrides,
  }
}

/**
 * `compileTask` 实际落到节点上的字段。
 *
 * 这份清单**不是**计划条目允许写什么，而是编译之后节点上真的有什么——判据只能读后者，
 * 因为前者里不在这份表上的字段会被**静默丢掉**。留在这里是为了给下面那条前提用例一个
 * 可核对的期望值：往计划节点上写一个不在表里的字段（例如 `acceptance_criteria`），
 * 编译后它在节点上根本不存在。
 *
 * 表里的每一项都对着 `lib/coordinator.js` 的 `compileTask`（它 `nodes.set(raw.id, {...})`
 * 的那一段，170–256 行）逐项核过，而不是照抄某一份注释：
 *
 *  - 计划原样搬过来的：`id`、`objective`、`depends_on`、`required_capabilities`、
 *    `write_scope`、`resources`、`expected_artifacts`、`frozen`；
 *  - 由编译期写死的初始值：`role`（`nodeRoleOf(raw)` 推断出来的语义角色）、`status`
 *    （恒为 `'pending'`）、`execution`（`attempt: 0` + 三个 `null` 的执行身份，
 *    `active_dispatch_id` / `last_result_ref` / `design_ref`）。
 *
 * 白名单以前**漏了** `status` 与 `execution`（`role` 当时也没列），于是本文件末尾那条
 * 「节点上出现的每个字段都必须在白名单里」的循环断言会把这两个**编译器确实写下的**字段
 * 报成「不该保留的字段」，用例一跑就红——而它红的原因与「判据读不到 acceptance_criteria」
 * 毫无关系。虚假的前提用例比没有前提用例更坏：它让人去改白名单本身，而改错方向就等于把
 * 「节点字段被静默丢弃」这条真前提一起松掉。所以这里按 `compileTask` 的**实际赋值**补齐，
 * 一个字都不凭推断加。
 *
 * 后三个是**运行态**而不是计划字段，这一点在 `serializeTask` / `deserializeTask` 那一对函数里
 * 看得最清楚：它们不来自计划，但必须随记录落盘，否则恢复之后节点会被重新推断成别的角色
 * （活体验收里设计节点被推断成执行节点就是这么来的）。恢复路径本身就是「借道 `compileTask`
 * 重建骨架，再把 status 与 execution 贴回去」，所以落盘再读回来之后，节点上的字段集合与
 * 刚编译完时**逐项相同**（`deserializeTask` 只在节点被阻塞或重开时才额外加 `blocked_by` /
 * `reopen_reason`，而新建的待派遣节点两者都没有）。这正是本文件末尾那条
 * `Object.keys(node).sort()` 断言敢用「恰好相等」而不是「包含」的依据。
 *
 * **哪一份字段表算数**：只有 `compileTask` 真正**写下**的键。这里刻意不照抄 `serializeTask`
 * 的字段表——它是落盘用的，与「编译后节点上有什么」在同一个字段上可能给出不同答案
 * （`blocked_by` / `reopen_reason` 就是只在某些状态下才落盘的），而本用例读的节点来自
 * `store.load()`。核对过的事实是：`serializeTask` 落下的每一个**编译期字段**（`id`、
 * `objective`、`depends_on`、`required_capabilities`、`write_scope`、`resources`、
 * `expected_artifacts`、`role`、`frozen`、`status`、`execution`）都在 `compileTask` 里写了一次，
 * 所以 `deserializeTask` 借道 `compileTask` 重建骨架时不会凭空多出节点上原本没有的键。
 */
const NODE_FIELDS_KEPT_BY_COMPILER = Object.freeze([
  // 计划字段：`compileTask` 从 `plan.nodes[i]` 原样搬过来。
  //
  // `frozen` 严格说来不是「原样」搬：`compileTask` 写的是 `raw.frozen === true`，也就是把它
  // **归一成布尔值**（缺省 `false`）。但键本身来自计划条目，且 `writer()` 给节点传的
  // `overrides` 会原样落进计划，所以它归在这一组里读起来才顺——两组的分界是「键从哪来」，
  // 不是「值有没有被归一」。
  'id', 'objective', 'depends_on', 'required_capabilities',
  'write_scope', 'resources', 'expected_artifacts', 'frozen',
  // 编译期写入的字段：不来自计划，但编译后**确实在节点上**。
  //
  // `status` 与 `execution` 是这次补上的两项。它们不是可选项：`serializeTask` 会原样落盘
  // （见 `lib/coordinator.js` 的 `status: node.status` / `execution: { ...node.execution }`），
  // `deserializeTask` 又借道 `compileTask` 重建骨架再把它们贴回去，所以「编译完的节点」
  // 与「落盘再读回来的节点」在字段集合上必须逐项相同——本文件末尾那条
  // `Object.keys(reloaded).sort()` 断言敢用「恰好相等」的依据就在这里，而白名单漏了它们
  // 会让那句「恰好相等」在**编译**那一侧就先错一次。
  'role', 'status', 'execution',
])

/**
 * 建一个标准任务，返回工具返回体。
 *
 * @param {object} h
 * @param {string} taskId
 * @param {readonly object[]} nodes
 * @param {object} [extra]
 * @returns {Promise<object>}
 */
function createTask(h, taskId, nodes, extra = {}) {
  return h.tool.execute({
    action: 'create',
    task_id: taskId,
    mode: 'standard_task',
    plan: { nodes },
    ...extra,
  }, h.exec)
}

/**
 * 一条包含验收标准的完整需求正文。
 *
 * 需求正文必须**逐条写出每条验收标准的含义**，否则冻结会被当场拒绝；而
 * `covers` 里用的是裸编号（`AC1`），所以正文就是「AC1：…」这样的行。
 *
 * @param {readonly string[]} criteria
 * @returns {string}
 */
function requirementText(criteria) {
  return criteria.map((id) => `${id}：这条验收标准要求某个可观察的行为。`).join('\n')
}

/**
 * 从返回里读出全部提示文本。
 *
 * 提示字段的确切名字由实现决定，而本套件要钉的是**行为**：命中了什么、指名到哪个节点、
 * 说清该怎么办。所以这里把返回里所有字符串字段（含 message）合成一份可搜文本，
 * 而不是把测试绑死在一个字段名上——`plan_id` 那几次翻版说明的正是「绑死字段名」
 * 与「漏读字段」是同一枚硬币的两面。
 *
 * 字段名那一侧的保证由本文件末尾那条 schema 用例单独钉住：提示照进 schema 声明过的字段，
 * 否则整条返回会被输出校验拒掉（而透传的 `defineTool` 让单测看不见那个失败）。
 *
 * @param {object} value
 * @returns {string}
 */
function adviceText(value) {
  const parts = []
  const visit = (node) => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const entry of Object.values(node)) visit(entry)
    }
  }
  visit(value)
  return parts.join('\n')
}

/**
 * 建一个**在自己的 task_id 名下已经登记了验收标准**的任务。
 *
 * 为什么要有这个助手，而不是在每个用例里各写一遍
 * ----------------------------------------------
 * 拆分判据的 AC 那一条读的是 `acceptanceCriteriaFor(store, task)`，而它按
 * **`task.task_id`** 去读访谈记录。于是「把标准登记在另一个 task_id 上」对被测任务而言
 * 等于**没有登记**：判据读到空数组，那条分支根本不进入（`criteria.length > 0` 是它的前置），
 * 用例于是以「本该命中却没命中」的姿态失败——而失败原因看起来像判据坏了，
 * 实际上是测试把标准挂错了名字。这就是原缺陷：标准冻在 `REQ-OVER` 名下，被测任务却是
 * `REQ-OVER-2`。
 *
 * 「登记时机」同样是这件事的一半，而它比名字更容易被忽略
 * ----------------------------------------------------
 * 判据不是在被调用方查询时才读标准的：`lib/tool-task.js` 的 `create` 分支里
 * `assessSplitting(task, acceptanceCriteriaFor(store, task))` 是**整个工具里唯一**
 * 计算拆分判据的地方（`status` / `advance` / `audit` 都不重算）。所以标准必须在
 * **`create` 那一刻**就已经挂在同一个 task_id 名下，`create` 之后再冻需求是**改不了**
 * 这次返回里的 `split_signals` 的。
 *
 * 而 `create` 又不是能随意提前的：`grill` 分支排在任务存在性检查之后，对还没建过的
 * task_id 调用只会拿到「找不到任务 ${taskId}」（下一段详述）。两条约束一夹，「先建再冻」
 * 与「先冻再建」各自堵死，于是本助手的做法是：**绕过工具层的存在性检查，用
 * `lib/grilling.js` 的真函数把访谈流程走完并落盘，再 `create`**——标准因此在 `create`
 * 之前就在位，判据读得到它。
 *
 * 为什么走 store 而不走工具的 `grill`
 * ---------------------------------
 * 工具那一侧的「任务必须已经存在」是 `gac_task` 的**工序要求**（「先建任务，再谈它的属性」），
 * 不是 `lib/grilling.js` 的不变量：`freezeRequirement(state, …)` 只检查状态自己自不自洽
 * （提出过收敛、有用户确认原话、正文逐条写出了每条标准），压根不看盘上有没有任务。
 * `TaskStore.saveGrilling` / `loadGrilling` 也纯粹按 task_id 读写，同样不要求任务存在。
 *
 * 用**真的** `startGrilling` / `recordRound` / `proposeConvergence` / `freezeRequirement`，
 * 而不是手搓一份访谈记录：手搓会把冻结校验（正文必须逐条写出每条标准的含义）绕过去，
 * 那样测的就不再是线上的那条路。
 *
 * 顺序必须是「先冻再 create」，而不是「先 create 再 grill」
 * ------------------------------------------------------
 * 后者曾经是本助手的写法，它在**原理上**就走不通，而它看起来却是通的——这正是它值得
 * 写在这里的原因。它会让 `create` 那一刻 `loadGrilling(taskId)` 仍读到 `undefined`，
 * 判据拿到空数组，`GAC_SPLIT_CRITERIA_FRAGMENTED` 永远不开火；随后 grill 冻结照常成功、
 * 末尾断言 `loadGrilling` 也确实有标准——用例全绿，而它要钉的那条判据一次都没被验证过。
 * 那正是本套件开头点名要防的「提示从不触发」。所以下面第三段断言钉的是**时机**：
 * 冻结必须在 `create` 之前完成。
 *
 * 反过来「先 grill 再 create」若走工具也走不通：`lib/tool-task.js` 里 `grill` 分支排在
 * **任务存在性检查之后**（`const task = store.load(taskId)`，未命中就抛「找不到任务 ${taskId}」），
 * 而那一段对 `create` 之外的所有动作都生效。工具自己的返回文本里也写着这件事：
 * 「`grill` 与 `contract` 都要求任务**已经存在**」。
 *
 * 唯一影响不到的是写范围冲突那条既有保证：登记访谈不改任务的节点、也不碰契约——
 * 契约门禁仍然在 `advance` 上，本助手不碰它。
 *
 * @param {object} h
 * @param {string} taskId
 * @param {readonly object[]} nodes
 * @param {readonly string[]} criteria
 * @returns {Promise<object>}
 */
async function createTaskWithCriteria(h, taskId, nodes, criteria) {
  // 顺序是有意的，不要调换。**下面这一段是本助手存在的全部理由**，读之前先接受一个事实：
  //
  //   `create` 那一步在 `lib/tool-task.js` 里读的是 `acceptanceCriteriaFor(store, task)`
  //   （第 988 行：`assessSplitting(task, acceptanceCriteriaFor(store, task))`），而
  //   `assessSplitting` 在整个工具里**只被调用这一次**——`status`、`advance`、`audit` 都不再
  //   重算它。所以「判据收得到哪些标准」在 `create` 返回之前就已经定死了，`create` 之后再冻
  //   需求**改不了这次返回里的 `split_signals`**。
  //
  // 于是「先 create 再 grill」这条路**在原理上就走不通**（它曾经是本助手的写法，也是这条用例
  // 第一版修复的写法）：`create` 那一刻 `loadGrilling(taskId)` 还是 `undefined`，判据拿到空数组，
  // `criteria.length > 0` 那道前置不成立，`GAC_SPLIT_CRITERIA_FRAGMENTED` 永远不会开火；
  // 随后 grill 把标准冻上，冻结**成功**、`loadGrilling` 读回来也**确实有标准**——末尾那两句
  // 断言双双通过，而用例真正要钉的那条判据一次都没被验证过。那正是本套件开头点名要防的
  // 「提示从不触发」：用例全绿，判据是死的。
  //
  // 而「先 grill 再 create」又过不了工具那一侧的检查：`grill` 分支排在任务存在性检查之后
  // （`const task = store.load(taskId)`，未命中就抛「找不到任务 ${taskId}」），对没建过的
  // task_id 调用它只会拿到那句错误。工具自己的返回文本里也写着这件事：「`grill` 与 `contract`
  // 都要求任务**已经存在**」。
  //
  // 两条路各自堵死，剩下唯一能同时满足「标准在 `create` 之前就登记好」与「登记用的还是那套
  // 真的冻结逻辑」的做法：**绕过工具层的存在性门禁，直接在 store 上把这套冻结流程走完**。
  // 那道理序只是 `gac_task` 的一个前置检查（「先建任务再谈它的属性」），它不是 `lib/grilling.js`
  // 的不变量——`freezeRequirement(state, …)` 只关心状态自己自不自洽（收敛过、有确认原话、
  // 正文逐条写出了每条标准），压根不看盘上有没有任务。所以这里用**真的** `startGrilling` /
  // `recordRound` / `proposeConvergence` / `freezeRequirement`，而不是手搓一份访谈记录：
  // 手搓的话，冻结校验（正文要逐条写出每条标准）就被绕过去了，测的便不再是线上的那条路。
  //
  // 这样冻出来的记录挂在**同一个 task_id** 名下，随后 `create` 建的是同一个 task_id，
  // `acceptanceCriteriaFor` 按 `task.task_id` 一读即中。判据一个字都没改：改的只是「标准在
  // 哪一刻登记」，而这正是原来错掉的那一件事——原缺陷把标准冻在了**另一个** task_id 上。
  //
  // 下面的断言顺序也是刻意的：
  //
  //  1. 冻结**之前**先证明这个 task_id 名下**一条记录都没有**——否则「标准登记上了」与
  //     「读错了地方」在断言里分不出来；
  //  2. 冻结**之后**、`create` **之前**，证明标准已经挂在这个 task_id 名下——这正是
  //     `create` 那一刻判据会读到的东西；
  //  3. `create` 之后，证明这次返回**是拿着标准算出来的**——这一句才是防退化装置：
  //     把顺序改回「先 create 再 grill」，`create` 那一刻 `loadGrilling` 还是空的，
  //     返回里的判据必然与「已登记标准」这个前提对不上，它当场变红。
  const before = h.store.loadGrilling(taskId)
  assert.equal(
    before,
    undefined,
    `${taskId} 名下原本不该有访谈记录——原来的缺陷写法正是把标准冻在了别处，`
    + `这里必须先证明读回来是空的，否则下面的断言分不清「标准登记上了」与「读错了地方」`,
  )

  // 走一遍与工具完全相同的访谈流程，只是不经过 `gac_task` 的存在性门禁。
  let state = startGrilling({ task_id: taskId, requirement: requirementText(criteria), now: 1 })
  state = recordRound(state, {
    focus: '验收标准',
    questions: criteria.map((id) => ({
      id,
      question: `${id} 怎么算达成？`,
      answer: '按需求正文里写的那样。',
    })),
    now: 2,
  })
  state = proposeConvergence(state)
  state = freezeGrilling(state, {
    confirmation: '就按这个做。',
    acceptance_criteria: [...criteria],
    now: 4,
  })
  h.store.saveGrilling(taskId, state)

  // 标准必须在 `create` **之前**就登记好——`create` 那一刻判据读的就是它。
  assert.deepEqual(
    h.store.loadGrilling(taskId)?.acceptance_criteria,
    [...criteria],
    `验收标准必须登记在 ${taskId} 自己名下，而且必须在 create 之前登记——`
    + `create 那一步会读它来算 split_signals`,
  )

  const value = await createTask(h, taskId, nodes)
  assert.equal(value.action, 'created', `任务 ${taskId} 应当建得起来`)
  // 这一句是本助手的理由，也是它的防退化装置：标准必须真的落在**被测任务自己**名下，
  // 而且必须在 `create` **之前**就落好——否则下面的判据读到的是空数组，用例会以一种
  // 看不出原因的方式失败（全绿，但那条判据一次都没被验证过）。
  //
  // 断言写在 `create` 的**返回值**上而不是再读一次盘，是因为「盘上有标准」与「这次返回
  // 是拿着标准算出来的」是两件事：前者在「先 create 再 grill」的退化写法下同样成立，
  // 而后者才对应判据的实际输入。这里用「标准非空 ⇒ AC 判据要么在场、要么被写节点数那道
  // 闸门挡住」这条蕴含关系把它钉住——它不假定用例形状，只要求「登记了标准」这件事在
  // 返回里有痕迹。
  assert.deepEqual(
    h.store.loadGrilling(taskId)?.acceptance_criteria,
    [...criteria],
    `验收标准必须登记在 ${taskId} 自己名下——判据按 task_id 读它`,
  )
  if (criteria.length > 0) {
    const codes = value.split_signals.map((signal) => signal.code)
    const writers = [...h.store.load(taskId).nodes.values()]
      .filter((node) => node.write_scope.length > 0).length
    assert.ok(
      codes.includes('GAC_SPLIT_CRITERIA_FRAGMENTED')
      || writers < 6
      || criteria.length / writers >= 1.2,
      `create 返回的判据必须是在「已登记 ${criteria.length} 条标准」这个前提下算出来的：`
      + `本轮 ${writers} 个写节点既没过 min_writers_for_criteria（=6），比值也没低于`
      + ` criteria_per_writer（=1.2），那条 AC 判据却不在场（实际收到：${JSON.stringify(codes)}）。`
      + '这通常意味着标准是在 create 之后才登记的——那样 create 那一刻判据读到的是空数组，'
      + '用例会全绿而判据从不触发',
    )
  }
  return value
}

describe('过拆提示 —— 只说不改判，合法的大任务一个字都不多说', () => {
  it('节点数远超独立模块数、且大量节点各自只覆盖一条 AC 时，给出过拆提示而不是静默接受', async () => {
    // 十一个节点、十一个写路径，而任务上只登记了三条验收标准：这意味着其中绝大多数节点
    // 各自只承载一条标准的一小部分。这是「把一次小改动切成了十一段」的典型形状——
    // 每个节点都很小，但合起来没有任何一个节点能独立说清「这件事做完了没有」。
    //
    // 原断言为什么测错了
    // ----------------
    // 这条用例此前用的是「先建 `REQ-OVER` 并冻结，再建 `REQ-OVER-2`」的写法，把验收标准
    // 冻在了 `REQ-OVER` 上，却在 `REQ-OVER-2` 上建任务。而
    // `acceptanceCriteriaFor(store, task)` 是拿 **`task.task_id`** 去读访谈记录的
    // （`store.loadGrilling(task.task_id)`），所以 `REQ-OVER-2` 名下**一条标准都没有**，
    // 判据拿到的是一份空数组，实测 `split_signals` 就是 `[]`。
    //
    // 它当时之所以还是红的，原本被解释成「靠结构面照样开火」，但那个解释**站不住**：
    // 十一个节点都写 `lib/mod-N.js`，归一化之后只落在 `lib` 一个模块上，而结构面判据有一道
    // `moduleCount >= SPLIT_THRESHOLDS.min_modules`（=3）的闸门，模块数只有 1 时它根本不开火
    // （详见下面「写路径为什么分成三个目录」那一段）。所以这条用例当时其实**两条判据都收不到**，
    // 它测的既不是 AC 面也不是结构面——而这正是「提示从不触发」那类缺陷最喜欢的藏身处：
    // 名字里写着 AC 子集，实际什么都没测。
    //
    // 新断言凭什么成立
    // ----------------
    // `createTaskWithCriteria` 用**同一个** task_id 把三条标准登记到它名下，而且在登记
    // **之前**先断言那个 task_id 名下**一条访谈记录都没有**、登记**之后**再断言标准确实
    // 在它名下。两条断言合起来才把「原来的缺陷」挡在门外：只留后面的，在退化实现下同样
    // 会失败，但失败原因会退化成一句「标准没登记上」——那看起来像判据坏了，
    // 而实情是测试把标准挂在了别处名字上。
    //
    // 顺序必须是「先登记标准，再 create」，而不是「先 create 再登记」
    // ---------------------------------------------------------------
    // 这一条比「挂对名字」更容易漏掉，因为挂对名字之后用例照样是绿的。`lib/tool-task.js`
    // 的 `create` 分支里 `assessSplitting(task, acceptanceCriteriaFor(store, task))` 是
    // **整个工具里唯一**算拆分判据的地方：`status` / `advance` / `audit` 都不重算，所以
    // `create` 之后再冻需求，改不了这次返回里的 `split_signals`。「先 create 再 grill」
    // 的写法因此会让 `create` 那一刻 `loadGrilling` 读到 `undefined`，判据拿到空数组，
    // 下面那条 `GAC_SPLIT_CRITERIA_FRAGMENTED` 断言永远不可能通过——而它当时之所以能被
    // 写成绿的，是因为断言与登记都退到了 `create` 之后，没有一处再看 `create` 的输入。
    //
    // 反过来走工具的 `grill` 去「先冻再建」也不行：`grill` 分支排在任务存在性检查之后
    // （`const task = store.load(taskId)`，未命中就抛「找不到任务」）。所以助手绕过工具层
    // 的工序检查，直接用 `lib/grilling.js` 的真函数在 store 上走完访谈与冻结——那一步的
    // 前置只是 `gac_task` 的工序要求，不是 `grilling.js` 的不变量，也不改任何判据。
    //
    // 判据读到的标准非空之后，返回里的 `split_signals` 上两条过拆判据都应当在场：
    // 结构面（11 节点 / 3 模块）与判据面（11 个写节点摊 3 条标准）。这里按 `code` 断言，
    // 因为要钉的就是「AC 那一条也真的开火了」——只断言文本里有「过拆」二字的话，
    // 结构面一条就能让用例变绿，等于把原来的缺陷原样留着。
    //
    // 顺带核过判据自己的门槛：`GAC_SPLIT_CRITERIA_FRAGMENTED` 的两道前置是
    // `criteria.length > 0` 且写节点数 ≥ `min_writers_for_criteria`（=6，见
    // `SPLIT_THRESHOLDS`），这里分别是 3 与 11，都过闸门；比值 `3 / 11 ≈ 0.27` 也低于
    // `criteria_per_writer`（=1.2），所以只要**标准真的在被测任务名下、且在 `create`
    // 之前就登记好**，它必然开火。
    // 这同时说明「按 code 断言」不是把测试绑死在实现细节上：它读的是本套件自己也要用的
    // 那个稳定标识。
    //
    // 写路径为什么分成 `lib/`、`src/`、`app/` 三个目录，而不是全塞在 `lib/`
    // ----------------------------------------------------------------
    // 结构面那条判据问的是「节点数相对**独立模块数**」，而独立模块取的是写范围的**目录部分**
    // （`lib/a.js` → `lib`，见 `independentModulesOf`）。十一个 `lib/mod-N.js` 归一之后
    // 只落在 `lib` **一个**模块上，于是 `moduleCount === 1`，而判据自己有一道
    // `moduleCount >= SPLIT_THRESHOLDS.min_modules`（=3）的闸门——模块太少时这个比值没有
    // 信息量。两者相乘的结果是：全塞在 `lib/` 的写法下 `GAC_SPLIT_OVERSIZED` **根本不可能
    // 开火**，断言会以「结构面没开火」的姿态失败，而那与 AC 那一半毫无关系。
    // （上面「原断言为什么测错了」那段说的「结构面照样开火」正是在这一点上不成立——
    // 它自己下一句就写着「只落在 `lib` 一个模块上」，与开火的前提自相矛盾。）
    //
    // 拆成三个目录之后 `moduleCount === 3` 恰好过闸门，而 11 个节点仍是同一个模块数的 3 倍
    // 以上（`significant_ratio` = 2），结构面照旧开火；节点数、AC 条数、判据面全都没变，
    // 所以「AC 那条也真的开火了」这件事一点没被削弱。
    const criteria = ['AC1', 'AC2', 'AC3']
    const modules = ['lib', 'src', 'app']
    const nodes = Array.from({ length: 11 }, (_, index) =>
      writer(`T${index + 1}`, `${modules[index % modules.length]}/mod-${index + 1}.js`))
    const h = splitHarness()
    const value = await createTaskWithCriteria(h, 'REQ-OVER', nodes, criteria)

    assert.equal(value.action, 'created', '判据是提示：命中也照样建任务')
    const codes = value.split_signals.map((signal) => signal.code)
    assert.ok(
      codes.includes('GAC_SPLIT_CRITERIA_FRAGMENTED'),
      `AC 子集被切碎这一条必须真的开火（本任务名下已登记 ${criteria.length} 条标准、`
      + `却有 ${nodes.length} 个写节点）；实际收到的判据：${JSON.stringify(codes)}`,
    )
    assert.ok(
      codes.includes('GAC_SPLIT_OVERSIZED'),
      `节点数远超独立模块数这一条也必须开火（${nodes.length} 个节点摊 ${modules.length} 个模块）；`
      + `实际收到的判据：${JSON.stringify(codes)}`,
    )
    const text = adviceText(value)
    assert.match(text, /过拆|拆得过细|节点数/u, `必须说出「拆得太细」这件事；实际返回：${text}`)
  })

  it('提示不阻断创建：任务照样落盘，节点一个不少', async () => {
    const criteria = ['AC1', 'AC2', 'AC3']
    const nodes = Array.from({ length: 11 }, (_, index) => writer(`T${index + 1}`, `lib/mod-${index + 1}.js`))
    const h = splitHarness()
    const value = await createTaskWithCriteria(h, 'REQ-OVER-2', nodes, criteria)
    assert.equal(value.task_id, 'REQ-OVER-2')
    const reloaded = new TaskStore({ root: h.store.root }).load('REQ-OVER-2')
    assert.equal(reloaded.nodes.size, nodes.length, '提示不得回滚任何节点')
  })

  it('**已经足够小的任务不被提示过拆** —— 一个节点、一个模块、无话说', async () => {
    // 这是本套件最要紧的一条反例方向。一个单节点的任务是能拆的最小形态，
    // 任何在这里冒出来的「过拆」话都是噪声，而噪声会让真正需要看见的那条被跳过。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-SMALL', [writer('T1', 'lib/small.js')])

    assert.equal(value.action, 'created')
    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /过拆|拆得过细|节点过多|拆成更少|合并节点/u,
      `足够小的任务不该被劝合并；实际返回：${text}`,
    )
    assert.doesNotMatch(
      text,
      /归口|集成节点|共享文件/u,
      `单节点任务不存在共享文件，不该要求归口；实际返回：${text}`,
    )
  })

  it('**两三个模块、写路径互不相交时不被提示过拆**', async () => {
    // 两个节点、两条互不相交的写路径——这是「拆得对」的形状：两个模块本来就该分开写，
    // 而且它们不共享任何文件。判据必须把它读成合法，否则它就在惩罚正确的做法。
    const h = splitHarness()
    const value = await createTaskWithCriteria(h, 'REQ-TWO', [
      writer('T1', 'lib/a.js'),
      writer('T2', 'lib/b.js'),
    ], ['AC1', 'AC2'])

    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /过拆|拆得过细|节点过多|拆成更少|合并节点/u,
      `两条互不相交的写路径是正确拆分，不该被劝合并；实际返回：${text}`,
    )
  })

  it('节点数不多时，即使每条 AC 只由一个节点承载也不打扰', async () => {
    // 反例的另一面：契约里那条「大量节点的 AC 子集只有一条」若单独成立就开火，
    // 会把「三个模块、三条 AC」这种完全正常的任务判成过拆。它必须与**节点数相对模块数**
    // 一起看，否则这条判据会退化成对所有细粒度计划的无条件骚扰。
    //
    // 这条用例的写法同时也是「AC 真的登记到了被测任务名下」的旁证：它走的是与命中那条
    // 相同的 `createTaskWithCriteria`，只有任务形状换成了合法的小任务，于是它必须**不**
    // 出现 `GAC_SPLIT_CRITERIA_FRAGMENTED`——同一个读法，两种形状，两个方向。
    const h = splitHarness()
    const value = await createTaskWithCriteria(h, 'REQ-BALANCED', [
      writer('T1', 'lib/a.js'),
      writer('T2', 'lib/b.js'),
      writer('T3', 'lib/c.js'),
    ], ['AC1', 'AC2', 'AC3'])

    const codes = value.split_signals.map((signal) => signal.code)
    assert.ok(
      !codes.includes('GAC_SPLIT_CRITERIA_FRAGMENTED'),
      `三个写节点摊三条标准是正常粒度，不该报 AC 切碎；实际收到的判据：${JSON.stringify(codes)}`,
    )
    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /过拆|拆得过细|节点过多|拆成更少|合并节点/u,
      `三个模块三个节点是正常粒度；实际返回：${text}`,
    )
  })

  it('没有登记验收标准时，AC 那一条判据无从判起，也不该凭空报出来', async () => {
    // 判据的输入必须真实存在。没有冻结需求时「每条 AC 只有一个节点」根本不知道说的是什么，
    // 这时报「你的 AC 拆得太碎」是一句编出来的话——而编出来的理由会把读的人引向错误方向。
    //
    // 这条用例是上一条的**对照组**，也正因为有它，「标准挂错 task_id」这个坑才有意义：
    // 未登记与登记在别的 task_id 这两件事在下游看起来一模一样（都是空数组），而本用例
    // 要求其中一种形状**必须**沉默。两个方向都钉住之后，「沉默」才不会被误当成「判据坏了」。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-NOAC', [
      writer('T1', 'lib/a.js'),
      writer('T2', 'lib/b.js'),
      writer('T3', 'lib/c.js'),
    ])

    assert.equal(value.action, 'created')
    assert.deepEqual(
      value.split_signals.map((signal) => signal.code),
      [],
      '三个节点的计划本来就没有任何形状问题，不该报出任何判据',
    )
    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /每条验收标准只有一个节点|AC 子集只有一条|验收标准拆得过细/u,
      `没有登记验收标准时不该就 AC 说任何话；实际返回：${text}`,
    )
  })

  it('合法的大任务不被拒绝：十二个互不相交的写路径照样建得起来', async () => {
    // 「不设武断的节点数上限」这条写在契约里。一个真需要十二个模块的任务，
    // 节点数多本身就是它的形状，而不是错误；判据最多只能说一句，绝不能拦。
    const nodes = Array.from({ length: 12 }, (_, index) => writer(`T${index + 1}`, `lib/part-${index + 1}.js`))
    const h = splitHarness()
    const value = await createTask(h, 'REQ-BIG', nodes)

    assert.equal(value.action, 'created', '大任务必须建得起来')
    assert.equal(h.store.load('REQ-BIG').nodes.size, 12)
  })

  it('编译器不认识的节点字段被静默丢弃 —— 判据不能依赖它们', async () => {
    // 这条钉的是本套件自己的前提，而不是实现的行为：节点上写 `acceptance_criteria`
    // 会被 `compileTask` 丢掉（它只保留固定的一组字段）。判据若依赖这个字段，
    // 它读到的永远是 undefined，于是「AC 子集」那条分支实际上从不生效——
    // 而任何针对它的测试都会以「不该触发时没触发」的姿态通过。
    //
    // 白名单此前测错了：它漏了 `compileTask` **实际会落下**的字段——`status` 与 `execution`
    // 两个，`role` 也没列。于是这条前提用例一跑就红，而它红的原因跟「判据读不到
    // acceptance_criteria」毫无关系：循环断言把编译器自己写下的 `status` / `execution`
    // 报成了「节点上出现了编译器不该保留的字段」。一个虚假的前提用例会让人去改白名单本身，
    // 而改错了方向（例如把 `acceptance_criteria` 加进去）就等于把「节点字段静默丢弃」
    // 这条真前提也一起松掉。
    //
    // 现在按 `lib/coordinator.js` 的 `compileTask` 实际落下的字段补齐（见
    // `NODE_FIELDS_KEPT_BY_COMPILER` 的注释，逐项对过 `nodes.set(raw.id, {...})`），
    // 并且仍然保留 `acceptance_criteria` 不会活下来这条**关键断言**：它才是本用例要守的
    // 那一件事。白名单只负责把「除了这几个字段以外什么都不该出现」钉死，方向是**收紧**的
    // ——计划里多写一个字段，这里就会多红一次。
    //
    // 「不在白名单上」为什么必须删掉而不是加进白名单
    // --------------------------------------------
    // `compileTask` 的 `nodes.set(raw.id, {...})` 里**没有** `acceptance_criteria`，所以那一项
    // 不在表里——计划里写得出来（`gac_task` 的 `plan` 是 `additionalProperties: true` 的自由
    // 对象），编译之后就是不在节点上。这正是「静默丢弃」这个说法的全部内容：**写得进去、
    // 落不下来，中间也不报错**。把一项加进白名单只会让两次断言同时变红（循环断言「节点上出现了
    // 编译器不该保留的字段」、集合断言「多列了已不再保留的字段」），而它对「字段被静默丢弃」
    // 这件事的证明力一点都没增加——真正的证明是下一句「节点上没有这个字段」，而那只取决于
    // 计划里写过它、编译没保留它。
    const h = splitHarness()
    await createTask(h, 'REQ-DROP', [
      writer('T1', 'lib/a.js', { acceptance_criteria: ['AC1'] }),
    ])
    const node = h.store.load('REQ-DROP').nodes.get('T1')
    for (const field of Object.keys(node)) {
      assert.ok(
        NODE_FIELDS_KEPT_BY_COMPILER.includes(field),
        `节点上出现了编译器不该保留的字段 ${field}——本前提变了，上面的用例需要重新核对`,
      )
    }
    // 计划里除了 `acceptance_criteria` 之外只写了实现节点该有的那些字段，所以编译之后
    // 节点上的字段集合应当**恰好**是白名单本身；多一个少一个都要重新核对。
    assert.deepEqual(
      Object.keys(node).sort(),
      [...NODE_FIELDS_KEPT_BY_COMPILER].sort(),
      '节点字段集合变了：白名单要么漏了新增字段，要么多列了已不再保留的字段',
    )
    assert.equal(
      'acceptance_criteria' in node,
      false,
      '节点级的 acceptance_criteria 不会活下来（`compileTask` 的那次赋值里根本没有这一项）',
    )
    // 「没有这个字段」与「这个字段是 undefined」是两件事：前者是编译期丢掉，后者只说明调用方
    // 恰好把它写成了 undefined。只有前者能证明判据读的是**节点上有没有这个字段**。
    assert.equal(Object.hasOwn(node, 'acceptance_criteria'), false)
    assert.equal(node.acceptance_criteria, undefined, '节点级的 acceptance_criteria 不会活下来')
    // 同样的理由向前推一层：`gac_task` 那一步不额外保留任何节点字段，所以**编译之后**的字段集合
    // 与**落盘再读回来**之后逐项相同。这条一旦变红，说明「编译后节点上有什么」这件事又多了一个
    // 来源，而本用例的两次断言读的正是其中的一个——两份真相必须一起改。
    const reloaded = new TaskStore({ root: h.store.root }).load('REQ-DROP').nodes.get('T1')
    assert.deepEqual(
      Object.keys(reloaded).sort(),
      Object.keys(node).sort(),
      '落盘再读回来的节点字段集合变了：`serializeTask` / `deserializeTask` 与 `compileTask` 漂移了',
    )
  })
})

describe('共享文件归口 —— 两个写节点碰同一份文件时要求一个集成节点', () => {
  it('两个写节点命中同一份具体文件时给出归口要求，并指名文件与节点', async () => {
    // 「共享入口文件」是并行写入里唯一真正会撞车的情形：两个节点都改 `lib/entry.js`，
    // 各自的改动单独看都对，合起来却可能互相覆盖。此时正确的动作不是串行跑两遍，
    // 而是把落到这份文件上的改动**归口到一个集成节点**——串行只解决「不会同时写」，
    // 不解决「两边写的东西要不要合在一起看」。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-SHARED', [
      writer('T1', 'lib/entry.js'),
      writer('T2', 'lib/entry.js'),
    ])

    assert.equal(value.action, 'created', '判据是提示：共享文件也不阻断创建')
    const text = adviceText(value)
    assert.match(text, /lib\/entry\.js/u, `必须指名是哪份共享文件；实际返回：${text}`)
    assert.match(text, /T1/u, `必须指名第一个命中的节点；实际返回：${text}`)
    assert.match(text, /T2/u, `必须指名第二个命中的节点；实际返回：${text}`)
    assert.match(
      text,
      /归口|集成节点|同一个节点/u,
      `必须说清该怎么办（归口到一个集成节点），而不只是说「冲突了」；实际返回：${text}`,
    )
  })

  it('目录级重叠不算共享文件 —— 各写各的文件时不该要求归口', async () => {
    // 反例方向。两个节点都写 `lib/` 但写的是**不同的文件**，这是并行写入的正常形态，
    // 而且它已经被写范围冲突那条既有规则处理（同一批里范围相交的节点会被串行）。
    // 把目录级重叠也报成「共享文件」会让每一个正常的并行计划都收到一条无用的归口要求。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-NOSHARE', [
      writer('T1', 'lib/a.js'),
      writer('T2', 'lib/b.js'),
    ])

    assert.equal(value.action, 'created')
    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /归口|集成节点|共享文件/u,
      `各写各的文件不构成共享文件；实际返回：${text}`,
    )
  })

  it('只有一读一写碰到同一份文件时不算共享 —— 归口要求针对的是写者', async () => {
    // 判据问的是「有几个**写节点**命中同一份文件」。一个只回传报告、不写文件的验证节点
    // 提到同一份文件是很正常的（它要核对的就是那份文件），把它算进来会让任何一个
    // 「实现 + 验证」的标准计划都收到归口要求——而标准计划恰恰是正确形态。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-READONLY', [
      writer('T1', 'lib/entry.js'),
      {
        id: 'V1',
        objective: '核对 lib/entry.js',
        depends_on: ['T1'],
        required_capabilities: ['verification'],
        write_scope: [],
      },
    ])

    assert.equal(value.action, 'created')
    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /归口|集成节点|共享文件/u,
      `不写文件的节点不构成共享写者；实际返回：${text}`,
    )
  })

  it('共享文件与过拆是两件事：两个节点共享一份文件时只说归口', async () => {
    // 两个节点不会被判过拆（节点少），但会命中共享文件。两条判据各自独立开火，
    // 不该互相带出对方的话——混在一起读的人分不清要他做什么。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-ONLY-SHARED', [
      writer('T1', 'lib/entry.js'),
      writer('T2', 'lib/entry.js'),
    ])

    assert.equal(value.action, 'created')
    const text = adviceText(value)
    assert.doesNotMatch(
      text,
      /过拆|拆得过细/u,
      `两个节点不是过拆；实际返回：${text}`,
    )
  })

  it('三个及以上写节点命中同一份文件时，全部被指名', async () => {
    const h = splitHarness()
    const value = await createTask(h, 'REQ-THREE', [
      writer('T1', 'lib/entry.js'),
      writer('T2', 'lib/entry.js'),
      writer('T3', 'lib/entry.js'),
    ])

    assert.equal(value.action, 'created')
    const text = adviceText(value)
    for (const id of ['T1', 'T2', 'T3']) {
      assert.match(text, new RegExp(id, 'u'), `节点 ${id} 应当被指名；实际返回：${text}`)
    }
    assert.match(text, /归口|集成节点/u)
  })
})

describe('按 AC 与独立写路径正确拆分 —— 拆对了就没有话说', () => {
  it('实现与测试各一个节点、写路径分属两类时通过，且不触发任何拆分提示', async () => {
    // 「按 AC 与独立写路径正确拆分」的正面形态：一个节点只写产品路径、一个只写测试路径。
    // 这是 `GAC_BUILDER_SCOPE_MIXED` 那条拒绝想引导得到的形状，所以它必须一路通畅——
    // 拆分判据若在这个形状上开火，等于把「拆对了」也劝回去。
    const h = splitHarness({ testPaths: ['test/'] })
    const value = await createTask(h, 'REQ-SPLIT-OK', [
      writer('S1', 'lib/a.js'),
      writer('T1', 'test/a.test.js'),
    ])

    assert.equal(value.action, 'created')
    assert.equal(h.store.load('REQ-SPLIT-OK').nodes.size, 2)
    const text = adviceText(value)
    assert.doesNotMatch(text, /过拆|拆得过细/u, `正确拆分不该被劝合并；实际返回：${text}`)
    assert.doesNotMatch(text, /归口|集成节点|共享文件/u, `两条路径互不相同；实际返回：${text}`)
  })

  it('按验收标准分节点且写路径互不相交时，任务建立后可以直接派遣', async () => {
    const h = splitHarness()
    await createTaskWithCriteria(h, 'REQ-DISPATCH', [
      writer('T1', 'lib/a.js'),
      writer('T2', 'lib/b.js'),
    ], ['AC1', 'AC2'])

    // 两个写者同批 -> 先冻结接口契约（既有门禁，不是本轮判据）。
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-DISPATCH',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)
    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-DISPATCH' }, h.exec)
    assert.deepEqual(
      h.calls.map((call) => call.node.id).sort(),
      ['T1', 'T2'],
      '互不相交的写路径应当同批并行，而不是被串行化',
    )
    assert.equal(value.classifications.length, 2)
  })
})

describe('写路径冲突时正确串行 —— 归口是提示，串行是既有保证', () => {
  it('两个节点写同一条路径时不会同批派遣，只有一个先走', async () => {
    // 拆分判据**不替代**既有的写范围互斥：即使提示已经说了「请归口」，
    // 调度器这一层仍然不能让两个写范围相交的节点同时开工。这条保证在判据加上之后
    // 一个字节都不能变——提示是建议，互斥是保证。
    //
    // 原断言为什么测错了
    // ----------------
    // 它断言的是 `[...task.nodes.values()].filter(n => n.status === 'in_progress').length === 1`，
    // 也就是「盘上恰好有一个节点处于 in_progress」。这个观察点在**本套件的替身执行者下恒为 0**：
    // `splitHarness` 的 `make(name)` 当场就把子会话跑完并返回 `{ status: 'completed' }`，
    // 于是 `advance` 内部先 `dispatch`（置 `in_progress`）紧接着 `applyResult`（置 `completed`），
    // 等调用方拿到返回时两个节点都不再是 `in_progress`——一个 `completed`，另一个从未被派遣、
    // 仍是 `pending`。实测这个 filter 的结果是 `0`，不是 `1`。
    //
    // 更要紧的是：即使执行者改成异步、让它凑巧停在 `in_progress` 上，它量的也**不是**
    // 「不会同批派遣」这件事。`in_progress` 是**瞬态**，它取决于执行者跑得快不快、以及调度器
    // 有没有等到结果。断言「这一瞬间只有一个 in_progress」在**顺序**调度下同样成立：一个把两个
    // 节点先后派进同一批、再一个跑完再跑另一个的实现，从头到尾也只会有一个 `in_progress`，
    // 于是它照样能让这条断言变绿——而两个写范围相交的节点同批飞出去这件事，恰恰要求被判红。
    // 真正要钉的是**同一次 `advance` 里被派遣的节点集合**：那一批里只能有一个。
    //
    // 新断言凭什么成立
    // ----------------
    // 派遣这件事有两个**审计记录**，它们都不依赖任何瞬态：
    //
    //  1. 节点上的 `execution.attempt`——`dispatch()` 对每个被派遣的节点把它 `+1`；
    //  2. 本次返回的 `transitions` 里 `kind === 'dispatched'` 的那些条目——`tool-task.js` 的
    //     `dispatchAndInvoke` 在 `dispatch(current, nodeIds, …)` 之后**按同一份 `nodeIds`**
    //     逐条写下 `{ kind: 'dispatched', node_id, attempt, dispatch_id }`。这份数组是**本次调用**
    //     累积的（在 `advance` 的分支之外声明），因此它对「这一批派遣了谁」是逐一对应的记录；
    //     本例只调用了一次 `advance`，两者恰好重合。
    //
    // 两者都是**单调的**：`dispatch` 只加不减，`transitions` 只追加不清空。而 `in_progress` 不是
    // ——它会随一次 `applyResult` 消失。原断言把观察点放在了一个会被后续步骤抹掉的状态上，
    // 于是它测的其实是「调用方拿到返回的那一刻执行者有没有跑完」这件与写范围互斥无关的事。
    // 换到这两本账上之后，断言量的是「这一批派了谁」，与执行者快慢、与调度器等不等结果都无关。
    //
    // 所以这里四条一起断言：
    //
    //  1. 执行者被调用恰好一次（`h.calls.length === 1`）——只有一个节点真的开始跑了；
    //  2. `transitions` 里恰好一条 `dispatched`，且它指的就是跑起来的那个节点——「被派遣的是谁」
    //     由工具自己说出来，不必靠读当时的状态去猜；
    //  3. 被派遣节点的 `execution.attempt === 1`——被**派遣过**的只有它；
    //  4. 另一个节点仍在 `pending` 且 `attempt === 0`——它没有被派进这一批。
    //
    // 顺序也不是随便定的：先读 `h.calls` 与 `transitions`，再读盘上的 `execution`。
    // 替身执行者当场返回，所以这一轮结束时被派遣的那个节点已经是 `completed`，这一批已经
    // 结束了——**盘上有快照，返回里也有账，两者读的是同一件事**。先读盘再拿 `h.calls[0]`
    // 去比，在退化实现（一批派了两个）下会先在 `h.calls.length` 那一条上停下，
    // 而这一条恰好是最能直说问题的那一条。
    //
    //  这四条合起来说的正是原断言想说的话，而且不依赖任何瞬态：同批派遣的实现在第 2 条第 3
    //  条上会看到两条 / 两个 `attempt === 1`，先派后撤的实现在第 1 条上会看到两次调用。
    //
    //  三本账互相校验，而它们记的是三件不同的事——**派了谁**（`transitions`）、**派了几次**
    //  （`execution.attempt`）、**跑了几回**（`h.calls.length`）。只有当批次里确实只有一个
    //  节点时，三本账才会同时记成一。
    //
    //  另外：这里不断言 `value.action`。第 2 本账用的是 `transitions` 而不是 `action`，两者
    //  记的不是一回事——`action` 是 `dispatchAndInvoke` 在回报结果**之后**重算出来的
    //  「下一步该做什么」（`nextAction(current)`），与写范围冲突无关：第二个节点因为冲突没进这一
    //  批，但它是就绪的 `pending`，于是下一轮照样会被算成 `dispatch`。所以这一轮结束时
    //  `action` 仍是 `dispatch`，只有 `classifications` 在本轮结束时是 `['accepted']`。
    const h = splitHarness()
    await createTask(h, 'REQ-SERIAL', [
      writer('T1', 'lib/same.js'),
      writer('T2', 'lib/same.js'),
    ])
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-SERIAL',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-SERIAL' }, h.exec)

    assert.equal(
      h.calls.length,
      1,
      `同一份写路径上只能有一个节点在飞；实际被派遣的是：${h.calls.map((call) => call.node.id).join('、')}`,
    )
    assert.deepEqual(value.classifications, ['accepted'])
    // 这一批被派遣的是谁，工具自己记在 `transitions` 里；只允许有一个。
    const dispatchedTransitions = value.transitions.filter((entry) => entry.kind === 'dispatched')
    assert.deepEqual(
      dispatchedTransitions.map((entry) => entry.node_id),
      [h.calls[0].node.id],
      '这一批里被派遣的节点必须恰好是跑起来的那个，另一个不得同批派出',
    )

    const task = h.store.load('REQ-SERIAL')
    const dispatched = [...task.nodes.values()].filter((node) => node.execution.attempt > 0)
    assert.deepEqual(
      dispatched.map((node) => node.id),
      [h.calls[0].node.id],
      'attempt 这本账必须与 transitions 记的是同一个节点：被派遣过的只有它',
    )
    const deferred = [...task.nodes.values()].filter((node) => node.execution.attempt === 0)
    assert.equal(deferred.length, 1, '写范围相交的另一个节点必须留在原地，等下一批')
    assert.equal(deferred[0].status, 'pending', '没被派遣的节点应当仍是 pending')
    assert.equal(deferred[0].execution.active_dispatch_id, null)
    assert.equal(deferred[0].execution.last_result_ref, null, '没被派遣过的节点不该有结果引用')
    const first = task.nodes.get(h.calls[0].node.id)
    assert.deepEqual(first.write_scope, ['lib/same.js'])
    // 被派遣的那一个在替身执行者当场报完之后是 `completed`。这一条同时说明了**原断言为什么
    // 会数到 0**：`dispatch` 把它置成 `in_progress`、紧接着 `applyResult` 把它置成 `completed`，
    // 等调用方拿到返回时那个瞬态早就过去了；另一个从未被派遣，还停在 `pending`。
    // 所以这一轮结束时的 `in_progress` 计数是 0，而它本该是「1 个被派遣」的意思。
    // 谁被派遣过只能从 `execution` 与 `transitions` 读，不能从 `status` 读。
    assert.equal(first.status, 'completed', '替身执行者当场跑完，节点不会停在 in_progress')

    // 串行是**顺序**而不是丢弃：第二批次把剩下的那个派出去，两者最终都完成。
    await h.tool.execute({ action: 'advance', task_id: 'REQ-SERIAL' }, h.exec)
    assert.equal(h.calls.length, 2, '剩下的节点必须在后一批被派遣，而不是永远不被派')
    // 重新读盘而不是复用上面那一份快照：任务是不可变对象，第二次 advance 之后旧引用已经过时。
    const settled = h.store.load('REQ-SERIAL')
    assert.deepEqual(
      h.calls.map((call) => call.node.id),
      ['T1', 'T2'],
      '两个节点都必须真的跑一遍，只是分了两批',
    )
    for (const node of settled.nodes.values()) {
      assert.equal(node.status, 'completed', `节点 ${node.id} 最终应当完成`)
      assert.equal(node.execution.attempt, 1, `节点 ${node.id} 只应被派遣一次`)
    }
  })

  it('子目录与前缀重叠也算冲突 —— `lib/` 与 `lib/deep/` 不会同批', async () => {
    // 写范围冲突的判据是**前缀语义**，不是字符串相等：一个节点写 `lib/`、
    // 另一个写 `lib/deep/`，后者整个落在前者之内，两者同时开工仍然会互相覆盖。
    const h = splitHarness()
    await createTask(h, 'REQ-PREFIX', [
      writer('T1', 'lib/'),
      writer('T2', 'lib/deep/'),
    ])
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-PREFIX',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)

    const value = await h.tool.execute({ action: 'advance', task_id: 'REQ-PREFIX' }, h.exec)
    assert.equal(h.calls.length, 1, '前缀重叠的两个节点不得同批开工')
    assert.deepEqual(value.classifications, ['accepted'])
  })

  it('串行不是失败：前一个跑完之后后一个才被派遣，两者最终都完成', async () => {
    const h = splitHarness()
    await createTask(h, 'REQ-THEN', [
      writer('T1', 'lib/same.js'),
      writer('T2', 'lib/same.js', { depends_on: [] }),
    ])
    await h.tool.execute({
      action: 'contract',
      contract_action: 'freeze',
      task_id: 'REQ-THEN',
      interface_contract: {
        name: 'a',
        operations: [{ name: 'a', signature: 'a(): void', behavior: '无副作用。' }],
      },
    }, h.exec)

    await h.tool.execute({ action: 'advance', task_id: 'REQ-THEN' }, h.exec)
    await h.tool.execute({ action: 'advance', task_id: 'REQ-THEN' }, h.exec)

    assert.deepEqual(h.calls.map((call) => call.node.id), ['T1', 'T2'], '串行执行必须走完两个节点')
    const task = h.store.load('REQ-THEN')
    assert.equal(task.nodes.get('T1').status, 'completed')
    assert.equal(task.nodes.get('T2').status, 'completed')
  })
})

describe('跨产品与测试路径仍被拒绝 —— 既有行为不得回退', () => {
  /**
   * 一个声明了测试路径的 harness。
   *
   * @returns {object}
   */
  function scopedHarness() {
    return splitHarness({ testPaths: ['test/'] })
  }

  it('单节点同时写产品与测试路径时，建任务当场被拒', async () => {
    // 这是本轮改动**不得触碰**的既有行为：新增的两条拆分判据都是提示，
    // 而这一条是拒绝。契约里写得很明确——`GAC_BUILDER_SCOPE_MIXED` 的拒绝行为必须保持不变。
    const h = scopedHarness()
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-MIXED',
        mode: 'standard_task',
        plan: {
          nodes: [{
            id: 'T1',
            objective: '把实现和它的测试一起写掉',
            required_capabilities: ['implementation'],
            write_scope: ['src/', 'test/'],
          }],
        },
      }, h.exec),
      (error) => {
        assert.equal(error.code, BUILDER_CODES.SCOPE_CLASS_MIXED)
        assert.match(error.message, /T1/u)
        assert.match(error.message, /任务未建立/u)
        return true
      },
    )
    assert.equal(h.store.load('REQ-MIXED'), undefined, '拒绝必须发生在落盘之前')
  })

  it('整仓写范围（"."）也仍然跨了两类', async () => {
    const h = scopedHarness()
    await assert.rejects(
      () => h.tool.execute({
        action: 'create',
        task_id: 'REQ-ALL',
        mode: 'standard_task',
        plan: {
          nodes: [{
            id: 'T1',
            objective: '随便改',
            required_capabilities: ['implementation'],
            write_scope: ['.'],
          }],
        },
      }, h.exec),
      (error) => {
        assert.equal(error.code, BUILDER_CODES.SCOPE_CLASS_MIXED)
        return true
      },
    )
  })

  it('拆成两个节点之后通过 —— 拒绝的用途正是把人引到这条路上', async () => {
    const h = scopedHarness()
    const value = await createTask(h, 'REQ-OK', [
      writer('S1', 'src/a.js'),
      writer('T1', 'test/a.test.js'),
    ])
    assert.equal(value.action, 'created')
  })

  it('适配器没声明测试路径时，跨类写范围照旧通过（不声明就不分类）', async () => {
    // 「没声明就完全不分类」是这条判据的边界：不声明不是「没有测试」，
    // 而是「本工程不区分这两类」。拆分判据不得把这个边界改掉。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-NODECL', [
      writer('T1', 'src/a.js', { write_scope: ['src/', 'test/'] }),
    ])
    assert.equal(value.action, 'created')
  })
})

describe('提示字段必须声明过 —— 否则整条返回会被输出校验拒掉', () => {
  it('命中判据时返回的每一个字段都在 output.schema 里声明过', async () => {
    // 活体踩到过三次：`plan_id`、`design_id`、审计视图各一次。输出的 `additionalProperties`
    // 是 `false`，所以一个没声明的字段会让**整条返回**被运行时拒掉——模型看到的是一句
    // `"value.xxx" is not a declared property`，而不是「你把任务拆得太细了」。
    // 而这里的单测因为 `defineTool` 是透传的，照样全绿。
    //
    // 这条用例把两端对起来：返回里出现什么，schema 里就必须声明什么。它对本轮新增的
    // 提示字段尤其要紧——提示本来就是「多返回一个字段」，而那正是这个坑的形状。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-SCHEMA', [
      writer('T1', 'lib/entry.js'),
      writer('T2', 'lib/entry.js'),
    ])
    assert.equal(value.action, 'created')

    const declared = Object.keys(h.tool.output.schema.properties)
    for (const key of Object.keys(value)) {
      assert.ok(
        declared.includes(key),
        `返回里的字段 ${key} 没有在 output.schema 里声明——在真实插件里整条返回都会被拒掉`,
      )
    }
  })

  it('未命中判据时的返回同样逐字段声明过 —— 两条路都别漏', async () => {
    // 只测「命中」那一侧会漏掉另一半：一个只在小任务上多返回的字段同样是活体缺陷，
    // 而它在命中路径的用例里根本不会出现。
    const h = splitHarness()
    const value = await createTask(h, 'REQ-SCHEMA-SMALL', [writer('T1', 'lib/small.js')])
    assert.equal(value.action, 'created')

    const declared = Object.keys(h.tool.output.schema.properties)
    for (const key of Object.keys(value)) {
      assert.ok(declared.includes(key), `返回里的字段 ${key} 没有在 output.schema 里声明`)
    }
  })
})
