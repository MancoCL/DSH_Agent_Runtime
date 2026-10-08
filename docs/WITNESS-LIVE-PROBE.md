# Workspace Witness 真实验收配方

目的：在**将要实际使用的 DSH Profile** 验证 `Workspace Changes Producer → workspace/changes → GAC Witness → EvidenceLog`，不能只凭 `witness-seam available=true` 宣称通过。

历史：2026-10-06 的临时 `gac-verify` Profile 已删除；它曾因误判生产者缺席而建立。实际生产者由 `dsh-web-app` 的 bundle patch 加载，日常 `core-020` 已有 live 证据 `ev-1820`。不再重建第二套长期 Profile。原事故与判断更正见 [ADR-0001](ADR-0001-子会话执行载体.md)，当前门槛见 [CUTOVER](CUTOVER.md)。

## 前置检查

1. 在目标 Profile 查看新的 `plugin-loaded`、`witness-seam`，确认当前**真实加载版本**及 `workspaceChanges` 可用。
2. 检查探针路径**未被 Git 忽略**（`git check-ignore <path>` 不应匹配），也不覆盖任何现有文件；建议在临时测试仓库执行，不在业务工程残留。
3. 在活动写作用域中使用真实 GAC 节点；记录 `session_id`、`task_id`、`node_id`、`dispatch_id`。
4. 每轮创建的探针文件**至少保留到该轮结束**。生产者比对轮结束时的净变化；同一轮创建又删除等于没有变化。

## 用例 A：正常范围内文件

创建单节点受管任务（如 `REQ-WIT-A/I1`），声明 `write_scope=["witness-probe-a.txt"]`，令 Builder 创建该文件。**不要在同一轮删除。**

验收：轮结束时真实追加 `workspace/changes`；GAC 报告出现 `witness-turn`；签发的 Workspace Evidence 包含 `in_scope=["witness-probe-a.txt"]`、`out_of_scope=[]`，并关联正确的治理身份。

## 用例 B：间接越界（受控、隔离环境）

不要直接调用越界 `write` 来代替 Witness 验收——它应被事前 Guard 拒绝。通过**事先授权、可安全回滚的外部文件生成动作**，在已声明作用域之外留下一个未被 Git 忽略的探针文件，待轮结束观察。

验收：`workspace/changes` 列出越界路径，GAC Evidence 的 `out_of_scope` 包含它；对应越界证据不能作为通过的 verification evidence。这个用例只在专用隔离仓库或明确授权的受控测试路径执行，不绕开真实生产权限去制造证据。

## 用例 C：截断与盲区

- 原活体验证曾记录：`total=505`，`listed=500`，`truncated=true`，`coverage=partial`。后续内核升级时应至少复验一次大于宿主 `maxFiles` 的受控变更集；**不能把列出的 500 条当成全部变化**。
- Git 忽略的目录（包括某些构建输出和 `.dsh/`）默认不会进入这个 Workspace Change Producer 的事件清单。Witness 不能证明此类路径没有改动；Structured Write Guard 的职责与这条限制独立。

## 验收记录与清理

保留：目标 Profile/宿主版本、插件实际加载来源与版本、真实 Session/Task/Node、事件序号、`listed/total/coverage`、`in_scope/out_of_scope` 和 Evidence ID。**下一轮**释放作用域并删除探针文件，核实仓库状态与原样一致。

若只观察到 `witness-seam available=true` 却没有新的 `workspace/changes` 或 `witness-turn`，结论只能是 **seam 存在、端到端尚未验证**。失败时记录缺失的阶段，不以旧证据替代本轮结果。
