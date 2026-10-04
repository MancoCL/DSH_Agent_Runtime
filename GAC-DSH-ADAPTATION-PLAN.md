# GAC Agent Architecture → DSH 适配执行方案

> 目标运行时：DeepSeek Harness / DSH 0.2.0-rc.2（桌面版 `resources/dsh`）
> 载体形态：一个 DSH 原生插件包 `dsh-gac-runtime`
> 核心结论：**大纲的架构方向与 DSH 的扩展面高度吻合，但有三处必须改写，否则会造出 DSH 里已经在跑的重复件。**

---

## 0. 结论摘要（先读这一节）

你的大纲把架构分成「Harness 提供执行内核 / GAC 提供策略、编排与验证」（§48、§56 末句），
这个切分是对的，DSH 的扩展面正好能承接。但落地前必须正视三件事：

| # | 结论 | 依据 |
| --- | --- | --- |
| 1 | **§22 Tool Pre-execution Guard 在 DSH 里是真能拦住的**，不是合同层 | `tools/pre-execute` 是 waterfall，可返回 `{kind:'deny'}` / `{kind:'ask'}`；`auto-review` 插件实测用它做逐调用授权 |
| 2 | **§9 Capability Routing 不必也不该自建** | DSH 已有 `subagents`（具名 provider 注册表）、`agentTeams`（含 DAG 任务板 + 依赖 + 写范围提示）、`agentPresets`（可钉模型/工具集）。自建就是 §33「Reuse first」的反面 |
| 3 | **§47 列的 14 个子模块里，只有约 6 个是真的缺口** | 其余已在 DSH 内核里，属「迁移」而非「实现」 |

一句话改写：

> **DSH 的内核已经是「固定代码负责控制」的那一半。GAC 的价值不在重建调度器，而在补齐内核刻意不管的四件事：执行模式语义、严格写范围、独立验证、证据与状态投影。**

---

## 1. DSH 已提供的扩展面（实测，非推测）

以下全部来自当前机器上的 0.2.0-rc.2 包体与 Cordis Inspect 查询结果。

### 1.1 关键服务（`ctx.*`）

| 服务 | 对 GAC 的作用 | 关键方法 |
| --- | --- | --- |
| `tools` | **唯一的执行前拦截点** | `guard(fn)`、`restrict({allow,deny})`、`register(def)`、`execute(exec)` |
| `approval` | §37 JIT Approval 原生出口 | `request(req)`、`setPolicy(agent, policy)`、`overrideOf(session)` |
| `llm` | **插件可以自己发起模型调用**，可钉 provider/model | `stream(GenerateOptions)` |
| `sessions` | 事件日志与状态投影 | `Session.append(type,data)`、`registerMessageProjection(p)`、`flush(session)` |
| `subagents` | 子 Agent 具名 provider 注册表 | `registerProvider(p)`、`startContinuable(spec)`、`sendMessage`、`interrupt` |
| `agentTeams` | 团队 + DAG 任务板（实验性） | `spawnTeammate`、`createTask`、`updateTask`、`waitForChange` |
| `agentPresets` | 可钉模型的 Agent 预设 | `register(PresetDefinition)`、`resolve(id)`、`select(agent,id)` |
| `permissionPresets` | 会话级权限档（GAC 模式的第一轴） | `current(session)`、`set(session,name)`、`defaultPreset` |
| `workflowEngine` | workflow 运行器 | `start(WorkflowStartRequest)` |
| `systemPrompt` | **把 GAC 协议注入模型视野** | `section(PromptSection)`、`context(PromptContext)`、`variables` |
| `fs` | 路径归一、包含判定、写意图 | `resolve(path)`、`contains(parent,child)`、`writeText(...)` |
| `workspaceChanges` | 事后现场比对（§25 Witness 的原生替代） | `summary(sessionId,seq)`、`diff(sessionId,seq,i)` |

### 1.2 关键事件（拦截 / 观测缝）

```text
tools/pre-execute     waterfall   ← §22 执行前 Guard（allow / deny / ask / cancel）
tools/post-execute    waterfall   ← 结果改写、纠正反馈（{kind:'block', feedback}）
tools/execute         waterfall   ← 计时、重试、指标
tools/result          emit        ← §41 证据捕获（冻结的最终结果）
fs/write-intent       waterfall   ← 只能加版本守卫意图，不能拒绝写入（见 §4.3）
fs/edit-intent        waterfall   ← 同上
fs/observed           emit        ← 读写观测，Witness 二次观测层的数据源
session/event         emit        ← §38 事件日志（提交后触发）
subagent/start|end    emit        ← 子 Agent 生命周期
workflow/start|phase|agent-start|agent-end|end|log  emit  ← workflow 进度
approval/request      waterfall   ← 审批答复链
```

### 1.3 插件与安装模型（已在运行的第三方插件为证）

一个 DSH **bundle** 就是普通 npm 包，加上 `package.json` 里的一个指针：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: gac-runtime
      name: 'dsh-gac-runtime'
```

profile 侧把它登记进 `dsh.profile.bundles`（`~/.dsh/profiles/<profile>/package.json`），
再在 profile 自己的 `cordis.patch.yml` 里做 id 定向覆盖。当前机器上 `dsh-tauri-pet`、
`dshmarket`、`@wenbin_wb/dsh-bridge` 等第三方插件都走这条路——**这条路是验证过的，不是设计意图。**

插件模块形状（照 `dsh-experimental-auto-review` 实测）：

```js
export const name = 'gac-runtime';
export const inject = ['tools', 'sessions', 'llm', 'approval', 'systemPrompt'];
export function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', handler, { prepend: true });
    // ...
  }, 'gac lifecycle');
}
```

**关键能力**：插件可以用 `ctx.llm.stream({provider, model, system, messages, temperature, signal})`
发起自己的模型调用。这意味着 Verifier / Reviewer **不需要子 Agent 会话也能独立成立**——
它们是插件里固定代码驱动的、钉住模型的、上下文隔离的模型调用。这是本方案最重要的一个设计支点。

---

## 2. 大纲逐条映射与裁决

裁决取三种：**复用**（DSH 已有，只接）、**迁移**（逻辑保留，换载体）、**新建**（真缺口）。

| 大纲 | 主张 | 裁决 | DSH 落地方式 |
| --- | --- | --- | --- |
| §2.2 | Agent 无状态 / 项目有状态 | 复用 | DSH session log + `session.persist`；Agent 本就是临时实例 |
| §2.3 | 固定代码控制，模型认知 | 强化 | 内核 + `apply()` 里的确定性协调器 |
| §2.4 | Runtime 观测优先于 Agent 自报 | 复用 + 补 | `tools/result`、`workspaceChanges`、`fs/observed` 取代自报 |
| §3 | 分层架构 | 复用 | Harness 层直接对应，GAC 只留插件层 |
| §4 | Requirement Gateway | **迁移** | `systemPrompt.section` + 一个 `gac_requirement` 工具 |
| §5 | 四级执行模式 | **新建**（语义是缺口） | 见 §4.1；映射到 DSH permission preset + GAC mode 双轴 |
| §6 | Execution Risk 模型 | 迁移 | 纯函数，留在插件内；高风险路径表放 Project Adapter |
| §7 | 动态升级 | 迁移 | 协调器状态机，升级事件写 session log |
| §8 | Capability 词表 | 迁移 | Project Adapter 声明；不再映射到固定子 Agent 名 |
| §9 | Capability Routing | **复用** | `subagents.registerProvider` / `agentPresets` / `agentTeams` |
| §10 | Subagent 最小上下文 | 复用 | `subagent` 工具的 push-minimum 已是默认；或插件内隔离 messages |
| §11–12 | 上下文优先级 / Pull API | 复用 | DSH 的 `read`/`glob`/`grep` 就是 pull API；优先级写进 prompt section |
| §13 | Memory Model | 迁移 | scope 分类保留；DSH 无 memory 服务，需自建薄层 |
| §14–15 | Project Adapter | **新建** | `.dsh/gac/project.json`；这是本方案第一优先级 |
| §16 | Deterministic Coordinator | **新建** | `apply()` 内状态机；不再用 Python CLI |
| §17 | DAG 模型 | 复用 | `agentTeams.createTask` 已有 `depends_on` |
| §18 | 并行条件 | 复用 + 补 | `agentTeams` 有 `writeScopes` 重叠**警告**；真正的锁需自建（§4.3） |
| §19 | 用原生 `parallel/pipeline/phase` | 采纳 | 已放弃自建执行桥 |
| §20–21 | Authority / Strict Write Scope | **新建**（真缺口） | 见 §4.2 |
| §22 | Tool Pre-execution Guard | **新建**（且可行） | `tools/pre-execute` waterfall |
| §23 | 三层沙箱 | 复用 | DSH sandbox / GAC authority / GAC write scope 正好三层 |
| §24 | Write Claims | **新建**（真缺口） | DSH 的 agent-team 写范围是 advisory，不阻断 |
| §25 | Witness 降为二次观测 | 采纳 | `workspaceChanges` + `fs/observed` |
| §26–31 | 验证独立性 / Falsification / 追溯 | **新建**（GAC 核心价值） | 见 §4.4 |
| §32 | Review 模型 | 迁移 | 可用 `ctx.llm.stream` 或复用 `auto-review` 的判定框架 |
| §33–34 | 工程质量 / 流程复杂度 | 迁移 | `ENGINEERING_POLICY.md` 原文保留 |
| §35–36 | Repair / 人工升级 | 迁移 | 内核自治循环 + `approval` |
| §37 | Approval | 复用 | `ctx.approval.request` |
| §38–39 | 事件驱动状态 / 投影 | **复用**（能力齐备） | `SessionEventMap` 类型合并 + `registerMessageProjection` |
| §40 | Semantic Artifacts | 迁移 | Requirement / VerificationPlan / ReviewReport 落 project 目录 |
| §41–42 | Evidence / Command Evidence | 复用 + 补 | `tools/result` 已给出 Command/CWD/ExitCode/stdout/stderr |
| §43–44 | Completion Policy | 新建 | 协调器判定；Agent 只报告 |
| §45 | 并发三层 | 复用 + 补 | 见 §4.3 |
| §46 | Provider 独立 | **复用**（已具备） | `GenerateOptions.provider/model` 逐调用可钉 |
| §47 | Plugin 边界 | 收窄 | 14 个模块 → 6 个真模块 + 4 个复用接线（§5） |
| §48 | 复用 DSH 原生 | 采纳 | 本方案主体 |
| §49 | 淘汰清单 | 采纳 | 整份 Python runtime 除策略文本外逐步退役 |
| §50 | 保留清单 | 采纳 | 全部是策略/语义资产，与载体无关 |
| §51 | Legacy 兼容 | 采纳 | `.claude/workflow/tasks/**` 只读归档 |
| §52–55 | 里程碑 / MVP / E2E / 指标 | 重排 | 见 §6–§8 |

---

## 3. 三个必须改写大纲的地方

### 3.1 执行模式是**双轴**，不是单轴

大纲 §5 的四级模式混了两件事：**能改什么文件**（权限）和**要走多少流程**（仪式）。
DSH 已经有第一轴的成熟实现（`permissionPresets`: `read-only` / `workspace-write` / `danger-full-access`
+ 会话级 `sandbox-policy`），GAC 不该重造。正确切分：

```text
DSH 轴（能力边界，内核强制）
  read-only / workspace-write / danger-full-access
        ↕ 映射，不是等同
GAC 轴（流程仪式，本插件强制）
  READ_ONLY / DIRECT_EDIT / STANDARD_TASK / HIGH_RISK_TASK

对账规则：
  GAC 模式必须在 DSH 权限允许的范围内；GAC 不得放宽 DSH 权限。
  GAC 可以收紧：HIGH_RISK_TASK 下把写范围再压到节点声明的最小集。
```

`READ_ONLY` 与 `DIRECT_EDIT` 在 GAC 侧不产生正式任务记录（沿用大纲 §5.1/§5.2），
但在 DSH 侧仍受 permission preset 约束——**这是纵深防御，不是重复实现。**

### 3.2 Capability Routing 应该**下沉到 DSH 的三件现成物**，而不是自建 Router

大纲 §9「不要固定 Builder/Verifier/Reviewer」的意图是对的，但 DSH 已有更合适的落点：

```text
能力 → 执行者，三种承载，按场景选：

(A) 需要独立会话 + 独立工作目录 + 可续接
    → ctx.subagents.registerProvider('gac-verifier', {
        name, capabilities, inheritsParentContext: false,
        agentRouteDefaults: { provider, model }   ← 钉模型的原生字段
      })
    或在 profile 里用 agentPresets 钉住模型/工具集
(B) 只需要独立上下文 + 钉住模型，不需要独立会话
    → ctx.llm.stream({provider, model, system, messages})   ← 最轻，首选用它
(C) 需要多人协作 + DAG 任务板 + 持久邮箱
    → ctx.agentTeams
```

注意 (A) 有一个现成的定钉点：`SubagentProvider.agentRouteDefaults?: {provider, model}`
——provider 级静态模型路由是内核字段，不是我们发明的约定
（`dsh-subagent/lib/types/types.d.ts:338-347`）。这意味着「Verifier 固定用 DeepSeek」
可以是 provider 声明，而不是运行时每次传参。

**MVP 选 (B)**：它同时满足 §30 独立性（不同 system prompt、不同 messages、
不共享 Builder 的推理）、§46 Provider 独立（逐调用钉 provider/model）、
以及 §33 的最小复杂度（零新基础设施）。`auto-review` 已经证明了这条路可跑。

### 3.3 Witness 的定位要**换数据源**，不是降级就完事

大纲 §25 把 Witness 降为二次观测，方向对。但 DSH 侧不必自己算文件哈希——
`ctx.workspaceChanges.summary(sessionId, seq)` 与 `diff(...)` 已经是内核维护的现场变化记录，
`fs/observed` 是权威观测事件。原来的 Python `witness.py`（含 git 增量比对、写范围归属、
2000 文件上限等一整套）**整体退役**，改成订阅这两个源。

---

## 4. 六个真缺口的设计（GAC 的核心增量）

### 4.1 执行模式与风险解析（`gac/policy`）

纯函数，无状态，无 IO（除了读 Project Adapter）：

```text
输入:  user 意图摘要 + 目标路径集 + Project Adapter 的 risk 表 + 当前 DSH permission preset
输出:  { mode, risk, reason, escalated_from, gac_write_scope }
```

判据照大纲 §6：语义影响 / 范围 / 歧义 / 可逆性 / 安全 / 持久化 / 公共契约 / 验证难度 /
外部副作用 / 爆炸半径。**不看文件数与行数**——这条原来在 `direct --paths` 里靠路径表实现，
现在搬到插件内，并在 `systemPrompt.section` 里告诉模型当前的模式与理由。

早期实现里那条「禁止朴素文本扫描」的约束继续有效：模式由语义判断（模型声明 + 路径表交叉校验），
不由描述文本关键词匹配。模型声明落在 `gac_requirement` 工具的入参里，由运行时核对。

### 4.2 严格写范围（`gac/write-scope`）—— 这是最硬的一道门

照大纲 §21：**禁止 basename alias 污染安全边界。**

```text
scope: ["mod.c"]        allowed: ./mod.c
                        denied:  src/mod.c, other/mod.c
```

实现约束（都是原 Python 版踩过的坑，必须保留）：

1. 归一化：反斜杠、`./`、`..`、Windows 大小写折叠——`SRC\x.c` 与 `src/x.c` 是同一个文件。
2. 范围比较**不要自己写第二个实现**：用 `ctx.fs.resolve(path)` 拿稳定 target，
   用 `ctx.fs.contains(parent, child)` 做包含判定。内核已经处理了别名与符号链接。
3. 未归一化的字符串前缀比较**不得**用于授权判定——大纲 §56 末列「Convenience aliases
   must never leak into security boundaries」就是这个意思。

**落点**：`tools/pre-execute`，**prepend** 到链首，在 `auto-review` 之前否决：

```js
ctx.on('tools/pre-execute', async (exec, next) => {
  const claim = claims.forAgent(exec.agent);           // 当前 agent 的活动写声明
  if (!claim) return next();                            // 非 GAC 管辖，放行
  const targets = extractWriteTargets(exec);            // 见下：覆盖所有写入类工具
  for (const t of targets) {
    if (!inScope(claim, t)) {
      return { kind: 'deny',
               reason: `GAC: 写入 ${t} 越出本任务声明范围`,
               info: { name: 'GacWriteScopeDenied', code: 'GAC_WRITE_SCOPE_DENIED' } };
    }
  }
  return next();
}, { prepend: true });
```

**必须覆盖全部写入面**，只拦 `write` 是漏的：

| 工具 | 参数名 | 备注 |
| --- | --- | --- |
| `write` | `file_path` | 已实测确认参数名 |
| `edit` | `file_path` | 同上 |
| str-replace 类 | `file_path` / `path` | 两个都取，缺失则保守放行并记证据 |
| `pwsh` / `bash` | 命令文本 | **拦不住**——见 §7 边界 |
| `run_code` (PTC) | 子调用 | `auto-review` 已示范如何处理 PTC 内层调用 |

> **诚实结论**：`tools/pre-execute` 挡得住结构化工具调用，挡不住 shell 重定向、
> 代码生成器、格式化器写文件。大纲 §21 的「Strict Write Scope」在 DSH 上只能做到
> **结构化写入路径的强制** + **shell 路径的检测**。这一点必须写进文档，不能宣称已完全强制。
> 补强手段：GAC 模式下把 `pwsh`/`bash` 用 `ctx.tools.restrict({deny:['pwsh','bash']})`
> 对 VERIFIER/REVIEWER 角色收回——**验证者本来就不该有写权限**，这条既补强又符合 §31。

### 4.3 写声明与并发（`gac/write-claims`）

大纲 §24、§45 要的跨会话物理防撞，DSH **没有现成的**：
`agentTeams` 的 `writeScopes` 明确写着 "warn on overlap … but never block claim or authorize writes"。
所以这个要自建，但要极简：

```text
一次声明一个文件（照原 Python 版，避开 lost-update）
路径: <project>/.dsh/gac/claims/<dispatch_id>.json
内容: { dispatch_id, session_id, project_id, node_id, paths[], created_at, heartbeat_at }
```

- **获取**：`fs.resolve` 判定目标是否落在任何**活动**声明的路径内。
  冲突即 `{kind:'deny'}`（不是 waiting，DSH 里直接拒更干净）。
- **释放**：只在真正收口时释放。参照原 Python 版的教训——
  **释放只认运行时记录的 active dispatch_id，不认结果里自报的 id**，
  否则一份冒名结果就能放掉别人的守卫。
- **残留**：靠 `heartbeat_at` + `session/event` 清理；DSH 崩溃恢复比 Python 版弱，
  这一层要明确标注为「尽力而为」。

### 4.4 独立验证（`gac/verification`）—— GAC 最不可替代的部分

大纲 §26–§31。在 DSH 上这样落地：

```text
HIGH_RISK_TASK:

  阶段 1  Verification Design（模型调用 A，钉 provider/model A）
          输入: Requirement + AC + 权威规范 + 既有契约
          禁止: 读取实现、读取 Builder 的推理与测试
          输出: VerificationPlan {cases:[{id,covers,type,expect,?expect_failure}]}
                → 冻结落盘，实现侧写范围**不得包含**该文件

  阶段 2  Implementation（Builder，正常 DSH 会话 + 写声明）
          Builder 的 Developer Tests 只作开发证据

  阶段 3  Independent Verification（模型调用 B，钉 provider/model B）
          输入: 冻结的计划 + 完整实现 + Builder 测试（此时才读）
          先逐条执行计划用例并留证据，再补 adversarial probe
          （标注 implementation-specific probe，与需求推导用例分开放）

  阶段 4  Review（模型调用 C）
          逐条回答验证独立性六问 + 工程质量逐维度
```

**门禁**（照原 `workflow.py` 的报码习惯，保持机器可分支）：

```text
GAC_VERIFICATION_PLAN_MISSING       高风险任务无计划
GAC_VERIFICATION_COVERAGE_GAP        AC 与计划覆盖差集非空（须指出缺失 AC）
GAC_FALSIFICATION_EVIDENCE_MISSING   某条 AC 缺 falsification 用例
GAC_INDEPENDENT_EVIDENCE_MISSING     计划用例缺已执行证据
                                     （含「一次运行摊到多条用例上」——同方法+同证据文件）
```

反退化规则照抄原版：**记录里一旦出现某版字段即按该版校验**，
把 `schema_version` 改回旧值不能关闭已生效的门禁。

### 4.5 证据层（`gac/evidence`）

大纲 §41–§42「证据来自运行时而非 Agent 自报」。DSH 里 `tools/result` 已经携带
冻结的最终结果，**不需要自己抓**，只需订阅并落盘关联：

```text
Tool / Input / IsError / ErrorCode / ExitCode / Output digest / Related AC
                 ↑ 内核已有                    ↑ GAC 补这一段关联
```

**实测修正（Phase 6 落地时发现）**：`tools/result` 给出的是
`{ isError, value, content, meta }` 与失败时的 `{ error: { message, info: { code } } }`。
**冻结结果里没有顶层的 CWD / stdout / stderr 字段**，`exitCode` 也不在顶层——它在
`result.value` 里，而**各工具 `value` 的形状不同**（`pwsh` 的 value 带
`exitCode`/`signal`/`timedOut`/`aborted`，并带 `kind` 判别联合）。
`exitCode`/`stdout` 出现在 `TerminalResultView` 上，那是 `presentResult` 产出的**展示类型**，
不是冻结结果。

因此证据层采取的口径是：`result.error.info.code` 原样记下（这是 `GAC_WRITE_SCOPE_DENIED`
这类信号的来源，且是内核给的、可核对）；`result.value` 只**在确实是对象时**按已知字段读
`exitCode`/`signal`/`timedOut`，**读不到就不写这一项**——缺失是诚实的，猜出来的是假的。
产出本身只留摘要与前缀，不落全文。

### 4.6 事件与状态投影（`gac/events`）

大纲 §38–§39，DSH 侧能力齐备：

```js
// 类型合并（每个内核插件都这么做，实测 31 处）
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'gac/task-created':    { taskId: string; mode: string; projectId: string };
    'gac/mode-selected':   { taskId: string; mode: string; escalatedFrom?: string };
    'gac/node-completed':  { taskId: string; nodeId: string; attempt: number };
    'gac/evidence-recorded': { taskId: string; ac: string; artifact: string };
    // ...
  }
}
```

```js
ctx.sessions.registerMessageProjection({ type: 'gac/task-created', project: ... });
ctx.sessions.get(sessionId).append('gac/task-created', { ... });
```

**实测修正（Phase 5 落地时发现）**：原方案称「于是 Current State = reduce(Session Events)，
不再维护可变状态 + 历史状态混合 JSON」。这条**对任务状态不成立**：

- 会话是会话作用域的，且 `ctx.sessions` 自述为**内存中的**会话存储，持久化由另一个插件挂在
  每个会话的写句柄上；而**任务是工程作用域的**——同一个需求的多个节点会由不同执行者、在不同
  会话里推进（这正是任务记录当初按工程存放的原因）。
- 一个跨会话的任务，其历史分散在多个会话日志里，而**没有任何工程级事件流或索引**能把它聚起来。

因此事件层做的是它做得到的事：把 GAC 动作追加进会话日志，提供**可见性与审计**，并按 §39 投影
成对话消息。**任务状态的权威仍然是 `.dsh/gac/tasks/` 里的记录。**

另外三处实测结论：

- 自定义事件类型**可以直接 append**：`validateSessionEventData` 只检查已知类型，未识别的类型
  不受约束，唯一要求是载荷可 JSON 序列化。因此纯 JS 插件不需要类型合并也能写事件；类型合并
  只是给 TypeScript 的编译期便利。
- `MessageSourceMap` 只有 user / model / tool / system-prompt 四种来源，**没有「运行时自己」
  这一格**，因此事件投影必然把运行时的话归到别人名下（这里用 user 加 `[GAC]` 前缀标记，那是
  失真而不是等价物）。
- `deriveEventMessage` 对投影返回的消息**不做任何校验**，而 `MessageBase` 要求 `id` 与
  `source`，且 `id` 必须跨次派生稳定；少写或写错不会报错，只会让形状不全的消息流进对话。

---

## 5. 收窄后的插件边界（替换大纲 §47）

```text
dsh-gac-runtime
├─ project-adapter      ★新建  .dsh/gac/project.json 读取与校验
├─ requirement          ★新建  systemPrompt.section + gac_requirement 工具
├─ policy               ★新建  执行模式 / 风险解析（纯函数）
├─ coordinator          ★新建  确定性 DAG 状态机（替代原 Python CLI）
├─ write-scope          ★新建  严格写范围（复用 ctx.fs.resolve/contains）
├─ write-claims         ★新建  跨会话写声明
├─ verification         ★新建  VerificationPlan / Falsification / 追溯
│
├─ router               ◇复用  → ctx.subagents / ctx.agentPresets / ctx.agentTeams
├─ approval             ◇复用  → ctx.approval.request
├─ evidence             ◇轻接  → tools/result 订阅 + AC 关联
├─ events               ◇复用  → SessionEventMap 合并 + registerMessageProjection
└─ witness              ◇复用  → ctx.workspaceChanges + fs/observed（原 witness.py 退役）
```

**从大纲 §47 删掉的**：`risk`（并入 policy）、`authority`（并入 write-scope）、
`capability-router`（复用）、`review`（并入 verification 的阶段 4）、`legacy-reader`
（降为一次性迁移脚本，不是常驻模块）。

---

## 6. 里程碑（重排大纲 §52，按「先证明可行性」排序）

原来的 Phase 1–7 是自底向上，但 DSH 侧的风险集中在**两处未知**，应该先打掉：

```text
Phase 0  可行性尖刀（1 次迭代，最先做）
  ├─ 一个最小插件：只做 tools/pre-execute + 一条硬编码写范围
  ├─ E2E-4 跑通：authority.write=["mod.c"]，Agent 尝试写 sub/mod.c → DENY BEFORE WRITE
  └─ 证明：拦住之后模型看到什么、能不能自己纠正
  ↳ 这一步失败则整个 §22 不成立，必须在投入其它模块前知道

Phase 1  Project Adapter + 执行模式
  .dsh/gac/project.json、policy 纯函数、systemPrompt.section 注入模式
  验收: E2E-1（删一个配置字段 → DIRECT_EDIT → 无任务、无子 Agent）

Phase 2  写范围 + 写声明
  ctx.fs.resolve/contains 归一化、claims 获取/释放/残留
  验收: E2E-5（共享独占资源的两个节点不同批）

Phase 3  协调器 + STANDARD_TASK
  确定性 DAG、Builder → Verifier
  验收: E2E-2（普通 bugfix → STANDARD → Builder → Verifier）

Phase 4  HIGH_RISK_TASK + 独立验证
  Verification Design ∥ Implementation → Verification → Review + 四道门禁
  验收: E2E-3

Phase 5  事件与投影
  SessionEventMap 合并、Projection、崩溃恢复
  验收: 重启后 reduce 出同一状态

Phase 6  证据与指标
  tools/result 订阅、AC 关联、§55 指标采集
  ↳ 已落地：`lib/evidence.js`（记录与引用）、`lib/evidence-store.js`（只追加 JSONL、
    运行时发号）、`lib/metrics.js`（归约）、`lib/tool-metrics.js`（只读出口）
  ↳ 关键性质：**运行时没发过的证据号一律不认**。在此之前 `evidence_ref` 只是模型写下的
    字符串，写下 `ev-1` 与真的跑过一条命令在数据上完全一样，于是「每条用例都有证据」
    可以靠编造满足。引用形如 `证据号#明细`，同号不同明细合法（一次套件运行支撑多条用例），
    同号同明细判为取证摊薄。

Phase 7  Legacy 切换
  ~/.claude/workflow 只读归档；新任务默认走 DSH
```

**相对大纲的调整**：原 Phase 2（Authority）提到 Phase 0，因为它是唯一的真未知；
原 Phase 3（Agents）降级并入 Phase 3–4，因为 Router 是复用不是新建。

> **与 §12.4 的关系**：Phase 0–7 是**技术风险排序**（先打掉未知），
> §12.4 是**功能闭环顺序**（产品路径）。两者不冲突：Phase 0 的尖刀同时是
> §12.4 中「写范围/写声明」两道门的技术验证；§12.4 的接口契约冻结落在 Phase 1–2 之间。
> 接口契约冻结**不依赖任何 DSH 未知**，可与 Phase 0 并行推进。

---

## 7. 必须写进文档的边界（否则会过度承诺）

这几条是 DSH 的真实能力边界，不能靠架构图掩盖：

1. **shell 写入拦不住**。`pwsh`/`bash` 可以绕过 `write`/`edit` 直接落盘。
   对策：结构性强制（工具层）+ 角色收权（验证者无 shell 写权限）+ 事后观测（`workspaceChanges`）。
   **不宣称「完全强制写范围」。**
2. **写声明是尽力而为**。DSH 无跨进程文件锁；崩溃可能留残留声明。
   对策：heartbeat + 显式清理出口。
3. **`fs/write-intent` 不能拒绝写入**。它只能附加版本守卫意图（`createIfAbsent` /
   `replaceIfVersion`）。任何「在 fs 层拦写」的设计都是错的。**拦写只有 `tools/pre-execute` 一条路。**
4. **PTC (`run_code`) 的内层调用**需要单独处理，外层 `run_code` 本身跳过。
   这条路 `auto-review` 已走通，照抄其 `scopePtcStarts` 的处理。
5. **独立验证的独立性来自信息路径，不是进程隔离**。同一 provider 的两个
   `ctx.llm.stream` 调用，只要 system prompt、messages、执行顺序三者分离，
   就满足大纲 §31 的要求。**不要为了「独立」而引入多进程**——那是复杂度而非严谨（§33）。
6. **理想的可观测性不如原 Python 版的 git 增量比对**。
   原 `witness.py` 能分清「已跟踪修改」与「未跟踪新增」并只比增量；
   `workspaceChanges` 覆盖面需在 Phase 6 实测后确认，**不够就补，不要在文档里先假定够用**。

---

## 8. 迁移与退役清单（落实大纲 §49 / §51）

| 原 `~/.claude/workflow` 资产 | 处置 |
| --- | --- |
| `PROTOCOL.md` 的流程语义 | 迁移进 `systemPrompt.section` 文本 + 协调器状态机 |
| `ENGINEERING_POLICY.md` | **原文保留**，纳入插件资源，作为 Reviewer 的 system prompt 素材 |
| `routing.py`（就绪节点/能力路由/并行判定） | 就绪节点判定→协调器；**能力路由删掉**（复用 DSH）；并行判定→保留为纯函数 |
| `runtime.py`（Invocation Builder / 状态迁移 / next action） | 迁移为协调器 + session events |
| `claims.py` | 迁移为 `gac/write-claims` |
| `witness.py` | **退役**，改订阅 `workspaceChanges` + `fs/observed` |
| `invocation.py`（AgentInvocation 契约） | 简化：DSH 工具调用本身即结构化契约；只留写范围与产物声明 |
| `memory.py` / `MEMORY.md` | scope 分类保留，接一个薄 DSH memory 层（Phase 6+） |
| `hook-entry.py` + Claude Code hooks | **退役**（被 DSH 插件取代） |
| `workflow.py` CLI 全套 | 退役；`direct --paths` 的准入逻辑并入 `policy` |
| `templates/*.json` | 保留为插件内的 schema，语义不变 |
| `.claude/workflow/tasks/**` 历史数据 | **只读归档**，不重写（大纲 §51） |
| `tests/`（Python 回归） | 迁移为插件侧测试；schema 门禁断言按原样保留 |

**迁移期间的双写风险**：建议 profile 里同时挂旧 hook 与新插件会互相打架。
正确做法是 **Phase 0 起就只挂插件**，旧 runtime 只作代码参考与数据归档。

---

## 9. E2E 验收（照大纲 §54，译为 DSH 断言）

| ID | 场景 | DSH 侧断言 |
| --- | --- | --- |
| E2E-1 | 删一个配置字段 | 模式 `DIRECT_EDIT`；**无** `gac/task-created` 事件；零子 Agent 调用 |
| E2E-2 | 普通 bugfix | `STANDARD_TASK`；事件序列含 node-started(Builder) → node-completed → node-started(Verifier) → completed |
| E2E-3 | 安全/持久化任务 | `HIGH_RISK_TASK`；Verification Design 与 Implementation 的模型调用**并发发起**；Verification 读实现的时间戳晚于计划冻结事件；Review 六问齐备 |
| E2E-4 | `write=["mod.c"]` 尝试写 `sub/mod.c` | `tools/pre-execute` 返回 deny，**工具体未执行**（`tools/result` 无对应成功记录），错误码 `GAC_WRITE_SCOPE_DENIED` |
| E2E-5 | 两节点共享独占资源 | 第二个节点的派遣被拒；拒绝理由含持有者 dispatch_id |
| E2E-6 | 验证者试图写产品代码 | Verifier 角色的 `pwsh`/`write` 已被 `tools.restrict` 收回，调用返回 UNKNOWN_TOOL |

---

## 10. 指标（大纲 §55，补 DSH 可测口径）

```text
Critical Path Duration          workflow/start → workflow/end
Agent Call Amplification        ctx.llm.stream 调用数 / 需求数
Context Reuse Ratio             Verify 侧命中缓存输入 token / 总输入
Duplicate Read Ratio            同一 session 内重复 read 同一路径
Token Usage                     tokenMeter.measure(session)
Independent Verification Cover  plan.cases 覆盖的 AC 数 / 总 AC 数
Unauthorized Write Attempts     GAC_WRITE_SCOPE_DENIED 次数        ← 应为 0，非 0 说明提示词有问题
False-positive Escalation       escalated_from 非空但实际无需升级的比例
Direct Edit Ratio               DIRECT_EDIT / 全部需求
Repair Attempts                 同节点 attempt 序号最大值
```

---

## 11. 载体、开发与安装（本工作区就是它的家）

当前工作目录 `Agent_Runtime` 是空的（除权限修复留下的 `.acl-recovery/`），
它就是 `dsh-gac-runtime` 的源码目录。**不需要先发布到 npm**：
`plugin_manager` 的 `install_bundle` 接受绝对路径，会直接读它的 `package.json`
（`dsh-plugin-manager/README.md:46`）。

```text
D:\WorkSpace\99_Others\02_UserProject\Agent_Runtime\
├─ package.json          name 与 dsh.bundle.patch 指针
├─ cordis.patch.yml      - insert: [{id: gac-runtime, name: 'dsh-gac-runtime'}]
├─ lib\
│  ├─ index.js           插件入口：name / inject / apply(ctx)
│  ├─ policy.js          执行模式与风险（纯函数）
│  ├─ write-scope.js     严格写范围（复用 ctx.fs.resolve/contains）
│  ├─ claims.js          写声明
│  ├─ coordinator.js     DAG 状态机
│  └─ verification.js    独立验证 + 门禁
├─ assets\
│  └─ ENGINEERING_POLICY.md   ← 从 ~/.claude/workflow 原文搬来
└─ test\
```

**纯 JS、ESM、无构建步骤**：没有 `build` script，因此不触发 pnpm 的
build-script 审批（`pendingBuilds` 不会出现），安装路径最短。

开发循环（HMR 已在本 profile 启用，`include:hmr` 为 active）：

```text
1. 改 lib/*.js
2. 若 profile 已 link 该包 → HMR 自动重载；否则首次安装：
   plugin_manager { action: install_bundle, target: "D:\\WorkSpace\\...\\Agent_Runtime" }
3. 在同一个 Web GUI 里验证（不要另起 server）
```

**注意 profile 选择**：本机 `~/.dsh/profiles/` 下同时有 `core-020` 与 `tauri`，
`core-020` 的 bundles 里含 `dsh-experimental-auto-review`。装之前先确认桌面版
实际加载的是哪一个（`list_bundles` 的实际结果为准），装错 profile 会「配置生效但行为不变」。

---

## 12. 核心需求的落地映射与三处必要修正

用户的核心需求（`Core Loop`）：

```text
需求输入 → grilling 细化 → 并行出「代码实施方案」+「测试实施方案」
        → 并行实施 功能代码 + 测试代码 → 用测试代码测功能代码
        → 审查测试结果与代码 → 输出需求实施结果
```

**结论：可实现，但原样照做会有三个坑，必须修正。**

### 12.1 修正一：grilling 必须在主会话里发生，不能藏在插件内层

实测约束：`ctx.userQuestions.ask()` 在调用者不是**运行时根 Agent** 时会抛
`DELEGATED_CALLER`（"an owned child has no human answerer and would block forever"）。

所以设计上不能是「插件内的协调器直接问用户」。正确形态是分工：

```text
协调器（固定代码）  拥有 frontier 算法：把依赖图里「前置已定」的集合算出来
                    ↳ 但「哪些决策存在、依赖关系是什么」是语义判断，归模型
主会话（模型）      提出 frontier 的问题与推荐答案
插件工具            gac_grill 工具：主会话调用它 → 内部走 ctx.userQuestions.ask()
                    ↳ 问题/答案落 session event，frontier 收敛可被代码核对
用户                在原生提问 UI 里回答（多问一次问完，multiSelect 支持）
```

`ctx.userQuestions` 的原生形状正好够用：`{id, question, detail, header, options[], multiSelect}`
→ `{answers:[{id, selected[], custom}]}`。**不需要自建提问 UI**，也不需要自建问答案存储。

这同时印证了大纲 §4 的定位：`PROTOCOL.md` 早就写了「grilling 只能由主会话执行：
子 Agent 拿不到用户答复」。**原架构的判断是对的，DSH 把这条从协议义务变成了硬约束。**

### 12.2 修正二：并行实施「功能代码 + 测试代码」之前，必须冻结接口契约

这是最重要的一处修正。

测试代码与功能代码**并行**编写，意味着测试作者在写测试时不知道实现长什么样。
如果两者各自发明接口，测试会因为「接口对不上」而失败——那是**结构性失败，不是缺陷**，
测出来的结果没有信息量。

DSH 侧完全可以支持测试先行（测试代码是普通文件产物，不依赖实现存在），
所以问题不在能不能，而在**测试作者凭什么知道接口**。答案：先冻结一个最小接口契约。

```text
需求 → grilling → ┌ 接口契约冻结（Interface Contract）
                  │   最小、显式、只写签名与行为约定，不写实现
                  ├──────────────┬──────────────┐
                  ↓              ↓              ↓
            代码实施方案     测试实施方案     （两者都只依赖契约）
                  ↓              ↓
            功能代码实施     测试代码实施      ← 真并行，写范围不相交
                  └──────┬───────┘
                         ↓
                  测试代码 × 功能代码（执行）
```

**接口契约冻结是本流程能成立的前提**，不是可选的礼节。它也是把「并行写测试」
从「凭猜测的赌博」变成「按契约的独立实现」的唯一手段。

有了契约之后，§31 的验证独立性才真正成立：测试从**契约 + 验收标准**推导，
没有读实现；功能代码从**契约 + 方案**推导，没有读测试。两者信息路径分离。

### 12.3 修正三：「用测试代码测功能代码」是执行，不是又一轮实施

原需求里「并行进行功能代码和测试代码的实施，最终使用测试代码去测试功能代码」
读起来像两件事都能并行。实际上：

```text
并行的是「编写」（authoring）—— 两个写者，写范围不相交，安全
串行的是「执行」（execution）—— 测试必须等两份产物都落盘且写声明都释放
```

这不是妥协，而是 DSH 上唯一正确的做法：

1. 两个模型调用**同时开始**，各自产出文件，靠 §4.3 写声明保证路径不相交。
2. 两者的写声明都释放后（即都收口），执行节点才就绪——这是 §17 DAG 的依赖边。
3. **执行者不能有测试目录的写权限**：否则「测试失败 → 改测试」会污染证据。
   用 `ctx.tools.restrict` 对执行角色收回测试路径的写权限。
4. 测试输出（exit code / stdout）不是结构化证据，需要一个映射层把
   「哪个用例跑了、通过与否、关联哪条 AC」从原始输出里提出来。这一层在 Phase 6，
   **是工作量，不是难点**，但要预留。

### 12.4 修正后的完整闭环

```text
┌─ 0 需求输入（主会话）
├─ 1 grilling：多轮，每轮问完 frontier，落 session event
│     ↳ 循环直到 frontier 清空且用户确认
├─ 2 需求定稿：Requirement + AC + interface_contract（冻结）
│     ↳ 契约冻结后进入写声明保护，实现侧不得改写
├─ 3 并行：代码实施方案 ∥ 测试实施方案（两个钉模型的独立调用）
├─ 4 并行：功能代码实施 ∥ 测试代码实施（两个写者，写范围不相交）
│     ↳ 都从冻结契约推导，互不读对方
├─ 5 串行：执行测试 × 功能代码（执行者无测试目录写权限）
├─ 6 审查：测试结果 + 代码 + 工程质量 + 验证独立性六问
├─ 7 结果：AC 逐条判定，输出 Requirement 实施结果
└─ 任一环节失败 → §35 修复循环（Observe→Diagnose→Repair→Verify），不清用户
```

对照原架构的缺口清单：

| Core Loop 环节 | 原架构 | DSH 落地 | 缺口 |
| --- | --- | --- | --- |
| grilling 多轮 | §4 有 | `ctx.userQuestions` + 主会话 | 无（需按 12.1 分工） |
| 接口契约冻结 | **未列** | 新增 artifact | **需补** |
| 并行双方案 | §18 有 | `ctx.llm.stream` ×2 | 无 |
| 并行双实施 | §18/§24 有 | 写声明 + 写范围 | 无（§4.3） |
| 测试执行 | §41/§42 有 | `tools/result` + 映射层 | 映射层工作量 |
| 审查 | §32 有 | 钉模型的审查调用 | 无 |
| 结果输出 | §43/§44 有 | 协调器判定 + 语义 artifact | 无 |

**唯一真正的架构缺口就是「接口契约冻结」这一环。** 其余环节原架构都已覆盖。

---

## 13. 立即下一步（建议的最小动作）

1. **先做 Phase 0 尖刀**：一个只含 `tools/pre-execute` 的 40 行插件，
   在 `~/.dsh/profiles/<profile>/` 里 link 进去，跑 E2E-4。
   这一步的成本约等于一次会话，但它决定 §22 是否成立。
2. 同时定稿 `.dsh/gac/project.json` 的 schema——它是所有后续模块的输入契约，
   且**不依赖任何 DSH 未知**，可以并行推进。
3. Phase 0 通过后再决定 `agentTeams`（实验性，契约可变）是否纳入，
   **不要**在 Phase 1 就依赖它。

---

## 附：本方案的事实来源

以下结论均在本机 0.2.0-rc.2 包体上直接核对，非推测：

- `tools/pre-execute` → `PreToolDecision` 四态、`ctx.tools.guard` 语义：
  `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:445-460`
- 插件用 pre-execute 做逐调用授权的完整实现：
  `node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:456-506`
- `write` 工具参数名 `file_path`：
  `node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js:527-539`
- `ctx.llm.stream(GenerateOptions)` 可钉 provider/model：
  `node_modules/@deepseek-ai/dsh-llm/lib/types/...`（Inspect Service 查询 `llm`）
- `SessionEventMap` 可被各插件类型合并（31 处实测）：
  如 `dsh-goal/lib/types/domain.d.ts:47`、`dsh-tools/lib/types/types.d.ts:28`
- `Session.append` / `registerMessageProjection`：
  Inspect Service 查询 `sessions`
- `fs/write-intent` 只能加意图、不能拒绝：
  `node_modules/@deepseek-ai/dsh-fs/lib/types/index.d.ts:19-42`
- bundle 形态与 profile 组装：
  `node_modules/@deepseek-ai/dsh-experimental-auto-review/cordis.patch.yml`、
  `~/.dsh/profiles/tauri/package.json`（`dsh.profile.bundles`）
- agentTeams 写范围是 advisory、不阻断：
  `node_modules/@deepseek-ai/dsh-experimental-agent-team/README.md:139,207`
