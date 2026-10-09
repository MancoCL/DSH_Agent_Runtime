# GAC 切换状态与验收索引

本文只记录**当前已验证什么、尚未证明什么、什么时候可以替代旧 Runtime**。设计原理看 [README](../README.md)，宿主级事故和详细调查看 [ADR-0001](ADR-0001-子会话执行载体.md)。历史活体原文与执行记录保留在 Git 历史和项目 GAC Evidence/Audit 中，不在此重复数十轮失败与改判过程。

## 1. 当前边界

- 新系统是 DSH 插件；旧系统在 `~/.claude/workflow`，属于另一宿主。**本仓库未迁移、删除或修改旧 Runtime**，也不能因为 DSH 一侧通过测试就宣称旧系统已经退役。
- 日常使用的 Profile 因机器而异，应通过真实加载报告核实插件来源与版本；可以安装固定 npm 版本、GitHub 标签/提交或验收过的本地包，**但不能长期链接源码工作树**。本机 `core-020` 当前为 `github:MancoCL/DSH_Agent_Runtime#v0.1.1`，这是已发布旧快照，不等于当前 Git HEAD；部署状态取当前检查结果为准。
- 自开发时，改 `lib/*.js` 前应关闭加载工作树的插件实例；生产稳定副本是否开启以实际 Profile 和加载报告为准，不照搬“本仓库开发默认关闭”的语句。
- GAC 的 TaskStore 是任务现态，GAC Event Log 是追加审计；**Host Session Log 属于 DSH，禁止写插件自定义事件**。
- `execution.required_capabilities` 是可执行门禁，不只是声明。高风险完成时发现必需能力缺失，按 `GAC_COMPLETION_CAPABILITY_MISSING` 拒绝；PTC 不属于必需项。

## 2. 已验证的关键行为

| 场景 | 真实证据与边界 |
| --- | --- |
| 写作用域 | 根文件 `mod.c` 不等于 `sub/mod.c`；结构化越界写在执行前 `GAC_WRITE_SCOPE_DENIED`；Child Binding 也已实测。 |
| 原生子会话 | Child Session 独立身份、工具面、结果回传和批次并发已实测；高风险演示 `REQ-HR-5` 四节点（Design、Implementation、Verification、Review）最终 `completed`。**这不是新四类专家设计链的 E2E**。 |
| 角色隔离 | `verification_design` 的仓库检视/写入/执行被角色策略拒绝；委派类在执行期 `GAC_CHILD_DELEGATION_DENIED`。模型呈现面仍可能出现宿主 own-layer 工具，见 ADR §23。 |
| 语义产物 | VerificationPlan、VerificationReport、ReviewReport 已能由 Child 结果自动登记；需冻结、AC 追溯、有效 Evidence 与 Review 结果才能收口。2026-10-09 新增 `verification_context`/测试详设注入与逐用例证据校验，**已有单测，不等于新场景活体已通过**。 |
| Witness | 日常 Profile 实测 `ev-1820`：`listed=2, total=2, coverage=complete, out_of_scope=1`。另一次 `505` 变更受 `maxFiles=500` 截断，按 `coverage=partial` 记录。被 Git 忽略的路径不被生产者观测。 |
| PTC | 实测外层 `run_code` 通过、内层越界 `write` 和 `pwsh` 各被正常门禁拒绝；PTC 在场可用，缺席不阻断 GAC。 |
| 审计安全 | 插件自定义审计写 `.dsh/gac/events/events.jsonl`；历史 Host Session 自定义事件兼容事故已修复，回归见 `test/session-log-integrity.test.js`。 |
| 默认处理与升级 | 普通修改默认 `direct_edit`；升至 `standard_task` / `high_risk_task` 必须绑定用户同意与相应评估，见 `test/mode-upgrade.test.js`、`test/operation-task.test.js`；不宣称所有宿主问答路径已活体验收。 |
| 后台派遣 | 新增 `DispatchTracker`：节点异步运行，按任务串行结算，持久化 outbox 并通过宿主消息通知；异常派遣可被标记中断。单元测试见 `test/dispatch-tracker.test.js`；跨宿主重启与真实业务最终闭环仍需现场验证。 |

需重新验证或升级 DSH 时，使用 [Witness 实测配方](WITNESS-LIVE-PROBE.md) 与 [PTC 实测配方](PTC-LIVE-PROBE.md)。不要把历史成功记录自动当成**新 DSH 内核、新 Profile 或新模型**下的成功记录。

## 3. 生产能力验收

- **必需**：原生 child dispatch、严格写范围、角色隔离、Write Claims、Evidence Log、语义产物、Workspace Observation；具体闭集看 `lib/capabilities.js` 与项目的 `required_capabilities`。
- **非必需**：PTC、额外子代理任意委派、Memory Provider；缺席不触发必需能力降级。
- **平台限制**：工具 `tools.restrict` 不能收子会话 own-layer 的委派名字；GAC 的执行前 Guard 拒绝调用，不声称完全移除可见工具，也不因此 fork 宿主。
- **安全边界**：只读工具面不等于操作系统级只读 Shell；结构化写入的 Guard、事后 Witness 与 OS Sandbox 是不同机制。Child 创建到绑定之间的竞态也不应被单测成功掩盖。

## 4. 旧 Runtime 切换条件

以下都满足时，才考虑将某个实际项目的默认入口从旧 Runtime 切到 DSH；不自动更改旧工程：

1. 在**实际将使用的 Profile** 上安装可追溯到具体源提交的稳定插件版本，且所需能力检查通过。
2. 使用至少一个**非框架自编的真实工程需求**，从需求收敛到最终验收、实物产物和独立 Evidence 全链路完成。
3. 对需要正式设计的 `high_risk_task`，完成真实的四类设计成果（软件架构、软件详设、测试架构、测试详设）→ DesignPackage 审核/批准 → Builder 与 Test Builder 独立实施 → Verifier → Reviewer → 最终收口。
4. 真实任务没有由主会话替代 Builder 编码，发生权限/工具不可用时有明确阻塞或授权豁免记录。
5. 复验所用生产 Profile、模型/Provider、插件代码版本、设计与验证证据可追溯，关键安全负例实际通过。

## 5. 已知限制与不在本轮范围

- DSH own-layer 委派工具呈现污染属于**宿主层已知限制**；执行期按工具族拒绝已实测。详细根因见 ADR §23，不再在 GAC 内部添加执行器或无穷的过滤补丁。
- Design 与 Verification 已具备不同 Session/Context/工具面，但**不同模型/作者**不是默认保证；需独立查验子会话实际 Provider/Model。
- VerificationPlan 若要求 Verifier 在当前工具面无法执行的攻击或写操作，仍可能缺少合规证据。目前已有可选的项目 `verification_context`（包含测试入口、能力与环境身份）及测试详设、冻结用例输入；**尚需真实任务证明这些输入足以防止用例不可执行**，不能虚报 PASS。
- 资源独占冲突当前在**调度期将节点放入不同批次串行执行**；不采用先派遣再拒绝的旧定义。Write Claims 仍负责跨会话写冲突。
- Memory、自动 Git Checkpoint、完整 Event Sourcing 当前均不是切换阻塞项；没有真实消费需求时不为其增加新子系统。

## 6. 阻碍一次完整切换的东西（当前清单）

### 6.1 尚未关闭

1. **真实用户需求的最终交付**：缺少一份非框架自编需求从确认、设计、批准、实施、独立验证到最终收口的完整现场证据。
2. **作者独立性**：已有角色级 Provider/Model 路由和独立 Session，但还应在目标生产 Profile 采集真实子会话身份、路由、执行和审查证据，不能仅靠角色名证明异作者独立。
3. **验证用例的实际可执行性**：最新代码已能注入适配器的测试能力/环境、测试详设和冻结用例，并要求逐 case 的证据；仍需真实 E2E 确认测试执行器能完成计划中的每一类测试。
4. **新设计驱动 HIGH_RISK 全链路**：四类设计产物、批准与设计换版已有代码及单测，但尚未证明全链从设计到 Builder、Test Builder、Verifier、Reviewer 自动达到 `completed`。旧 `REQ-HR-5` 不覆盖这一点。
5. **后台派遣与消息结算的宿主现场**：新 `DispatchTracker` 已有单元测试；实际 DSH 中断恢复、持续派遣、异步通知与无人工补登记收口仍需独立验收。

Own-layer 委派工具可见性属于 §5 已归因的平台限制；资源冲突按调度期分批串行执行属于已决定的规格，**两者不再当作待开发功能**。

### 6.2 已关闭（证据索引）

- Runtime 原生子会话、独立上下文、并发与结构化结果闭环：`REQ-HR-5`。
- Child 自动绑定 Strict Scope、越界写前拒绝及旧 Attempt 隔离：相关工具与测试、历史 Live Probe。
- Witness 日常 Profile 与截断：`ev-1820` 及 505 文件探针。
- PTC 内层权限审查：见 [PTC 配方](PTC-LIVE-PROBE.md)。
- `verification_design` 的仓库检视工具限制、委派执行期拒绝：`REQ-BLIND-1`、`REQ-DELEG-1`；**工具呈现限制仍按 §6.1 #3 标注**。
- GAC 事件与宿主 Session Log 分离：`test/session-log-integrity.test.js`，事故经过见 ADR。

## 7. 下一次宿主验收清单（尚未执行）

2026-10-09 的 S0–S5 实施代码已分别进入提交 `9459dd8`、`38564da`、`dfb05ed`、`27dca93`、`e260cf3`、`9640ee3`；集成测试见 `0b70d4d`。原一次性实施清单已从现行文档移除。**S6 的真实宿主 E1–E7 尚未执行，不得把单元测试或早期 `REQ-HR-5` 算作通过。**

| 场景 | 现场必须核实 |
| --- | --- |
| E1 日常非代码、注释及局部缺陷修复 | 默认为 `direct_edit`；不产生 Task/Child，也不多余地请求升级 |
| E2 高风险路径上的只读或注释改动 | 评估真实影响；不因路径命中直接升级，读写范围有效 |
| E3 复杂非核心需求 | 宿主问答同意前不得创建并派遣 Standard Task；拒绝后不得继续实施 |
| E4 真实核心行为修改 | `high_risk_task` 完成四类设计、方案批准、Builder/Test Builder、独立验证、复核及业务交付 |
| E5 快慢节点并发与失败 | 分别及时后台结算并通知，错误和阻塞如实记录；不依赖人工 sleep/轮询 |
| E6 设计专家助手 | `gac_expert` 只允许一层只读助手，预算、盲化、二次委派拒绝及取消回收均成立 |
| E7 重启、重复通知、旧 attempt 与设计换版 | 不重复结算、不把中断误报完成、不接受过时结果 |

**实施方式：**取得真实需求后，先固定 Git 提交、确认干净工作区并通过 `npm test`；核对目标 Profile 与 `deploy:status`。仅在明确需要验收当前源码时，完全退出 DSH 并执行 `deploy:validate -- --apply --confirm-verify`；重启 DSH 执行 E1–E7，保存实际加载版本、会话身份、Evidence 和回归日志。通过后再次退出宿主，以真实 Evidence ID 执行 `deploy:publish -- --apply --confirmed-pass --evidence <验收编号>` 安装隔离的本地包；失败则 `deploy:restore -- --apply` 恢复原安装。**其他固定 npm/GitHub 版本也可作为日常安装来源，不能把“只允许本地包”当作普遍限制。**

## 8. 维护口径

本文件只记**当前结论及指向原始证据的索引**，不重复历史十几轮工具返回、逐字日志和已经撤回的假设。README 负责当前能力；ADR 负责为什么这样设计；Live Probe 文档负责重测操作；测试输出与当前 DSH 加载报告优先于人工计数。
