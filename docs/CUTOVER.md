# GAC 切换记录：做完了什么、没做什么、本仓库不碰什么

本文件是 **Phase 7（Legacy 切换）落在本仓库内的那一半**。它记录处置与状态，**不执行任何
仓库外的动作**。

## 0. 本文件的范围

- **`~/.claude/workflow` 本仓库一个字节都不动。** 那是本机另一套正在用的流程，不是本仓库的
  代码。要不要只读归档是**仓库所有者**的决定；本文件只记录处置口径，不代表已经发生。
- **两个运行时不共享开关。** 旧的是 Claude Code 的 hook 机制，新的是 DSH 插件；它们跑在
  不同的宿主里。「切换」因此不是翻一个开关，而是**决定在哪个宿主里干活**，以及**不要同时挂
  两边**。
- 本仓库能做到的只有一件：把 DSH 这一侧的默认指向写清楚（见 §5）。

## 1. 双写风险：在本 profile 里不存在（已核对）

方案 §8 警告「profile 里同时挂旧 hook 与新插件会互相打架」。**本机的 `core-020` profile 没有
这个问题**：它的 bundles 列表里既没有 `dsh-hooks-claude-code`，也没有任何旧 workflow 挂载
（读了 `~/.dsh/profiles/core-020/package.json` 确认）。因此那条警告目前是**预防性的**，不是
正在发生的故障。若日后有人把 hooks 插件加进来，它才会生效。

## 2. 退役清单（方案 §8）——逐项实际状态

| 原资产 | 方案处置 | 本仓库实际状态 |
| --- | --- | --- |
| `PROTOCOL.md` 流程语义 | → 协调器状态机 | **已完成**（`lib/coordinator.js`） |
| `PROTOCOL.md` 流程语义 | → `systemPrompt.section` 文本 | **已完成（刻意收窄）**。`lib/prompt-section.js` 注入 `gac:protocol`（order 700）：工程已纳管就发声，段落只讲**状态**（当前模式与理由、当前写范围、证据号出口），不重述模式阶梯与写范围语义——那两处在工具描述里，抄第二份就是两处会各自漂移的副本。未纳管且什么都没声明时整段消失。**实测**（2026-10-04）：本会话的 `system/message` 节点里确实带上了这段文本 |
| `ENGINEERING_POLICY.md` | 原文保留，作 Reviewer 的 system prompt 素材 | **已完成**。逐字复制到 `assets/ENGINEERING_POLICY.md`（与原文件同一个 SHA-256，未改写一个字），由 `lib/engineering-policy.js` 读出，进审查节点的**系统提示**（`lib/executor.js`）；读不到时只少这一段并在提示里说明，不让审查节点跑不起来 |
| `routing.py` 就绪节点判定 | → 协调器 | **已完成**（`resolveReady`） |
| `routing.py` 能力路由 | **删掉**（复用 DSH） | **偏离**：新建了 `lib/capability-router.js`。理由是适配器用 `executors` 声明「谁承载哪种能力」，而 DSH 现成的三件物表达不了这件事。这是对 §3.2 的**有意偏离**，不是遗漏——但它确实是偏离 |
| `routing.py` 并行判定 | → 纯函数 | **已完成**（同批判定 + 写范围相交排除） |
| `runtime.py` | → 协调器 + session events | **已完成**（`coordinator.js` + `gac-events.js`） |
| `claims.py` | → `gac/write-claims` | **已完成**（`claims.js` + `claim-store.js` + `gac_scope`） |
| `witness.py` | **退役**，改订阅 `workspaceChanges` + `fs/observed` | **已完成（有一处有意收窄）**。`lib/workspace-witness.js`（纯模块）+ `lib/index.js` 订阅 `session/event` 的 `workspace/changes`，把每一轮变更集按已声明的写作用域归成 in_scope / out_of_scope / outside_project，记成一条证据（`source: workspace-changes`），并从证据、加载报告、指标三个出口出来。**收窄点**：本轮只订阅 `workspaceChanges`，**不**订阅 `fs/observed`——后者是逐次文件读写的观测流，把它也接进来会让「这一轮改了什么」与「某个工具碰过什么」混在同一个出口里，而前者才是越界归属需要的口径。这条收窄是任务 `REQ-WITNESS` 的接口契约里写明的 non_goal，不是遗漏 |
| `invocation.py` | 简化：只留写范围与产物声明 | **部分**。执行者收到结构化输入（`{ node, task, root, dispatchId }`），但没有一份显式的调用契约 |
| `memory.py` / `MEMORY.md` | scope 分类保留，接薄 memory 层 | **未做** |
| `hook-entry.py` + Claude Code hooks | **退役** | 本仓库不适用（从未挂载） |
| `workflow.py` CLI | 退役 | 本仓库不适用 |
| `templates/*.json` | 保留为插件内 schema | **部分完成**。`templates/review.json` 的 `verification_independence` 六条 key 与 `engineering_quality` 五个维度**逐字**迁进 `lib/review.js`（见 §3 E2E-3）；`verification-plan.json` 的语义已在 `lib/verification.js`；其余模板（`requirement` / `invocation` / `memory` / `approval` / `result` / `tasks` / `verification` / `adr`）**未**沿用——本仓库用自己的 schema，其中 `invocation` 与 `memory` 两行本来就标着「部分」与「未做」 |
| `.claude/workflow/tasks/**` | **只读归档**，不重写 | **本仓库未触碰**（按 §0 的决定） |
| `tests/`（Python 回归） | 迁移为插件侧测试 | **精神上完成**：671 条 JS 测试覆盖同类断言；但**不是**逐条迁移，schema 门禁断言未按原样搬过来 |

## 3. E2E 验收（方案 §9）——逐项实际状态

这一节是全文最该被读的部分：**六条里只有两条真正验过**。

| ID | 场景 | 实际状态 |
| --- | --- | --- |
| E2E-1 | 删一个配置字段 → `DIRECT_EDIT`，无 `gac/task-created` 事件，零子 Agent | **部分验证，缺的两条断言已补（2026-10-05）**。真实会话里验过 `direct_edit` 命中高风险路径会被升级为 `high_risk_task`（Phase 1）。「无 `task-created` 事件」现在有三处断言：`NON_TASK_MODES` 恰好是 `read_only`/`direct_edit`、声明之后盘上连任务目录都没有、事件翻译对一次 `direct_edit` 只产出 `mode-declared`；「零子 Agent」也钉住了——`lib/` 里不出现 `subagents`，引入时会红。**仍未验的是端到端那一步**：需要在插件开启的真实会话里声明一次 `direct_edit`，而本机默认关闭、开关是否热生效不定（见 §4） |
| E2E-2 | 普通 bugfix → `STANDARD_TASK` → Builder → Verifier | **已验证**。真实需求 `REQ-EVIDENCE-LIST` 完整走过 standard_task 的四个节点（实现 ∥ 测试 → 独立验证 → 审查 → 收口）。**注意**：方案写的事件名 `node-started`/`node-completed` **不存在**，实际事件是 `gac/node-dispatched`/`gac/node-reported` |
| E2E-3 | 安全/持久化任务 → `HIGH_RISK_TASK`；Verification Design 与 Implementation **并发发起**；Verification 读实现晚于计划冻结；Review **六问齐备** | **仍未端到端验证，但「六问」这一格已补**。`lib/review.js` 把原模板的六问与五个质量维度逐字迁进来，登记时拒收未回答的报告、收口时拒收方向自反或留下阻塞问题的报告（`gac_task` 的 `review` 动作 + 收口门禁），审查节点的提示词里带上策略原文与清单。**仍未验证的两条**：「Verification Design ∥ Implementation 并发发起」**不是**我建的流程（我的并行情形是「功能代码 ∥ 测试代码」），以及从未真的跑过一次完整的 `high_risk_task` 端到端 |
| E2E-4 | `write=["mod.c"]` 尝试写 `sub/mod.c` → deny，工具体未执行，`GAC_WRITE_SCOPE_DENIED` | **已验证**（Phase 0，真实会话）：越界写入被拒、shell 被拒，且**被拒的文件在盘上确实不存在**——这是「派遣前拦截」的证明 |
| E2E-5 | 两节点共享独占资源 → 第二个节点的派遣被拒，理由含持有者 `dispatch_id` | **未按规格实现；现有行为已被断言钉住**。占用声明被用于**同批判定**（写范围相交或共享独占资源的节点不进同一批，于是串行）与 `gac_scope` 的声明冲突；**派遣本身不查占用声明**，因此不存在「拒绝派遣并指出持有者的 dispatch_id」。串行而非拒绝可能更好（它不制造「必须等待别人释放」的仪式），但它**不是**规格里被断言的那个行为——现在串行这条路有三条断言守着（`test/coordinator.test.js` 的「写范围相交时不进同一批」「共享独占资源时不进同一批」「已在执行的节点占住写范围，后续批次会避开」），免得它悄悄变成第三种行为 |
| E2E-6 | 验证者试图写产品代码 → 其 `pwsh`/`write` 已被 `tools.restrict` 收回，返回 `UNKNOWN_TOOL` | **已实现，并做过 4 轮活体验证（2026-10-05，每轮都由隔离子 agent 在真实会话里执行）**；**判据的字面形态仍未观察到**：实测到的拦截是**守卫逐字拒绝**（`GAC: 会话 … 当前在推进只读节点 [T1] …`，`guard-denied` / `GAC_READ_ONLY_ROLE_DENIED`），不是 `UNKNOWN_TOOL`。原因已查明，不是缺陷：内核的执行顺序是「`createExecution` → `tools/pre-execute` 瀑布 → dispatch 时才 `resolveExecution`」（`dsh-tools` 的 `prepareExecution`），而模型那一轮的可用工具清单在本轮开始时就已装配——所以**同一轮里**对已收权工具的调用一定先撞上守卫；`UNKNOWN_TOOL` 只可能出现在**新一轮**（工具根本不再被提供）。收权本身在视野层确实生效：第 4 轮收权之后按同一作用域复查，`view(agent).visible` 里已经没有 `write`/`edit`。**四轮抓到的三处缺陷**（914 条单测全绿时一个都没被覆盖）：核心没接上收权器、`restrict` 名单来源错（改用 `view(agent).restrictableNames`，`run_code` 按内核规定不进名单）、派遣身份没写进返回文本。**与字面判据的差别**：`pwsh` 默认**不**收回（计划 §4.4 阶段 3 要求验证者执行计划用例并留证据）；项目可用 `execution.revoke_shell_for_read_only_roles: true` 换回字面行为。收权降级时守卫兜底是真的在（第 1 轮的失败就是兜底根本没接上），且收权**自己复查**：`mode: guard-only` + `revoked: []` + `role-revocation-unverified` 才是「没真收掉」的诚实读数 |

## 4. 方案 §7 的边界——逐项实际状态

| 边界 | 实际状态 |
| --- | --- |
| shell 写入拦不住 | **按文档处置**：作用域生效时 shell 被整体拒绝，而不是假装能检查命令串里的重定向目标 |
| 写声明是尽力而为 | 已实现：占用声明带存活判定，存活未知时**保留**声明而不是猜成已死 |
| `fs/write-intent` 不能拒绝写入 | 不适用（从未使用该接缝） |
| **PTC（`run_code`）内层调用需单独处理** | **已按 §7.4 处理（只做了单测）**。外层传输放行——它自己不碰文件；真正受管的是它派发的内层子调用，内核在 `ToolExecution.parent` 上标出它们、并保证每一次都走 `tools/pre-execute`（`dsh-tools` 的注释原文：「every started PTC inner call is reviewed once before its body」），因此内层 `write` 查作用域、内层 `pwsh` 按 shell 拒绝、内层未知工具按失败即拒绝。此前 `run_code` 不在任何名单里 → 归类为 `UNKNOWN` → **PTC 在作用域下整体不可用**，而那是「把通道关掉」，不是更严的守卫。**未实测的原因**：本机 profile 没有装配 PTC 运行时——`dsh-ptc-runtime` 桌面安装里有，但不在 profile 的 junction 集合里，因此插件解析不到它，`run_code` 工具不在场 |
| 独立验证的独立性来自信息路径 | **部分**。契约确实把两条推导路径分开了（测试只依据契约，实现只依据契约与方案），但**唯一一次真实走查里两边出自同一个作者** |
| `workspaceChanges` 覆盖面需实测确认 | **测了一半，诚实结果是「这一层在本机是惰性的」**。已核实的：`workspace/changes` 是 `dsh-session` 声明的**已知事件类型**，而它的生产者 `@deepseek-ai/dsh-workspace-changes` **不在** `core-020` 的 `bundles` 列表里，也不在 profile 的 junction 集合里（`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是指向桌面安装的 junction，而那个集合是桌面安装的子集——桌面安装里有这个包，链接里没有），因此没有东西会追加该事件、`ctx.workspaceChanges` 也不存在。插件按契约用 `ctx.inject` 降级：照常加载、照常订阅，加载报告写一条 `witness-seam` 说明该源不在。**仍未测的**：把该包装进 profile 之后，摘要的覆盖面（`maxFiles` 上限、`oversized`/`binary` 的标记是否如期到达）以及真实越界发现——那需要一次插件在场并声明了写作用域的会话 |
| **插件改自己的代码时无法自管** | **按文档处置，且默认就不启用**：本项目约定本插件**默认关闭**，只在需要跑真实会话（E2E 验收）时打开，测完关回去——开关是 `npm run plugin:on` / `plugin:off` / `plugin:status`（`scripts/plugin-switch.js`，只改 profile patch 里 `- id: gac-runtime` 的 `disabled:` 一行）。理由：开着改 `lib/*.js`，每一笔写入都会热重载进模型自己正在用的宿主进程，而门禁与提示段落的失败方向分别是「拒绝一切」与「每一步装配失败」——那会把自己关在门外，且没有工具能用来修。代价：插件的模式与写作用域是**内存**状态，卸载即丢（任务记录在盘上，不丢），所以关闭期间没有 GAC 管辖；门禁、提示段落与 `gac_*` 工具都不在，**那是默认状态，不是故障**。**开关是否热生效未定论**：2026-10-05 实测 `plugin:on` 之后 90 秒，加载报告里仍没有新的 `plugin-loaded`（最后一次写入停在 1 小时前），而同一天的历史记录里存在 3–8 ms 就应用的条目——因此判断只能靠报告里有没有新记录，没有就说明这个宿主需要重启才能实测。实测的关闭/重开循环见 README「Install」 |

## 5. 「新任务默认走 DSH」具体指什么

**指**：在一个已纳管工程的 DSH 会话里，且**本插件处于启用状态**时（`npm run plugin:on`；默认是关的，
见 §4 与 `AGENTS.md` §0），`gac_project` / `gac_scope` / `gac_task` /
`gac_evidence` / `gac_metrics` 五个工具已注册，写作用域闸门处于生效状态（`tools/pre-execute`，
以 `prepend` 注册）。除此之外不需要任何动作。

**但「默认」这个词现在要加前提。** 本仓库开发的就是这个插件，而它默认关闭（开着改自己的代码会把
自己关在门外，见 §4）。所以这套门禁在本仓库里**不是常驻的**：日常改代码时它不在，需要跑真实会话
验收时才打开、测完关回去。`npm run plugin:status` 是判断「此刻到底有没有门禁」的唯一可信来源——
凭记忆判断会得出相反结论，而两种结论的行为差别很大（一个拒绝一切写入，一个放行一切）。

**不指**：
- 不指旧运行时被停用。本仓库**不能也不会**去停用它。
- 不指旧数据被迁移或改写。
- 不指两个宿主的流程语义已经对齐——它们只是不再互相干扰。

**所有者若要归档旧流程**：那是所有者的动作，本仓库不代劳。归档前值得先确认**还有哪些工程
在跑旧流程**，因为归档会直接断掉它们。

## 6. 阻碍一次真正切换的东西（诚实清单）

按重要性排序，不是按工作量：

1. ~~**没有系统提示段落。**~~ **已补（2026-10-04）**：`lib/prompt-section.js` 注入
   `gac:protocol`，工程已纳管时模型就能看到门禁存在与当前状态，不必靠撞上去才发现。
   **仍未做的**：没有一段「协议总览」——流程语义仍散在各工具的描述里；要不要再写一段是
   待定项，因为段落每长一分，每个模型步进都多付一分。验证方式也记在这里：段落是否真的
   送达，看的是会话日志里的 `system/message` 节点，而不是插件自报。
2. ~~**E2E-6 缺失。** 没有按角色收权；「验证者不能写产品代码」目前只靠进程内执行者结构上没有写工具来间接成立。~~ **已补并活体验证（2026-10-05，4 轮，见 §3 E2E-6）**：只读节点在飞时 `write` 被逐字拒绝、回报后立刻恢复；`shell` 默认留着（项目可声明连它一起收回）。
   **仍未闭合的一步**：判据字面要求的 `UNKNOWN_TOOL` 形态没被观察到，只观察到守卫拒绝。原因是内核顺序（`tools/pre-execute` 在 dispatch 之前）加上「工具清单按轮装配」，所以它只可能出现在**新一轮**。要验证它，需要一个能在只读节点在飞时**结束本轮、再开一轮**的会话——单个子 agent 只有一轮，做不了；下一次可以用一个可续话的 agent 试一次。
3. **E2E-5 语义与规格不同。** 串行与拒绝是两种不同的保证，文档必须说清是哪种。
4. ~~**PTC 被整体拒绝。** 任何依赖 `run_code` 的流程在作用域下无法运行。~~ **已补（§4）**：外层传输放行、内层子调用按自己的名字受管。**仍未实测**——本机 profile 没有装配 PTC 运行时，`run_code` 不在场，所以这一条目前只有单测；真要实测，得先把 `@deepseek-ai/dsh-ptc-runtime` 装进 profile。
5. ~~**witness 替代品缺失。** 变更证据只有工具调用，没有工作区差异比对。~~ **已补（任务 `REQ-WITNESS`）**：`lib/workspace-witness.js` + 入口订阅，变更集按已声明写作用域归属，越界影响证据可用性但不阻断调用。**仍未证明的**：这一层在本机 profile 下收不到任何事件（生产者未装配，见 §4），所以它的单测覆盖的是契约行为，不是线上行为；它的独立验证（原计划的 W3）也还没有做。
6. **独立性未证明。** 契约起了作用，但两边出自同一个作者。`lib/review.js` 现在把这一点变成了**必须回答的六问**，可它核对的是申报而不是事实：同一个模型写出来的两份产物，六问照样能填绿。要让这条从「填了」变成「成立」，需要的是不同的信息路径（不同 system prompt、不同 messages、不同执行顺序），不是再加一道门禁。
7. **从未交付过一个不是自己编的需求。** 上面每一条门禁都拦住过我，但拦住的**都是我自己写下的
   缺陷**。这证明的是「门禁能工作」，还没证明「门禁能拦住别人」。

## 7. 这份记录本身的状态

它是**声明，不是机器强制**：没有任何代码消费本文件，格式不达标不会被拦下。它唯一的用处是
让下一个接手的人不必从零开始核对——尤其是 §3 与 §6，那两节里每一行都是一次实测的结论，
而不是推断。
