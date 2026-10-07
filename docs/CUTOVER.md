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
- **本目录里的其他文档**：`ADR-0001-子会话执行载体.md` 是节点执行载体的决策记录（含阶段 1-3 的
  活体验收结论与那次会话日志事故）；`PHASE0-VERIFICATION.md` **已删除**——那是阶段 0 的一次性
  操作手册（「请在一次重启之后运行它」），结论已经落在 §3 的 E2E-4 与单测里，留着一份会被当成
  现行流程读的旧手册只会误导人。

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

这一节是全文最该被读的部分：**六条里有四条真正跑过真实会话**（E2E-1 端到端那一步除外），
另有两条与规格的字面判据仍有差别，逐条写清。

| ID | 场景 | 实际状态 |
| --- | --- | --- |
| E2E-1 | 删一个配置字段 → `DIRECT_EDIT`，无 `gac/task-created` 事件，零子 Agent | **已验证，判据已改（2026-10-05）**。真实会话里验过 `direct_edit` 命中高风险路径会被升级为 `high_risk_task`（Phase 1）。「无 `task-created` 事件」有三处断言：`NON_TASK_MODES` 恰好是 `read_only`/`direct_edit`、声明之后盘上连任务目录都没有、事件翻译对一次 `direct_edit` 只产出 `mode-declared`。**「零子 Agent」这条判据已退役**——GAC 现在**就是**用子会话来执行节点的，判据换成「约束引入方式」：子会话只能经 `ctx.inject`/`ctx.get` 拿服务、`lib/` 里不得 import `@deepseek-ai/dsh-subagent`、不得依赖 Agent Teams（`test/entry.test.js`） |
| E2E-2 | 普通 bugfix → `STANDARD_TASK` → Builder → Verifier | **已验证**。真实需求 `REQ-EVIDENCE-LIST` 完整走过 standard_task 的四个节点（实现 ∥ 测试 → 独立验证 → 审查 → 收口）。**注意**：方案写的事件名 `node-started`/`node-completed` **不存在**，实际是 `gac/node-dispatched`/`gac/node-reported` |
| E2E-3 | 安全/持久化任务 → `HIGH_RISK_TASK`；Verification Design 与 Implementation **并发发起**；Verification 读实现晚于计划冻结；Review **六问齐备** | **已端到端跑过一次真实 `high_risk_task`（2026-10-05，`REQ-HR-1`，隔离子 agent 在真实会话里执行）**：先按门禁顺序登记验证计划（`plan-82a1446a`）与接口契约（`contract-781ec625`），再逐批派遣。**并发成立**：D1（设计）与 I1（实现）两个子会话建立相差 2 ms、`turn/start` 相差 67 ms、活跃区间重叠约 19.2 秒。**计划先于实现冻结成立**（计划与契约都在 `advance` 之前落盘）。V1 独立验证、R1 独立复核，四个节点全部 completed、复核报告登记成功（六问与五个维度齐备）。**当初两条没成立，其一已关闭（2026-10-08）**：① ~~设计节点的**盲区只到「启动时」**——它的提示词与上下文里对实现内容零命中（实现文件晚于它启动 14 秒才出现），但它后来自己把产物读了过来（`read`/`grep`/`glob` 对它开着）~~ **已关闭**：设计节点现在拿不到任何仓库检视工具（`lib/role-tools.js` 按语义角色给 `verification_design` 的 `deny_kinds`，创建期 `toolFilter` + `start()` 后对账补收 + 全局门禁三层落地），盲区覆盖整个生命周期；② **收口一次都没成功过**，两次 `complete` 都被证据门禁如实拒绝，缺的是每条用例的执行结论与证据引用——这一条随后在 `REQ-HR-5` 上闭合（见本节下方指针）。详见 `docs/ADR-0001-子会话执行载体.md` §12 |
| E2E-4 | `write=["mod.c"]` 尝试写 `sub/mod.c` → deny，工具体未执行，`GAC_WRITE_SCOPE_DENIED` | **已验证**（Phase 0，真实会话）：越界写入被拒、shell 被拒，且**被拒的文件在盘上确实不存在**——这是「派遣前拦截」的证明。**子会话侧也已验证（2026-10-05，`REQ-SCOPE-2`）**：阶段 2 收掉子会话的 `gac_*` 工具时漏了运行时绑定，子会话的越界写一度畅通；现在写作用域由运行时绑定（`lib/child-binding.js`，写进同一张作用域注册表），越界写同样在执行前被拒、被拒文件 `Test-Path` 为 `False`，拒因带 `child_session_id`/`task_id`/`node_id`/`dispatch_id`。见 `docs/ADR-0001-子会话执行载体.md` §14 |
| E2E-5 | 两节点共享独占资源 → 第二个节点的派遣被拒，理由含持有者 `dispatch_id` | **未按规格实现；现有行为已被断言钉住**。占用声明被用于**同批判定**（写范围相交或共享独占资源的节点不进同一批，于是串行）与 `gac_scope` 的声明冲突；**派遣本身不查占用声明**，因此不存在「拒绝派遣并指出持有者的 dispatch_id」。串行而非拒绝可能更好（它不制造「必须等待别人释放」的仪式），但它**不是**规格里被断言的那个行为——现在串行这条路有三条断言守着（`test/coordinator.test.js` 的「写范围相交时不进同一批」「共享独占资源时不进同一批」「已在执行的节点占住写范围，后续批次会避开」）。**是改代码还是改规格，是个待定的决定** |
| E2E-6 | 验证者试图写产品代码 → 其 `pwsh`/`write` 已被 `tools.restrict` 收回，返回 `UNKNOWN_TOOL` | **已实现，并做过 6 轮活体验证（2026-10-05，每轮都由隔离子 agent 在真实会话里执行）**；**判据的字面形态（`UNKNOWN_TOOL`）已作废，原因已查明（2026-10-08）**：实测到的拦截是**守卫逐字拒绝**（`GAC: 会话 … 当前只读角色不得使用 "write" …`，报告里 `guard-denied` / `GAC_READ_ONLY_ROLE_DENIED`）。已落定的内核事实：其一，顺序是「`createExecution` → `tools/pre-execute` 瀑布 → dispatch 时才 `resolveExecution`」（`dsh-tools` 的 `prepareExecution`），所以同一轮里对已收权工具的调用一定先撞上守卫；其二，第 6 轮那个「收权落到的那个作用域与装配清单用的那个不是同一个」的推断**是错的**——`restrict` 只过滤该作用域**继承**来的工具，agent 自己那一层注册的工具不受管辖，而这条豁免是刻意的（子会话的 `structured_output` 就靠它活）；当初真正的问题是 `subagent` **没被点名**，不是「收不掉」。其三，守卫是 **fail-closed 按类别**判定的——对**根本不存在的**工具名发起的调用同样被逐字拒绝，所以「守卫拒绝了某次调用」不能用来证明那个名字在收权名单上，收权是否生效只能看报告里的 `mode` 与 `presented`/`removed` 名单。收权本身在**它自己那个作用域**上确实生效（第 4 轮复查 `view(agent).visible`，`write`/`edit` 已不在）。**仍未取得**：跨轮观测（子 agent 只有一轮且不可续话、居留 teammate 无法被消息唤醒，见 `task-1`）。六轮共抓到三处缺陷（914 条单测全绿时一处都没覆盖）：核心没接上收权器、`restrict` 名单来源错、派遣身份没写进返回文本。**与字面判据的差别**：`pwsh` 默认**不**收回（计划 §4.4 阶段 3 要求验证者执行计划用例并留证据）；项目可用 `execution.revoke_shell_for_read_only_roles: true` 换回字面行为 |

**另有一条已修的事故要在这里留指针**：插件曾把 `gac/*` 事件写进**会话日志**，而宿主的事件词表是
构建期生成的——那些日志会被持久化层整份拒读，用户的历史因此打不开（本工程 23 个会话、97 条记录
中招）。已改为写工程自己的 `.dsh/gac/events/events.jsonl`，并提供修复工具。事故事实、损害范围、
修复与回归钉子见 `docs/ADR-0001-子会话执行载体.md` §13 与 `AGENTS.md` §0。

**还有一条链条级的验收要在这里留指针**：高风险流程「子会话产出语义产物 → 运行时校验并自动登记 →
父会话零补写收口」在 `REQ-HR-5` 上走完（四节点全 completed、计划/验证报告/复核报告三份产物均由
运行时落盘、收口返回「任务 REQ-HR-5 已收口。」）。它经过四轮真实会话才成立，前两轮的失败面分别是
「提示词没给计划 id、子会话漏报用例、复用同一份证据」与「复核产出契约与复核报告编译器的字段表
不一致」，第三轮则是「复核的 `self:<n>` 引用没被解析」。事实与四轮记录见同一份 ADR 的 §15。

## 4. 方案 §7 的边界——逐项实际状态

| 边界 | 实际状态 |
| --- | --- |
| shell 写入拦不住 | **按文档处置**：作用域生效时 shell 被整体拒绝，而不是假装能检查命令串里的重定向目标 |
| 写声明是尽力而为 | 已实现：占用声明带存活判定，存活未知时**保留**声明而不是猜成已死 |
| `fs/write-intent` 不能拒绝写入 | 不适用（从未使用该接缝） |
| **PTC（`run_code`）内层调用** | **已活体验收（2026-10-06，本会话，PTC 呈现模式）：外层传输放行、内层子调用按自己的名字受管**。依据是 `dsh-tools@0.2.0-rc.2` 的 `ToolExecution.parent` 注释（「under `mode: 'ptc'`, only calls WITH a parent may execute a native tool name」，以及「every started PTC inner call is reviewed once before its body」）：内层 `write` 查作用域、内层 `pwsh` 按 shell 拒、内层未知工具失败即拒绝。**一处更正**：本轮曾据「日常 profile 不装 PTC 运行时」把它收缩为明确拒绝，那个前提是错的——`dsh-base/cordis.patch.yml:390-391` 插入 `ptc-runtime` 与 `workflow-ptc`，**PTC 一直在场**（`run_code` 只是只在 PTC 模式下呈现给模型），收缩会打断活能力，**已撤回**。撤回与教训见 `docs/ADR-0001-子会话执行载体.md` §19。**怎么验的（配方见 [docs/PTC-LIVE-PROBE.md](PTC-LIVE-PROBE.md)，自包含、任何会话可执行）**：先核对 §0 前提——模型拿到的正是「只有 `run_code` 加一份生成的 SDK」（那份 SDK 里是宿主工具，`tools.run_code` 反而是 `undefined`），原生 `write`/`pwsh`/`read` **不能**被直呼，说明本会话的 preset **就是 `ptc`**。**一处容易读错的地方**：会话头记的是**创建时**的 preset（本会话是 `standard`），实时状态才是判据（投影缓存 `session-f7b80b5f-…` 的 `agentPreset.val` 为 `ptc`）——只看会话头，会把「preset 已切到 ptc、`run_code` 已在工具面里」误读成「preset 没生效」。另有一条**部署级**来源也决定呈现模式：`dsh-tools` 的 `mode`，`dsh-web-app` 的 bundle patch 把它接到 `process.env.DSH_TOOLS_MODE`（`dsh-web-app/cordis.patch.yml:32-38`，注释写明是临时接缝）。进入 PTC 呈现后逐步实测（逐字结果）：① `gac_scope` 声明作用域 → **放行**，返回「任务 REQ-PTC-PROBE 节点 REQ-PTC-PROBE 现在可以写入 [ptc-probe-ok.txt]」（运行时自己的记账工具在内层也放行）；② 内层 `write` 写**范围内**文件 → **放行**，盘上确实出现、内容为 `ok`；③ 内层 `write` 写**范围外**文件 → **外层 `run_code` 照常跑完，只有那一次子调用被拒**：`GAC_WRITE_SCOPE_DENIED`，原文「GAC: 任务 REQ-PTC-PROBE 的节点 REQ-PTC-PROBE 只能写入 [ptc-probe-ok.txt]。"ptc-probe-bad.txt" 在该作用域之外（已声明的写作用域为 [ptc-probe-ok.txt]）。」，该文件盘上**不存在**；④ 内层 `pwsh` → `GAC_SHELL_DENIED_UNDER_SCOPE`；⑤ `gac_scope` 释放 → 返回「写作用域已释放，其写占用声明也已撤回。这个会话处于无管辖状态，所以不再检查任何写入。」，随后 shell **立刻恢复可用**、探针文件已删（`Test-Path` 为 `False`）。两个码取自已落盘的加载报告 `guard-denied` 记录（`tool: "write"` / `tool: "pwsh"`、`session: "session-f7b80b5f-5033-4f0f-9c95-6954ce4b6492"`），`gac_scope` 的声明与释放是工程证据日志的 seq 98/99。**如实说明一处没能单独观测的**：内核「子调用带 `parent` 令牌」这一条本身无法从 SDK 内单独观测（`tools.run_code` 在 SDK 里是 `undefined`——传输不能自己派发自己），观测到的是它的**行为后果**：外层放行、内层逐次受管 |
| 独立验证的独立性来自信息路径 | **部分**。契约确实把两条推导路径分开了（测试只依据契约，实现只依据契约与方案），但**唯一一次真实走查里两边出自同一个作者** |
| `workspaceChanges` 覆盖面需实测确认 | **已活体验证（2026-10-06，日常 profile）**。`workspace/changes` 是 `dsh-session` 声明的**已知事件类型**，生产者 `@deepseek-ai/dsh-workspace-changes` 由 `dsh-web-app` 的 bundle patch 插入（`cordis.patch.yml:339`），因此**一直在场**——**此前写的「它不在 `core-020` 的 bundles 里、没有东西会追加该事件」是错的**：那是**解析层**的判断（profile 的 `package.json` 与提升 junction），而 `dsh-web-app` 的 patch 插入了这一行，事件一直在被追加（历史里就有 56 条）。判据应当是**已加载树**：服务在不在（`witness-seam`）、事件来不来（`workspace/changes`）。**live 结果**：`turn 38` 的 `listed/total = 2`、`coverage: complete`、`out_of_scope: 1`，证据 `ev-1820` 的 `in_scope = ["witness-probe-a.txt"]`、`out_of_scope = ["witness-probe-b.txt"]`、身份字段齐全；更丰富的一例是 validation profile 的 `ev-1789`（越界 4 个，含三个真实源码文件，`isPassingEvidence` 判为不可用）。**已核实的契约**（对着桌面安装里那份类型声明逐字段比对，`dsh-workspace-changes@0.2.0-rc.2`）：服务是 `summary(sessionId, seq)` **两个参数**（包里那个单参数的 `summary(seq)` 是内部 recorder，看串就会永远取不到摘要），摘要与文件字段名与 `compileWitnessSummary` 一致，`binary`/`oversized` 是可选真值标记而不是 `kind` 判别联合。**截断也已实测（2026-10-06）**：一轮里造 505 个文件（生产者默认 `maxFiles = 500`），报告与证据都如实记下 `listed: 500` / `total: 505` / `truncated: true` / `coverage: "partial"`（证据 `ev-1882`）——**截断是可见的**，插件没有把「只列了 500 个」读成「只有 500 个改动」，那正是这一层要防的误读 |
| **插件改自己的代码时无法自管** | **按文档处置，且默认就不启用**：本项目约定本插件**默认关闭**，只在需要跑真实会话（E2E 验收）时打开，测完关回去——开关是 `npm run plugin:on` / `plugin:off` / `plugin:status`（`scripts/plugin-switch.js`，只改 profile patch 里 `- id: gac-runtime` 的 `disabled:` 一行）。理由：开着改 `lib/*.js`，每一笔写入都会热重载进模型自己正在用的宿主进程，而门禁与提示段落的失败方向分别是「拒绝一切」与「每一步装配失败」——那会把自己关在门外，且没有工具能用来修。代价：插件的模式与写作用域是**内存**状态，卸载即丢（任务记录在盘上，不丢），所以关闭期间没有 GAC 管辖；门禁、提示段落与 `gac_*` 工具都不在，**那是默认状态，不是故障**。**开关是否热生效未定论**：2026-10-05 实测 `plugin:on` 之后 90 秒，加载报告里仍没有新的 `plugin-loaded`（最后一次写入停在 1 小时前），而同一天的历史记录里存在 3–8 ms 就应用的条目——因此判断只能靠报告里有没有新记录，没有就说明这个宿主需要重启才能实测。实测的关闭/重开循环见 README「Install」 |

## 5. 切旧运行时之前的门槛

**这一节是本轮新增的：门槛按「生产能力契约」判，而契约里的能力必须在日常 profile 里成立**
（只在验收 profile 里成立的不算，那意味着验收时验的是运行时 A、日常跑的是运行时 B）。

```text
原生子会话执行            PASS（活体，§3）
子会话严格写作用域        PASS（活体，§3 E2E-4 与 ADR §14）
角色工具面隔离            PASS（活体 6 轮，§3 E2E-6；2026-10-08 起按语义角色给档，设计节点无仓库检视工具）
子会话委派封堵            **部分**（判据、收权与守卫已落地；2026-10-08 活体：真实子会话三次委派调用全部被拒，呈现层收不掉的原因已查明，见 §6.1 第 3 条）
HIGH_RISK 完整链          PASS（活体，ADR §15 的 REQ-HR-5：四节点全 completed、三份产物由运行时登记、父会话零补写）
语义产物自动登记          PASS（同上）
工作区观测 live           **PASS（日常 profile，2026-10-06，证据 `ev-1820`）**
全部测试                  PASS
```

- **工作区观测是必需项**（纵深防御层，不是可选增强）：它覆盖事前拦截够不着的那一类落盘——shell 重定向、生成器、外部进程、间接写入。**它进入日常 profile 之前，旧运行时不能切。** 探针文档：[docs/WITNESS-LIVE-PROBE.md](WITNESS-LIVE-PROBE.md)。
  **live 结果（日常 profile，逐字）**：`{"event":"witness-turn","turn":38,"listed":2,"total":2,"coverage":"complete","out_of_scope":1}` 与 `{"event":"witness-out-of-scope","turn":38,"files":1}`；证据 `ev-1820` 的 `workspace.in_scope = ["witness-probe-a.txt"]`、`out_of_scope = ["witness-probe-b.txt"]`、`governing_session_id` / `task_id` / `node_id` 齐全——一次干净的两文件探针，范围内与范围外各归各位。**范围外那个文件是「作用域声明之前启动的进程」写的，守卫从未见过它：第二层抓到了事前拦截抓不到的东西。**
  **`ev-1789`（validation profile，`turn 36`）是同一断言的更丰富一例**：越界清单里既有那种进程写出的文件，也有同一轮在声明作用域之前改掉的三个真实源码/测试文件；`isPassingEvidence` 判为**不可用**（越界 4 个），对照实验（只清空越界清单）立刻变可用。
  **这一轮还修掉一条只有活体能发现的缺陷**：生产者先 `append`（同步发布 `session/event`）、后把摘要存进记录表，插件读得太早，于是每一次都是 `witness-summary-missing`（提交 `f589bde`）。
  **一处更正（原判断是错的）**：此前写的是「本机 profile 未装配生产者」。**生产者一直在场**——它不在 profile 自己的依赖里，却是 `dsh-web-app` 的 bundle patch 插入的一行（`cordis.patch.yml:339`），因此每个含 `dsh-web-app` 的 profile 都有它。当时的判断用的是**解析层**（profile 的 `package.json` 与提升 junction），而正确的判据是**已加载树**：服务在不在（`witness-seam`）、事件来不来（`workspace/changes`）。**因此「把生产者装进日常 profile」这一步根本不需要**，临时验收 profile 也没有存在的必要——它**已经删掉**（机器上只剩 `core-020` 与 `tauri`），「验收一个运行时、运行另一个运行时」的隐患随之消失。经过见 [docs/WITNESS-LIVE-PROBE.md](WITNESS-LIVE-PROBE.md) §0 与 §7。
- **PTC 不在门槛里。** 它是执行便利，不是权限原语、验证原语、证据原语或隔离原语；没有它 GAC 仍然完整、安全、正确地工作。因此「PTC 缺席」不算 Runtime 未完成——**而它其实在场**（`dsh-base` 的 patch 插入 `ptc-runtime` 与 `workflow-ptc`），`run_code` 只在 PTC 模式下才呈现给模型。
- **门槛本身现在有执行点。** 上面那张表的每一项都能被机器核对：工程在适配器里声明 `execution.required_capabilities`，插件在第一次工具调用时逐项核对**已加载树**并把缺项写进加载报告的 `capability-check`；`high_risk_task` 收口时缺项未获显式豁免（`capability_ack`）就按 `GAC_COMPLETION_CAPABILITY_MISSING` 拒绝。**本仓库的适配器已声明全部六项**，因此这条路径在本工程上是活的（不是只写了文档）。决定与两个实现坑见 `docs/ADR-0001-子会话执行载体.md` §20。

## 6. 「新任务默认走 DSH」具体指什么

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

按重要性排序，不是按工作量。**§6.1 是仍未关闭的门槛；§6.2 是已关闭的条目**——已关闭的留在这里而不是
删掉，因为本文件里每一行都是一次实测的结论，删掉它等于让下一个人重走一遍。

### 6.1 仍未关闭

1. **从未交付过一个不是自己编的需求。** 上面每一条门禁都拦住过我，但拦住的**都是我自己写下的
   缺陷**。这证明的是「门禁能工作」，还没证明「门禁能拦住别人」。**要闭掉它，需要你给一个真实需求。**
2. **独立性未证明。** 契约起了作用，但两边出自同一个作者。`lib/review.js` 现在把这一点变成了
   **必须回答的六问**，可它核对的是申报而不是事实：同一个模型写出来的两份产物，六问照样能填绿。
   要让这条从「填了」变成「成立」，需要的是不同的信息路径（不同 system prompt、不同 messages、
   不同执行顺序）**和不同的作者**（真人或另一个模型扮演 Builder/Verifier），不是再加一道门禁。
   **2026-10-08 的进展**：信息路径这一半已经由运行时分开——设计节点拿不到任何仓库检视工具，
   「它知道什么」不再靠它自觉；但「同一个作者」那一半仍未解决。
   **2026-10-08 的活体裁决（`REQ-BLIND-1`，独立验证节点做了 41 次只读调用）**：AC1 **部分成立**、
   AC2 **不成立**、AC3/AC4/AC5/AC7 成立、AC6 **不成立**。逐条口径：工具面确由角色派生，且检视轴与
   实现节点形成干净对照（D1 呈现面 12 项里没有 `read`/`grep`/`glob`/`pwsh`/`write`/`edit`，I1 的 43 项
   里有），但**同一清单仍携带委派类**（AC2，见第 3 条）；设计与实现的挂钟交集 **13026 ms**、任务图无
   依赖边（AC4）；三类产物零实现侧泄漏，`blind-secret`/`blind-e2e` 从未进入设计节点的输入输出与历史
   （AC5）；**盲区证书只覆盖启动瞬间的一张快照**——AFTER_PLAN=0、AFTER_SESSION_END=0，五条中途换面的
   触发路径一条都没发生、也没有对应护栏证据（AC6）。**核心主张成立**：设计节点没有仓库检视能力，
   且这一点是 Runtime Fact，不是它的自述。
3. **子会话委派封堵在呈现层收不干净（进程外 provider 上更装不上）。** 委派类与父会话协调类的判据、
   创建期 `toolFilter`、`start()` 之后的对账补收与守卫都已落地；但 `ctx.subagents.start()` 只返回
   `run.id`，进程外 provider 拿不到 `localAgent`，那两层的容器就无从取得。此时记
   `child-surface-unavailable` 并按角色阻塞（高风险任务 fail closed），**不宣称委派已被封堵**。
   **2026-10-08 活体读数（`REQ-DELEG-1`）**：真实子会话里 `subagent`、`team_task_create`、以及**只读的**
   `team_task_list` 三次调用全部被拒（拒因逐字见 ADR §21），没有产生任何子会话或共享任务条目——拦截
   是**按工具族**做的，fail-closed 在活体上成立；同一会话里 `pwsh` 被写作用域闸门独立拒掉
   （`GAC_SHELL_DENIED_UNDER_SCOPE`），而 `read`/`glob`/`write` 正常，说明这不是会话残缺而是精确的策略面。
   **呈现层的缺口现在也有精确读数**：设计节点（`REQ-BLIND-1/D1`）的呈现面是 12 项，其中 7 个委派类名字
   仍在——运行时**本就想收掉它们**，收权却在本机宿主上失败，运行时自己记的 `role-revocation-failed`
   写明原因：`tools.restrict() names unknown global tools "spawn_teammate","wait_agent",
   "team_task_create","team_task_list","team_task_get","team_task_update","subagent"`。**能不能收掉取决于
   宿主把哪些名字算作「可收集合」，运行时无法单方面决定**；收不掉时按工程声明的 `tool_guard` 逐次拒绝，
   呈现层如实记 `child-surface-unverified`。未实测的仍是 `spawn_teammate`/`interrupt_agent`/
   `team_task_update`/`workflow` 的逐条返回（只有族级推断）。
4. **收口的「验证载荷」是摩擦点。** `high_risk_task` 收口要求 `evidence.verification` 里逐条给出 `case_id`/`outcome`/`evidence_ref`，而模型的默认行为是回一份散文——真实那轮两次被拒（拒因如今能读懂，见 `GAC_VERIFICATION_PAYLOAD_MISSING`）。可行方向：让运行时从已签发证据自动装配载荷，或在契约里给出形状。未做。
   **2026-10-08 两次活体复现**：① `REQ-BLIND-1/V1` 第一次失败是「`self:<n>` 引用解析不到运行时签发过的号」——根因**不在载荷方案**，而在插件中途被卸载：证据采集是 `tools/result` 上的一条订阅，重载即静默截断（该子会话 49 次调用只采到 11 条证据）。② 重派后换了理由：「缺少已执行证据的用例：VP-BLIND-01、02、07、09、11、12、13」——验证者**如实**把那 7 条判成 `failed`（自陈口径「未验证 ≠ 通过」），而门禁只认 `outcome === 'passed'`，于是整份报告被拒。这是**门禁按设计工作**，同时说明：由需求推导出来的计划里，会有若干条用例在验证者的证据面里**无法证明**（例如要求「实际发起攻击并观察拦截」而该节点没有任何攻击手段）。
5. **E2E-5 语义与规格不同。** 串行与拒绝是两种不同的保证，文档必须说清是哪种；**现在是「文档说清了、但还没决定要不要改回规格的行为」**。

### 6.2 已关闭（留档）

6. ~~**没有系统提示段落。**~~ **已补（2026-10-04）**：`lib/prompt-section.js` 注入
   `gac:protocol`，工程已纳管时模型就能看到门禁存在与当前状态，不必靠撞上去才发现。
   **仍未做的**：没有一段「协议总览」——流程语义仍散在各工具的描述里；要不要再写一段是
   待定项，因为段落每长一分，每个模型步进都多付一分。验证方式也记在这里：段落是否真的
   送达，看的是会话日志里的 `system/message` 节点，而不是插件自报。
7. ~~**E2E-6 缺失。** 没有按角色收权；「验证者不能写产品代码」目前只靠进程内执行者结构上没有写工具来间接成立。~~ **已补并活体验证（2026-10-05，6 轮，见 §3 E2E-6）**：只读节点在飞时 `write` 被逐字拒绝、回报后立刻恢复；`shell` 默认留着（项目可声明连它一起收回）。
   ~~**仍未闭合的两步**：其一，判据字面要求的 `UNKNOWN_TOOL` 形态没被观察到……其二，第 6 轮查明守卫是 **fail-closed 按类别**判定……~~
   **两步都已闭合（2026-10-08）**：其一，`subagent` 收不掉的归因**是错的**——它不是「不在可收集合里」，而是**没被点名**。内核 `tools.restrict` 只过滤该作用域**继承**来的工具；agent 自己那一层注册的工具不受管辖，而这条豁免是刻意的（子会话的 `structured_output` 就靠它活）。现在按语义角色点名收掉，并在 `start()` 之后用**子会话自己的视图**对账补收（`lib/child-surface.js`）；收不掉就如实降级成 `guard-only` 并记 `child-surface-unverified`。其二，`UNKNOWN_TOOL` 形态的判据**作废**：守卫是 fail-closed 按类别判定，单看「被守卫拒绝」无法判断收权有没有生效——所以判据改为报告的 `mode` 与 `presented`/`removed` 名单，而不是拒绝本身。
8. ~~**PTC 被整体拒绝。** 任何依赖 `run_code` 的流程在作用域下无法运行。~~ **处置仍是「外层传输放行、内层子调用按自己的名字受管」**，因此这一条从来不是缺口。**一处更正**：本轮曾把它改判成「不属于生产能力契约、明确拒绝」，前提是「日常 profile 不装 PTC 运行时」——那个前提错了（`dsh-base` 的 patch 插入 `ptc-runtime` 与 `workflow-ptc`，PTC 一直在场），改动会打断 PTC 模式下声明了作用域的活能力，**已撤回**。**它不在 §5 的门槛里**这一点不变：PTC 是执行便利，不是权限原语。撤回与教训见 `docs/ADR-0001-子会话执行载体.md` §19 与 README 的「生产能力契约」。
9. ~~**witness 替代品缺失。** 变更证据只有工具调用，没有工作区差异比对。~~ **已补（任务 `REQ-WITNESS`）**：`lib/workspace-witness.js` + 入口订阅，变更集按已声明写作用域归属，越界影响证据可用性但不阻断调用；证据载荷本轮补齐了 `in_scope` 清单与治理身份（`governing_session_id` / `task_id` / `node_id`），越界不可用那条分支也终于有了测试。~~**仍未证明的**：这一层在本机 profile 下收不到任何事件（生产者未装配，见 §4），所以它的单测覆盖的是契约行为，不是线上行为。~~ **已活体验证（2026-10-06，日常 profile，证据 `ev-1820`）**：`witness-turn listed=2 total=2 coverage=complete out_of_scope=1`，并生成了真实工作区证据；`maxFiles=500` 截断那一档也实测过（505 个变更 → `listed=500 / total=505 / coverage=partial`）。此前「生产者未装配」的判断是错的，更正记在 `docs/ADR-0001-子会话执行载体.md` §19。**本轮把它的定位从「可选后续」提升为「生产纵深防御层」**：验收 profile 活体验收通过之后要装进日常 profile，并且**它进入日常之前，旧运行时不能切**（见 §5）。
10. ~~**设计节点的盲区只到「启动时」。** 真实 `high_risk_task` 里，设计子会话启动时没被推入任何实现信息，但它后来自己把实现产物读了过来（`read`/`grep`/`glob` 对它开着）。而 §14 要求设计与实现**并发**——两条在字面上冲突。可行方向：给设计节点一个**无工具面**……~~
    **已关闭（2026-10-08）**：设计节点现在拿不到任何仓库检视工具。`lib/role-tools.js` 按语义角色给出 `verification_design` 的 `deny_kinds`（read / shell / write / ptc / unknown），三层落地——创建期 `toolFilter`、`start()` 之后对账补收、全局门禁按会话读角色兜底（`lib/plugin.js`）。独立性因此是 **Runtime Fact**：工具面里没有 `read`/`grep`/`glob`，它就没有能力读实现。设计与实现仍然**并发**：它只依据需求、验收标准与冻结契约推理。
11. ~~**子会话仍拿得到 `subagent`。** 8 个协调/委派名单点掉了 7 个，`subagent` 是 agent **自己那一层**注册的，既不在父会话的可收集合里、也不受 `restrict` 管辖；GAC 传的 `maxDepth` 只管 GAC 自己的派遣。可行方向：`start()` 返回子会话 id 后立刻给那个 id 登记一条角色收权——**要先量出竞态窗口**……~~
    **已关闭（2026-10-08）**：委派类（`subagent` / `subagent_fork` / `workflow` / `spawn_teammate` / `send_message` / `team_task_*`）与父会话协调类（`gac_*`）在**任何**语义角色下都被拒，拒因带 `child_session_id` / `task_id` / `node_id` / `role` / `tool`，稳定码 `GAC_CHILD_DELEGATION_DENIED`。编排权归 GAC。**仍存在的平台限制**见 §6.1 第 3 条。
12. ~~**`native_child_dispatch` 的代码默认仍是 `false`。** 只有本工程适配器打开。……所以默认值现在是个**待定决定**，不是缺陷。~~
    **已决定：默认开（2026-10-08）**。当初不给默认值的三条理由（子会话工具面没收窄 / 子会话写作用域未完成 / 语义结果未完成）都已关闭；默认关会让新纳管工程**静默退回主会话自我验证**。默认开不等于静默降级：接缝缺席时，高风险任务与含非实现节点的任务**阻塞**（`GAC_CHILD_SEAM_UNAVAILABLE`，不由主会话代跑），只有「全是实现节点且非高风险」才显式降级。`direct_edit` 永远不起子会话。

## 7. 这份记录本身的状态

它是**声明，不是机器强制**：没有任何代码消费本文件，格式不达标不会被拦下。它唯一的用处是
让下一个接手的人不必从零开始核对——尤其是 §3 与 §6，那两节里每一行都是一次实测的结论，
而不是推断。
