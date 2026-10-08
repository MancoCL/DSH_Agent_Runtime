# AGENTS.md — 本仓库开发纪律

本仓库是 DSH 插件 `dsh-gac-runtime`。当前功能、架构与已知限制见 [README.md](README.md)；运行时证据见 [CUTOVER](docs/CUTOVER.md)。

## 0. 开发、验收和日常使用必须物理隔离

**日常 DSH 只能从已打包的本地插件安装使用，不能长期 link 到当前工作区。** 开发源文件可以任意迭代，但这些改动不得通过热重载影响日常会话。

唯一允许把 DSH Profile **临时**指向本工作区的情形：已经完成代码实现和单元测试，并且明确决定执行真实宿主验收。完成验收后无论成功与否都必须退出源码模式：

- 验收通过：打包成带 Git SHA 的不可变本地 `.tgz`，通过 `pnpm` 安装到当前 Profile，再核实实际 `node_modules` 落点不指向工作区。
- 验收失败：通过恢复命令重新安装验收前依赖，保持问题代码留在工作区修改，不发布、不伪造通过结论。
- **严禁手工创建 Junction、只改 `package.json` 而不更新 lockfile 或 node_modules**。本机曾出现三者互相矛盾的真实问题。
- 任意依赖切换都**必须先彻底退出 DSH 宿主**。切换脚本发现运行中 PID 会拒绝，不提供强制绕过；切换后再启动 DSH 验证实际加载报告。

### 标准操作

在本机目标 Profile 下（路径按环境核实，不要猜）：

```powershell
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\core-020"

# 日常开发：只改仓库源码，绝不将 Profile 指向工作区。
npm run deploy:status

# 代码完成、测试通过并提交之后，才进入受控源码验收：
npm test
# 完全退出 DSH，然后：
npm run deploy:validate -- --apply --confirm-verify
# 重新启动 DSH，进行真实 E2E；验收期间禁止改动工作区的源代码。

# 验收通过：记录真实验收证据；再次完全退出 DSH。
npm run deploy:publish -- --apply --confirmed-pass --evidence ev-真实验收号

# 或者验收失败：完全退出 DSH，恢复验收前的安装：
npm run deploy:restore -- --apply

# 发布或恢复后复查声明、锁文件及真实插件落点，再启动 DSH：
npm run deploy:status
```

- `deploy:validate` 会检查源码 **Git 工作区干净**、HEAD 可追溯并重新运行 `npm test`。验收之后修改过源码，必须结束旧验收并重新走流程，不能直接发布。
- `deploy:publish` 需要明确的 `--confirmed-pass` 和真实 `--evidence`；打包包含 `lib/`、`assets/` 和 Bundle 配置，发布文件放在 `$DSH_HOME/packages/`，附带 Git SHA、SHA-256 与验收记录。
- `deploy:status` 必须核查**真实 `node_modules` 路径**；不能仅以 Profile `package.json` 或 pnpm 锁文件自述判断。若提示实际仍指向本仓库，不得当成日常稳定版本使用。
- `npm run plugin:on/off` 只是插件启用开关，**不是版本部署工具**；尤其 `plugin:on` 不得绕过未经确认的源码模式。不要靠关闭插件来长期替代正确的版本隔离。
- 如果 `pnpm install --offline` 或安全验证失败，停止操作并保留退出状态；不要因为安装未成功就强行重开宿主。
- 不改 DSH 内核、不热替换宿主 Session 数据、不在生产会话中执行发布脚本。

### 宿主 Session 持久化硬边界

**禁止把 `gac/*` 自定义事件写入 Host Session Log。** DSH 曾因未知事件无法反序列化会话历史。审计只写本工程 `.dsh/gac/events/events.jsonl`，保留 `test/session-log-integrity.test.js`。历史修复工具必须经核实、备份和明确授权才能使用，不是清理脚本。详情见 [ADR-0001](docs/ADR-0001-子会话执行载体.md)。

## 1. 代码与质量

- 先检查已有实现、复用代码，减少重复逻辑和无需求支持的扩展。
- 只修改当前任务所属文件；不操作历史任务证据、不伪造 E2E、不要擅自改变运行时现有安全语义。
- 代码、测试、脚本的新注释使用中文，保留标识符、JSDoc 类型和工具名原文。
- 核心边界改动应配真实反例与单元测试，执行 `npm test`。
- 第三方安装面与运行时同等重要：`package.json` 里的 `files`、`dsh.bundle.patch`、`peerDependencies` 和安装期脚本决定别人能否从 GitHub 装上本插件，改动必须让 `test/install-surface.test.js` 通过。**不得新增 `prepare`/`postinstall` 等安装期脚本**（会让安装方被迫放行 `allowBuilds`），**不得去掉 peer 的 `optional` 标记**，也不得把 peer 指向宿主之外的包。

## 2. Git 纪律

- 只显式暂存本任务文件，禁止 `git add .`、`git add -A`、`git add --all`。
- 不推送、不 amend、不改历史、不提交其他会话的修改；用户未要求提交时不自行提交。
- 用户要求提交时，主题为 `type(scope): 中文简述`，空行后单行正文说明行为、原因和影响；不添加自动署名。
- 临时提交信息文件用任务唯一、受忽略保护的路径，提交后清理；不把密钥、发布包、机器路径下的会话数据提交到仓库。
- 提交后核对 `git show --stat HEAD`、`git log -1 --format=%B`、`git status --porcelain`。只要求本轮负责的路径干净。
- 适配器 `checkpoint` 目前只有声明，没有 Runtime 自动提交的机制。
