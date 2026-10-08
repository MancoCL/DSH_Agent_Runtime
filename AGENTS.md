# AGENTS.md — 本仓库开发约定

本文件只规定**开发本 DSH 插件时**必须遵守的纪律。运行能力看 [README.md](README.md)，未完成事项看 [CUTOVER](docs/CUTOVER.md)，宿主级事故与设计决策看 [ADR-0001](docs/ADR-0001-子会话执行载体.md)。

## 0. 自开发期间必须隔离热重载

本仓库开发的是插件本身；若活宿主正在加载**此工作树**，修改 `lib/*.js` 可能立刻将未完成代码热应用到自身会话，导致工具全部被拒或系统提示装配失败。

```powershell
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\core-020" # 按实际 profile 调整
npm run plugin:status
npm run plugin:off      # 实际工作树被加载时，修改代码之前必须关闭
npm test
npm run plugin:on       # 仅用于明确安排的活体验收
npm run plugin:off      # 验收完复原
```

- **先确认当前 Profile 与实际加载路径**：稳定发布副本与源码工作树可能不相同，不能只凭开关值或路径名下结论。
- 开关可能不会立即热应用。以加载报告中的 `plugin-loaded` / `plugin-unloaded` 为准；必要时重启宿主。
- 本插件关闭时，活会话不受 GAC 管辖；这是自开发隔离措施，不代表生产项目应默认关闭。
- 不要在正在执行受管任务时热卸载/升级插件：这可能切断 `tools/result` 订阅，造成证据不完整。

### 宿主 Session 持久化硬边界

**禁止通过 `session.append('gac/*', ...)` 等方式，把 GAC 自定义事件写进宿主 Session Log。** DSH 持久化反序列化可能拒读未知事件，历史上曾导致整批会话无法打开。

- GAC 审计仅写项目自己的 `.dsh/gac/events/events.jsonl`；Host Session Log 属于 Harness。
- 永久保留 `test/session-log-integrity.test.js` 回归约束。
- 历史数据修复脚本 `scripts/repair-session-events.js` 只在明确核实、备份和授权后使用，不作为普通清理工具。
- 决策和事故详见 ADR §13；不要重复实施旧方案。

## 1. 改动边界与质量

- 只改本任务目标涉及的路径。修改前先查找现有实现和可复用组件，减少语义重复、投机抽象和无关重构。
- 固定代码负责权限、状态和门禁；模型负责技术认知。勿把已有 Runtime 约束复制成第二份提示词判据。
- 不更改已冻结的历史任务、证明文件、证据链或宿主资源格式来制造“测试通过”。
- 本项目源码 `lib/`、`test/`、`scripts/` 的新增注释使用中文；标识符、命令与 JSDoc 标签保持其真实写法。改动注释不得偷换设计含义。
- 修改核心路径、能力契约或门禁时，增加与根因直接对应的负例，并执行 `npm test`。

## 2. Git 提交纪律

- **只暂存本任务确实改动的文件**：`git add <明确路径>...`。禁止 `git add .`、`git add -A`、`git add --all`。
- 不推送、不 `git commit --amend`、不改写历史；不要把其他会话或用户的改动纳入本次提交。
- 用户明确要求提交时，使用已有风格：主题行 `type(scope): 中文简述`，空一行后以**单行完整段落**说明行为、原因与影响；段落之间一空行，不加 Co-Authored-By/Generated 等署名。
- 提交前确认内容和临时信息文件不会被误提交；临时提交信息文件使用本次唯一、被忽略的路径，提交成功即清理。
- 提交后复核 `git show --stat HEAD`、`git log -1 --format=%B` 与 `git status --porcelain`，只要求本次负责的路径干净。不要凭估计编造测试数或文件数。
- `.dsh/gac/project.json` 的 `checkpoint` 目前是**声明而非自动提交机制**；不能假设 Runtime 会代替上述操作。
