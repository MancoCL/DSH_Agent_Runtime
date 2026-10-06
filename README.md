# dsh-gac-runtime

面向 DeepSeek Harness 的 GAC（Governed Agent Collaboration）运行时。

这是一个 DSH 插件，在 harness 内核之上加上**按风险分级的执行模式、严格的写作用域、写占用声明与独立验证**。它不重新实现调度、会话、子代理或审批——那些由 harness 拥有（见 [GAC-DSH-ADAPTATION-PLAN.md](GAC-DSH-ADAPTATION-PLAN.md) §1）。

```text
Harness kernel  →  会话、事件、工具、子代理、工作流、审批、沙箱
GAC plugin      →  执行模式、写作用域、写占用声明、验证、证据
```

---

## 状态

| 阶段 | 组件 | 状态 |
| --- | --- | --- |
| 0 | `lib/write-scope.js` —— 严格的包含判定 | 已完成，35 个测试 |
| 0 | `lib/project.js` —— Project Adapter + 模式升级 | 已完成，30 个测试 |
| 0 | `lib/tool-targets.js` —— 什么算作一次写入 | 已完成 |
| 0 | `lib/plugin.js` —— `tools/pre-execute` 门禁 | 已完成，28 个测试 |
| 0.5 | `lib/tool-scope.js` —— `gac_scope` 工具 | 已完成 |
| 0.5 | `lib/index.js` —— DSH 外壳，已装进 `core-020` profile | **已在真实会话中验证** |
| 1 | `lib/project-state.js` —— 从 `.dsh/gac/project.json` 加载 Project Adapter | 已完成 |
| 1 | `lib/tool-project.js` —— `gac_project`：检查适配器 + 声明模式 | 已完成 |
| 1 | `lib/prompt-section.js` —— 把 GAC 状态放进模型自己的系统提示 | 已完成，24 个测试，实测通过 |
| 2 | `lib/claims.js` + `lib/claim-store.js` —— 写占用声明 | 已完成 |
| 3 | `lib/coordinator.js` —— 任务 DAG、就绪节点、状态迁移 | 已完成（逻辑） |
| 3 | `lib/child-executor.js` —— 节点由**原生子会话**承载（角色工具面、真并发、深度上限） | 已完成并**活体验收通过**：子会话 id 与父不同、子会话自己写的文件、结果回到 `applyResult`、父会话不自锁；三条残留见 [docs/ADR-0001-子会话执行载体.md](docs/ADR-0001-子会话执行载体.md) §10-§12 |
| 3 | `lib/task-store.js` + `lib/tool-task.js` —— 持久化任务记录、`gac_task` | 已完成 |
| 3 | `lib/capability-router.js` + `lib/executor.js` —— 派遣会真正调用 | 已完成 |
| 4 | `lib/verification.js` —— 计划、反例与可追溯性门禁 | 已完成 |
| 4 | 计划与证据门禁已接进 `gac_task` | 已完成 |
| 4 | `lib/review.js` + `assets/ENGINEERING_POLICY.md` —— 独立复核：六问与五个质量维度 | 已完成，24 个测试 |
| 4 | `lib/role-guard.js` —— 只读角色的写入面收权（E2E-6） | 已完成；**已活体验证 6 轮**：`write`/`edit` 被守卫逐字拒绝、探针文件从未落地、回报后立刻恢复。收权本身在它自己那个作用域上生效（`write`/`edit` 已不在 `view(agent).visible` 里），但模型面清单依赖的**装配作用域是哪一个仍未查明**——见 [docs/CUTOVER.md](docs/CUTOVER.md) §3 E2E-6 |
| 5 | `lib/grilling.js` —— 多轮需求精化 | 已完成 |
| 5 | `lib/contract.js` —— 接口契约冻结 | 已完成 |
| 6 | `lib/evidence.js` + `lib/evidence-store.js` —— 由运行时签发的证据 | 已完成 |
| 6 | `lib/metrics.js` + `lib/tool-metrics.js` —— 带只读出口的指标 | 已完成 |
| 6 | `lib/tool-evidence.js` —— 证据号可被发现，因而可以被引用 | 已完成 |
| 5 | `lib/gac-events.js` + `lib/gac-event-log.js` —— GAC 审计事件（写工程自己的文件，**不**写会话日志） | 已完成（审计，不是状态权威） |
| 6 | `lib/workspace-witness.js` —— 工作区差异观测（witness 的原生替代） | 已完成，55 个测试；本机 profile 未装配观测源，因此它是惰性的（服务与摘要形状已对着真包 `dsh-workspace-changes@0.2.0-rc.2` 的类型声明逐字段核实，见 ADR §17） |
| 7 | 遗留系统切换 —— 处置与 E2E 状态已记录 | 记录在 [docs/CUTOVER.md](docs/CUTOVER.md) 中；本仓库之外的东西一律未动 |

**在相信上面这张表之前，先读 [docs/CUTOVER.md](docs/CUTOVER.md)。** 它逐项记录了什么是真正验证过的、什么不是——包括大纲的**六条 E2E 判据里有四条跑过真实会话、两条与字面判据仍有差别**，以及阶段 1-3（节点由原生子会话承载）的实测结论与三条残留。这里的表说的是哪些东西有代码；那份文档说的是哪些东西有证据。

**阶段 0 是验证过的，不只是测过。** 在一次作用域为 `scope: ["docs/scratch.md"]` 的真实会话里：

| 尝试 | 结果 |
| --- | --- |
| 写 `docs/scratch.md`（在作用域内） | 允许，文件被创建 |
| 写 `docs/outside.md`（在作用域之外） | **被拒绝**，`GAC_WRITE_SCOPE_DENIED` |
| `pwsh` shell 写入 | **被拒绝**，`GAC_SHELL_DENIED_UNDER_SCOPE` |

决定性的检查是文件系统，不是那条消息：事后那两个被拒绝的路径都不存在。拒绝发生在派遣**之前**，而这正是这套架构其余部分所依赖的假设。

**阶段 1 也在一次真实会话里验证过。** `gac_project` 报告了这个工程、它声明的五条高风险路径和它的能力词汇表；随后一次针对 `lib/write-scope.js` 的 `direct_edit` 被自动升级为 `high_risk_task`。

有意思的是模型拿这件事做了什么。它用一条真实的理由声明了 `direct_edit`（一个文件、可回退、可立即验证、不改接口也不做迁移），并且没有想办法绕开这次升级：

> 这不是一次声明错了的模式。这条路径的高风险属性是工程事先声明的；声明这一步无法绕过它，也不该去尝试绕过。`lib/write-scope.js` 是权限作用域的核心——直接改它会影响哪些写入被拒绝，所以升级与设计意图相符。

这正是那份工具描述所要产出的行为。一个*试图*去猜门禁的模型，有时会选出比工作所需更重的流程，而那正是这套设计要避免的仪式。

**在一个会话声明作用域之前，守卫是惰性的。** 每个会话一开始都处于无管辖状态，门禁放行一切。这是刻意的：一道强制执行着没人声明过的作用域的门禁，在 GAC 工作之外根本没法用。

---

## 安装

本插件从 profile 解析 DSH 包，所以它必须被安装进一个 profile，而不是被直接 import（原因见 `lib/resolve-dsh.js`）。

```text
plugin_manager { action: install_bundle, target: "<this directory>" }
```

这会把 `dsh-gac-runtime` 作为当前活跃 profile 的一个 `link:` 依赖加进去，并把它追加到 `dsh.profile.bundles`。几个值得知道的后果：

- **需要重启一次——除非把 watch root 放宽。** harness 的 HMR 入口监视的是*配置*，不是模块文件（当启动器提供了 profile 上下文时，基础 bundle 会把 `root: []`）。所以开箱状态下，编辑 `lib/*.js` **不会**重载插件，只有重启才能让代码改动生效。

  为了不必重启就能迭代，在 *profile* 补丁（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里放宽 HMR 的 watch root。要用**绝对路径**：

  ```yaml
  - id: hmr
    name: "@deepseek-ai/dsh-hmr"
    config:
      root:
        - D:/WorkSpace/99_Others/02_UserProject/Agent_Runtime
  ```

  profile 补丁层的优先级最高，所以它会覆盖基础 bundle 的 `root: []`。它在下次重启时生效；此后 `lib/*.js` 的编辑会自行重载。

  **不要**用 `root: ["."]`。watch root 是相对 `baseDir` 解析的，而 `baseDir` 是 profile 目录（`dsh-hmr/lib/index.js:319`），所以 `"."` 监视的是 profile，永远不会是插件——插件是从它外面链接进来的。这条曾经是本文件给出的建议，而它是错的：它看起来像是配置好了，实际什么都没改。

- **本插件默认不启用；只在需要实测时打开。** 本仓库开发的就是它，而 watch root 放宽之后，每一笔对 `lib/*.js` 的写入都会热重载进宿主进程——也就是模型正在其中工作的那个进程。半成品代码于是直接生效：一道拒绝一切的写作用域门禁，或一个在装配期间抛错的提示 provider，会把本来用来修它的那些工具拿走。所以开关只有一处，用脚本：

  ```bash
  npm run plugin:status   # 现在开着没有（唯一可信的状态来源）
  npm run plugin:on       # 打开：只为了跑一次真实会话（E2E 验收）
  npm run plugin:off      # 测完关回去——本项目的默认状态
  ```

  开关就是 profile patch 里 `- id: gac-runtime` 的 `disabled:` 一行；脚本只动这一行，其余字节原样保留（`scripts/plugin-switch.js`，纯变换有单测，`test/plugin-switch.test.js`）。**打开是否立刻生效，取决于宿主在不在监视配置——不要假设，看加载报告**：`plugin:on` 之后报告里应当出现新的 `plugin-loaded`，出现了才算真的在跑；没出现就是这个宿主不会热应用配置，实测需要先重启宿主。2026-10-05 实测过一次「没生效」：改完 patch 90 秒后报告里仍没有新记录（报告的最后一次写入停在 1 小时前），而历史上确实有过 3–8 ms 就应用的记录——两种情形都真实存在过，所以判断只能靠报告。关闭同理：`plugin-unloaded` 出现才算真的卸掉。

  三条纪律：**开着的时候不要改 `lib/*.js`**；**打开之后记得关回去**；**别凭记忆判断状态**，用 `plugin:status`。本文件以前声称重新启用只会重跑 `apply`、继续执行启动时载入的代码，因此重启是让改动生效的唯一途径。**在 watch root 放宽之后**，那是错的：被监视的文件一变，HMR 就替换模块缓存，所以重新启用会导入新模块。实测而非推理：在一次禁用 → 编辑 → 重新启用的循环之后，加载报告带上了新代码自己的字段（`prompt-section-registered`），没有重启。

  默认关闭的代价是明确的：插件声明过的模式与作用域都在内存里，卸载即丢失（任务记录在盘上，不丢）。所以插件关着的时候，没有任何任务能被插件*管辖*——门禁、提示段落与 `gac_*` 工具都不在。**那是默认状态，不是故障**；见 [docs/CUTOVER.md](docs/CUTOVER.md) §6。

- 因为它是链接，本插件保留自己的 `node_modules`，无法裸 import `@deepseek-ai/*`。`lib/resolve-dsh.js` 转而从 profile 目录解析它们。

  **本机上那条路径的真相**：`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是指向桌面安装（`resources/dsh/node_modules`）的 **junction**，而链接集合是桌面安装的**子集**。所以解析会在 profile 目录这个锚点上成功，落点却在桌面安装里；而 `@deepseek-ai/dsh-workspace-changes`（witness 的观测源）、`@deepseek-ai/dsh-ptc-runtime`（PTC）这类包**桌面安装里有、链接集合里没有**，插件因此解析不到——「服务缺席」的准确原因就在这里，与它们是否存在于桌面安装无关。`node scripts/diagnose-resolution.js` 会把成功的那一个锚点单独打出来（`OK <anchor>`），这条信息此前是缺的：它把成功的锚点误报成「未走到」，正好指错地方。

### 这台机器上的当前状态

下面这些已经应用过了，所以以后对 `lib/*.js` 的编辑无需重启就会重载：

- `dsh-gac-runtime` 已作为指向本目录的链接装进 `core-020` profile。
- `~/.dsh/profiles/core-020/cordis.patch.yml` 带着上面的 `hmr` 覆盖项。该文件旁边躺着一份带时间戳的备份。
- 同一个文件里 `- id: gac-runtime` 是 `disabled: true`——这是本项目的**默认状态**，不是待修的故障。要实测时用 `npm run plugin:on`，测完 `npm run plugin:off`。

仍然需要重启的：对 `package.json`、`cordis.patch.yml` 的改动，或任何会改变已注册插件或工具集合的改动。

### 哪个 profile？

这台机器上有两个：`core-020`（Web GUI）和 `tauri`（桌面外壳）。`plugin_manager` 安装进的是**活跃** profile。下结论之前先用 `plugin_manager { action: list_bundles }` 查一下。

---

## 验证它正在运行

插件会在 DSH home 目录旁边写一份 JSONL 报告（`$DSH_HOME/gac-runtime-report.jsonl`，退回用户 profile）。之所以是文件而不是一行日志，是因为在 web 服务的 harness 里，console 输出不可靠可见。

```jsonc
{"event":"plugin-loaded","services":{"tools":true,"sessions":true},
 "scope_tool":"registered",
 "enforcement":"生效中 —— 已声明的写作用域会在派遣前强制执行"}
{"event":"guard-denied","tool":"write","code":"GAC_WRITE_SCOPE_DENIED", ...}
{"event":"plugin-unloaded","observed":{"calls":17,"denials":0}}
```

卸载时的 `observed.calls` 计数器就是「拦截确实在活着」的证据：它数的是门禁看到的每一次工具调用。

### 工具没有出现时

先读加载报告里的 `scope_tool` 与 `scope_tool_note`——那条 note 会列出试过的每一个解析锚点以及各自失败的原因。这条诊断之所以存在，是因为更早的一个版本只报「无法解析」，把一次调试会话两次引向了错误的方向。

```bash
node scripts/diagnose-resolution.js   # 锚点列表是如何推导出来的，以及每个锚点各自失败的原因
node scripts/diagnose-import.js       # 把解析失败与导入失败区分开
```

重启之前先跑 `npm test`：当 DSH 存在时，测试套件会驱动真实的 `defineTool`，从而抓住那些否则只会在重启后表现为「工具不见了」的编写错误。

---

## 使用

### 模型被告知了什么，以及什么时候什么都不告诉它

一个已纳管的工程会得到一段提示段落：`gac:protocol`，order 700（`lib/prompt-section.js`）。它是**状态，不是策略**：模式阶梯在 `gac_project` 的描述里，作用域语义在 `gac_scope` 的描述里，所以这一段不重述它们——一条规则有两份副本就会漂移，而漂移的那一份正是模型读到的那一份。它补的是工具描述无从知道的东西：

```text
GAC 运行时：工程 `dsh-gac-runtime` 受 .dsh/gac/project.json 治理。 本会话还没有
声明执行模式，因此没有任务记录，也没有任何写作用域在强制执行。在改动任何东西之前，
先用 gac_project 声明最低的充分模式；在编辑文件之前，用 gac_scope 声明这项任务
可以修改的确切路径；这两个工具的描述说明了每一级别给你带来的义务。 证据 id 由运行时
签发：在任务报告里引用某个 id 之前，先用 gac_evidence 列出它们——运行时从未签发过的
id 会在收口时被拒绝。
```

而一旦有了声明：

```text
本会话声明的模式：`standard_task`（风险 medium）——<reason>。 预期由一个独立校验者
检查结果。 任务 `REQ-X` 节点 `build` 的写作用域生效中：[lib/, test/]。落在它之外的
写入、shell 命令，以及本运行时无法检查的工具，都会在派发之前被拒绝
（GAC_WRITE_SCOPE_DENIED / GAC_SHELL_DENIED_UNDER_SCOPE /
GAC_UNGUARDABLE_WRITE_DENIED）；这样的拒绝正是这份声明在被强制执行，而不是要绕开
的障碍。
```

有三条性质是承重的：

- **它会消失**，当工程未纳管且什么都没有声明时。那种情况下门禁是惰性的，而一段照样出现的文字会是在主张一项并未发生的强制执行。
- **可见性由盘上的事实决定，而不是由会话内存决定。** 「已纳管」的意思是 `.dsh/gac/project.json` 存在，这一点能扛过插件重载；而声明过的模式与作用域不能。拿会话状态来判定可见性，会让这一段在每次重载时忽隐忽现。
- **它不能抛错。** 文本 provider 运行在提示装配内部，那里的抛错会让*每一个模型步进*都失败——包括模型拿来修它的那一步。所以 provider 整个包在 try 里，对任何输入都返回字符串，并且注册时带 `interpolate: false`：这段文本会逐字嵌入工程提供的值（路径、理由），而一次开放的插值处理会在渲染期因为其中某个值里出现 `{{` 而失败。

`test/prompt-wiring.test.js` 用一个假 context 驱动真实的 `apply()`，断言这一段带着上述性质注册——并且断言一个没有 `systemPrompt` 服务的组合仍然会装上写作用域门禁，因为丢一段提示绝不能以丢掉一道强制执行为代价。

这一段是实测验证的：在插件带着新代码重载之后，从会话自己的日志里把它读了回来（`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，zstd 帧）：

```text
type: system/message ... "You are an AI agent powered by DeepSeek Harness. ...
GAC 运行时：工程 `dsh-gac-runtime` 受 .dsh/gac/project.json 治理。本会话还没有
声明执行模式， ..."
```

那个文件并不构成「这一段存在」的证据；**模型自己历史里的 system 角色消息**才是。

### 声明这项工作需要多少流程

```text
gac_project {}                          # 我在哪个工程里，它认为什么有风险？
gac_project { mode: "direct_edit", reason: "one config value", target_paths: ["config/app.json"] }
```

模式，按最省的够用流程排在前面：

| 模式 | 适用于 | 它承诺了什么 |
| --- | --- | --- |
| `read_only` | 讲解、搜索、阅读、分析 | 不创建任务记录 |
| `direct_edit` | 一处明确、局部、可回退的改动 | 不创建任务记录，也没有验证者 |
| `standard_task` | 普通的缺陷修复 / 功能开发 / 局部重构 | 由一个独立验证者检查结果 |
| `high_risk_task` | 安全、认证、持久化状态、迁移、公开契约、启动、生产 | 在实现*之前*从需求推导出一份验证计划，随后跟随一次独立复核 |

**模式是被交叉核对的，不是被信任的。** 声明的模式如果其 `target_paths` 落在工程声明的高风险路径中，会被自动升级为 `high_risk_task`：

```text
gac_project { mode: "direct_edit", reason: "tweak one comparison",
              target_paths: ["lib/write-scope.js"] }
→ 已从 direct_edit 升级为 high_risk_task：声明了 direct_edit，但有 1 个目标路径落在
  工程声明的高风险路径中：lib/write-scope.js。
```

不要试图抢先规避这项检查；如实声明，并报告你被告知的内容。一个去猜门禁的模型有时会选出比工作所需更重的流程，而那正是这套设计要避免的仪式。

### 声明这项任务可以写哪些路径

```text
gac_scope { task_id: "REQ-20261004-xyz", scope: ["src/", "docs/api.md"] }
```

作用域生效期间，有四类东西会在派遣之前被拒绝：

| 尝试 | 结果 | 代码 |
| --- | --- | --- |
| 写作用域之外的写入 | 被拒绝 | `GAC_WRITE_SCOPE_DENIED` |
| shell 命令（`pwsh`、`bash`） | 被拒绝 | `GAC_SHELL_DENIED_UNDER_SCOPE` |
| 本运行时无法归类的工具 | 被拒绝 | `GAC_UNGUARDABLE_WRITE_DENIED` |
| 没有可读路径参数的写工具 | 被拒绝 | `GAC_UNGUARDABLE_WRITE_DENIED` |

```text
gac_scope {}                    # 查看当前作用域
gac_scope { clear: true }       # 释放它，回到无管辖状态
```

### 声明也会把这些路径对其他会话占住

声明就是会话说出「这些路径是我的」的那一刻，而那正是能够检测出跨会话冲突的时刻。它不是模型必须记住的一个独立步骤——一份必须被记住的保护，终有一天会被跳过。

```text
session A: gac_scope { task_id: "REQ-1", scope: ["src/"] }
           → 生效中，并认领了 src/

session B: gac_scope { task_id: "REQ-2", scope: ["src/a.c"] }
           → 被拒绝：gac_scope: 这次声明被拒绝。已声明的写作用域 "src/a.c" 与任务
             REQ-1 节点 REQ-1 （会话 ...，派遣 ...）持有的 "src/" 重叠。该路径已归
             另一个写入者所有，因此这次声明被拒绝，而不是放任两个写入者都去写它。
             请把作用域收窄到没有其他写者持有的路径，或者等那个任务释放这些路径。
             你当前的作用域没有改变。
```

拒绝信息会指明持有者与两条路径，这样模型可以收窄自己的作用域，而不是重试。B 保持**无管辖**，而不是被声明了一半——一个被自己并不拥有的作用域管辖的会话，等于一道守卫在执行它从未被授予的路径。

占用声明存放在 `<project>/.dsh/gac/claims/`，一个会话一个文件，因此每个会话都看得见，并且能扛过插件重载。再次声明会替换你自己的作用域；它绝不与之合并。`clear` 撤回这份占用声明。

作用域重叠是按**前缀重叠**比较的，不是按字面字符串，所以 `src/` 与 `src/deep/a.c` 会如期相撞。这条规则刻意会在一种情形下过度上报：`src/*.c` 与 `src/*.h` 共享前缀 `src`，尽管两个集合不相交，仍被当作冲突。误报只损失一点并行度；漏报则让两个写入者撞在同一个文件上，而那事后无法分离。见 `lib/claims.js` 的文件头。

### 声明工程认为什么有风险

工程根目录下的 `.dsh/gac/project.json`。未知的顶层键会被**拒绝**，所以 `risk.high_risk_paths` 里一个拼错的键会大声失败，而不是静默地让升级门禁失效：

```json
{
  "schema_version": 1,
  "project": { "id": "my-project", "title": "My Project" },
  "capabilities": ["implementation", "verification"],
  "executors": { "implementation": ["builder"], "verification": ["verifier"] },
  "risk": { "high_risk_paths": ["src/auth/", "src/boot/**"], "default_level": "low" }
}
```

没有适配器的工程是**无管辖**，不是坏了：`gac_project` 会如实这样报告，而声明过的模式会被记录，但标记为 `NOT cross-checked`。**无效**的适配器不会被缓存，所以修好文件在下次调用就生效，不需要重启。

### 作用域语义

`gac_scope` 是一份**严格的清单**，而这是值得仔细读的部分：

```text
scope ["mod.c"]     允许  ./mod.c
                    拒绝  src/mod.c, other/mod.c, SRC/MOD.C
scope ["src/"]      允许  src/a.c, src/deep/a.c
                    拒绝  src2/a.c, src/../other.c
scope ["src/*.c"]   允许  src/a.c（以及 src/deep/a.c —— 见下文）
```

路径比较会归一化分隔符、解析 `.`/`..`，并**折叠大小写**，所以 `SRC/MOD.C` 与 `src/mod.c` 是同一个文件。裸写的 basename 是一个确切的文件，绝不是别处同名文件的别名。

`*` 会跨过分隔符，与 `fnmatch` 一致，所以 `src/*.c` 也覆盖 `src/sub/a.c`。这是刻意的，并为行为兼容而保留。它指向安全的方向：更宽的作用域*允许*得更多，因此它永远不会静默地允许一次工程本想禁止的写入。不读 `lib/write-scope.js` 的模块头就不要收窄它。

---

## 协调器（`lib/coordinator.js`）

纯逻辑，也是这套运行时其余部分将来被其驱动的模块。它先于任何暴露它的工具被写出并测试，因为它所执行的规则正是值得在隔离状态下做到分毫不差的那些。

有三条性质是结构性的，而不是约定性的：

**执行者从不宣告完成。** `applyResult` 接受一份结构化结果，并依据一张显式迁移表决定迁移。`completed` 与 `superseded` 不出现在任何表的 *source* 位置，所以「终态不能被一份迟到的结果推动」是表结构本身的性质，而不是散落在各分支里的检查。

**尝试从不被复用。** 每次派遣都会铸造一个新的身份（`attempt`、`dispatch_id`）。一份 `dispatch_id` 与节点当前活跃执行对不上的结果会被判为 `stale`，不改变任何东西——否则上一次尝试的迟到结果会看起来像当前这一次，从而改写它无权主张的状态。

**并行由事实决定，不由意愿决定。** 一个节点的依赖都完成时它才是*就绪*的；只有当它的写作用域与每一个在飞节点和同批节点都不相交、且不共享独占资源时，它才加入执行*批次*。就绪但未进批的节点会带着原因被报出来，这样「它为什么没在跑」就有答案。

```text
compileTask(plan)   → 校验：节点存在、无环、能力非空、声明了写作用域。
                      在任何文件被触碰之前就拒绝。
resolveReady(task)  → { ready, batch, reason }
dispatch(task, ids) → 每个节点铸造一个新的 attempt 与 dispatch 身份
applyResult(t, r)   → { classification: accepted | stale | rejected }
reopen(t, id, why)  → 原因必填；终态只被显式地移动
nextAction(task)    → dispatch | await | blocked | repair | complete_task | done
```

注意 `await` 与 `blocked` 是刻意区分的：等待你自己派出的子代理属于内部行为，把它记成外部阻塞，会掩盖「外部世界在阻碍进展」与「我自己的工作还在跑」之间的区别。

### 驱动它：`gac_task`

```text
gac_task { action: "create", task_id: "REQ-1", mode: "standard_task",
           plan: { nodes: [
             { id: "T1", objective: "implement", required_capabilities: ["implementation"],
               write_scope: ["src/"] },
             { id: "T2", objective: "verify", depends_on: ["T1"],
               required_capabilities: ["verification"], write_scope: [] } ] } }

gac_task { action: "advance", task_id: "REQ-1" }
  → action: dispatch, nodes: ["T1"]      工具铸造了 dispatch_id REQ-1-T1-A1

gac_task { action: "advance", task_id: "REQ-1",
           report: { node_id: "T1", dispatch_id: "REQ-1-T1-A1", status: "completed" } }
  → classifications: ["accepted"], action: dispatch, nodes: ["T2"]
```

**你不能宣告完成。** 一份报告必须带上节点被派遣时铸造的那个 `dispatch_id`。没有它——或者带的是一个过期的——报告会被判为 `stale`，不改变任何东西，因为上一次尝试的迟到结果不该改写它无权主张的状态。这条规则正是那个身份存在的全部理由，所以它在工具边界上被强制执行，而不是仅仅写在文档里。

任务记录存放在 `<project>/.dsh/gac/tasks/`，一个任务一个文件，并在加载时由校验新计划的那同一份代码重新校验。这是刻意的：否则一份手工编辑过的记录就能绕过 `compileTask`，引入一个有环或没有能力的 DAG。加载时会检查两条一致性规则——处于 `in_progress` 的节点必须持有派遣身份，而不处于 `in_progress` 的节点必须没有——因为任何一种倒置都会留下一个再也无法推进的任务。

任务按**工程**存放，而不是按会话：同一个需求的多个节点由不同执行者推进，而一份按会话存放的记录对接手下一个节点的人来说是不可见的。

### 派遣会真正调用

`advance` 不只是登记某个节点该跑了——它会按节点的 `required_capabilities` 路由，并调用执行者：

```text
advance → 把 T1（implementation）路由到 builder，把 T2（verification）路由到 verifier
        → 调用、应用返回的状态，然后重新判定下一步行动
advance → complete_task
complete { evidence: { all_criteria_covered: true } } → completed
advance → done
```

一次 `executorsFor(root)` 装配出来的执行者，按优先级是这三个：

| 执行者 | 什么时候在 | 承载什么 |
| --- | --- | --- |
| **原生子会话**（`child:<provider>`） | 适配器声明 `execution.native_child_dispatch: true` 时（**代码默认 `false`**，见下） | **所有节点**：写文件的与只读的各跑一个独立会话 |
| 路由进来的进程内执行者 | 适配器声明了 `execution.provider_routes` | 只承载 `write_scope` 为空的节点——它没有写入工具 |
| 会话型执行者 | 总在（兜底） | 需要落盘的节点被如实登记为 `in_progress` 等待会话执行，而不是伪造一份没写任何文件的成功报告 |

**子会话执行者排在最前**，因为路由选中的名字（例如 `builder`）往往只是适配器声明的执行者名，在运行时的执行者数组里找不到——`invokeNode` 于是退到「第一个 `supports(node)` 的执行者」。要写文件的节点必须由它接住，否则就退回主会话。

有四条性质让这件事是诚实的，而不是装饰性的：

**路由偏好最贴合的执行者。** 在覆盖所需能力的执行者当中，*额外能力最少*的那个胜出，这样一个通才就不会把所有节点都吸走——否则能力声明就是装饰性的，而验证的独立性也不可能成立。没有任何单个执行者能覆盖的节点会在任何文件被触碰之前被拒绝，并指明缺口（`拆节点`——不要把一个执行者声明成无所不能）。

**进程内调用不能写入。** 它没有写工具，所以只服务 `write_scope` 为空的节点，其余的一概*拒绝*。

**`in_progress` 是一个真实的答案。** 一次还在跑的运行，或一次没能启动的运行，既不是通过也不是失败。两者都不被编造出来；原生子会话接缝缺席或能力不足时，它返回的是**显式降级**与原因，而不是静默落回主会话。

**收口以证据为门禁。** 除非每个节点都已完成且 `all_criteria_covered` 为 true，否则 `complete` 会被拒绝——拒绝不改变状态，因为收了一半比完全没收更难回退。在这条存在之前，`complete_task` 会永远重复，任务永远收不了口。

Provider 路由来自适配器的 `execution.provider_routes`（按执行者名作键——见[模型路由](#模型路由)），所以「验证者跑在另一个模型上」是配置而不是约定——这正是让独立性变成真的、而不是名义上的原因。

---

### 节点跑在独立子会话里

打开 `execution.native_child_dispatch` 之后，节点由 `ctx.subagents.start()` 拉起的**真子会话**承载（provider 默认 `spawn`）。这不是「换个 prompt 的同一段上下文」：子会话有自己的 session identity、自己的上下文、自己的一份工具面，父会话只等它的结构化产出。决策与取舍记在 [docs/ADR-0001-子会话执行载体.md](docs/ADR-0001-子会话执行载体.md)。

**工具面在创建时就定死。** 子会话创建窗口里会 join 父会话的 preset，再叠加 per-child 的 persona 与 `toolFilter`。GAC 因此按角色点名：写范围为空的节点连 `write`/`edit` 一起去掉，两类节点都去掉委派类与父会话协调类（`gac_task`/`gac_scope`/…）——后者是因为子会话里也装着 GAC 自己，它会自己声明作用域、并试着回报它那一侧的派遣。名单只从**父会话的可收集合**里点（子会话 join 父会话的 preset，那份集合正是继承面的安全子集），因为 `toolFilter` 被直接交给创建窗口里的 `restrict`，点错一个名字会让整次创建失败；被拒绝时退到无过滤重试，但**把「这一层没生效」写进结果**，不静默降级。实测（会话日志里的 `request/header.tools`）：父会话 43 个工具、子会话 35 个，`write` 与 `edit` 都不在后者清单里。

**同一批是真的同时开工。** `resolveReady` 会把写范围不相交的节点算进同一批，派遣循环先 `Promise.all` 同时起、再按批次顺序收结果（启动重叠、记录写入仍串行）。这条以前是 `for … await`，也就是**实现侧的伪并行**。实测：同一批的两个子会话建立相差 2 ms、活跃区间重叠约 19 秒。

**深度上限按调用方算。** 每次派遣只允许再开一层（上限 = 调用方深度 + 1，深度取会话头的 `delegationDepth` 与 `AgentOptions.subagentDepth` 里更深的一个）。写死成 1 会让「调用方自己就是子会话」的场景整个用不了——实测撞过 `subagent depth 2 exceeds maxDepth 1`。

**返回文本里带子会话 id 与产物**（`advance` 返回「子会话 `<id>`」），任务记录里落 `result_ref: child-session:<id>`，将来要复核「是谁写的」从这个 id 追回去。

**三条如实留下的残留**（都在 ADR 里）：① 设计节点的盲区只保证**启动时**没被推入实现信息，它完全可以自己去读——`read`/`grep`/`glob` 对它开着；② 子会话仍拿得到 `subagent`（它是 agent 自己那一层注册的，`restrict` 摘不掉）；③ 代码默认仍是 `false`，只有本工程适配器打开。

---

### 独立验证

这里回答的问题是唯一要紧的那个：**实现是对的——我们怎么知道？**「测试通过了」不是答案，因为实现与它的测试出自同一份理解，而一份错误的理解会让两者一起变绿。

计划必须在它所评判的工作**之前**登记：

```text
gac_task { action: "plan", task_id: "REQ-1", criteria: ["AC1", "AC2"],
           verification_plan: { cases: [
             { id: "V1", covers: ["AC1"], type: "positive",      expect: "..." },
             { id: "V2", covers: ["AC1"], type: "falsification", expect_failure: "..." } ] } }
```

有三条规则被强制执行，而每一条都会指明缺的是什么，而不是去数数：

**每条验收标准都需要最少一个正例*和*一个反例。** 正例证明正确的实现能过；反例证明一个相关的错误实现会被抓住。一组正例无法区分「实现正确」与「断言太弱」——所以反例必须写明 `expect_failure`，否则它就退化成了一条更弱的正例。

**证据必须能追溯到验收标准 → 用例 → 执行。** 每条用例都需要各自被执行过的证据引用；一句光秃秃的「通过了」，是在请人相信它。

**取证摊薄会被单独拒绝。** 把一条命令的产出当作若干条用例的证据，在形式上完全合法——用例齐全、标准覆盖、证据在场——可它只是一个观测。数数发现不了它；比对证据才能。

门禁在还能改变结果的地方触发：

| 门禁 | 何时触发 | 为什么在那里 |
| --- | --- | --- |
| 计划必需 | 在派遣 `high_risk_task` 的一个 `verification`/`review` 节点之前 | 在实现之后才写的计划，推导自实现，而不是需求 |
| 反例 / 覆盖 | 在计划登记时 | 此刻报出来的缺口会在任何文件被触碰之前被补上 |
| 证据 | 在 `complete` 时 | 使用内容寻址的 `plan_id`，所以一份针对已被取代的计划的报告会被抓住 |

计划与任务记录分开存放，并且拒绝被覆盖：两者的生命周期不同——冻结的计划从不改变，而任务状态每一轮都在变——混在一起会让「这份计划被改过吗？」变得难以回答。

计划缺失时只拦下*验证*节点，批次里其余节点照常派遣。把整批拦下会把「先出计划，再实现」压成三步串行，丢掉本该有的并行。

---

### 独立复核：这次验证本身可不可信

验证计划执行完了，还差一步：谁来回答「这次验证可不可信」。计划那三道门禁守的是**产物齐全**（覆盖、反例、证据），这一层守的是**产物可信**——一个齐全的验证过程仍然可能建立在「只跑了实现者自己写的测试」之上，而那种情况在数据上完全看不出来。

复核报告必须逐条回答**验证独立性六问**与**工程质量五个维度**（词表来自原运行时的 `templates/review.json`，六条 key 逐字保留）：

```text
六问：builder_tests_only / expectations_from_requirement / falsification_present /
      uncovered_criteria / verifier_reran_builder_tests_only / plan_modified_by_builder
维度：reuse / duplication / unnecessary_abstraction / change_scope / dependency
```

```text
gac_task { action: "review", task_id: "REQ-1", review_report: {
  summary: "复核通过：契约、计划、证据三者对得上",
  evidence: ["ev-12#V1"],                       # 可选；引用的号必须是运行时发过的
  blocking_issues: [],                          # 非空即不能收口
  engineering_quality: { reuse: "…", duplication: "无", unnecessary_abstraction: "无",
                         change_scope: "…", dependency: "无" },
  verification_independence: { builder_tests_only: false, expectations_from_requirement: true,
                               falsification_present: true, uncovered_criteria: [],
                               verifier_reran_builder_tests_only: false,
                               plan_modified_by_builder: false } } }
```

三条性质是承重的：

- **未回答不是一个答案。** `null` 与缺键在**登记**时就被拒——放它过去，会让一份没回答的复核看起来像一份答完的复核。这与 `all_criteria_covered` 同一个道理：门禁只能核对申报，所以申报必须存在。
- **方向反了会被如实记下，并在收口时被拒。** 拒绝的是收口，不是那份记录：一份承认「验证只依赖了实现者自己的测试」的报告是有价值的事实，把它藏起来才是问题。修好之后重新复核会覆盖上一份——复核是对已完成的活儿的一次观察，后来的观察取代先前的观察。计划与契约相反：它们是**开工的输入**，改写会让已经照它们做出来的东西对着一份不存在的约定。
- **触发条件按产物判，不按风险标签。** 计划里有承载审查能力的节点，或这个模式要求独立复核，收口才需要这份报告；标准任务里没有审查节点时，这一步不会凭空出现。

收口被拒时给出的码是机器可分支的：`GAC_REVIEW_REPORT_MISSING`、`GAC_REVIEW_INDEPENDENCE_UNANSWERED`、`GAC_REVIEW_INDEPENDENCE_FAILED`（含「申报了未被覆盖的 AC」）、`GAC_REVIEW_QUALITY_MISSING`、`GAC_REVIEW_BLOCKING_ISSUES`、`GAC_REVIEW_EVIDENCE_NOT_FROM_RUNTIME`。

**它核对的是申报，不是事实。** 运行时不读实现、也不读测试，判不了那些回答是不是真的；它做到的只有：回答必须存在、方向必须自洽、与同一份记录里的其他申报不能互相矛盾（例如「验收标准全覆盖」与「未覆盖 AC 列表非空」同时出现）。独立性真正的来源是信息路径——两份产物由同一个模型写出来时，六问照样能填绿（适配计划 §7 边界 5）。

---

### 任务审计：把链条从盘上派生出来

收口之后（或收口失败之后）常有人问同一件事：**这个任务到底经过了什么，凭什么（或凭什么不）收口。**
答案已经在盘上了——任务记录、需求冻结、契约、验证计划、验证报告、复核报告，加上
`.dsh/gac/events/events.jsonl` 那份只追加的审计日志。`gac_task action: "audit"` 把它们读出来，
拼成一条时间线与一份产物清单，然后**只说缺口**：

```text
gac_task { action: "audit", task_id: "REQ-HR-5" }
→ 任务 REQ-HR-5（模式 high_risk_task，状态 completed）：4 个节点，4 个已完成。
  需求：已冻结，2 条验收标准；契约：localArtifact；计划：plan-778ae0d5（4 条用例，其中 2 条反例）。
  验证：plan-778ae0d5；复核：plan-778ae0d5；运行时签发过的证据：1566 条。
  审计事件：12 条。
  未发现缺口。
```

它做的三件事在这一层才看得见：

| 它查什么 | 为什么只有这里能查 |
| --- | --- |
| **时间线**：谁在什么时候派遣了谁、谁回报了什么 | 日志本身只有一串事件，没有「任务视图」；而且它按 `task_id` 筛，别的任务的事件不会混进来 |
| **产物之间的身份**：验证/复核报告写的是不是**当前**那份计划 | 单看任何一份产物都发现不了——每一份自己都是合法的，配在一起才是错的（内容寻址的 `plan_id` 让这件事可判） |
| **缺口**：缺什么、什么没冻、哪条引用的证据号不存在 | 审计的价值在缺口上，不在复述已有的东西；一句「一切正常」如果是从「读不到就当没有」推出来的，比不说更坏 |

两条设计口径：

- **不新增存储。** 再引入一份「任务审计存储」只会得到第二份会漂移的真相源，而本仓库反复吃亏的正是「两处各自维护同一件事」。这个动作是**纯派生**：给它已经读出来的东西，它只负责拼与核对。
- **一个根因只报一次。** 没有计划时不再把「缺验证报告」重复数一遍——缺报告是缺计划的后果，不是第二个独立缺口；把同一个根因换几种说法凑数，会让「发现 5 个缺口」这种读数失去意义。反过来，计划没了而报告还在时，那两份报告会被标成「对不上当前计划」，因为那正是事实。

它**不改任何状态**，也不判「这次做得对不对」——那是复核与门禁的事。跨任务的历史沉淀（「上一次同类失败是怎么发生的」）刻意没做：没有消费者，只会变成第二份会漂移的真相源；真要做，应当先有一个具体的问题要它回答。

审查节点的执行者，系统提示里带的是 `assets/ENGINEERING_POLICY.md` 的**原文**（从原运行时逐字搬来，同一个 SHA-256），任务提示里则是六问与五个维度的清单——清单从 `lib/review.js` 的定义生成，只有一份，免得提示词与门禁核对的那份漂移。

### 只读角色：收权加守卫两层，写入面不在它手里

写作用域门禁守的是**已经声明过作用域**的会话，而只读节点（`write_scope` 为空）通常就没有 `gac_scope` 声明——于是「验证者不该写产品代码」在此之前只是一句期望。现在节点被派遣时，`lib/role-guard.js` 把该角色的写入面从**内核视野**里拿掉（`agent.ctx.tools.restrict`，只作用于这一个 agent）。

**两层，观测到的形态不一样，别把它们混起来**（四轮活体验证之后才写清）：

| 层 | 是什么 | 观测到的样子 |
| --- | --- | --- |
| 收权 | `tools.restrict` 把名字从该作用域的**视野**里去掉 | 收权之后按同一作用域复查 `view(agent).visible`，`write`/`edit` 已不在 |
| 守卫 | `tools/pre-execute` 上的拒绝 | 逐字拒绝：`GAC: 会话 … 当前只读角色不得使用 "write" …`，报告里记成 `guard-denied` / `GAC_READ_ONLY_ROLE_DENIED` |

实测到的拦截**总是守卫**，而**不是** `UNKNOWN_TOOL`。两个内核事实把这件事的解释收窄到一种：其一，`tools/pre-execute` 瀑布排在 dispatch 之前（`dsh-tools` 的 `prepareExecution` 是「`createExecution` → 瀑布 → 才 `resolveExecution`」），所以调用一定先撞上守卫；其二，**模型面的工具清单每次装配都会重算**（`dsh-system-prompt` 的 `assemble(context)` 就地调用每个 provider），而 `dsh-tools` 注册的那个 provider 是 `wireSchemas(context.scope)`、读的是限制感知的 `view(scope).visible`。既然收权**之后紧接着的那一步**模型仍然拿到了 `write`，唯一自洽的读法就是：**收权落到的那个作用域，与装配工具清单用的那个作用域不是同一个**。收权因此只对「它自己那个作用域」生效；模型面那一份清单照旧把工具提供出去，拦住调用的是守卫。判据字面要求的形态（`UNKNOWN_TOOL`）**还没被观察到**；装配作用域到底是哪一个（疑似会话）也还没查明——两条都记在 [docs/CUTOVER.md](docs/CUTOVER.md) §3 E2E-6 与 §6 第 2 条。

**守卫是 fail-closed 的：判据是类别，不是名单。** 一次隔离验证里，对**根本不存在的**工具名发起的调用同样被逐字拒绝——`roleRevokedToolNames` 属于「失败即拒」的分类器，凡不属于 read / shell / runtime 的名字一律收回，名单里有没有它并不重要。这比按名单严，但它有一个读法上的后果：**「守卫拒绝了某次调用」不能用来证明那个名字在收权名单上**，只能证明它不在被放行的那几类里；同样，一个只读角色「可用的工具清单里没有 `write`」也不能单独证明是收权把它摘掉的——要断言收权本身生效，只能看报告里的 `mode` 与 `revoked`，那是独立的一层数据。最近一次同类验证的读数：`write` 与 `edit` 两个调用都被 `GAC_READ_ONLY_ROLE_DENIED` 逐字拒绝、探针文件从未落地、会话本身没被锁死；而同一次的报告是 `mode: "guard-only"`、`revoked: []`、`role-revocation-unverified` ——**拦住写入的是守卫那一层，这一点不要读成「收权成功」**。

**别只看收权那一层。** 第 1 轮活体验证里，收权与兜底各自都「看着没问题」，实际两次本该被拦的写入全部成功：`createGacCore` 没拿到 `roleGuard`，兜底那一层根本不存在，而收权因为名单里混了 7 个作用域内注册的工具（宿主的 Team 工具）直接抛错→降级。**收权自己复查**这件事因此是必需项，不是保险：只有 `mode: restricted` 才表示「名字确实从视野里没了」；`mode: guard-only` + `revoked: []` + `role-revocation-unverified` 才是「没真收掉，只剩守卫」的诚实读数。

四条设计取舍，每条都有理由：

| 取舍 | 为什么 |
| --- | --- |
| 判据是**声明的写范围为空**，不是能力名 | 写范围是计划里唯一可核对的事实；用能力名当判据，会让一个同样只读但没叫 `verifier` 的节点躲过收权 |
| `gac_task` / `gac_scope` / `gac_project` **留着** | 收掉它们，角色就再也回报不了结果、也清不掉自己的作用域——把角色变成陷阱，与 `gac_scope` 当初被自己的门禁拒掉是同一个形状 |
| `shell` **默认不收** | 验证者要逐条执行计划用例才能留下证据，而执行用例靠 shell。收掉它会让「每条用例都要有独立证据」的收口门禁永远过不去——那是拿掉验证者的能力，不是收窄它的权限 |
| 名单取自 `view(agent).restrictableNames` | `restrict` 只接受「这个作用域**继承**来的」名字，**不接受它自己那一层注册的**（内核原文：a restriction filters what a scope inherits … and never what its OWN layer registers），而且**按名字拒绝 `run_code`**（原文：cannot name reserved PTC mode presentation transport）。用别的来源都会让整次收权抛错或静默退化——两次都真实发生过 |

**项目可以换回计划原文的行为。** E2E-6 的字面判据是连 `pwsh` 一起收回，而计划 §4.4 阶段 3 又要求验证者执行用例——两条不能同时成立。默认选了保住证据路径；要字面行为就在适配器里声明：

```json
{ "execution": { "revoke_shell_for_read_only_roles": true } }
```

那时越界的 shell 写入只剩 witness 事后观测（§「事后观测」），也就是适配计划 §7 边界 1 说的那个接缝极限。

**收不掉的那些要留名。** 守卫兜底按**同一张表**拒绝（`GAC_READ_ONLY_ROLE_DENIED`），加载报告里留下 `role-restricted` / `role-revocation-failed` / `role-revocation-unverified`。`shadowed` 是「按表该收、而实测仍在视野里」的名字（`run_code` 必在，因为内核不许收它；作用域内注册的委派类工具也在）。一条静默失效的收权比没有收权更糟——它会让人以为角色已经安全了。

**收回必须能撤销，而且撤销必须可靠。** 收权若撤不掉，那个会话再也写不了文件——「把自己关在门外」的同一个形状，只是这次关的是用户。因此每次状态变化都**重算**（而不是逐个事件加减：增量式会漏掉 `reopen`、失败回报、插件重载），插件卸载时 `liftAll()` 全部放开，任何一次 `restrict` 抛错都被吞掉并如实报告。

### 需求精化（访谈 / grilling）

这个回路由固定代码运行；问题由会话提出。「还有哪些决定没有做」是代码做不出的语义判断，所以**问题由会话提供**。但「跑了几轮、每轮覆盖了什么、收敛了没有、用户确认了吗」是事实，这些被记录在这里。模型思考；运行时作证。

```text
gac_task { action: "grill", grill_action: "status" }                        # 已经问过什么
gac_task { action: "grill", grill_action: "record",  round: { questions: [...] } }
gac_task { action: "grill", grill_action: "converge" }                      # 你认为已经问尽
gac_task { action: "grill", grill_action: "confirm", confirmation: "<用户的原话>" }
```

**这个回路不以模型的自我评估结束。** 一份理解有误的模型会自信地认为自己已经问全了，所以回路只在*用户*说够了的时候结束。记录 `converge` 不结束任何东西——它只是陈述一个看法。`confirm` 需要用户的原话。

**一轮里必须同时有问题和答案。** 答案为「不知道」是一条真实的发现，会被记录并报为未消解；答案*缺失*与「用户不知道」是两件事，把两者混为一谈，就丢掉了「决定仍然悬着」与「根本没人问过」之间的区别。

**轮数没有上限语义。** 一个真的需要五轮的需求就该得到五轮。上限是一个防止失控的守卫，而不是在说「这么多应该就够了」。

### 接口契约（并行开工之前冻结）

这就是让「并行写实现和测试」不只是一句口号的东西。写测试的人在写测试时并不知道实现长什么样。如果两边各自发明接口，测试就会因为*接口*对不上而失败——那是结构性失败，不是缺陷，而且它不会产出任何关于正确性的信息。先冻结一份最小契约，意味着两条分支都只依赖它：测试推导自**契约 + 验收标准**（不读实现），代码推导自**契约 + 设计**（不读测试）。两条彼此分开的信息路径——这也正是让验证的独立性变成真的、而不是名义上的原因。

**`behavior` 是必需的，而不只是 `signature`。** 只有签名时，「它返回什么」仍要靠猜，而猜出来的期望正是两边对不上的地方。行为说明不必穷尽，只需要够别人据此写出一条断言。

**冻结是派遣前的一道门禁，而且由工程来声明。** 适配器声明它，所以小的改动不需要仪式：

```json
"execution": { "require_contract": ["high_risk_task"] }
```

只有*写文件的*节点会被拦下；只回传报告的节点不会。而且和验证计划一样，契约是内容寻址的，拒绝被覆盖——在两条分支都已经按它开工之后再改，恰恰就是这道冻结所要防止的那种不一致。

### 模型路由

两条路径各有一套键空间，**不要混用**——它们的区分依据不同。

**进程内执行者**按**执行者名字**作键（即 `executors` 里列出的那些名字），而不是按能力：

```json
"execution": { "provider_routes": { "verifier": { "provider": "p", "model": "m" } } }
```

之所以按名字作键，是因为能力路由返回的是一个*名字*，而这个名字要能找到它所表示的那个执行者。按能力作键、并把执行者命名为 `capability:provider/model`，意味着查找永远匹配不上，静默地落到「谁支持就谁上」的兜底分支——声明的路由被忽略，而看起来一切正常。按名字作键也让*同一个*能力下的两个执行者使用不同模型成为可表达的，而那正是独立性需要的东西。

**原生子会话**按**语义角色**作键。这条路走的是另一套键空间，理由是：原生路径上只有**一个**执行者（`child:spawn`）覆盖全部节点，按执行者名根本区分不出「验证者跑在另一个模型上」，而能区分它们的只有角色。

```json
"execution": {
  "role_routes": {
    "*": { "provider": "opencode-go", "model": "cheap" },
    "verification_execution": { "model": "strong" },
    "review": { "model": "strong", "reasoning_effort": "high", "max_tokens": 8192 }
  }
}
```

- **`provider` 是模型 provider，不是派遣接缝名。** 这两个词在这里各指一样东西，而它们看起来都像「provider」：`ctx.subagents.start()` 的第一个参数（`spawn`）是**派遣接缝**，而 `role_routes.<角色>.provider` 进的是宿主请求的 `agentOptions.provider`，那是**已注册的模型适配器**（本机是 `opencode-go`）。写错的表现是宿主当场拒绝：`no adapter registered for provider "spawn"`（`NO_ADAPTER`）——活体验收实测过这一幕，也正是它证明了路由值确实送到了宿主。
- 先按角色精确匹配，再退到 `*`（所有角色的缺省）；两条都没有就**继承父会话**（不传 `agentOptions`——传空对象会把父会话的模型一起清掉）。
- 字段用适配器的 snake_case 写（`reasoning_effort`、`max_tokens`），运行时翻成宿主收的 `reasoningEffort`、`maxTokens`。角色名取自节点 `role` 的词表，拼错会在**读适配器时**被拒，而不是派遣时静默不生效。
- 每次派遣的实际路由写进 `advance` 的返回文本（`；路由 provider/model`）：配错了模型、或某个角色悄悄继承回父会话，只能从这里发现。子会话起不来时，失败**原因**（宿主的 `diagnostic`）同样进返回文本——否则父会话只读到「结论 failed」，而原因只活在子会话日志里。
- **适配器按根目录缓存，改动要重载插件（或 `forget()`）才生效**——这是有意的：策略在同一会话里必须稳定，中途换适配器会让跑着的任务脚下换规则。代价是「改了没生效」，而它是可发现的（返回文本里那行路由会显示实际生效的那一条）。

### 证据：由运行时签发，而不是由 Agent 写下

在此之前，验证报告里的 `evidence_ref` 只是模型写下的一个字符串。写下 `ev-1` 与真正跑过一条命令，在数据上**完全一样**，于是「每条用例都有证据」可以靠编造满足。插件现在订阅 `tools/result`，记录每一次观测；**证据号由运行时签发**。

```text
ev-3  |  pwsh  |  exit=0  |  is_error=false  |  output digest 67d02982
```

一条 `evidence_ref` 形如 `evidence_id#detail`。同一个 id 配**不同**明细是合法的——一次测试套件运行支撑多条用例，每条各自落在产出的不同部分。同一个 id 配**相同**明细则是取证摊薄：一个观测顶替两条主张。

有三件事是硬性事实，不是判断：

| 检查 | 为什么 |
| --- | --- |
| 这个 id 从未被签发过 | 该引用是编造的 |
| `is_error` 为 true | 那次调用没有成功 |
| `exit_code` 非零 | **一条失败的命令证明不了任何东西通过了** |

采集范围限定在**已介入**的会话（声明了写作用域，或声明了执行模式）。把每个会话里的每一次读取和每一次目录列举都记下来，会把真正需要复核的验证证据埋掉。

**冻结下来的结果带有什么、不带有什么。** `tools/result` 产出 `{ isError, value, content, meta }`，失败时外加 `error.info.code`。它**没有顶层的 CWD / stdout / stderr**，`exitCode` 也不是顶层的——它在 `result.value` 里面，而那个值的形状**每个工具都不一样**。所以采集只在那个值确实是携带这些字段的对象时才读 `exitCode` / `signal` / `timedOut`，**读不到就不写这一项**：缺失的事实是诚实的，猜出来的是假的。产出以摘要加一小段预览存放，从不全文存。

### 事后观测：这一轮到底改了什么

证据层记录的是工具调用——哪个工具、什么参数、退出码几。那是**意图**层面的记录，而「实际改了哪些文件」是另一件事，两者在最要紧的地方会分叉：一次 `pwsh` 里的重定向目标、一次代码生成器写出的文件，在工具参数里都读不出来。原 Python 运行时有一个 `witness.py` 专门做这件事；适配计划判它整体退役，改由宿主的现成观测源替代（§3.3）。

本插件订阅 `session/event` 上的 `workspace/changes`，把每一轮的变更集记成一条证据（`source: workspace-changes`），并按**已声明的写作用域**把文件分进三类：

```text
in_scope          落在本任务声明的写作用域之内
out_of_scope      不在该范围之内
outside_project   在工程根之外（它是 out_of_scope 的子集标记，不是第三类）
```

四条承重的性质：

- **未受治理时不产出越界结论。** 没有声明写作用域的会话里，每一个改动都「不在任何作用域内」；照此报告，每一轮都会产出一堆越界。那不是发现，是噪声——而噪声会把真正的越界淹掉。
- **覆盖不完整必须说出来。** 宿主按 `maxFiles` 截断过，唯一的痕迹就是「总数大于列出的条数」。被截断的摘要若当成完整观测来读，「这一轮没有越界」这句话就不成立——它只是「列出来的那些没有越界」。
- **越界影响的是证据可用性，不是调用的成败。** 一条越界的观测会被判为不可用（`gac_evidence` 里直接标出来），因此它不能被引用来支持一个「通过」的结论。它绝不去阻断任何工具调用：改动在发现时已经发生，此时拒绝那次调用既拦不住它，还会把「事后可查」变成「事后不可查」。
- **子会话借用先代会话的作用域。** 子 Agent 的写作用域声明留在先代会话的内存里，而它落在盘上的改动属于同一次任务；不借用的话，子会话的每一次变更都会被算成未受治理。借用只发生在判定时——**绝不给子会话施加父作用域**，观测不是授权。

发现走三个出口，而且刻意**不**追加进会话事件日志（这个订阅本身跑在会话事件的发布路径上，在那里再 `append` 会撞上重入保护）：

| 出口 | 内容 |
| --- | --- |
| 证据 | `gac_evidence` 列表里是单独一种条目：轮次、列出的文件数与总数、覆盖是否完整、越界个数（含工程之外） |
| 加载报告 | `witness-turn`；越界非空时另写 `witness-out-of-scope`；取不到摘要写 `witness-summary-missing`；异常写 `witness-failed` |
| 指标 | `gac_metrics` 的 `evidence.witness`：观测轮数、越界总数、覆盖不完整的轮数 |

**本机 profile 里这一层是惰性的。** `workspaceChanges` 服务由 `@deepseek-ai/dsh-workspace-changes` 提供，而该包**不在** `core-020` 的 bundles 里：事件类型 `workspace/changes` 是已知类型（`dsh-session` 声明了它），但没有任何东西会追加它。于是插件照常加载、照常订阅，只是没有事件到达；加载报告里那条 `witness-seam` 就是这条事实的痕迹。把该服务写进 `inject` 列表会让整个插件连同写作用域闸门一起不加载——那是拿一道强制执行去换一个可选的观测源。

### 指标，以及算不出来的指标

`gac_metrics` 是只读的，它存在的意义是让这些数真的能够被拿到——写出来却从未被调用的代码，等于从未写过的代码，而本仓库不得不修正这个错误不止一次。

最该盯的一个数是**越权写入尝试**，它**应当恒为 0**。非零不代表门禁失效（门禁拦住了它）——它代表提示词与文档有问题：模型在试图做一件本就不该尝试的事。把「我们拦住了」当成成功，就是这个信号被永远忽略的方式。

大纲里的四个指标在这里算不出来，而 `gac_metrics` 会把它们连同原因一起列出，而不是省略——省掉一个会让人以为它没问题：

| 指标 | 为什么算不出来 |
| --- | --- |
| Agent Call Amplification | 需要一个*需求*条数作为分母；运行时跟踪的是会话与工具调用，不是需求边界 |
| Token Usage / Context Reuse | 需要 `tokenMeter` 的读数；证据日志里装的是工具调用，不是 token 账 |
| False-positive Escalation | 需要事后判断那次升级是否真的必要——那不是运行时事实 |
| Critical Path Duration | 需要任务级的开始/结束事件 |

Duplicate Read Ratio 是**算得出来的**：同一会话、同一个读工具、参数摘要相同。

### 门禁守的是产物，不是一个风险标签

有两道门禁以同一种方式错了，而一个真实需求端到端走一遍就把两者都逮住了。它们各自按**执行模式**作键，守的却是与风险无关的东西：

| 门禁 | 原先的键 | 真正要紧的条件 |
| --- | --- | --- |
| 接口契约 | `high_risk_task` | **同一批里有 ≥2 个节点在写文件**——那才是两个作者可能发明出不同接口的时候 |
| 验证证据 | `high_risk_task` | **存在一份冻结的验证计划**——那才是有一个承诺可以拿来核对的时候 |

后果不是表面上的。一个带着并行代码节点与测试节点的 `standard_task` **没有契约**就派遣了——正是契约门禁存在所要防止的那种结构性失败。而一个带着 20 条用例的冻结计划的 `standard_task`，在 `all_criteria_covered: true` 且**一条证据都没引用**的情况下收了口，在终点线上把这份计划的全部价值丢掉，而一切看起来都正常。

按风险标签作键的门禁，是一个你可以靠不声明那个标签就绕过去的门禁。现在两者都按自己守的产物作键，并且都会说出触发的是哪一个——「你的批次里有并行的写入者」与「你的适配器声明了这个模式」，对不得不采取行动的人来说是两件不同的事。

### 发现也是回路的一部分

`gac_evidence` 之所以存在，是因为证据门禁**在实际使用中不可用**：它要求引用运行时签发过的号，而在此之前没有任何东西能让模型知道有哪些号。一条要求引用真证据、却没有办法找到真证据的规则，是一条会被编造出来的号满足的规则。

关于它有两点是吃了苦头才学到的：

**`render` 是接口的一部分，不是展示细节。** 第一个版本返回的数据是对的，却只渲染了一行汇总——于是模型看到「共有 8 条证据记录」，一个号也没看到。数据是对的，工具却毫无用处。模型*读到*的东西，与函数返回的东西一样，都是契约的一部分，而这项任务冻结的契约把它漏掉了——这正是那个缺陷一路活到验证阶段的原因。

**采集不能依赖内存状态。** 证据采集原先限定在声明过作用域或模式的会话里——两者都在内存中。一次插件重载把它们悄悄丢掉，采集就此停止：两轮测试一条也没记下，而一切看起来都正常。它现在按*工程*是否纳管（盘上有适配器）作键，而那能扛过重载。

### GAC 事件写在工程自己的文件里，**不**写进会话日志

GAC 的工具调用会被翻译成审计事件（模式声明、作用域声明、节点派遣与回报、契约冻结、计划登记、复核登记、任务收口），落在 **`.dsh/gac/events/events.jsonl`**：只追加、由运行时发号，读者是 `gac_evidence`、该文件与加载报告。

**曾经它们写在会话日志里，那是一个把用户历史写坏的缺陷（2026-10-05）。** 会话日志的事件词表由宿主**构建期生成**（`dsh-session` 的 `KNOWN_SESSION_EVENT_TYPES`），外部插件的类型按构造就不在其中；`Session.append(type, data, ...opts)` 只把 `sourceEventSeqs` 与 `surfaceOp` 放进日志，**没有任何途径**给一条事件打上 `ignorable` 标记。持久化层读回日志时于是整份拒读：

```text
session "…" contains event type "gac/…" (seq N) unknown to this harness and not marked
ignorable; refusing to interpret the log — it was likely written by a newer harness
（dsh-session-persistence/lib/index.js 的 validateStoredEvents）
```

后果不是「少一条事件」，而是**那份会话再也打不开**——界面上的表现是「子智能体的历史记录全部显示不出来，点进去全报错」。当时 970 条测试全绿，因为没有任何一条断言过「我们往会话日志写了什么」；现在 `test/session-log-integrity.test.js` 用一个会记录每次 `append` 的假 ctx 钉住这件事：**它必须始终为空**，而且插件不再注册任何消息投影（注册投影会让「读这份日志」依赖插件在场，而本插件默认是关的）。

已经写坏的历史用修复工具补标记（宿主为这种情况留了出口：标成 `ignorable` 的记录作为**不参与重放**的日志项被保留，审计线索不丢，日志可正常读回）：

```bash
node scripts/repair-session-events.js            # 预演：只报告哪些会话要修
node scripts/repair-session-events.js --apply    # 真的修：先备份再原子替换
```

它只碰 `gac/` 前缀的记录，未改动的帧按字节原样复制，写盘前把并发追加的新帧接回去（修活着的会话时不会丢掉最新对话）——本工程第一次跑的真实结果是 23 个会话、97 条记录，修完复查为 0。

**「把工具结果翻译成事件」住在 `lib/gac-events.js` 里，不在入口里。** 那是判断而不是接线：哪些调用该记、每条事件从哪儿取事实，都是会出错也必须被断言的东西。它原先写在 `lib/index.js` 里，于是只能靠跑一次活的 harness 才验得到——而本仓库吃过同类的亏（`gac_metrics` 漏了 `output`，五个工具一个都没注册上，而当时单测全绿）。搬过去之后它和事件词表在同一个文件里，`test/gac-events.test.js` 会把翻译出来的每一条载荷拿去 `compileGacEvent` 核对：形状对不上不会当场报错，只会让事件在落盘之前被拦下，而那条链路只写一条 report——模型与用户什么都看不到。

事实分两处取，这是刻意的：**「刚才发生了什么」取自工具返回**（`action` 与 `transitions`，工具自己说的），**「它登记了什么」取自盘上的记录**（任务、计划、契约、访谈、复核报告）。复核那一格的两个数因此来自两处：报告里写下了几个阻塞问题（产物），这次登记命中了几条门禁（刚发生的事）。

**大纲 §4.6 的说法不成立，而这值得直说。** 计划里写着 `Current State = reduce(Session Events)`，用它取代可变状态加一份历史 JSON。对*任务*状态而言这是做不到的：

| 事实 | 后果 |
| --- | --- |
| 会话按会话划分；`ctx.sessions` 明确是一个**内存**存储，其持久化是另一个插件 | 一份事件日志只描述一个会话 |
| 任务按**工程**划分——同一个需求的节点由不同会话里的不同执行者推进 | 一个任务的历史散落在多份会话日志里 |
| 不存在工程级的事件流，也不存在 工程→会话 的索引 | 没有任何东西能把它们聚起来 |

所以基于文件的任务存储仍然是**权威**，而事件补的是*审计*：这次调用改了什么、登记了什么，只追加、不可改。两者回答的是不同的问题——「这个任务在哪儿」跨会话；「这次调用做了什么」只有事件文件能回答。

**从脚本里读会话日志并不简单。** 日志是**拼接起来的 zstd 帧**，每次写入一帧（这里的一个 4 MB 文件里有 3000 多帧），而 Node 的 `zstdDecompressSync` / `createZstdDecompress` 都在**第一帧**之后就停下——只返回头部。审计或修复一份日志需要从每个魔数偏移处逐帧解码（`scripts/repair-session-events.js` 就是这么做的）。

---

## 生产能力契约（Production Capability Contract）

**日常 profile 是唯一的生产验收目标。** 一份「只在验收 profile 里成立」的能力不算支持——那意味着
验收时验的是运行时 A、日常跑的是运行时 B。下面这份清单是测试与文档的共同依据。

| 能力 | 状态 | 缺了它意味着什么 |
| --- | --- | --- |
| 原生子会话（`execution.native_child_dispatch`） | **必需** | 节点退回主会话执行，「独立验证」在事实层面不成立 |
| 严格写作用域 + 派遣前拦截 | **必需** | 越界写入只在事后可见 |
| 角色工具面隔离 | **必需** | 只读角色可能拿到写入面 |
| 写占用声明（claims） | **必需** | 两个写入者可能同时改同一个文件 |
| 语义产物（计划 / 验证报告 / 复核报告）由运行时登记 | **必需** | 收口要父会话手工补写，产物与结论可能对不上 |
| **工作区观测（Witness）** | **必需（纵深防御层）**：**日常 profile 已活体验证**（2026-10-06，证据 `ev-1820`） | shell / 生成器 / 外部进程的落盘**没有任何事后记录**——这是它与「事前拦截」并列的那一层，不是可选增强 |
| 证据（运行时签发） | **必需** | 「每条用例都有证据」可以靠编造满足 |
| GAC 审计日志（工程自己的追加文件） | **必需** | 复盘只能靠会话日志，而那是宿主拥有的格式 |
| PTC / `run_code` | **已装载，非必需** | 正常：它是执行便利，不是权限原语。缺席**不产生**降级告警；在场时守卫**放行外层传输、按名字守卫内层子调用** |
| Agent Teams / 任意委派 | **默认不支持** | 正常 |
| memory provider | **默认不支持** | 正常 |

三条口径：

- **必需能力的缺席要可见，可选能力的缺席要安静。** 工作区观测源不在时，加载报告写 `witness-seam`
  并把这一层记为惰性；PTC 不在时什么都不用说——**把两者都输出成「feature unavailable」会让真正的
  降级淹没在噪声里**。
- **判「在不在」要看已加载树，不看 profile 的 `package.json`。** 这两者会给出相反答案，本仓库两条都
  踩过：`workspace-changes` 不在 profile 自己的依赖里，却是 `dsh-web-app` 的 bundle patch 插入的一行
  （`cordis.patch.yml:339`），因此**一直在场**；`ptc-runtime` 同理（`dsh-base` 的 patch 插入）。可靠
  的判据是**服务在不在**（`witness-seam` 那一行）与**事件来不来**（`workspace/changes` 有没有追加），
  而不是解析层能不能从那个锚点找到包。
- **清单要有执行点，不能只是散文。** 上面那张表现在是**机器可校验**的，三件事各有一处代码：

  1. **项目声明**它需要哪些能力：适配器的 `execution.required_capabilities`（闭集见
     `lib/capabilities.js`，拼错的标识在**校验适配器时**就被拒）；
  2. **核对真实环境**：第一次用到某个工程时（第一次工具调用）逐项核对**已加载树**的真实状态——
     `native_child_dispatch` 看子会话接缝、`workspace_observation` 看观测接缝，其余几项是本插件
     自己的机制（加载即具备）。结果写进加载报告的 `capability-check`（每个工程一次，缺项写明
     「缺了它意味着什么」）；
  3. **高风险收口时拒绝结论**：`high_risk_task` 收口若本工程声明的能力有缺项，守卫按
     `GAC_COMPLETION_CAPABILITY_MISSING` 拒绝，并说明「缺的是结论的凭据」。想继续就得用
     `capability_ack` 显式写下接受缺口的理由——它随任务记录落盘、重启后仍在，并出现在
     `gac_task action:"audit"` 的链条里。**拒的是收口，不是工具**：一个永远收不了口的高风险模式
     就是「把自己关在门外」的同一个形状，本仓库在 `gac_scope` 上已经踩过一次。

  只写在文档里的契约会与代码漂移——本仓库在 `checkpoint` 那条上已经吃过一次（`AGENTS.md` §5 自己
  承认它「没有代码消费」）。

## 已知局限

写在这里，而不是留到以后才发现（适配计划 §7）：

1. **shell 写入无法被守护。** 命令字符串里的重定向或生成器目标，对工具流水线上的守卫是不可见的。与其假装不是这样，门禁在作用域生效期间干脆完全拒绝 shell 命令。需要 shell 执行的模式，要么在作用域之外跑，要么改接到结构化的文件工具上。**只读角色的收权对 shell 同样只到「按项目声明收回」为止**：默认留着它，是因为验证者要靠它执行计划用例留证据；留着就意味着一个只读角色仍可能通过 shell 写文件，那一类只能事后由 witness 观测发现。
2. **门禁是按工具调用生效的，不是按进程。** 在一个作用域被声明之前就已经启动的进程，不受它影响。
3. **作用域在内存里。** 重启会丢掉每一个作用域；这是正确的失败方向，因为一个过期的作用域会强制执行一项没人持有的权限。持久化的作用域会随协调器到来，从会话日志重新推导。**占用声明是持久化的**，所以一次崩溃可能把它留下——一旦它的会话不再存活，它就不再阻塞，因为带存活判定的存储会在判定下一次冲突之前先把它清理掉。当完全拿不到存活信息时，占用声明会被保留，而不是被猜成已死：挡住一个写入者是可以恢复的，而两个写入者写同一个文件不是。
4. **已纳管时，未知工具按失败即拒绝处理。** harness 升级新增的工具会被拒绝，直到它在 `lib/tool-targets.js` 里被归类。这是刻意的：一次运行时升级绝不能静默地放宽权限。

   这条规则产生过一个真实缺陷，留在这里作为实例。GAC 自己的 `gac_scope` 最初没有归类，于是作用域一旦声明，守卫就拒绝了唯一能释放它的工具——作用域变成了陷阱。它现在被归类为不触碰任何文件。**任何其强制路径本身也被守卫的工具，都必须可证明地无法写入**，否则它会重新制造这个死锁。

5. **工作区观测只看得见宿主算出来的那一份变更集，而且对 git 忽略的路径是盲的。** 它不做行级 diff，也分不清「已跟踪文件的修改」与「未跟踪的新增」——原 `witness.py` 用 git 增量比对能做到这一点，而现成的观测源只给一份合并后的清单。宿主按 `maxFiles` 截断过时，本插件把它记成 `coverage: partial` 并写明「未列全」，因此截断本身是可见的。**另有一条实测出来的盲区**：生产者的变更集来自 git 快照，并用 `check-ignore` 剔除被忽略的路径，所以**写在 `.gitignore` 覆盖的路径里的改动连事件都不产生**（构建产物、缓存、`.dsh/` 下的运行时状态都在此列）。这条只影响**事后观测**这一层——**事前拦截不受影响**：结构化写入的路径检查与 gitignore 无关。发现经过见 `docs/WITNESS-LIVE-PROBE.md` §0.5（第一轮探针恰好写在 `.dsh/gac/local/` 里，于是插件侧 `witness-turn` 一条都没有，而接缝 `available=true` 有 30 条）。

6. **PTC（`run_code`）在场，但它的守护建立在一个内核保证上。** 外层传输被**放行**——它自己不碰文件；真正受管的是它派发的**内层子调用**，而它们之所以受得到管，是因为内核在 `ToolExecution.parent` 上标出子调用、并保证每一次都走 `tools/pre-execute`。这条保证若不成立，PTC 就成了绕过写作用域的通道，所以它是必须核对的前提，不是实现细节。**PTC 运行时在日常 profile 里是装载的**（`dsh-base/cordis.patch.yml` 插入 `ptc-runtime` 与 `workflow-ptc`），`run_code` 只是**只在 PTC 模式下**才被呈现给模型——所以「工具面里没有 `run_code`」**不等于**「PTC 不在场」。本轮曾据后者把它收缩为「明确拒绝」，那是**基于错误前提**的改动（它会打断 PTC 模式下声明了作用域的活能力），已撤回；决策记录与教训见 `docs/ADR-0001-子会话执行载体.md` §19。

---

## 开发

```bash
npm test          # 910 个测试，不需要 DSH
```

这些库模块是纯的、依赖注入的，正是为了让测试套件不需要 harness 就能跑。`test/entry.test.js` 另外断言了 Cordis 导出的形状，并断言没有任何模块在模块作用域里裸 import `@deepseek-ai/*` 包（那会在求值期间抛错，早于任何插件代码来得及报告原因）。

```text
lib/
  index.js           DSH 外壳：注册守卫与声明工具
  plugin.js          pre-execute 门禁（对每一个未知项都按失败即拒绝）
  write-scope.js     严格的路径包含判定——安全边界
  claims.js          写占用声明冲突检测（纯函数）
  claim-store.js     持久化存储，一份占用一个文件，带孤儿清理
  capability-router.js  按所需能力挑选执行者（纯函数）
  contract.js        接口契约：并行开工之前先冻结它（纯函数）
  executor.js        执行边界：调用，或者诚实地拒绝
  gac-events.js      GAC 会话事件：词汇表、归约器、投影（纯函数）
  evidence.js        运行时签发的证据记录与引用（纯函数）
  evidence-store.js  只追加的 JSONL 日志；证据号由运行时签发
  engineering-policy.js  把 assets/ENGINEERING_POLICY.md 原文读给审查者
  metrics.js         对证据与任务做归约（纯函数）
  coordinator.js     任务 DAG、就绪判定、状态迁移（纯函数）
  grilling.js        多轮需求精化（纯函数）
  review.js          独立复核：六问与五个质量维度的门禁（纯函数）
  role-guard.js      只读角色的收权：把写入面从该角色自己的视野里拿掉
  task-store.js      持久化存储，一份任务一个文件，含计划与加载时重新校验
  tool-task.js       gac_task 工具
  tool-metrics.js    只读的 gac_metrics 工具
  tool-evidence.js   只读的 gac_evidence 工具
  verification.js    验证计划、反例与可追溯性门禁（纯函数）
  project.js         适配器校验 + 执行模式升级（纯函数）
  project-state.js   适配器加载、缓存，以及按会话的模式状态
  tool-project.js    gac_project 工具
  tool-targets.js    哪些工具调用会写哪些路径
  tool-scope.js      gac_scope 工具
  session-scope.js   按会话的已声明作用域注册表
  workspace-witness.js  工作区变更观测：折摘要、归属判定、事实与报告出口（纯函数）
  path-utils.js      绝对路径与根前缀辅助函数
  resolve-dsh.js     从链接安装的形态里解析 @deepseek-ai/*
```

代码遵循的设计规则：

- **每项安全决定只有一个定义处。** 包含判定只住在 `write-scope.js` 里，并且有单元测试；DSH 桥调用它，而不是重新推导一遍。第二份实现会漂移。
- **运行时里没有工程事实。** `lib/` 里不出现任何工程名、路径或能力词；一旦出现，`test/project.test.js` 会红。
- **失败是显式的。** 一次拒绝会指明所声明的写作用域并携带一个稳定的码；一个无法注册一半行为的插件会在加载报告里说明这一点，而不是悄悄丢掉它。

完整设计、六道真实缺口、边界条件与阶段计划见 [GAC-DSH-ADAPTATION-PLAN.md](GAC-DSH-ADAPTATION-PLAN.md)。
