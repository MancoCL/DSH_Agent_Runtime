/**
 * 原生子会话执行者：把节点**真正**交给宿主的一个独立子会话。
 *
 * @module dsh-gac-runtime/child-executor
 *
 * 它补的是哪一格
 * ------------
 * `createSessionExecutor()` 只是占位：它把节点置为 `in_progress` 就返回，真正的执行落回主会话——
 * 模型自己干完再手工 `report`。后果是「独立验证」在事实层面从未成立（Builder 与 Verifier 是同
 * 一个会话，只是 prompt 不同），「并行批次」也只是协调器算出来的批次。本模块把节点交给
 * `ctx.subagents.start()` 起的一个真子会话：**独立 session identity、独立 context、独立工具面、
 * 独立结果**，结果经 `SubagentResult` 回到 `applyResult()`。
 *
 * 决定与理由记在 `docs/ADR-0001-子会话执行载体.md`；这里只重复三条最容易忘的：
 *
 *  1. **不用自造执行器。** 不建 worker pool / daemon / queue：agent 与 session 的生命周期、传输、
 *     模型调用、工具执行、取消都归宿主。
 *  2. **不用 Agent Teams 当执行基座。** 它与原生子会话是**同一个基座上的两个消费者**
 *     （`spawn_teammate` → `ctx.agentTeams.spawnTeammate` → `ctx.subagents.startContinuable`），
 *     但它的看板没有 mode / 写作用域 / 证据 / 验证计划 / 风险升级，两套任务模型必然漂移；而且它的
 *     包不在本机 profile 的 junction 集里（插件解析不到）。它只能作为「跨轮、人在环」的可选交互面。
 *  3. **深度上限是相对的，不是写死的。** 上限取「调用方深度 + 1」，因此每次派遣只允许再开一层；
 *     而调用方自己可能是子会话（例如由 Team/子 agent 驱动 GAC 时会这样）。写死 `1` 会让「调用方
 *     已经是深度 1」的场景整个用不了——活体验收实测过：宿主回 `subagent depth 2 exceeds maxDepth 1`。
 *     深度来自会话头（与宿主同一个口径：`session.header.delegationDepth` 权威且单调，
 *     `AgentOptions.subagentDepth` 只能加深），读不到就交给宿主自己的配置上限，而不是猜一个。
 *
 * 工具面：角色决定它能看到什么（三层，缺一层都只是部分保证）
 * ------------------------------------------------
 *  1. **创建窗口的 `toolFilter`**（`roleToolFilterFor`）——在 `start()` 落定之前就已生效，因此
 *     呈现层面没有竞态。它只收得掉**继承面**上的工具（preset 层与全局层）。
 *  2. **`start()` 之后的对账补收 + 单调守卫**（`lib/child-surface.js`）——以子会话**自己的**真实视图
 *     为准，补上创建期漏掉的名字，并用 `tools.guard()` 拒掉内核 `restrict` 结构上收不掉的调用
 *     （子会话自己那层注册的工具、以及保留名 `run_code`）。
 *  3. **全局门禁**（`lib/plugin.js` 的 `preExecute` 按会话读角色）——单调兜底，且是「谁真的调了」这条
 *     审计事实的落点。
 *
 * 为什么不能只靠创建期那一层：派遣方算名单时用的是**父会话**的可收集合，而子会话的可收集合是父会话的
 * 超集（父会话自己那层注册的工具，对子会话而言是祖先贡献）。活体验收因此看到子会话仍拿得到
 * `subagent`——旧文档把它归因成「收不掉」，实际是**没点名**。
 *
 * 三条分支的输入/输出边界（测试设计、验证设计、验证执行）
 * ----------------------------------------------------
 * 这三条分支各自缺过一样东西，而且缺的样子都是「形状完全正常、只是依据不是那一份」：
 *
 *  1. **测试设计必须有工程事实，但不得有观测。** 它的预期要从需求与契约推导，所以工具面里没有
 *     `read`/`shell`（`ROLE_TOOL_POLICY.test_design`）；可它要写出「另一个人能照着做」的测试详设，
 *     就必须知道现有测试怎么跑、构建系统与测试入口是什么。这两件事**不矛盾**：依据由运行时**注入**
 *     文本，观测才由工具面收掉。此前提示词把这件事推回给子会话（「需要什么就在 summary 里说」），
 *     于是那份设计要么停在追问上，要么自己编一套跑法。
 *  2. **验证设计的输入基线是测试详设产物。** 它此前只拿得到验收标准与冻结契约；而「这份计划覆盖得
 *     够不够、反例真能抓住错实现吗、这些用例在现有测试入口下跑得起来吗」三个问题只有对着测试详设
 *     才答得上。基线是**补充依据，不是新依据**：预期仍然只能来自需求与冻结契约，测试详设只回答
 *     「落在哪、跑得起来吗」。据实现反推预期时，验证就退化成自我确认。
 *  3. **验证执行要给出失败归因。** 只记「挂了」的报告无法据以行动。归因落进
 *     `FAILURE_CLASSIFICATIONS` 六类闭集，并逐条带依据（证据引用或说明）——补分类、改分类、补依据
 *     是三件不同的事，合并成一句「归因不合法」就只能靠人读文本分辨。
 */

// 计划 id 是**内容寻址**算出来的（不在计划对象里），而验证节点必须把它原样回报回来，
// 所以由运行时算好交给它——见下面 `buildChildPrompt` 里那段注释（活体验收里那轮渲染成了
// 「id = (见盘上)」，子会话只能去读盘反推）。
import { FAILURE_CLASSIFICATIONS, planId } from './verification.js'
import { DESIGN_ROLE_ARTIFACTS, reviewSubjectOf } from './design.js'
import { CALL_KINDS, classifyCall } from './tool-targets.js'
import { deniedToolNamesFor, semanticRoleOf } from './role-tools.js'

/** 子会话 provider 的默认名：`dsh-subagent-spawn-in-process` 的配置默认值就是它。 */
const CHILD_PROVIDER_DEFAULT = 'spawn'

/** 所有子会话都必须具备的能力。缺任何一个都不该把它当执行者用。 */
const REQUIRED_CHILD_CAPABILITIES = Object.freeze([
  'outputSchema',
  'depthLimit',
  'agentOptions',
])

/**
 * 需要拿到**已冻结接口契约**的角色。
 *
 * 三个角色都靠需求侧事实推导，契约是其中最硬的一条：验证设计拿它推导方案，软件设计与测试设计拿它
 * 当实现约定。只在验证设计那一支里取契约，另外两个设计角色就只能自己发明约定——活体 `REQ-DD-3` 里
 * 软件详设写了 `claim_released`，而冻结契约与冻结计划都写 `released`；设计包的一致性核对查的是追溯
 * 编号，**查不出键名**，于是「实现照设计 → 验证计划必红」与「实现照契约 → 与已批准设计不一致」
 * 两条路都走不通，而冲突直到主会话裁决时才被发现。
 */
const CONTRACT_ROLES = Object.freeze(['verification_design', 'software_design', 'test_design'])

/**
 * 子会话必须回的产出契约。
 *
 * 结构化是刻意的：从散文里猜「它到底做成了没有」正是本仓库反复吃亏的地方。判定用 `status`，
 * `summary` 给人看，`artifacts` 是可选的产物清单（文件路径等）。
 *
 * **这是一份标准 JSON Schema，不是本仓库工具创作 DSL 的那种写法。** 两者的区别是实测踩出来的：
 * 工具产出契约里写 `{ type: 'string', required: true }`（`required` 在**属性内部**）是 DSL 的约定，
 * `defineTool` 接受它；而 `SubagentStartRequest.outputSchema` 交给的是宿主的**原始 JSON Schema 校验**，
 * 它按标准读——`required` 必须是对象层的数组。把它写成 DSL 那种，宿主的回答是
 * `unsupported JSON schema: schema.properties.status.required is not supported on type "string"`，
 * 而那次派遣会**在子会话创建之前**就被拒掉（活体验收实测：`advance` 只回一条裸 Error，节点停在
 * pending）。所以这里刻意写成标准形状，并有一条断言盯着它。
 */
export const CHILD_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
  },
})

/**
 * 给渲染用的那一行可追溯信息：子会话 id、（如有的）产物、这次绑了什么作用域，以及结论的**节选**。
 *
 * 抽出来是因为**失败分支也要给**——活体验收里子会话两件事都做对了、只是回报被门禁拒了，而返回
 * 文本里连子会话 id 都没有，父会话无从知道该去查谁。成功分支与失败分支共用同一句话，
 * 读者不必去分辨「这次失败能不能追」。
 *
 * 结论只放**节选**：返回文本要读得下去，全文另有出处（证据与子会话记录）。截断时明说截断了，
 * 而不是让读者以为那就是全部。
 *
 * @param {string} runId
 * @param {string} boundNote - 绑定说明（可能为空串）。
 * @param {string[]} [artifacts]
 * @param {string} [summary] - 子会话自己的结论。
 * @returns {string}
 */
function childDetail(runId, boundNote, artifacts = [], summary, routeNote = '') {
  const text = typeof summary === 'string' ? summary.trim() : ''
  const excerpt = text === ''
    ? ''
    : `；结论：${text.length <= CHILD_SUMMARY_EXCERPT ? text : `${text.slice(0, CHILD_SUMMARY_EXCERPT)}…（截断）`}`
  return `子会话 ${runId}`
    + `${artifacts.length === 0 ? '' : `；产物：${artifacts.join('、')}`}`
    + `${boundNote}`
    + `${routeNote}`
    + excerpt
}

/** 结论节选的上限（字符）。超出就截断并注明，不让返回文本被一整篇汇报淹掉。 */
const CHILD_SUMMARY_EXCERPT = 200

/** 子会话可以申报的三种结论。 */
const CHILD_VERDICTS = Object.freeze(['completed', 'failed', 'blocked'])

/**
 * 把适配器里声明的角色路由翻成宿主的 `AgentOptions`。
 *
 * 两处**必须**翻名字：适配器是 JSON，用 snake_case（`reasoning_effort`、`max_tokens`），而宿主收的
 * 是 `reasoningEffort`、`maxTokens`。翻错的表现是「配置写了但一点效果都没有」——宿主对多余的键
 * 不报错，静默忽略。
 *
 * 没有任何字段时返回 `undefined`：**不传 `agentOptions` 就是继承父会话**（宿主把子会话的选项合并
 * 在父 agent 的选项之上），而不是「传一个空对象」——空对象会把父会话的模型也一起清掉。
 *
 * @param {object|undefined} route
 * @returns {object|undefined}
 */
export function agentOptionsFor(route) {
  if (route === null || typeof route !== 'object') return undefined
  const options = {}
  if (typeof route.provider === 'string' && route.provider !== '') options.provider = route.provider
  if (typeof route.model === 'string' && route.model !== '') options.model = route.model
  if (typeof route.reasoning_effort === 'string' && route.reasoning_effort !== '') {
    options.reasoningEffort = route.reasoning_effort
  }
  if (Number.isSafeInteger(route.max_tokens) && route.max_tokens > 0) options.maxTokens = route.max_tokens
  return Object.keys(options).length === 0 ? undefined : options
}

/**
 * 这次派遣实际用的是哪个模型路由（给人看的一行）。
 *
 * 路由必须**看得见**：配错了模型、或者某个角色悄悄继承回了父会话的模型，都只能从这里发现。
 *
 * @param {object|undefined} options - `agentOptionsFor` 的结果。
 * @param {object|undefined} route - 适配器里声明的那一条（可能带 `provider` 而 `options` 里没有）。
 * @returns {string} 形如「；路由 provider/model」；没有路由时为空串。
 */
export function describeRoute(options, route) {
  if (options === undefined) return ''
  const parts = [
    options.provider ?? route?.provider,
    options.model ?? route?.model,
    options.reasoningEffort === undefined ? undefined : `推理 ${options.reasoningEffort}`,
    options.maxTokens === undefined ? undefined : `上限 ${options.maxTokens}`,
  ].filter((part) => part !== undefined)
  return `；路由 ${parts.join('/')}`
}

/**
 * 子会话的产出契约，**按角色分开**。
 *
 * 为什么不能一个万能 schema 塞满可选字段
 * ----------------------------------
 * `{status, summary, artifacts}` 只够做**传输**：它能把「做完了」带回来，带不回**语义产物**。
 * 真实 `REQ-HR-1` 已经证明这一点——四个节点全部 `completed`，而验证计划、逐条用例结论与复核报告
 * 仍然要父会话额外调用 GAC 工具手工登记（复核那次甚至是父会话重新读证据再补登的）。那是错误的
 * 职责边界：**子会话负责产生认知结果，运行时负责校验、持久化与推进状态**，而不是「子会话写一段
 * 散文、父会话再解释成产物」。
 *
 * 角色的判据是节点的 `role`（`lib/coordinator.js` 的 `NODE_ROLES`），不是能力名：同一个
 * `verification` 能力，设计节点产出的是**计划**，执行节点产出的是**逐条结论**。
 */
export const CHILD_OUTPUT_SCHEMAS = Object.freeze({
  implementation: CHILD_OUTPUT_SCHEMA,
  // 设计角色交回来的**是一份设计产物**，不是一段散文：产物名取自闭集（`lib/design.js` 的
  // `DESIGN_ARTIFACTS`），正文与追溯表分开。运行时据此编译成有身份的产物并落盘——「设计」因此成为
  // 一份可以被下游引用的记录，而不是某个 Agent 推理过程里的一段话。
  software_design: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'design'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
      summary: { type: 'string' },
      design: {
        type: 'object',
        required: ['artifact', 'content', 'traceability'],
        properties: {
          artifact: { type: 'string', enum: ['software_architecture', 'software_detail'] },
          content: { type: 'string' },
          traceability: {
            // 这里**不能**写 `minItems`：宿主的 `child:spawn` 只接受 type/oneOf/properties/required/
            // additionalProperties/items/enum/const 这八个约束关键字加注解，多写一个就在**建子会话之前**
            // 直接抛 `unsupported JSON schema`。2026-10-08 活体 `REQ-DD-2` 第一波里，四个设计节点全灭
            // 而 `verification_design` 照常成功——差别只在这个关键字（ADR §23 记着这次事故）。
            // 「追溯表不能为空」由 `lib/design.js` 的 `compileDesignArtifact` 在编译时判，那里才是它该待的地方。
            type: 'array',
            items: {
              type: 'object',
              required: ['criteria', 'where'],
              properties: {
                criteria: { type: 'string' },
                where: { type: 'string' },
              },
            },
          },
          unresolved_issues: {
            type: 'array',
            items: {
              type: 'object',
              required: ['issue', 'reason'],
              properties: {
                issue: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }),
  test_design: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'design'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
      summary: { type: 'string' },
      design: {
        type: 'object',
        required: ['artifact', 'content', 'traceability'],
        properties: {
          artifact: { type: 'string', enum: ['test_architecture', 'test_detail'] },
          content: { type: 'string' },
          traceability: {
            // 这里**不能**写 `minItems`：宿主的 `child:spawn` 只接受 type/oneOf/properties/required/
            // additionalProperties/items/enum/const 这八个约束关键字加注解，多写一个就在**建子会话之前**
            // 直接抛 `unsupported JSON schema`。2026-10-08 活体 `REQ-DD-2` 第一波里，四个设计节点全灭
            // 而 `verification_design` 照常成功——差别只在这个关键字（ADR §23 记着这次事故）。
            // 「追溯表不能为空」由 `lib/design.js` 的 `compileDesignArtifact` 在编译时判，那里才是它该待的地方。
            type: 'array',
            items: {
              type: 'object',
              required: ['criteria', 'where'],
              properties: {
                criteria: { type: 'string' },
                where: { type: 'string' },
              },
            },
          },
          unresolved_issues: {
            type: 'array',
            items: {
              type: 'object',
              required: ['issue', 'reason'],
              properties: {
                issue: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }),
  verification_design: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'plan'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
      summary: { type: 'string' },
      // 形状与 `compileVerificationPlan` 收的一致：反例必须写明 `expect_failure`，正例必须写明 `expect`。
      // 校验权在编译器那边——这里只负责让模型把该给的东西给出来。
      plan: {
        type: 'object',
        required: ['cases'],
        properties: {
          cases: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'covers', 'type'],
              properties: {
                id: { type: 'string' },
                covers: { type: 'array', items: { type: 'string' } },
                type: { type: 'string', enum: ['positive', 'falsification'] },
                expect: { type: 'string' },
                expect_failure: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }),
  verification_execution: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'plan_id', 'executions'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
      summary: { type: 'string' },
      plan_id: { type: 'string' },
      // 字段名与收口门禁收的一致（`evidence_ref` 单值，不是数组）。运行时自己签发证据号，
      // 子会话报「我跑了什么」，由运行时把它解析成真实发过的号。
      executions: {
        type: 'array',
        items: {
          type: 'object',
          // **归因三件套不写进 `required`，这是刻意的。** 它们只在非通过用例上才该出现：写成必需
          // 会让一条通过的用例先编一个归因出来；而宿主只接受 type/oneOf/properties/required/
          // additionalProperties/items/enum/const 这八个关键字，用 `if/then` 表达「失败时才必需」
          // 会在**建子会话之前**直接抛 `unsupported JSON schema`（ADR §23 那次事故）。
          // 「非通过用例必须给归因」由 `lib/verification.js` 的 `validateFailureClassification` 判，
          // 那里才判得准——它看得见 `outcome`，而 schema 看不见。
          required: ['case_id', 'outcome'],
          properties: {
            case_id: { type: 'string' },
            outcome: { type: 'string', enum: ['passed', 'failed'] },
            evidence_ref: { type: 'string' },
            // 失败归因：闭集取自 `lib/verification.js` 的 `FAILURE_CLASSIFICATIONS`，**不在这里另抄
            // 一份字面量**——抄一份就会在两边漂移，而漂移的表现是运行时把一份合法归因判成越界。
            failure_classification: { type: 'string', enum: [...FAILURE_CLASSIFICATIONS] },
            // 归因依据。`validateFailureClassification` 收的是「`evidence_ref` 或 `note` 二者之一」：
            // 前者指向运行时真实的观测，后者是不便取证时的文字依据。两个字段都要在这里声明，否则
            // `additionalProperties: false` 会把子会话给出的依据当成多余字段拒掉——那会让「有依据的
            // 归因」在传输层就被削成「无依据的归因」。
            note: { type: 'string' },
          },
        },
      },
    },
  }),
  review: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'verification_independence', 'engineering_quality'],
    properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
      summary: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      blocking_issues: { type: 'array', items: { type: 'string' } },
      engineering_quality: {
        type: 'object',
        required: ['reuse', 'duplication', 'unnecessary_abstraction', 'change_scope', 'dependency'],
        properties: {
          reuse: { type: 'string' },
          duplication: { type: 'string' },
          unnecessary_abstraction: { type: 'string' },
          change_scope: { type: 'string' },
          dependency: { type: 'string' },
        },
      },
      verification_independence: {
        type: 'object',
        required: [
          'builder_tests_only',
          'expectations_from_requirement',
          'falsification_present',
          'uncovered_criteria',
          'verifier_reran_builder_tests_only',
          'plan_modified_by_builder',
        ],
        properties: {
          builder_tests_only: { type: 'boolean' },
          expectations_from_requirement: { type: 'boolean' },
          falsification_present: { type: 'boolean' },
          uncovered_criteria: { type: 'array', items: { type: 'string' } },
          verifier_reran_builder_tests_only: { type: 'boolean' },
          plan_modified_by_builder: { type: 'boolean' },
        },
      },
    },
  }),
})

/**
 * 按节点的语义角色挑产出契约。
 *
 * 认不出的角色退到 Builder 契约——**不猜**：给一个未知角色套上「能产出计划」的契约，等于让一份
 * 散文被当成计划读。
 *
 * 但「退到 Builder」本身也是一次猜测，所以它不该是**唯一**的防线：`nodeRoleOf` 只放行
 * `NODE_ROLES` 里的角色，因此「角色在词表里、却没有产出契约」是一种程序错误。那条不变式由测试钉住
 * （`test/child-executor.test.js` 断言 `NODE_ROLES` 每一项都有契约），于是漏加会在测试里当场红，
 * 而不是等到某个子会话白跑一趟、交回一份没有产物的报告才发现。
 *
 * @param {object|undefined} node
 * @returns {object}
 */
export function childOutputSchemaFor(node) {
  const role = typeof node?.role === 'string' ? node.role : 'implementation'
  return CHILD_OUTPUT_SCHEMAS[role] ?? CHILD_OUTPUT_SCHEMA
}

/**
 * 按**语义角色**算出子会话创建窗口的工具过滤。
 *
 * 判据是语义角色（`lib/role-tools.js`），**不再**从「写范围是否为空」推导：`verification_design`
 * 与 `verification_execution` 的写范围都是空的，前者必须连 `read`/`grep`/`glob`/`pwsh` 都不许，
 * 后者必须能读、能跑用例——一个空数组说不出这个区别。代价已经真实发生过：真实 `REQ-HR-5` 里设计
 * 子会话启动时确实没被推入实现信息，但它**自己**用 `read` 把实现产物读了回来（`hr5-artifact.txt`
 * 的 `Length=3`），推理里出现「3 bytes = ok\n likely」。独立性因此不成立，而独立性正是这整套架构
 * 要买的东西。
 *
 * 与角色**无关**的那一半仍然成立，并已并进角色策略表：任何子会话都不该委派（`subagent` /
 * `subagent_fork` / `workflow` / `spawn_teammate` / `send_message` / `team_task_*`），也都不该碰
 * 派遣方的协调状态（`gac_task` / `gac_scope` / `gac_project` / `gac_metrics` / `gac_evidence`）。
 * 那条纪律的来源是一次活体验收：子会话里也有 `gac_*`（插件是宿主级的），于是它自己声明作用域、并
 * 试着回报它那一侧的派遣；它的产出里写着「A1 的回报被判 stale、T1 停在 blocked」，而父侧权威状态
 * 是 completed——父侧没被污染，但这件事不该靠运气。
 *
 * 收不掉的那一类在这里**故意不点名**：`run_code` 是内核保留名，`restrict` 点名它会直接抛错，代价是
 * 整次子会话创建失败。它由 `lib/child-surface.js` 装在子会话自己层上的单调守卫拒。
 *
 * 这个过滤器只做得掉**继承面**上的工具；子会话自己那一层注册的工具（宿主的 Team 工具）要靠
 * `child-surface` 的对账补收与守卫，或全局门禁那一层。
 *
 * @param {object|undefined} node
 * @param {readonly string[]|undefined} inheritableNames - 父会话的可收集合；undefined 表示读不出来。
 * @returns {{deny: string[]}|undefined} 没有可点名者、或读不出可收集合时返回 undefined（调用方会把
 *   「角色工具面没生效」如实记进结果，而不是假装设上了）。
 */
export function roleToolFilterFor(node, inheritableNames) {
  if (!Array.isArray(inheritableNames)) return undefined
  const deny = deniedToolNamesFor(node, inheritableNames)
    .filter((name) => classifyCall(name, {}).kind !== CALL_KINDS.PTC)
  return deny.length === 0 ? undefined : { deny }
}

/**
 * 读一个 agent 的委派深度。
 *
 * 与宿主同一口径（`dsh-subagent` 的 `delegationDepthOf`，模块注释说明它就是给「不想 import 注册表
 * 的组合辅助」用的）：会话头里的 `delegationDepth` 是权威且**单调**的，`AgentOptions.subagentDepth`
 * 只能加深——一个被恢复的子会话带着全新的 options 回来，若从零重算，它就会像顶层一样继续委派。
 *
 * 读不出来时返回 undefined：**不猜**。调用方据此把上限交给宿主自己的配置（`resolveMaxDepth`），
 * 而不是拿一个写死的数字顶上去——写死 `1` 正是活体验收里那次 `depth 2 exceeds maxDepth 1` 的来源。
 *
 * @param {object|undefined} agent
 * @returns {number|undefined}
 */
export function parentDelegationDepth(agent) {
  const candidates = [agent?.session?.header?.delegationDepth, agent?.options?.subagentDepth]
  const usable = candidates.filter((value) => Number.isSafeInteger(value) && value >= 0)
  return usable.length === 0 ? undefined : Math.max(...usable)
}

/**
 * 子会话的人格段。
 *
 * 它进的是子会话**自己的**系统提示（provider 把它装成 `deployment:persona-prefix` 段），因此不能
 * 复用 `buildSystemPrompt`——那一份是给「没有写工具的进程内执行者」写的，里面明说「你没有任何写入
 * 工具」。把那段交给一个有工具的 Builder，等于让它以为不该写文件。
 *
 * @param {object} node
 * @returns {string}
 */
export function buildChildPersona(node) {
  const writes = Array.isArray(node?.write_scope) ? node.write_scope : []
  return [
    '你是 GAC 运行时派出的一个执行者，跑在自己的会话里。',
    '你有工具，也应当用工具把活儿真做完——不要只交一份说明。',
    writes.length === 0
      ? '本节点没有写范围：不得写任何文件。'
      : `只能写 [${writes.join(', ')}] 之内的路径；越界的写入会被拒绝。`,
    '做完之后按给定结构汇报：status、summary、以及（如有的）artifacts。',
  ].join('')
}

/**
 * 子会话的任务提示词。
 *
 * 子会话**没有父会话的上下文**（`spawn` 提供者的 `inheritsParentContext` 为 false），所以这份提示词
 * 必须自包含：节点契约、验收标准、写范围、期望产物、以及停止条件都要在这里讲清。刻意不塞的东西：
 * 完整聊天历史、Verifier 的私有推理、Reviewer 的私有推理、整个仓库的全文、无关的历史任务。
 *
 * @param {object} input
 * @param {object} input.node
 * @param {object} input.task
 * @param {string} input.root
 * @param {string} input.dispatchId
 * @param {object} [input.contract] - 已冻结的接口契约。靠需求侧事实推导的三个角色（验证设计、
 *   软件设计、测试设计）都要用它：验证设计拿它推导方案，两个设计角色拿它当实现约定。
 *   契约里的名字与形状是硬约束——不交给设计角色，它们只能自己发明一套。
 * @param {string} [input.requirement] - 冻结需求里的**需求正文**（用户原话）。验收标准只存编号，
 *   编号本身不表达意思，所以正文是那些读不到实现的角色唯一的依据来源。
 * @param {string} [input.engineering_facts] - **工程的测试与构建入口**（测试怎么跑、构建与测试入口是
 *   什么、有哪些可直接调用的能力）。只有 `test_design` 用它：它的工具面里没有 `read`/`shell`，而
 *   一份写不出「怎么跑」的测试详设等于把这件事推给下游去猜。注入的是文本，不是工具面。
 * @param {object} [input.test_detail] - **测试详设产物**（`compileDesignArtifact` 编译过的那一份，
 *   含 `artifact` / `content` / `ref` / `traceability`）。只有 `verification_design` 用它，作为
 *   「覆盖 / 反例 / 执行力」三项检查的输入基线。传的是**产物**而不是散文：`artifact` 与 `ref` 是它
 *   在盘上的身份，计划因此能说清自己对的是哪一版详设。
 * @param {object} [input.plan_cases] - 已冻结计划里已有的用例（`{id, covers, type}` 即可），让验证
 *   设计在**既有结构内**做检查与补全。**不新增用例模型**：产出仍然是 `plan.cases`。
 * @returns {string}
 */
export function buildChildPrompt({
  node,
  task,
  root,
  dispatchId,
  contract,
  criteria: passedCriteria,
  plan,
  requirement: passedRequirement,
  engineering_facts: passedEngineeringFacts,
  test_detail: passedTestDetail,
  plan_cases: passedPlanCases,
}) {
  const writes = Array.isArray(node?.write_scope) ? node.write_scope : []
  const artifacts = Array.isArray(node?.expected_artifacts) ? node.expected_artifacts : []
  const criteria = Array.isArray(passedCriteria)
    ? passedCriteria
    : (Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : [])
  // 需求正文交给**每一个**子会话，而不只是设计角色：它是这个任务的需求侧依据，Builder 与验证执行者
  // 同样照着它干活。对读不到实现的角色尤其致命——它们除了这里给的事实之外没有任何别的依据，
  // 而验收标准只存编号（AC1…），编号不表达「这条说的是什么」。
  const requirement = typeof passedRequirement === 'string' && passedRequirement.trim() !== ''
    ? passedRequirement
    : (typeof task?.requirement === 'string' ? task.requirement : '')
  // 正文缺席（早期任务可能如此）时**不能装作没有这回事**：照编号猜出来的方案与计划在形状上完全
  // 正常，只有覆盖的是别的东西。让它成为子会话必须讲出来的一个缺口，而不是一次静默的猜测。
  const requirementNote = requirement.trim() === ''
    ? ['**本任务没有记下需求正文**（只有验收标准的编号）。编号不表达意思，'
      + '请在 summary 里明确指出这一缺口，不要照编号猜每条说的是什么。']
    : []
  // 编号与含义的对应**只**存在于正文里（`freezeRequirement` 要求正文逐条写出每条标准）。读不到实现的
  // 角色拿到的就是这两样事实，所以这里把对应关系在哪说明白，免得它自己编一套——编错是静默的：
  // 方案照样产出、覆盖检查照样按编号通过，测的却是别的东西（2026-10-08 活体 `REQ-DD-2` 的原样）。
  const criteriaNote = requirement.trim() === '' || criteria.length === 0
    ? []
    : ['上面那份需求正文里逐条写着每条验收标准的含义：`AC1` 这类编号对应的是哪一条，'
      + '一律以正文为准，不要自己给编号另配一套含义。']
  // 契约摘要：**名字、签名与行为都要给**。只给名字与签名时，写在 `behavior` 里的载荷形状对设计角色
  // 完全不可见，它们只能自己发明一套——而发明出来的名字不会在设计门禁上暴露，要到验证阶段才以
  // 「用例红」的形式炸出来（2026-10-08 活体 `REQ-DD-3`：两份设计写 `claim_released`，冻结契约与
  // 冻结验证计划都写 `released`；设计包的一致性核对查的是追溯编号，查不出键名对不上）。
  const contractLines = (frozen) => {
    const operations = Array.isArray(frozen?.operations) ? frozen.operations : []
    return [
      `已冻结的接口契约：${frozen.name ?? '(未命名)'}，${operations.length} 个操作。`,
      '契约里写死的名字与形状是**硬约束**：事件类型名、载荷键名、返回字段名一律逐字沿用，'
        + '不要另起一个名字，也不要自己补一个契约里没有的字段。',
      ...operations.map((op) => `- ${op.name}${op.signature === undefined ? '' : `：${op.signature}`}`
        + `${op.behavior === undefined ? '' : `（${op.behavior}）`}`),
    ]
  }
  // 工程事实（测试怎么跑、构建与测试入口是什么、有哪些能力）由派遣方以文本注入，供 `test_design`
  // 使用。**注入文本不等于放开工具面**：这个角色的策略表里 `READ`/`SHELL` 照旧全禁（见
  // `lib/role-tools.js` 的 `ROLE_TOOL_POLICY.test_design`），而它写测试详设又必须知道这些。
  // 断言「两件事不是互相抵消」的是 `test/child-executor.test.js` 那组盲化边界反例。
  const engineeringFacts = typeof passedEngineeringFacts === 'string' ? passedEngineeringFacts.trim() : ''
  // 测试详设产物的正文可能很长，而提示词要读得下去；截断时明说截断了，免得读者以为那就是全部。
  const TEST_DETAIL_EXCERPT = 4000
  const testDetail = passedTestDetail !== null && typeof passedTestDetail === 'object' ? passedTestDetail : undefined
  const testDetailBaselineLines = () => {
    if (testDetail === undefined) {
      return [
        '**本次派遣没有带上测试详设产物**：因此你只能按需求与契约写出计划，'
        + '无法核对「既有用例是否够用、反例是否真能抓住错实现、这些用例在现有测试入口下跑不跑得起来」。'
        + '请在 summary 里明确写出这一缺口。',
      ]
    }
    const content = typeof testDetail.content === 'string' ? testDetail.content : ''
    const excerpt = content.length <= TEST_DETAIL_EXCERPT
      ? content
      : `${content.slice(0, TEST_DETAIL_EXCERPT)}…（截断，全文见产物 ${testDetail.ref ?? '(无引用)'}）`
    const traceability = Array.isArray(testDetail.traceability) ? testDetail.traceability : []
    return [
      `作为输入基线的**测试详设产物**：\`${testDetail.artifact ?? 'test_detail'}\``
        + `${testDetail.ref === undefined ? '' : `（${testDetail.ref}）`}。`,
      ...(traceability.length === 0
        ? []
        : ['它的追溯表（它自称支撑哪条验收标准、落在正文哪里）：',
          ...traceability.map((entry) => `- ${entry?.criteria}：${entry?.where}`)]),
      '正文如下：',
      excerpt,
    ]
  }
  // 既有用例（如果这次派遣带了）。**复用既有 VerificationPlan 结构**：补全的产出仍然是
  // `plan.cases`（`{id, covers, type, expect?, expect_failure?}`），不新增用例模型——每多一种模型，
  // 收口门禁就得再学一遍「哪一份才算数」。
  const planCases = Array.isArray(passedPlanCases) ? passedPlanCases : []
  const describePlanCase = (entry) => `- ${entry?.id}（covers ${(entry?.covers ?? []).join('、')}，`
    + `${entry?.type}）：${entry?.type === 'falsification'
      ? `反例，应当被抓住的错误实现：${entry?.expect_failure}`
      : `期望：${entry?.expect}`}`
  const lines = [
    `项目根目录：${root}`,
    `任务：${task.task_id}（模式 ${task.mode}）`,
    `节点：${node.id} — ${node.objective}`,
    `本次派遣标识：${dispatchId}`,
    node.depends_on === undefined || node.depends_on.length === 0
      ? '本节点无前置依赖。'
      : `前置节点：${node.depends_on.join('、')}（均已完成）。`,
    writes.length === 0
      ? '写范围：空——本节点不得写任何文件。'
      : `写范围：只能写 [${writes.join(', ')}] 之内的路径。`,
    artifacts.length === 0 ? '期望产物：无特别要求。' : `期望产物：${artifacts.join('、')}。`,
    requirement.trim() === ''
      ? '需求正文：**本任务没有记下需求正文**（见下）。'
      : `需求正文（用户原话）：${requirement}`,
    ...criteriaNote,
  ]

  // 设计节点是**计划的作者**，因此它需要的是需求侧的事实，而不是实现侧的事实：验收标准与冻结契约。
  // 这两样都在它的提示词里，所以它可以不读仓库就把方案写出来——而「不读仓库」正是它保持盲的机制
  // （见 ADR §12：并发的设计节点只有结构性盲，晚冻的计划才仍然独立于实现）。
  //
  // 上一轮起它的输入多了一样：**测试详设产物**。它补的是「方案够不够用」这一类问题——覆盖有没有
  // 空洞、反例是不是真能抓住错实现、这些用例在既有测试入口下跑不跑得起来——这三样都只有对着测试
  // 详设才答得上，而它们又都不需要看实现。基线是**补充依据**，不是新依据：见下面那段「预期从哪来」。
  if (node?.role === 'verification_design') {
    lines.push(`工程测试与构建事实：${engineeringFacts || '未登记，必须报告缺口。'}`)
    lines.push(
      criteria.length === 0
        ? '验收标准：本任务没有登记验收标准——请先按需求写出方案，并在 summary 里指出这一缺口。'
        : `验收标准（每条都要有正例与反例）：${criteria.join('、')}。`,
      ...requirementNote,
    )
    if (contract !== undefined && contract !== null) lines.push(...contractLines(contract))
    lines.push(
      ...testDetailBaselineLines(),
      planCases.length === 0
        ? '要补全的对象是**空的**：这条链上还没有任何既有用例，请从上面的需求侧事实从头写出 `plan.cases`。'
        : ['要检查与补全的既有用例（本次派遣带上来的那一份）：',
          ...planCases.map(describePlanCase)],
      '你要交的是一份**验证方案**：`plan.cases` 里每条用例给出 id、covers（它证明哪条验收标准）、'
      + 'type（positive 或 falsification），正例写明 expect、反例写明 expect_failure。'
      + '**沿用这个结构交付补全后的完整计划，不要另造一套用例结构**：收口门禁、计划身份与证据解析'
      + '认的都是 `plan.cases`，多一种模型只会让「哪一份才算数」变成一个需要猜的问题。'
      + '（既有用例若已经够用就原样保留它们的 id 与措辞——计划是按内容算身份的，改一个字就换一份。）',
      '**预期从哪来（这条没有例外）**：每条用例的 `expect` / `expect_failure` 只能从上面的需求正文、'
      + '验收标准与冻结契约推导，**不得从实现反推**——包括不得把实现当前的行为写成期望。'
      + '上面那份测试详设只回答三件事：这条用例**落在哪**、这条验收标准**有没有被覆盖**、'
      + '这些用例**在现有测试入口下跑不跑得起来**。它对「正确应该是什么」没有发言权。',
      '按这三件事逐项检查，并把检查结论写进 summary（缺的补进 plan）：'
      + '① **覆盖**——每条验收标准至少一条正例、一条反例，指名到具体是哪条标准缺；'
      + '② **反例**——每条 `expect_failure` 都要说得出「什么样的错误实现会被它抓住」，'
      + '说不出具体错误形态的反例是一个更弱的正例；'
      + '③ **执行力**——每条用例在现有测试入口与能力下**跑得起来**，跑不起来的要写明缺什么'
      + '（不要写成一条无法执行的用例，那会让执行节点只能报「跑不了」）。',
      '方案必须只依据上面的需求侧事实推导——**不要**去读实现。',
    )
  }

  // 设计节点（软件设计 / 测试设计）：它交回来的**是一份设计产物**，不是对代码的修改。产物名取自节点
  // 声明的期望产物，运行时按「角色能写哪几份」核对（`roleMayAuthorArtifact`）——所以这里必须把名字
  // 说死，否则子会话只能猜，而猜错的名字会被判越界、整份产物作废。
  if (node?.role === 'software_design' || node?.role === 'test_design') {
    const authored = DESIGN_ROLE_ARTIFACTS[node.role] ?? []
    const expected = artifacts.find((name) => authored.includes(name))
    lines.push(
      criteria.length === 0
        ? '验收标准：本任务没有登记验收标准——请按需求写出设计，并在 summary 里明确指出这一缺口。'
        : `验收标准（设计必须覆盖它们）：${criteria.join('、')}。`,
      ...requirementNote,
    )
    if (contract !== undefined && contract !== null) lines.push(...contractLines(contract))
    lines.push(
      expected === undefined
        ? `你要交的是一份**设计产物**：\`design.artifact\` 取 ${authored.join(' 或 ')} 之一。`
        : `你要交的是设计产物 \`${expected}\`：\`design.artifact\` 就填这个名字，正文写在 \`design.content\`。`,
      '正文要写到**另一个人能照着做**的程度：它会先被冻结、再被批准，然后成为实现与验证的依据。'
        + '含糊的正文不会在下游被发现，只会变成两种互不相同的实现。',
      '`design.traceability` 逐条回答「这份产物支撑哪条验收标准（criteria）、落在正文的哪里（where）」。'
        + '**上面列出的每条验收标准都要在 traceability 里出现一次**，不能空着——空表会让下游的'
        + '「没填」与「真的不一致」看起来一样。'
        + '`criteria` 一律写**裸编号**（`AC1`、`AC2`…），不要写「AC1（见契约 op1）」这类带解释的长字符串'
        + '——设计包的一致性核对是**逐字比对**编号的，带解释会让它认不出来。',
      node.role === 'software_design'
        ? '架构与详设的一致性由运行时逐条核对：架构产物在 `traceability` 里承诺过的每条 criteria，'
          + '详设产物必须原样出现同一条。所以既不要让详设少列一条，也不要让架构承诺你不打算实现的东西。'
        : '测试架构与测试详设的一致性由运行时逐条核对：测试架构在 `traceability` 里承诺过的每条 criteria，'
          + '测试详设必须原样出现同一条。所以既不要让测试详设少列一条，也不要让测试架构承诺不打算测的东西。',
      '不要在设计里规定**新增或删除哪些文件**：实现节点能写哪些路径由任务图给定，设计只描述行为与'
        + '结构。要求一个写范围之外的新文件，实现节点既写不出来、也过不了验证——活体 `REQ-DD-3` 里'
        + '软件架构的追溯要求新增 `test/scope-audit.test.js`，而测试架构明确说不新增测试文件、任务图里'
        + '实现节点的写范围也不含它，于是两份已冻结的设计互相打架。',
      '正文里确实留着没解决的问题，就写进 `design.unresolved_issues`（每条给出是什么、以及为什么可以'
        + '先不解决）——留在正文里的一句话不会被任何门禁看见，而它会变成实现阶段的一次猜测。',
    )
    if (node.role === 'test_design') {
      lines.push(
        '**你没有读仓库的工具，这是刻意的**：测试设计的预期必须从上面的需求与契约推导。'
        + '读本次实现会让预期照着实现写，那样证明的是「实现自洽」，而不是「实现正确」。',
      )
      // 工程事实由**运行时注入**，而不是让它去翻仓库，也不是让它回去追问：
      //  - 去翻仓库不行——那正是工具面要收掉的东西；
      //  - 追问也不行——早先的提示词是「需要什么就在 summary 里写明，由运行时决定是否提供」，
      //    于是这份设计要么停在一次追问上（而 summary 是**结论**，不是提问通道），要么自己编一套
      //    跑法写进详设，然后被下游照着执行。
      // 注入的是**文本**，与工具面无关：它照旧拿不到 `read`/`shell`。
      lines.push(
        engineeringFacts === ''
          ? '**本次派遣没有带上工程的测试与构建事实**（现有测试怎么跑、构建系统与测试入口是什么、'
            + '有哪些可直接调用的能力）。一份不知道「怎么跑」的测试详设会把这件事推给下游去猜，'
            + '所以请在 summary 里**明确写出这一缺口**，并只描述你有依据的那部分——不要凭空编一套'
            + '跑法、命令或入口路径。'
          : ['工程的测试与构建事实（由运行时提供，是这次派遣的**依据**之一；'
            + '你没有读仓库的工具，这份事实就是你看不到的那部分工程现状）：', engineeringFacts].join('\n'),
      )
    }
  }

  // 验证执行节点：它执行的是**已冻结的计划**，所以计划必须原样交到它手里（连同计划 id，因为
  // 它要把 id 回报回来，收口门禁正是拿它核对「这份结论对应的是当前那份计划吗」）。
  if (node?.role === 'verification_execution') {
    if (plan === undefined || plan === null) {
      lines.push('**本任务还没有冻结的验证计划**：先让设计节点产出计划，再来执行。')
    } else {
      const cases = Array.isArray(plan.cases) ? plan.cases : []
      // 计划 id 是**内容寻址算出来的**，不在计划对象里（写进去会让它依赖自己）。运行时代它算好：
      // 活体验收里那轮提示词渲染成了「id = (见盘上)」，子会话只能去读盘反推——那是运行时该给的
      // 事实，不是让子会话猜的。
      lines.push(
        `要执行的**已冻结验证计划**：id = ${planId(plan)}，共 ${cases.length} 条用例。`,
        ...cases.map((entry) => `- ${entry.id}（covers ${(entry.covers ?? []).join('、')}，${entry.type}）：`
          + `${entry.type === 'falsification' ? `反例，应当被抓住的错误实现：${entry.expect_failure}` : `期望：${entry.expect}`}`),
        '逐条执行并逐条给出结论。汇报里的 `plan_id` 必须是上面这个 id；每条用例给 `case_id`、'
        + '`outcome`（passed / failed）与 `evidence_ref`。',
        // **一条都不能少**：活体验收里子会话报了 8 条用例的结论，却只在结构化字段里放了 5 条，
        // 于是整份报告被拒（缺 C2/C3/C6 的执行证据）——它自己以为交齐了。这条必须写死。
        `**${cases.length} 条用例每一条都必须出现在 executions 里，一条都不能少**：`
        + '缺一条整份报告都会被拒，你此前的结论也就白做了。',
        // 证据号由**运行时**签发，子会话看不到它——所以这里给的是子会话能自己数出来的东西：
        // 它本会话第几次工具调用。运行时拿这个序号去自己那份证据日志里取出真实签发过的号，
        // 解析不出来就判这条用例缺证据（收口门禁会拒），而不是把一份猜出来的引用放过去。
        '`evidence_ref` 的写法：`self:<n>`，n 是**你本会话第 n 次工具调用**的序号（从 1 开始，'
        + '只数你自己发起的调用）。例如你第 3 次调用跑了一条用例，就写 `self:3`。'
        + '**每条用例必须引用各自那次调用**——两条用例共用同一份证据会被判「取证摊薄」而整份被拒'
        + '（活体验收里那轮正是这样：`ev-1100` 同时被 C4、C7 引用）。'
        + '**不要**去读 `.dsh/gac/evidence/` 下的文件挑号：那是运行时的账本，你抄来的号不一定属于'
        + '你自己那次调用。'
        // 摊薄的另一种形态是「一条命令顺手跑了三条用例」：形式上每条都引用了自己那次调用，可实际上
        // 三条用例只有一个观测。判据要说得出口，否则它只是一句劝告。
        + '**每条用例必须引用可识别的结果条目**：批量执行用 TAP 输出，并用 self:<n>#tap:<输出行号> 引用实际通过的条目；笼统 PASS 不能覆盖多条用例。'
        + '同一条目不能被多条用例复用；'
        + '不能解析逐项结果时单独执行相应检查，不用重复引用冒充覆盖。',
        // 失败归因：只记「挂了」的报告无法据以行动——没人知道该去改产品、改测试还是修环境。
        // 闭集与依据这两条规则都由 `lib/verification.js` 的门禁判，两处不各写一套。
        '**非通过的用例必须给出失败归因**，两个字段都要：'
        + '`failure_classification` 从这六类里**选且只选一类**——'
        + '`product_implementation`（产品实现不对，产品侧要改）、'
        + '`test_implementation`（用例本身写错了：断言逻辑、驱动方式；产品可能没问题）、'
        + '`test_expectation`（用例实现没问题，但期望值本身是错的：期望与验收标准不一致）、'
        + '`build_environment`（构建或运行环境的问题：编译器、依赖、路径、工具链）、'
        + '`external_resource`（外部依赖不可用：网络、第三方服务、硬件、上游数据源）、'
        + '`evidence_insufficient`（拿不出足够证据判断是谁的问题——这是**诚实**的一类，'
        + '它让「查不清楚」也能被结构化记录，而不是被硬塞进上面某一类冒充结论）。',
        '**逐条给出归因依据**：`failure_classification` 是判断，不是证据。举证用 `evidence_ref`'
        + '（指向运行时真实的观测），或者用 `note` 写下那次观测里看到的东西'
        + '（实际输出、报错原文、与期望的差异）——**两者至少要有一个**。'
        + '分类合法却既无 `evidence_ref` 也无 `note` 的归因会被判「无从复核」而拒掉整份报告；'
        + '而缺分类与分类越界各自也是一个拒因——补分类、改分类、补依据是三件不同的事，'
        + '所以别把它们混成一句「大概是环境问题」。',
      )
    }
  }

  if (node?.role === 'review') {
    const subject = reviewSubjectOf(node)
    lines.push(
      '你要交的是一份**独立复核报告**：六个独立性提问与五个工程质量维度**逐条作答**（形状见产出契约），'
      + '外加 `summary`、`evidence`（用 `self:<n>` 引用你本会话的工具调用）与 `blocking_issues`。'
      + '答不了的如实说——一份记录了「验证方法有洞」的报告是有价值的事实，而方向自反或留下阻塞问题的'
      + '报告会在收口时被拦下。',
      `这份复核针对的是`
        + `${subject === 'design' ? '**设计产物**（四份设计正文与设计包），不是这次实现写出来的代码' : '**这次实现**'}。`
        + '复核对象由运行时按这个节点声明的产物判定，不需要你另填字段。',
    )
  }

  lines.push(
    '停止条件：目标达成，或你确信做不下去。两者都要按结构汇报，不要留半截状态。',
    '汇报必须包含 status（completed / failed / blocked）、summary（你做了什么、看到了什么、结论'
      + '是什么、还有哪些没做），以及该角色要求的结构化字段。',
  )
  return lines.join('\n')
}

/**
 * 一个节点该不该由子会话承载。
 *
 * 阶段 1 只承载需要写文件的节点。判据是**声明的写范围**，不是能力名——写范围是计划里唯一可核对的
 * 事实，用能力名会让一个同样要写文件却没叫 `implementation` 的节点落回主会话。
 *
 * @param {object|undefined} node
 * @returns {boolean}
 */
export function needsChildSession(node) {
  return Array.isArray(node?.write_scope) && node.write_scope.length > 0
}

/**
 * 这份任务里有哪些「非实现」节点（设计 / 验证执行 / 复核），返回它们的节点 id。
 *
 * 用来决定接缝缺席时**能不能降级**：只要任务里有任何一个非实现节点，独立性就是它存在的理由，
 * 主会话代跑等于把独立验证换成自我验证——那正是整套 Runtime 要结束的状态。
 *
 * 节点表在不同入口下可能是 `Map`（编译后的任务是 `Map`）、数组或普通对象；读不出来时返回
 * `undefined`，由调用方把「判不准」如实写进结果，而不是当成「没有独立节点」。
 *
 * @param {object|undefined} task
 * @returns {string[]|undefined} 非实现节点的 id；节点表读不出来时是 `undefined`。
 */
function independentNodesIn(task) {
  const nodes = task?.nodes
  let list
  if (nodes instanceof Map) list = [...nodes.entries()]
  else if (Array.isArray(nodes)) list = nodes.map((peer) => [peer?.id, peer])
  else if (nodes !== undefined && nodes !== null && typeof nodes === 'object') list = Object.entries(nodes)
  else return undefined
  return list
    .filter(([, peer]) => semanticRoleOf(peer) !== 'implementation')
    .map(([id, peer]) => (typeof id === 'string' && id !== '' ? id : String(peer?.id ?? '?')))
}

/**
 * 读一眼子会话接缝的可用性，用于加载报告。
 *
 * 与 `witness-seam` 同一个形态：**接缝缺席要留痕**，否则「派遣已经交给子会话了」会变成一句
 * 没有依据的话（本仓库在观测源上吃过这个亏）。
 *
 * @param {object|undefined} subagents
 * @param {string} [providerName]
 * @returns {{available: boolean, provider?: string, providers: string[], capabilities?: object, reason?: string}}
 */
export function describeChildSeam(subagents, providerName = CHILD_PROVIDER_DEFAULT) {
  if (subagents === undefined || subagents === null) {
    return { available: false, providers: [], reason: 'ctx.subagents 服务不在（本机没装配子会话运行时）' }
  }
  if (typeof subagents.list !== 'function' || typeof subagents.start !== 'function') {
    return { available: false, providers: [], reason: 'ctx.subagents 没有 start()/list()，接缝形状不符' }
  }
  let providers = []
  try {
    providers = subagents.list()
  } catch (error) {
    return {
      available: false,
      providers: [],
      reason: `读 provider 列表失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const provider = providers.includes(providerName) ? providerName : providers[0]
  if (provider === undefined) {
    return { available: false, providers, reason: '没有任何子会话 provider 注册' }
  }
  const capabilities = typeof subagents.getProvider === 'function'
    ? subagents.getProvider(provider)?.capabilities
    : undefined
  const missing = REQUIRED_CHILD_CAPABILITIES.filter((name) => capabilities?.[name] !== true)
  if (missing.length > 0) {
    return {
      available: false,
      providers,
      provider,
      capabilities,
      reason: `provider ${provider} 缺少能力：${missing.join('、')}`,
    }
  }
  return { available: true, provider, providers, capabilities }
}

/**
 * 造一个原生子会话执行者。
 *
 * @param {object} deps
 * @param {() => object|undefined} deps.subagentsFor - 取 `ctx.subagents`（注入而非 import：这条
 *   接缝可能不在，缺席时要能优雅降级，而不是让插件加载失败）。
 * @param {string} [deps.providerName]
 * @param {(agent: object) => string[]|undefined} [deps.namesFor] - 读父会话的可收集合，用于算角色
 *   工具面。省略或读不出来时**不设**工具面，并把这件事记进结果。
 * @param {object} [deps.surface] - 子会话工具面的对账与守卫（`lib/child-surface.js` 的
 *   `createChildSurface()`）。创建窗口的 `toolFilter` 只能收**继承面**上的工具，而子会话自己那层
 *   注册的工具（宿主的 Team 工具）与保留名 `run_code` 只能靠它以子会话自己的真实视图补收 + 装单调
 *   守卫。省略时这一层缺席——此时只剩创建期工具面、全局门禁与平台深度上限，**不要**据此宣称委派已
 *   被封堵。
 * @param {(taskId: string) => string|undefined} [deps.engineeringFactsFor] - 取工程的测试与构建事实
 *   （测试怎么跑、构建与测试入口是什么、有哪些可直接调用的能力），交给 `test_design`。它是**文本**，
 *   与该角色的工具面无关：那个角色照旧没有 `read`/`shell`。省略时提示词里如实写「这份事实缺席」，
 *   而不是留一段空白让子会话自己编——**不要**在这里编一份兜底文案：跑法与构造入口是工程事实，
 *   猜错会写进一份被下游照着执行的详设。
 * @param {(taskId: string) => object|undefined} [deps.testDetailFor] - 取**测试详设产物**
 *   （`test_detail` 那一份），交给 `verification_design` 作为「覆盖 / 反例 / 执行力」三项检查的输入
 *   基线。它只补「落在哪、覆盖没覆盖、跑不跑得起来」，**不参与**「正确应该是什么」——预期仍然只能
 *   从需求与冻结契约推导。省略时提示词里如实写这一缺口。
 * @param {(taskId: string) => readonly object[]|undefined} [deps.planCasesFor] - 取**既有计划里的用例**
 *   （`{id, covers, type}` 即可），让验证设计在**既有结构内**做补全。复用既有 `plan.cases`，
 *   不新增用例模型。省略时提示词按「没有任何既有用例」处理。
 * @returns {object} 与 `lib/executor.js` 里其它执行者同形的对象。多读一个 `agent` 字段：子会话需要
 *   一个**父 agent** 才能建起来，而 `sessionId` 换不出 agent——不去猜，由调用方把它交进来。
 */
export function createChildExecutor({
  subagentsFor,
  providerName = CHILD_PROVIDER_DEFAULT,
  namesFor,
  bindings,
  surface,
  contractFor,
  planFor,
  routeFor,
  engineeringFactsFor,
  testDetailFor,
  planCasesFor,
  helpers,
} = {}) {
  return {
    name: `child:${providerName}`,
    // 阶段 2 起承载**所有**节点：写文件的（Builder）与只读的（Verifier / Reviewer）都该跑在独立会话里
    // ——「独立验证」的实质是独立 session identity / 独立上下文 / 独立工具面，而不是换个 prompt。
    supports: () => true,
    async run({ node, task, root, dispatchId, agent, signal, criteria, requirement }) {
      const writes = Array.isArray(node.write_scope) ? node.write_scope : []
      const mode = task?.mode
      const independent = independentNodesIn(task)
      // **不静默降级。** 子会话起不来时要分清两件事：
      //  - 可以降级：任务里只有实现节点，没有谁的独立性依赖子会话——主会话代跑不改变任何保证；
      //  - 不可以降级：本来就是高风险任务，或任务里有设计 / 验证执行 / 复核节点。那些节点存在的
      //    理由就是独立 Session、独立上下文、独立工具面；主会话代跑等于把独立验证换成自我验证，
      //    看起来照常跑完，独立性却已经不在了。此时**阻塞**，让上层看见并决策。
      //
      // 「任务节点表读不出来」不算不可以降级（那会把一次读不到变成一次假阻塞），但也**不装作核对过**
      // ——降级消息里会明说这一点。这条判据两个入口共用：接缝缺席与拿不到父 agent。
      const mustBlock = mode === 'direct_edit'
        || mode === 'high_risk_task'
        || (Array.isArray(independent) && independent.length > 0)
      const blockedOutcome = (unavailable) => {
        const why = mode === 'direct_edit'
          ? 'direct_edit 不派子会话'
          : mode === 'high_risk_task'
            ? 'high_risk_task 要求原生子会话在场（收口门禁同样会拒绝缺项）'
            : `任务里有非实现节点 ${independent.join(', ')}，它们要求独立执行者`
        return {
          status: 'blocked',
          summary: `节点 ${node.id} 的原生子会话${unavailable}，且不可降级：${why}。`
            + '本次派遣已登记为阻塞，等待接缝恢复或由上层显式决策——**不由主会话代跑**。',
          blocked_by: { code: 'GAC_CHILD_SEAM_UNAVAILABLE', detail: why },
        }
      }
      const seam = describeChildSeam(subagentsFor?.(), providerName)
      if (!seam.available) {
        if (mustBlock) return { ...blockedOutcome(`不可用（${seam.reason}）`), reason: seam.reason }
        // **显式降级**，不是静默落回：这条消息会进模型视野，也是「这一轮其实是主会话自己干」的唯一
        // 依据。早先会话执行者只写「需要写入 [...]，必须由带工具的会话执行」，读的人无从知道
        // 子会话接缝本该在。
        return {
          status: 'in_progress',
          summary: `节点 ${node.id} 需要写入 [${writes.join(', ')}]，但原生子会话不可用`
            + `（${seam.reason}）。本次派遣已登记，降级为由上层会话执行并把结果回报回来。`
            + (independent === undefined
              ? '（任务节点表读不出来，无法核对独立性——按「只有实现节点」处理。）'
              : ''),
          reason: seam.reason,
        }
      }
      if (agent === undefined || agent === null) {
        // 子会话必须有父 agent。拿不到就如实降级——**不要**拿别的会话的 agent 顶替，那会把子会话挂到
        // 一条不属于它的血缘上，之后连「这个结果是谁给的」都追不回来。
        if (mustBlock) return { ...blockedOutcome('没有可用的父 agent'), reason: 'no parent agent' }
        return {
          status: 'in_progress',
          summary: `节点 ${node.id} 需要写入，但本次调用没有可用的父 agent，无法建子会话。`
            + '本次派遣已登记，降级为由上层会话执行并把结果回报回来。',
          reason: 'no parent agent',
        }
      }

      const subagents = subagentsFor()
      // 本次派遣的**有效角色**：显式 `role` 优先，否则按能力推断（`nodeRoleOf`）。用有效角色而不是
      // `node.role ?? 'implementation'`，是为了让「没写 role 的验证节点」也拿到验证角色的工具面与
      // 守卫——否则它会被当成 Builder，拿到写入面。
      const role = semanticRoleOf(node)
      // 每次派遣只允许再开一层：上限 = 调用方深度 + 1。调用方深度读不出来时交 `undefined`，
      // 让宿主用它自己的配置上限——不拿一个写死的数字顶上去（写死 1 会让深度 1 的调用方整个用不了）。
      const depth = parentDelegationDepth(agent)
      // 契约交给 `CONTRACT_ROLES` 里那三个靠需求侧事实推导的角色（理由见该常量的注释）；验证执行
      // 节点要拿到**已冻结的计划**，其余角色不需要（它们读仓库或用不着）。
      const contract = CONTRACT_ROLES.includes(role) ? contractFor?.(task.task_id) : undefined
      const plan = role === 'verification_execution' ? planFor?.(task.task_id) : undefined
      // 各角色**额外**的输入基线。三处都按角色取，不是因为别处用不上，而是因为「给了不该给的角色」
      // 会悄悄改变它的依据面：工程事实只该给测试设计（它的工具面里没有仓库），测试详设只该给验证
      // 设计（它拿它做检查，不拿它做推导），既有用例只该给验证设计的补全。给错了不会报错，
      // 只会让一份产物的依据变成另一份。
      const engineeringFacts = ['test_design', 'verification_design'].includes(role) ? engineeringFactsFor?.(task.task_id) : undefined
      if (engineeringFactsFor && ['test_design', 'verification_design'].includes(role) && !engineeringFacts) return { status: 'blocked', summary: 'GAC_VERIFICATION_CONTEXT_MISSING: 项目必须声明测试入口与可用验证能力。', blocked_by: 'GAC_VERIFICATION_CONTEXT_MISSING' }
      const testDetail = role === 'verification_design' ? testDetailFor?.(task.task_id) : undefined
      const planCases = role === 'verification_design' ? planCasesFor?.(task.task_id) : undefined
      // 模型路由按**语义角色**取（适配器 `execution.role_routes`）；没声明就继承父会话。
      const route = routeFor?.(role)
      const agentOptions = agentOptionsFor(route)
      // 路由要进返回文本：配错了模型、或者某个角色悄悄继承回父会话的模型，只能从这里发现。
      const routeNote = describeRoute(agentOptions, route)
      const request = {
        label: `${task.task_id}/${node.id}`,
        prompt: [{ type: 'text', text: buildChildPrompt({
          node,
          task,
          root,
          dispatchId,
          contract,
          plan,
          // 验收标准由派遣者交进来（需求侧那一份）；执行者不从任务记录里自己猜。
          criteria: Array.isArray(criteria) ? criteria : undefined,
          // 需求正文同理：验收标准只存编号，编号不表达意思——读不到实现的角色只有这一份依据。
          requirement: typeof requirement === 'string' ? requirement : undefined,
          engineering_facts: typeof engineeringFacts === 'string' ? engineeringFacts : undefined,
          test_detail: testDetail,
          plan_cases: Array.isArray(planCases) ? planCases : undefined,
        }) }],
        parent: agent,
        signal,
        persona: buildChildPersona(node),
        // **产出契约按角色挑**：设计节点交计划、执行节点交逐条结论、复核节点交六问与五维。
        // 一个万能 schema 只能传输「做完了」，带不回语义产物——真实 `REQ-HR-1` 已经证明过。
        outputSchema: childOutputSchemaFor(node),
        ...(depth === undefined ? {} : { maxDepth: depth + 1 }),
        // 路由是**可选**的：没有声明就不传这个键，子会话继承父会话的 provider / 模型 / 推理档位。
        ...(agentOptions === undefined ? {} : { agentOptions }),
      }
      // 角色工具面（第 1 层）：创建窗口的 `toolFilter`，在 `start()` 落定之前就已生效，因此呈现层面
      // **没有竞态**——这是它不可替代的价值。名单只点名列在**父会话可收集合**里的名字：子会话会 join
      // 父会话的 preset，那份集合是子会话继承面的安全子集；父会话自己那一层注册的工具（宿主的 Team
      // 工具）不在里面，因此**这一层结构上点不到它们**。这不是配置问题，而是这一层的边界：它们由
      // `start()` 之后的对账补收与单调守卫接住（第 2 层），再往下还有全局门禁（第 3 层）。
      const toolFilter = roleToolFilterFor(node, namesFor?.(agent))
      let run
      let filterNote = ''
      try {
        run = await subagents.start(seam.provider, toolFilter === undefined
          ? request
          : { ...request, toolFilter })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 工具面被宿主拒绝时**不放弃这次派遣**：退到无过滤重试，并把「这一层没生效」如实写进结果。
        // 静默降级是最坏的形态——读的人会以为模型面里已经没有写入工具了，而 pre-execute 守卫其实
        // 是唯一的防线。
        if (toolFilter === undefined || !/unknown global tool/iu.test(message)) throw error
        run = await subagents.start(seam.provider, request)
        filterNote = `⚠ 角色工具面未生效（${message}）——已按无过滤重试，这一层只剩 pre-execute 守卫`
      }

      // **授权由派遣者绑定，不由执行者自报。** 子会话拿到的那一刻就该是「它自己那份作用域」，
      // 而不是靠 persona 里那句「只能写 [...]」的措辞——措辞不是权限。绑在 `start()` 返回之后、
      // await 结果之前：`start()` 一返回子会话就可能在跑，而它的第一个工具调用至少要等一次模型往返，
      // 所以实际窗口可忽略；但契约上不存在「首个工具调用之前」的钩子，这一点如实记在 ADR 里，
      // 不假装它是硬保证。只读节点不绑（空写范围：绑上去会把 shell 一起拒掉，而验证者要用它跑用例）。
      //
      // 绑定、角色登记、工具面对账与拒因共用**同一份身份**：读报告的人不会看到两种说法。
      const writeScope = writes
      const identity = {
        child_session_id: run.id,
        parent_session_id: agent?.session?.id,
        task_id: task.task_id,
        node_id: node.id,
        dispatch_id: dispatchId,
        attempt: node.execution?.attempt,
        role,
        write_scope: writeScope,
      }
      const binding = bindings?.bind(identity)
      // 角色登记**对空写范围也做**：只读子会话没有写作用域绑定，但守卫要知道它是哪个角色，才能把
      // `verification_design` 的 `read`/`shell` 一并拒掉。写作用域为空是「不许写」的理由，不是
      // 「没有身份」。
      bindings?.declareRole(identity)
      helpers?.openParent(run.id, identity, signal, request.prompt[0].text)
      // 第 2 层：以子会话**自己的**真实视图对账补收，并装上单调守卫——它接住创建窗口收不掉的那一层
      // （子会话自己那层注册的工具、保留名 `run_code`）。进程外 provider 拿不到 `localAgent` 时这一层
      // 装不上，此时它记一条 `child-surface-unavailable`：如实记，不假装收过。
      const surfaceRecord = surface?.bind({
        ...identity,
        binding: binding ?? identity,
        agent: run.localAgent,
      })
      const surfaceNote = surfaceRecord === undefined
        ? ''
        : `；子会话工具面 ${surfaceRecord.mode}（presented ${surfaceRecord.presented.length}`
          + `，removed ${surfaceRecord.removed.length}）`
      const boundNote = (binding === undefined
        ? ''
        : `；已绑定写作用域 [${binding.write_scope.join(', ')}]`) + surfaceNote

      try {
        const result = await run.result
        const structured = result?.structured
        const stopReason = result?.stopReason
        if (structured === undefined || structured === null || typeof structured !== 'object') {
          // 没有结构化产出就无法判定成败。这不是「大概成了」——按失败处理，并要求重新派遣。
          //
          // `detail` 在**失败分支也要给**，而且要给**原因**：可追溯信息恰恰是父会话最需要它的时候。
          // 活体验收实测过两种缺法：一次是子会话两件事都做对了、只是回报被门禁拒了，而返回文本里
          // 连子会话 id 都没有；一次是宿主根本没注册那个 provider（`NO_ADAPTER`），失败原文只活在
          // 子会话日志里，父会话读到的只有「结论 failed」。宿主的 `diagnostic` 就是为这种情况准备的。
          const reason = `没有按契约回结构化产出（stopReason: ${JSON.stringify(stopReason) ?? 'unknown'}）`
            + `${result?.diagnostic === undefined ? '' : `诊断：${result.diagnostic}`}`
          return {
            status: 'failed',
            detail: childDetail(run.id, boundNote, [], reason, routeNote),
            summary: `子会话 ${run.id} ${reason}。`,
          }
        }
        const verdict = CHILD_VERDICTS.includes(structured.status) ? structured.status : undefined
        if (verdict === undefined) {
          const reason = `status 不在契约内：${JSON.stringify(structured.status) ?? 'undefined'}`
          return {
            status: 'failed',
            detail: childDetail(run.id, boundNote, [], reason, routeNote),
            summary: `子会话 ${run.id} 回的 ${reason}。`,
          }
        }
        const artifacts = Array.isArray(structured.artifacts) ? structured.artifacts : []
        const detail = childDetail(run.id, boundNote, artifacts, structured.summary, routeNote)
          + `${filterNote === '' ? '' : `；${filterNote}`}`
        return {
          status: verdict,
          summary: `${structured.summary}`
            + `（子会话 ${run.id}；stopReason: ${JSON.stringify(stopReason) ?? 'unknown'}`
            + `${artifacts.length === 0 ? '' : `；产物：${artifacts.join('、')}`}）`,
          // 返回文本里要能看见**子会话 id**：可追溯性此前只活在任务记录的 `result_ref` 与证据日志里，
          // 模型看不到。`detail` 就是给渲染用的那一行。
          detail,
          // **语义产物原样带回去**：执行者只负责运输，落盘与门禁在 `gac_task` 那一层（那里才有
          // 任务存储与门禁）。把「谁负责持久化」分开，是为了让这一层仍然可单测、不碰盘。
          //
          // `child_session_id` 一并带上：验证者报的是 `self:<n>`（它本会话第 n 次工具调用），
          // 而把那个序号解析成运行时真正签发过的证据号，需要知道**是哪个会话**的记录。
          semantic: {
            role,
            child_session_id: run.id,
            payload: structured,
          },
          // `artifact` 落到任务记录的 `result_ref`：它是一个**指针**，不是结论。指出这次结果是哪个
          // 子会话给的——将来要复核「是谁写的」，得从这个 id 追回去。
          artifact: `child-session:${run.id}`,
        }
      } finally {
        await helpers?.closeParent(run.id)
        // 授权随派遣一起结束。按 `dispatch_id` 释放：一个迟到的释放（旧 attempt 的收尾）不得动摇
        // 新 attempt 的绑定——这正是「重试之后子会话 B 的 scope 不能被 A 的清掉」那条。
        bindings?.release(dispatchId)
        // 角色登记按同一条纪律释放（只读子会话没有写作用域绑定，`release` 对它是空操作，角色的收尾
        // 必须自己走这一条）。
        bindings?.releaseRole(dispatchId)
        // 工具面的收权与守卫按**会话**摘掉：会话 id 唯一，不存在「迟到释放动摇新 attempt」的问题；
        // 而且子会话的层随它自己被销毁，这里摘掉只是不留悬空登记。
        surface?.unbind(run.id)
        // 无论成败都要收：宿主把子会话的收尾交给我们，留着它就是留一个不再需要却仍活着的会话。
        try {
          await run.dispose?.()
        } catch {
          // 收尾失败不该改变本次派遣的结论——它已经发生了。
        }
      }
    },
  }
}
