# dsh-gac-runtime

DeepSeek Harness（DSH）中的通用 GAC（Governed Agent Collaboration）插件。**DSH 提供会话、子代理与工具执行内核；GAC 提供需求分级、设计与实施治理、写权限、独立验证、证据和任务收口。** 不在插件内重建第二套 Agent Runtime。

> **阅读顺序**：本文件用于当前使用；[AGENTS.md](AGENTS.md) 是本仓库开发纪律；[docs/CUTOVER.md](docs/CUTOVER.md) 是真实验收与剩余缺口；[ADR-0001](docs/ADR-0001-子会话执行载体.md) 保留历史决策与事故细节。以代码、当前 Profile 和真实测试结果为最终依据，不以历史计划作为现状。

## 架构与职责

```text
用户 → 主 Agent（目标、进度、方案批准、最终验收）
          ↓
GAC Runtime（风险、DAG、派遣、权限、状态、证据和门禁）
          ↓
技术专家（软件/测试架构、软件/测试详设）
          ↓
Builder / Test Builder（分别实施产品代码与测试代码）
          ↓
独立 Verifier → Reviewer → Runtime 收口 → 主 Agent
```

- 主 Agent 管理需求与进度、批准设计并审核最终结果；**标准和高风险任务中不应直接修改产品代码或测试代码**。本工程通过 `authority.coordinator_write=protected` 保护 `lib/` 和 `test/`，只允许带理由的一次性审计豁免。该机制只检查结构化写工具，不能声称阻止所有 Shell 副作用。
- Agent 是有明确上下文、能力与权限的临时子会话。默认 `execution.native_child_dispatch=true`；不是靠同一主会话换提示词冒充独立执行。子会话由 `ctx.subagents.start()` 启动。
- 固定代码负责状态迁移、权限、调度、证据关联和结果验收；模型负责需求理解、技术方案、实现和认知型审查。
- 工程事实在 `<project>/.dsh/gac/project.json`；任务在 `.dsh/gac/tasks/`；GAC 审计事件在 `.dsh/gac/events/events.jsonl`。**不得向 DSH 宿主 Session Log 追加自定义 `gac/*` 事件**。

## 执行模式

| 模式 | 适用情况 | 执行方式 |
| --- | --- | --- |
| `read_only` | 调查、分析、说明 | 不产生产品修改 |
| `direct_edit` | 明确、低风险、局部、可立即验证 | 不建正式任务 DAG；当前实现由主会话完成 |
| `standard_task` | 普通功能、缺陷修复或局部重构 | Builder 与独立验证，按需进行设计 |
| `high_risk_task` | 安全、持久状态、公共契约、关键状态机等 | 冻结需求与接口、设计批准后实施，独立验证与复核 |

工程风险规则和实际执行约束在 `lib/project.js`、`lib/coordinator.js`、`lib/tool-task.js`；模型自报的低风险不覆盖项目适配器的高风险路径策略。

### 设计驱动的任务

设计专家通过独立子会话承担两类语义角色：

- `software_design`：产出软件架构和软件详设；可读取现有工程以形成增量方案。
- `test_design`：产出测试架构和测试详设；其测试预期来源于需求、已冻结接口与授权事实，不能从 Builder 当前实现反推。
- 四种设计正文组成引用式 DesignPackage；需求、设计产物、契约、验证计划采用内容身份。修订设计要显式换版，相关下游结果随之失效。
- **高风险实现节点必须等待设计包批准**；批准权在主会话，不在专家本身。实现与测试代码由不同节点持有写范围。

通用验证仍区分 `verification_design`（不具备仓库检视工具）、`verification_execution`（依据冻结计划执行）与 `review`（独立复核）。按节点语义角色施加工具与结果契约，不能只依据是否有写范围来判断角色。

当前设计驱动的结构、冻结门禁与换版回退已具有单元测试；**包含四类设计、批准、两类 Builder 和最终收口的全链路真实 E2E 仍待完成**，不能以单测全绿代替。

## 权限、调度与证据

- **Strict Scope**：`["mod.c"]` 只覆盖根目录 `mod.c`，不覆盖 `sub/mod.c`；`["src/"]` 覆盖 `src/` 子树。路径由 `lib/write-scope.js` 统一判断。部分 glob 使用现行跨目录的 `fnmatch` 语义；不要擅自改成另一套。
- **派遣前阻止越界**：`tools/pre-execute` 按会话和节点绑定的作用域拒绝越界结构化写入；写占用声明阻止跨会话冲突。Shell 在活动写作用域下按策略拒绝，不把 Shell 字符串当可靠路径声明。
- **调度**：DAG 依赖、写范围与独占资源决定当前安全批次；冲突节点串行，不是先派遣再争锁。每次派遣有 `attempt/dispatch_id`，过时结果不得覆盖新尝试。
- **主会话最小化**：`gac_task advance` 默认一波，可用 `max_waves` 受限连续推进；失败、阻塞或需要批准时停下。
- **验证**：冻结 VerificationPlan（含 positive/falsification）→ Runtime 签发 Evidence → VerificationReport → ReviewReport → 证据与 AC 覆盖门禁。角色结构化结果由 Runtime 自动登记，不能只信 Agent 的 “PASS”。
- **Workspace Witness**：订阅 `workspace/changes` 做事后变化分类，不能代替前置 Guard；对 Git 忽略路径不可见，截断时 `coverage=partial`。生产日常 Profile 已活体验证，复验配方见 [Witness 探针](docs/WITNESS-LIVE-PROBE.md)。
- **PTC**：存在时允许外层 `run_code` 传输；内层工具仍接受权限审查。它是可选执行能力，不是 GAC 必需能力。复验配方见 [PTC 探针](docs/PTC-LIVE-PROBE.md)。

### 生产能力契约

项目通过 `execution.required_capabilities` 声明需要的能力（闭集由 `lib/capabilities.js` 定义），运行时核对真实加载树；高风险完成阶段缺少必需能力会拒绝收口。主要必需项包括：

```text
native_child_dispatch, workspace_observation, role_isolation,
write_claims, evidence_log, semantic_artifacts
```

PTC、任意子 Agent 委派、Memory Provider 不属于默认必需能力。缺少必需能力不能静默降级成“照常完成”。

## 安装与本仓库开发

插件是 DSH Bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），通过 DSH 插件管理器安装到目标 Profile；**不要手动改桌面内核代码或其拥有的 Session 数据格式**。

```powershell
npm test
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\core-020"
npm run plugin:status
npm run plugin:on
npm run plugin:off
```

Profile 路径只作本机示例，应实际核对；启停是否热应用以 `plugin-loaded/plugin-unloaded` 报告为准，必要时重启 DSH。在开发本插件自身时，应关闭其自管实例后再修改 `lib/*.js`，避免 HMR 将半成品代码热加载进活宿主。日常稳定副本和 Git 源码可能不同，验收需记录真实加载版本。详见 [AGENTS.md](AGENTS.md)。

## 当前限制与验收边界

1. **尚未用一个真实外部业务需求完成新的设计驱动 HIGH_RISK 全流程 E2E**；参见 [CUTOVER](docs/CUTOVER.md)。旧的 `REQ-HR-5` 验证了四子会话的语义结果链，不等于新的设计驱动流程已经验收。
2. 多 Session / 工具与上下文隔离已实现，但**异模型/异作者独立性不是默认硬保证**；角色路由可以配置，结论要以实际子会话头和证据为准。
3. DSH 子会话 **own-layer 委派工具可能仍显示在模型面**；GAC 的执行前 Guard 已验证按工具族拒绝。宿主事件时序根因见 [ADR §23](docs/ADR-0001-子会话执行载体.md)，不要在插件里重新造执行器。
4. 只读角色可根据策略保留测试 Shell；它不等于操作系统级只读沙箱。GAC 结构化写拦截不保证发现所有间接文件修改，Witness 也不观察 Git 忽略路径。
5. 子会话创建到权限绑定之间可能有平台时序窗口；不可凭成功样例宣布任意调度时序下完全安全。
6. `memory` 与 `checkpoint` 的部分字段目前只是项目策略声明，**没有对应完整 Runtime enforcement**；不会自动 Git commit。GAC 审计文件也不是任务状态的权威来源。
7. 具体剩余项、历史真 E2E 与切换条件见 [CUTOVER](docs/CUTOVER.md)。历史执行接缝、宿主事故与版本判据见 [ADR](docs/ADR-0001-子会话执行载体.md)。

## 文档职责

| 文档 | 用途 |
| --- | --- |
| 本 README | 当前能力、使用方式及限制 |
| [AGENTS.md](AGENTS.md) | 在本仓库开发时的安全和提交规则 |
| [CUTOVER](docs/CUTOVER.md) | 当前未闭合条件与已验证证据索引 |
| [ADR-0001](docs/ADR-0001-子会话执行载体.md) | 原生执行载体、宿主兼容性与历史事故依据 |
| [ENGINEERING_POLICY](assets/ENGINEERING_POLICY.md) | Reviewer 真实读取的工程质量策略 |
| [Witness 探针](docs/WITNESS-LIVE-PROBE.md) / [PTC 探针](docs/PTC-LIVE-PROBE.md) | 未来升级后的复验步骤 |
