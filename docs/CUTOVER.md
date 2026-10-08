# GAC 切换状态与验收索引

本文只记录**当前已验证什么、尚未证明什么、什么时候可以替代旧 Runtime**。设计原理看 [README](../README.md)，宿主级事故和详细调查看 [ADR-0001](ADR-0001-子会话执行载体.md)。历史活体原文与执行记录保留在 Git 历史和项目 GAC Evidence/Audit 中，不在此重复数十轮失败与改判过程。

## 1. 当前边界

- 新系统是 DSH 插件；旧系统在 `~/.claude/workflow`，属于另一宿主。**本仓库未迁移、删除或修改旧 Runtime**，也不能因为 DSH 一侧通过测试就宣称旧系统已经退役。
- 本机日常 Profile 为 `core-020`（切换机器或 Profile 后须重新核实），插件可通过稳定副本安装；当前 Git 工作树不一定与日常加载字节一致。
- 自开发时，改 `lib/*.js` 前应关闭加载工作树的插件实例；生产稳定副本是否开启以实际 Profile 和加载报告为准，不照搬“本仓库开发默认关闭”的语句。
- GAC 的 TaskStore 是任务现态，GAC Event Log 是追加审计；**Host Session Log 属于 DSH，禁止写插件自定义事件**。
- `execution.required_capabilities` 是可执行门禁，不只是声明。高风险完成时发现必需能力缺失，按 `GAC_COMPLETION_CAPABILITY_MISSING` 拒绝；PTC 不属于必需项。

## 2. 已验证的关键行为

| 场景 | 真实证据与边界 |
| --- | --- |
| 写作用域 | 根文件 `mod.c` 不等于 `sub/mod.c`；结构化越界写在执行前 `GAC_WRITE_SCOPE_DENIED`；Child Binding 也已实测。 |
| 原生子会话 | Child Session 独立身份、工具面、结果回传和批次并发已实测；高风险演示 `REQ-HR-5` 四节点（Design、Implementation、Verification、Review）最终 `completed`。**这不是新四类专家设计链的 E2E**。 |
| 角色隔离 | `verification_design` 的仓库检视/写入/执行被角色策略拒绝；委派类在执行期 `GAC_CHILD_DELEGATION_DENIED`。模型呈现面仍可能出现宿主 own-layer 工具，见 ADR §23。 |
| 语义产物 | VerificationPlan、VerificationReport、ReviewReport 已能由 Child 结果自动登记；需冻结、AC 追溯、有效 Evidence 与 Review 结果才能收口。 |
| Witness | 日常 Profile 实测 `ev-1820`：`listed=2, total=2, coverage=complete, out_of_scope=1`。另一次 `505` 变更受 `maxFiles=500` 截断，按 `coverage=partial` 记录。被 Git 忽略的路径不被生产者观测。 |
| PTC | 实测外层 `run_code` 通过、内层越界 `write` 和 `pwsh` 各被正常门禁拒绝；PTC 在场可用，缺席不阻断 GAC。 |
| 审计安全 | 插件自定义审计写 `.dsh/gac/events/events.jsonl`；历史 Host Session 自定义事件兼容事故已修复，回归见 `test/session-log-integrity.test.js`。 |

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
- VerificationPlan 若要求 Verifier 在当前工具面无法做的攻击或写操作，可能导致真实 case 无法产生通过证据。应为设计专家提供**静态验证能力清单**，而不是让验证者虚报 PASS。
- 资源独占冲突当前在**调度期将节点放入不同批次串行执行**；不采用先派遣再拒绝的旧定义。Write Claims 仍负责跨会话写冲突。
- Memory、自动 Git Checkpoint、完整 Event Sourcing 当前均不是切换阻塞项；没有真实消费需求时不为其增加新子系统。

## 6. 阻碍一次完整切换的东西（当前清单）

### 6.1 尚未关闭

1. **真实用户需求的最终交付**：已有大量自建负例和 E2E，但缺一个真实外部工程任务的完整需求→设计→实现→独立验证→最终验收记录。
2. **作者独立性的证明**：分离 Session、Prompt、Context、Tools 已有机制，但尚未在目标生产场景中凭真实 Provider/Model 或独立作者证据充分证明。六问 Review 不能代替作者事实。
3. **平台 own-layer 委派呈现**：执行调用已经 fail-closed，呈现面仍无法由 GAC 全收；这是**已归因平台限制，不是继续开发的 GAC 阻塞**。
4. **验证方案的可执行性**：曾有部分 case 缺实际执行能力而如实失败；建议把 Verifier 的静态可用能力注入设计上下文，保持设计节点对实现盲化。
5. **资源冲突的旧规格差异**：正式以调度期分批串行为准，后续规格/用例用同一表述，不引入 Resource Lease Manager。
6. **新设计驱动全链路 E2E**：四类设计产物、批准和设计换版已有代码与单测，但尚未完整实测到最终 `completed`。不得以旧 `REQ-HR-5` 代替。

### 6.2 已关闭（证据索引）

- Runtime 原生子会话、独立上下文、并发与结构化结果闭环：`REQ-HR-5`。
- Child 自动绑定 Strict Scope、越界写前拒绝及旧 Attempt 隔离：相关工具与测试、历史 Live Probe。
- Witness 日常 Profile 与截断：`ev-1820` 及 505 文件探针。
- PTC 内层权限审查：见 [PTC 配方](PTC-LIVE-PROBE.md)。
- `verification_design` 的仓库检视工具限制、委派执行期拒绝：`REQ-BLIND-1`、`REQ-DELEG-1`；**工具呈现限制仍按 §6.1 #3 标注**。
- GAC 事件与宿主 Session Log 分离：`test/session-log-integrity.test.js`，事故经过见 ADR。

## 7. 维护口径

本文件只记**当前结论及指向原始证据的索引**，不重复历史十几轮工具返回、逐字日志和已经撤回的假设。README 负责当前能力；ADR 负责为什么这样设计；Live Probe 文档负责重测操作；测试输出与当前 DSH 加载报告优先于人工计数。
