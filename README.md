# dsh-gac-runtime

DeepSeek Harness（DSH）中的通用 GAC（Governed Agent Collaboration）插件。**DSH 提供会话、子代理与工具执行内核；GAC 提供需求分级、设计与实施治理、写权限、独立验证、证据和任务收口。** 不在插件内重建第二套 Agent Runtime。

> **阅读顺序**：本文件用于当前使用；[AGENTS.md](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/AGENTS.md) 是本仓库开发纪律；[docs/CUTOVER.md](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/CUTOVER.md) 是真实验收与剩余缺口；[ADR-0001](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/ADR-0001-子会话执行载体.md) 保留历史决策与事故细节。以代码、当前 Profile 和真实测试结果为最终依据，不以历史计划作为现状。

## 从 npm 安装

包同时发布在 npm 官方源与中国镜像（npmmirror）。两条 npm 来源装的是**同一个已发布快照**，只是下载地址不同；因为本包不含安装期脚本，npm 路径比 GitHub 路径少一层 git 与 allowBuilds 放行。

```powershell
# npm 官方源（默认）
dsh plugin --profile web add dsh-gac-runtime
# 中国镜像（npmmirror 会自动从官方源同步，通常数分钟内可见；--registry 也可用于安装瞬时加速）
dsh plugin --profile web add dsh-gac-runtime --registry=https://registry.npmmirror.com
# 固定版本（把 0.1.1 换成要用的版本号）
dsh plugin --profile web add dsh-gac-runtime@0.1.1
```

- **版本来源区别**：GitHub 来源以具体提交写进 Profile 的 lockfile（因此必须显式带 `#<标签或提交>` 才会升级）；npm 来源以**版本号**固定，`add` 不带版本号时取该源上的最新版。
- **`minimumReleaseAge` 与刚发布的版本**：部分 Profile（本机的 `core-020` 在桌面安装路径上就出现过）带 24 小时供应链策略。实测 pnpm 11.7 对 `add` 显式请求的直接依赖会自己补一条豁免并打印 `Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml`，所以正常安装不会被悄悄降级；风险在别处：该 Profile 把 `minimumReleaseAgeStrict` 打开（改成弹提示）、或这个版本是被传递引入时，pnpm 可能**静默装回旧版并 exit 0**。这是 Profile 的策略而不是包的问题：一次性绕过用 `dsh plugin --profile <profile> add dsh-gac-runtime --config.minimum-release-age=0`（pnpm 10/11/12 通用，pnpm 12.3 原生 CLI 用 `--config.minimumReleaseAge=0`），长期放行则把 `dsh-gac-runtime@<版本>` 写进该 Profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。
- **镜像同步**：npmmirror 是只读镜像，不接收发布；发布上游只有 npm 官方源。镜像通常会在数分钟内自动收录新版本；要立刻触发用 `curl.exe -X PUT https://registry.npmmirror.com/dsh-gac-runtime/sync`（实测返回 `201 {"ok":true,...}`，本机约一分钟后即可见新版本）。注意旧写法 `PUT https://registry.npmmirror.com/-/package/<包名>/sync` 是错的：本地实测它即使对已被镜像收录的包也返回 404。核对版本时加 `--prefer-online`：`npm view dsh-gac-runtime version --registry=https://registry.npmmirror.com --prefer-online`，不带时可能读到 300 秒缓存里的旧版本号。
- 装完之后的行为（自动写入 `dsh.profile.bundles`、Desktop 界面、升级、卸载、每个工程仍需复制 `examples/gac-project.json` 选择加入、版本要求与排障）与下节完全相同，见下节。

## 从 GitHub 安装

本包是纯 ESM JavaScript，没有构建步骤、也没有 npm 运行时依赖，装上即可用。DSH 的 `plugin` 命令就是 Profile 目录里的 pnpm：`add` 在安装完成后还会自动把本包写进该 Profile 的 `dsh.profile.bundles`，所以不需要再手工编辑启用配置。**安装或升级后必须完全退出并重启 DSH，新版本才会被加载。**

```powershell
# 装进指定 Profile（web / headless / acp / sdk / desktop，或你自己的 Profile 名）
dsh plugin --profile web add github:MancoCL/DSH_Agent_Runtime
# 需要固定版本时在地址后加 #<标签或提交>
dsh plugin --profile web add github:MancoCL/DSH_Agent_Runtime#<标签或提交>
```

- Desktop 应用的插件管理界面填同一个地址 `github:MancoCL/DSH_Agent_Runtime`，走的是同一套 pnpm 安装路径。`--profile desktop` 要求先完整启动过一次 Desktop 再完全退出：宿主不会在自己运行时改动 desktop Profile。
- **升级**：重新执行一次 `add`，并显式带上新的 `#<标签或提交>`——GitHub 来源会以具体提交记进 Profile 的 lockfile，只更新远端分支不会自动生效。**卸载**：`dsh plugin --profile <profile> remove dsh-gac-runtime`，同时会把它移出 `dsh.profile.bundles`。
- **装完不等于被治理**：每个工程要显式选择加入——把 [examples/gac-project.json](examples/gac-project.json) 复制成该工程的 `.dsh/gac/project.json`，再把其中的路径、能力与执行者改成真实情况。没有适配器的工程照常运行，只是不受 GAC 治理（见 `lib/project-state.js`）。
- 版本要求写在 `engines.dsh` 与 `peerDependencies`：只有 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools` 两个宿主自带的包，且声明为 optional，不会去公网安装它们。宿主版本过旧时 DSH 会拒绝安装并回滚，按它打印的 `dsh plugin --profile <profile> allow-version …` 执行即可。
- **排障**：`dsh plugin --profile <profile> ls` 确认是否装进当前 Profile；插件命令的完整日志在 `<profile>/.plugin-manager/logs/operation-*/pnpm.log`。

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
| `direct_edit` | 默认模式：非代码、注释、普通功能与局部缺陷修复 | 主会话直接完成；0 Task、0 child；先登记影响和目标范围 |
| `standard_task` | 单 Agent 难以可靠完成的复杂非核心工作 | 说明复杂度依据并经用户同意后，独立 Builder → Verifier；涉及测试写入时另设 Test Builder |
| `high_risk_task` | 影响整个项目核心功能的行为变更：Boot Swap、Flash 边界、安全访问、持久化格式、公共 ABI 等 | 说明核心影响并经用户同意后，完整设计、批准、实施、验证与复核 |

工程风险规则和实际执行约束在 `lib/project.js`、`lib/operation-store.js`、`lib/coordinator.js`、`lib/tool-task.js`。目前普通工作**默认 `direct_edit`**：`gac_project begin` 开始目标、`assess` 提交行为影响及路径，只有复杂的非核心工作或项目级核心行为变更才提出升级；升至 `standard_task` / `high_risk_task` 必须由宿主问答取得用户同意并把授权绑定到该次评估。命中高风险路径本身不自动升级，但必须进行风险评估；升级待确认时不得借 `direct_edit` 继续写入。

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
- **主会话最小化**：`gac_task advance` 默认最多派遣一波，可用 `max_waves` 设置受限推进上界。新派遣跟踪器可先返回 `awaiting_results`：子节点在后台执行，Runtime 按任务串行结算、持久化通知待发送记录，并通过宿主消息接缝提醒主 Agent 继续推进。**这不等于整条 DAG 自动完成**；宿主通知失败或进程中断时仍需检查任务状态与阻塞原因，不能按通知发出就判定验收通过。
- **验证**：冻结 VerificationPlan（高风险要求 positive/falsification）→ Runtime 签发 Evidence → VerificationReport → ReviewReport → 逐项 AC 与证据门禁。`verification_execution` 可接收项目适配器中已声明的 `verification_context`（测试入口、可用能力与环境身份）、设计里的测试详设及冻结用例；验证证据按 case 关联，不能用一个笼统 PASS 或共用证据代替。可选的内容指纹复用有覆盖范围和环境身份条件，不应声称所有任务都能跳过重测。
- **Workspace Witness**：订阅 `workspace/changes` 做事后变化分类，不能代替前置 Guard；对 Git 忽略路径不可见，截断时 `coverage=partial`。生产日常 Profile 已活体验证，复验配方见 [Witness 探针](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/WITNESS-LIVE-PROBE.md)。
- **PTC**：存在时允许外层 `run_code` 传输；内层工具仍接受权限审查。它是可选执行能力，不是 GAC 必需能力。复验配方见 [PTC 探针](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/PTC-LIVE-PROBE.md)。

设计专家可用 `gac_expert start/status` 启动一层只读助手（root=0、专家=1、助手=2）。每次父派遣最多同时 2 个、累计 4 个；测试设计助手继承盲化，助手不得再委派。助手结果只通知父专家，父专家综合后交付最终产物。

需要独立验证的工程应通过 `verification_context` 声明真实测试入口、可用能力、限制及环境身份；未声明的测试事实不能凭实现反推。示例见 `examples/gac-project.json`；未完成的宿主验收场景、切换条件与证据要求统一见 [CUTOVER](docs/CUTOVER.md)。

### 生产能力契约

项目通过 `execution.required_capabilities` 声明需要的能力（闭集由 `lib/capabilities.js` 定义），运行时核对真实加载树；高风险完成阶段缺少必需能力会拒绝收口。主要必需项包括：

```text
native_child_dispatch, workspace_observation, role_isolation,
write_claims, evidence_log, semantic_artifacts
```

PTC、任意子 Agent 委派、Memory Provider 不属于默认必需能力。缺少必需能力不能静默降级成“照常完成”。

## 开发、验收与本地发布隔离

**公开与本地边界**：GitHub 只跟踪插件源码、测试、示例和维护文档；每台机器的 `.dsh/` 适配器、任务、设计、证据、审计与验收状态均只保留本地，不进入 Git 或 npm 包。新工程应复制 `examples/gac-project.json` 生成本地 `.dsh/gac/project.json`，不应把真实项目配置提交到插件仓库。推送与 PR 会触发 GitHub Gitleaks 凭据扫描；发布前仍应人工检查暂存差异与 `npm pack --dry-run --json` 清单。

**日常 DSH 必须使用与开发工作区隔离的已安装插件**，可以来自 npm 官方包、固定 GitHub 标签/提交，或者经本机验收的不可变 `.tgz`。只有代码完成、测试通过且明确安排真实 E2E 时，才临时把目标 Profile 指向 Git 工作树。下面的 `deploy:*` 是**本机源码验收→本地包安装**流程，不能代替 npm/GitHub 的正式发布流程；它通过 `pnpm` 同时更新依赖、锁文件和实际 `node_modules`，而不是只改配置字符串。

```powershell
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\<实际Profile名>" # 请按真实环境设置
npm run deploy:status         # 检查 package.json 与 node_modules 真实落点
npm test                      # 日常在独立工作区开发

# 代码完成、Git 工作区干净、决定启动真实验收之后：
# 先完全退出 DSH，以下命令会复核 Git HEAD 和单元测试
npm run deploy:validate -- --apply --confirm-verify
# 启动 DSH，运行真实 E2E；期间不修改工作区
# 再完全退出 DSH：
npm run deploy:publish -- --apply --confirmed-pass --evidence ev-真实编号

# 若验收未通过：退出 DSH 后恢复验收前依赖，而不是发布：
npm run deploy:restore -- --apply
npm run deploy:status
```

`deploy:validate` 保存恢复锚点并要求宿主退出。`deploy:publish` 打包成带 Git SHA 的**不可变本地 tarball**，同时记录 SHA-256、验收号、真实已安装内容；发布成功后解除工作树链接。`deploy:restore` 使用包管理器恢复原依赖而不是手工重建 Junction。所有变更命令缺少 `--apply` 时只做预检，检测到运行中的 DSH 会拒绝切换。**已安装的固定 npm/GitHub 快照也满足日常隔离要求**；旧 `deploy:status` 对非 `file:` 来源可能仍提示“不是本地包”，应结合实际 `node_modules`、Profile 依赖和锁文件判断，不应据此认为必须改用 `.tgz`。

**历史故障记录（已非当前状态）：** 以前出现过 Profile 依赖、锁文件和实际 Junction 分别指向不同来源的情况；当时真实模块指向工作区，未实现隔离。现在本机日常 `core-020` 的依赖及锁文件均指向 `github:MancoCL/DSH_Agent_Runtime#v0.1.1`，实际安装目录也不在此 Git 工作树；**这是已安装的旧发布快照，不代表当前 HEAD 已在日常环境实测**。若今后再次发生三处漂移，必须在宿主退出后按受控流程修复。`plugin:on/off` 只控制启停，不代替版本切换。

详见 [AGENTS.md](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/AGENTS.md) 的开发和 Git 纪律。

### 发布到 npm 与镜像

npm 官方源是唯一发布上游；npmmirror 是只读镜像，只由它自动同步，不能作为发布目标。发布前必须：工作区干净、`npm test` 通过、`package.json` 的版本号在 Git 上有对应 tag（tag 一旦公开就不再移动，内容有变就换版本号）。**tag 必须指向实际发布的那次提交**：本仓库出现过 `v0.1.0` 指向的提交里 `package.json` 仍是 `private: true`、而 npm 上的 0.1.0 来自另一个无标签提交的情况；workflow 里的标签门禁就是为了拦住这种不一致。

```powershell
npm login                                   # 首次需要；账号启用 2FA 时发布用 --otp
npm publish                                 # 按 publishConfig 发到 https://registry.npmjs.org/
# 镜像无需手动发布；要立刻同步可执行：
#   curl.exe -X PUT https://registry.npmmirror.com/dsh-gac-runtime/sync   # 返回 201 {"ok":true,...}
```

- 发布物就是 `npm pack` 的产物（实际文件数以 npm pack --dry-run --json 为准）。`test/install-surface.test.js` 会在上传前拦下四类错误：包名与 bundle 不同名、`private` 为真、`publishConfig` 指向镜像源、`files` 混入 `test/scripts/.dsh`。
- 发布后核对两个源：`npm view dsh-gac-runtime version --prefer-online` 与 `npm view dsh-gac-runtime version --registry=https://registry.npmmirror.com --prefer-online` 都应给出刚发布的版本（不加 `--prefer-online` 可能读到缓存里的旧结果）；随后在一个隔离 `DSH_HOME` 的沙箱 Profile 里真装一次（`dsh plugin --profile <p> add dsh-gac-runtime@<版本>`）。
- **刚发布几分钟内出现 404 不等于失败**：注册表 CDN 对 packument 与 tarball 都有约 5 分钟的负缓存（0.1.1 实测：发布后 3 分钟内直连 tarball 仍 404，约 3.5 分钟后恢复 200，字节与本地 `npm pack` 产物一致）。要立刻验证可在 URL 后加时间戳查询串，或先 `--prefer-online` 读 packument，不要据此重发同一个版本号。
- 同一版本号不能覆盖发布，只能发新版本号；**刚发布的版本可能被 Profile 的 `minimumReleaseAge` 策略影响**（pnpm 11.7 对显式 `add` 的依赖会自动补豁免并打印提示，不会降级），见上文。

#### 用 GitHub Actions + Trusted Publisher 发布（推荐，免 token 与 OTP）

npm 已经提示 bypass-2FA 的 granular token 正在被限制用于直接发布，官方推荐的长期方案是 Trusted Publisher（OIDC）：仓库内 [.github/workflows/publish-npm.yml](.github/workflows/publish-npm.yml) 只声明 `id-token: write`，**不保存任何 npm 凭据**（`test/install-surface.test.js` 会拦下把 token 写进去的改动）。

首次由包维护者在本机执行一次（会提示 OTP）：

```powershell
npm trust github dsh-gac-runtime --file publish-npm.yml --repo MancoCL/DSH_Agent_Runtime --allow-publish
npm trust list dsh-gac-runtime          # 核对已登记的发布者（GitHub Actions / 仓库 / workflow 文件名）
```

之后发版：改 `package.json` 版本号 → `npm test` → 提交 → `git tag -a v<版本>` 并推送 → 在 Actions 页面 Run workflow（可选 dry run）。workflow 会在发布前重跑 `npm test`，并强制版本号与 `v<版本>` 标签指向同一提交，不满足就直接失败。`--file` 只接受工作流文件名，改名会让已登记的 trust 失效。

## 当前限制与验收边界

1. **尚未用一个真实外部业务需求完成新的设计驱动 HIGH_RISK 全流程 E2E**；参见 [CUTOVER](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/CUTOVER.md)。旧的 `REQ-HR-5` 验证了四子会话的语义结果链，不等于新的设计驱动流程已经验收。
2. 多 Session / 工具与上下文隔离已实现，但**异模型/异作者独立性不是默认硬保证**；角色路由可以配置，结论要以实际子会话头和证据为准。
3. DSH 子会话 **own-layer 委派工具可能仍显示在模型面**；GAC 的执行前 Guard 已验证按工具族拒绝。宿主事件时序根因见 [ADR §23](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/ADR-0001-子会话执行载体.md)，不要在插件里重新造执行器。
4. 只读角色可根据策略保留测试 Shell；它不等于操作系统级只读沙箱。GAC 结构化写拦截不保证发现所有间接文件修改，Witness 也不观察 Git 忽略路径。
5. 子会话创建到权限绑定之间可能有平台时序窗口；不可凭成功样例宣布任意调度时序下完全安全。
6. `memory` 与 `checkpoint` 的部分字段目前只是项目策略声明，**没有对应完整 Runtime enforcement**；不会自动 Git commit。GAC 审计文件也不是任务状态的权威来源。
7. 具体剩余项、历史真 E2E 与切换条件见 [CUTOVER](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/CUTOVER.md)。历史执行接缝、宿主事故与版本判据见 [ADR](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/ADR-0001-子会话执行载体.md)。
8. 从 GitHub 安装取的是**源码快照**：宿主安装时不会运行本仓库的测试，任何提交都能被装上。请固定到已通过 `npm test` 的标签或提交，而不是长期跟随 `main`。

## 文档职责

| 文档 | 用途 |
| --- | --- |
| 本 README | 当前能力、使用方式及限制 |
| [AGENTS.md](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/AGENTS.md) | 在本仓库开发时的安全和提交规则 |
| [CUTOVER](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/CUTOVER.md) | 当前未闭合条件与已验证证据索引 |
| [ADR-0001](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/ADR-0001-子会话执行载体.md) | 原生执行载体、宿主兼容性与历史事故依据 |
| [ENGINEERING_POLICY](assets/ENGINEERING_POLICY.md) | Reviewer 真实读取的工程质量策略 |
| [Witness 探针](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/WITNESS-LIVE-PROBE.md) / [PTC 探针](https://github.com/MancoCL/DSH_Agent_Runtime/blob/main/docs/PTC-LIVE-PROBE.md) | 未来升级后的复验步骤 |

## 许可证

本项目采用 [MIT 许可证](LICENSE) 授权，版权归 MancoCL 所有。
