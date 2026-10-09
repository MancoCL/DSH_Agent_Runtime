# 通用工程质量策略（Engineering Quality Policy）

本文件只回答一个问题：**Agent 应该以什么工程原则修改代码。** 它管"怎么写"，不管"能不能写"。

```text
Requirement / Goal
        ↓
Execution Policy        GAC Runtime（lib/coordinator.js、lib/tool-task.js）    模式、DAG、派遣与收口
        ↓
Authority Policy        Project Adapter / Node Scope / Approval    写入范围、工具权限与升级授权
        ↓
Engineering Quality Policy（本文件）        如何写代码、如何控制复杂度、如何避免重复、是否该新增抽象
        ↓
Project Policy          <project>/.dsh/gac/project.json   工程身份、领域规范与已有架构约束
        ↓
Task Constraints        GAC Task / Node / DesignPackage        验收条件、设计基线与节点权限
        ↓
Effective Policy
```

优先级：

```text
任务明确要求  >  项目硬约束  >  通用工程质量策略
```

任务与项目策略都**不得降低平台安全要求**。有效策略 = 通用工程质量策略 + 项目工程策略 + 任务约束。

**单一来源**：本文件是通用工程质量策略，供 Runtime 注入 Reviewer 以及相关专家/执行者参考；权限与派遣的权威实现仍在 GAC 代码和工程适配器中。工程特有规则（语言规范、芯片事实、接口契约、既有模式、静态门禁）来自该工程自己的 `.dsh/gac/project.json` 及明确授权的工程资料，不能把历史 Claude 工作流的 `PROTOCOL.md`、`ROLES.md`、`.claude/project/` 当作当前必备文件。

## 0. 最高原则

优化目标**不是最少代码行数**，而是**最小必要复杂度**：

> Prefer the simplest implementation that fully satisfies the requirement without unnecessary
> abstraction, duplication, indirection, speculative extensibility, or unrelated changes.

> Write the smallest necessary solution, not the smallest amount of code.

```text
Reuse before recreate.
Avoid semantic duplication.
Prefer minimum necessary complexity.
Prefer localized changes.
Avoid speculative abstractions.
Avoid unrelated refactoring.
Preserve existing behavior unless change is required.
Prefer consolidation over parallel implementations when safe.
Prefer readability over code golf.
Add dependencies only when existing capabilities are insufficient.
Follow existing architecture before inventing new patterns.
Test behavior, not implementation trivia.
```

## 1. 优先复用已有实现

新增实现前，先在当前 Task 范围内查找是否已有：相同或相似功能、helper、utility、service、adapter、
component、parser、validator、抽象、测试夹具与接口。默认优先级：

```text
Reuse existing behavior unchanged
        ↓
Extend existing behavior
        ↓
Refactor existing behavior when necessary
        ↓
Create new implementation        ← 最后选择，不是第一选择
```

## 2. Reuse Scan（动手前必做）

```text
Understand Task
   ↓ 定向搜索：等价行为 → 相关抽象 → 相关测试
Decide: reuse / extend / refactor / create
   ↓
Implement
```

**按当前 Task 范围做定向搜索**，不为"找复用"而通读整个工程。搜索手段用项目既有的事实来源与检索方式
（既有目录结构、命名约定、项目已配置的检索工具），不要为此新建索引或框架。

## 3. 重复：区分语义重复与表面重复

要消除的是**有漂移风险的语义重复**：

- 同一业务规则多处实现；
- 同一协议逻辑多处实现；
- 同一数据校验多份实现；
- 同一常量多处独立维护；
- 已有 helper 却重新实现；
- 多份实现存在行为漂移风险。

> Do not introduce abstraction merely to remove superficial repetition.

两段代码只是偶然相似、语义不同，**不要求合并**。为消除几行表面相似而强行抽抽象，属于引入复杂度。

## 4. 不做投机抽象

除非当前 Requirement、现有架构或多个**真实**使用场景明确需要，否则不主动创建：

```text
Factory / Registry / Plugin system / Generic framework / 新的架构层
多余的 interface / abstract base class / 只服务一个实现的 adapter 层
为假设需求预留的 extension point / 当前没有消费者的通用框架
```

> Do not design for hypothetical future requirements unless the current requirement explicitly demands it.

**不为尚不存在的需求支付复杂度成本。**

## 5. 新抽象的成立条件

创建新抽象至少要有一条真实理由：

```text
1. 当前已有多个真实调用方
2. 能消除有实际漂移风险的语义重复
3. 当前架构既有模式要求
4. 当前 Requirement 明确要求可扩展性
5. 能明显降低当前（而不是假想未来）的复杂度
```

只有"以后可能会用到"不成立。

## 6. 最小修改范围

> Prefer localized changes. / No unrelated refactoring.

- 优先修改直接相关代码；
- 不顺手重构无关模块；
- 不做与 Requirement 无关的格式化；
- 不做无关 rename；
- 不清理整个仓库；
- 不因为看到旧代码"不够漂亮"就扩大范围。

## 7. 范围扩张（Change Scope Expansion）

原计划范围不够用时**不一定要问用户**，但必须：

1. 判断是否仍处于 Requirement 授权范围内；
2. 记录扩张原因；
3. 先复核 GAC 节点的 `write_scope`、现存 Write Claims 和设计基线；超出已批准边界的改动不得自行扩大写权限；
4. 在当前 GAC 任务、设计变更或审批记录中说明原因并保留可追溯证据；
5. 在需要独立审查的任务中，由 Reviewer 复核变更范围与需求、已批准设计的一致性。

当前 Runtime 的结构化写入按节点 `write_scope` 和作用域绑定在执行前检查；一旦扩张越过原批准的模式、范围或关键设计，应停止并走需求评估/用户授权与设计换版流程。不要声称旧版 `invocation --file` 或 `quality.scope_expansion` 门禁在本插件内自动生效。

当扩张涉及**业务目标、关键安全行为、已批准设计、生产部署、破坏性操作或新的外部成本**时，应先经主 Agent 评估并按 GAC 升级/审批流程取得必要的用户授权；不能用“只是技术细节”绕过风险分级。

## 8. 保持既有行为

> Preserve existing behavior unless the requirement requires changing it.

修复任务只修目标行为，不顺带改变其他已有行为。兼容性变化若不是 Requirement 明确要求，需要充分理由；
有理由时写进当前可追溯的设计变更或任务结果说明，而不是依赖旧工作流字段。

## 9. 整合优于并行实现

> Prefer consolidation over parallel duplicate implementations when safe.

新实现替换旧逻辑时优先 `replace` / `consolidate`，不要长期保留 `foo()` / `foo_new()` / `foo_v2()`。
删除旧实现前必须确认：

```text
当前 Requirement 允许 / 无兼容性要求 / 没有真实调用方依赖 / 测试能覆盖迁移结果
```

## 10. 可读性优先于 Code Golf

> Readability > fewer lines.

不为少几行代码使用：难理解的表达式、过度嵌套的三元表达式、不必要的宏技巧、隐晦副作用、
过度压缩的逻辑、不直观的一行多操作。

"代码精简"的定义是**少不必要的结构与重复，而不是少字符**。

## 11. 复杂度控制

主动避免：深层嵌套、不必要状态、不必要中间层、多余数据转换、多余 wrapper、多余 indirection、
多余配置项、同一事实多份存储。优先：单一职责、清晰控制流、显式数据流、最小必要状态。

但不得机械转化为"所有函数必须极短"——见 §14。

## 12. 依赖策略

新增依赖前先确认现有能力不足：

```text
现有标准库  →  项目已有依赖  →  现有 utility  →  新增依赖
```

新依赖应有实际价值；不为减少少量实现代码引入重量级依赖。新增依赖时在节点 `quality.new_dependency`
声明，并让 Reviewer 检查必要性。

## 13. 测试同样适用

测试**验证行为**，不复刻实现细节：不为通过测试修改测试语义、不直接复刻实现算法、不对内部实现
产生无必要强耦合、已有 helper 可复用时不重写大量重复 setup。

但也不为消除少量测试重复而创建复杂 test framework。

## 14. 不设通用硬性规模指标

通用策略**不含**固定阈值（函数 ≤ N 行、文件 ≤ N 行、重复 ≤ N 行、复杂度 ≤ N）。这类指标会诱导
Agent 为指标而拆分，反而增加复杂度。

通用层使用：**语义策略 + Reviewer 判断 + 可选的项目静态门禁**。项目已有复杂度或行数限制时，
由 Project Policy 补充声明；`engineering.thresholds` 为 `null` 表示本工程未设此类阈值。

## 15. Reviewer 的阻塞边界

可以阻塞（实质工程问题）：

```text
重复实现同一业务规则，存在未来行为漂移
绕开已有安全校验重新实现一套逻辑
新增明显不必要的复杂架构层
修改大量无关文件
引入没有必要的新依赖并显著增加风险
保留两套冲突实现
```

通常不应阻塞（主观审美）：

```text
还能再减少几行代码
存在另一种同样合理的写法
变量命名存在主观偏好
可以进一步抽取一个小函数
少量无风险重复
个人风格差异
```

> Reviewer 阻塞实质工程问题，不阻塞主观审美问题。

## 16. 本策略不增加用户确认路径

本策略**不产生**新的用户确认。以下都由 Agent 自己判断，不向用户提问：

```text
复用已有实现还是新写 / 是否创建 helper / 是否为了消除语义重复做局部重构
```

需要用户同意的仍包括 GAC 从 `direct_edit` 升级为 `standard_task` / `high_risk_task` 的明确授权，以及超出原需求或存在外部不可逆影响的决定。不要把普通复用选择变成额外确认。
"你希望我复用还是新写？"这类问题不属于本框架的询问理由。

## 17. 流程复杂度同样适用

最小必要复杂度不只约束实现，也约束**流程本身**：

```text
Use the minimum process necessary to safely complete the request.
A modification is not automatically a workflow.
Process ceremony is complexity and must be justified by risk.
```

只读问题直接处理；一般需求与多数局部 bugfix 默认 `direct_edit`，由主会话评估范围后直接修改，不建正式 DAG。
仅当单 Agent 难以可靠完成的复杂非核心任务出现时，才**申请** `standard_task`；影响项目级安全、ABI、持久化状态、启动或关键契约的行为变更才**申请** `high_risk_task`。两种升级都须说明理由并取得用户明确同意，不能仅凭命中高风险目录自动升级。权威规则见 `lib/project.js` 与 `lib/operation-store.js`。

判断依据是风险而不是规模：**文件数与代码行数不是判据**——单文件的认证策略可能是高风险，两个相关配置文件
可能只是 Direct。反向也成立：不得为了「流程完整」给一件小事套上 Requirement、多条 AC、Verification、
Review 与 reopen；那是流程放大，不是严谨。

## 18. 验证独立性

```text
Developer-authored tests support development but do not independently prove the developer's own implementation.
High-risk verification should attempt to falsify the implementation, not merely confirm the happy path.
```

Builder 写测试是**开发证据**：开发反馈、局部防回归、复现与边界。它不能作为高风险实现正确性的唯一独立证据——
理解一旦有偏，错误实现与同源测试会一起全绿，两边的绿灯来自同一个错误前提。

因此高风险工作把「应当为真」与「实际怎么做」分开：验证计划在读取实现之前从 Requirement 独立推导，
每条验收标准同时要有正例和一个 falsification 用例（写明什么样的错误实现必须被抓住）；计划冻结后由实现侧
之外的角色执行，执行阶段才读实现并补对抗性探针。**不同执行容器不等于独立性**——独立来自不同的信息来源与
不同的推导路径。判据与门禁见 `lib/verification.js`、`lib/tool-task.js`、`lib/role-tools.js`；验证者要用已冻结计划、逐项证据与独立复核，而不是只引用执行者自述。
