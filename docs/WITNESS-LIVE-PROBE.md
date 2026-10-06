# Witness 活体验收探针（validation profile）

**这份文档是可执行的验收依据，不是说明文。** 目标：证明
`Workspace Changes Producer → workspace/changes → GAC Witness → EvidenceLog`
这条链在**真实会话**里成立——而不是只证明 `ctx.get("workspaceChanges") !== undefined`。

**为什么需要它**：工作区观测是生产纵深防御层（见 README「生产能力契约」），它覆盖事前拦截够不着的
那一类落盘（shell 重定向、生成器、外部进程、间接写入）。它缺席时，「没有越界写入」这句话无从成立。
**它进入日常 profile 之前，旧运行时不能切。**

## 0. validation profile 现状（2026-10-06 建好并预检）

```text
~/.dsh/profiles/gac-verify/
├─ package.json          与 core-020 同构，差异只有一处：多装 producer
├─ cordis.yml            []（树由 bundles + patch 组合）
├─ cordis.patch.yml      与 core-020 逐字节一致（插件开关就在里面）
├─ pnpm-workspace.yaml   nodeLinker: hoisted
├─ pnpm-lock.yaml        pnpm install 生成
└─ node_modules/         含 @deepseek-ai/dsh-workspace-changes（profile 内 junction）
```

**安装方式**是正规机制：把 `@deepseek-ai/dsh-workspace-changes` 作为 `link:` 依赖写进该 profile 的
`package.json`、加进 `dsh.profile.bundles`、在该目录跑 `pnpm install`（`link:` 依赖不需要网络）。
**不是**手工往被提升的 `profiles/node_modules` 里塞 junction——那种状态会被一次升级抹掉，于是「生产
里有 Witness」变成升级就消失的手工事实。

**预检结果**：21 个标识符全部解析得到（bundle 18 项 + 依赖 + 5 个关键服务）。两个
`@deepseek-ai/dsh-experimental-*` bundle **日常 profile 自己也解析不到**（既不在提升集合、也不在
`core-020/node_modules` 里）——宿主对缺失 bundle 容错，validation profile 在这一点上与日常同构。

## 0.5 两个坑：探针文件必须**未被忽略**，而且必须**留在盘上到该轮结束**

**坑一（第一轮踩到）：写在 git 忽略的路径里。** 第一轮把文件写在 `.dsh/gac/local/`（本仓库唯一被
授权的可写目录）——**而那个目录在 `.gitignore:9` 里**。生产者的变更集来自 git 快照并用 `check-ignore`
剔除被忽略的路径（`dsh-workspace-changes/lib/index.js` 的 `ignoredPaths(...)`），所以写在那里的文件
连 `workspace/changes` 事件都产生不了。

**坑二（第二轮踩到，更隐蔽）：同一轮内创建又删除，净变化为零。** 第二轮的探针写在仓库根（**未被
忽略** ✓），但子会话在同一轮里把两个探针文件**建完又删了**——生产者在轮结束时比对工作区快照，看到
的净变化是零，于是**不追加任何事件**。证据是硬的：会话日志里 `workspace/changes` 最后一条是
`turn 33`，而插件加载之后**再没有过一次追加**——插件在场期间这条路径**一次都没被行使**。

**因此探针的规矩是两条**：① 写在**未被 git 忽略**的路径（例如仓库根下的 `witness-probe-a.txt`）；
② **创建之后留在盘上**，等到该轮结束（生产者在这一刻比对快照并追加事件），**下一轮再清理**。
清理那一轮自身也会产生一次追加（一次删除），那同样是有效观测。

**附带的产品结论**：插件在场期间从未发生过一次 `workspace/changes` 追加，所以「订阅能不能收到」
这件事**至今未被行使**——不是证伪，是未测。`witness-seam available=true` 只证明 `ctx.get` 拿得到
服务，**不能**当作「订阅接通」的凭据。

**gitignore 那条仍是真实的产品局限，不只是探针技巧**：GAC 的**事后观测层对 git 忽略的路径是盲的**
（构建产物、缓存、`.dsh/` 下的运行时状态都在此列）。**事前拦截不受影响**——结构化写入的路径检查与
gitignore 无关，盲的只是第二层。已记进 README 的「已知局限」。

## 1. 前置（在**切换之后**的会话里做）

| 检查 | 怎么看 | 通过的样子 |
| --- | --- | --- |
| 宿主真的跑在 validation profile | `$DSH_HOME/gac-runtime-report.jsonl` 尾部 | 切换后出现新的 `plugin-loaded` |
| 插件在该 profile 里是启用的 | `npm run plugin:status`（带 `DSH_PROFILE_DIR`） | 报告的是 `.../gac-verify/cordis.patch.yml`，状态「已开启」 |
| **生产者真的在场** | 同上报告的 `witness-seam` 一行 | `available: true`（**这是 AC1 的判据**，不是猜的） |
| 会话的模型 provider 与日常一致 | 任意一次子会话派遣的返回文本 | 出现 `；路由 …` 行且与日常相同（未声明 `role_routes` 时**不出现**该行 = 继承父会话） |

启用/关闭插件（在仓库里执行）：

```powershell
$env:DSH_PROFILE_DIR = "$env:DSH_HOME\profiles\gac-verify"
npm run plugin:status   # 先看它报告的是哪个 profile
npm run plugin:on       # 只为了这次验收
# …… 验收结束后
npm run plugin:off
```

## 2. 用例 A：范围内写入 → `in_scope` 命中（AC2、AC3、AC6）

1. `gac_task action:"create"`，`task_id:"REQ-WIT-A"`，`mode:"standard_task"`，一个节点
   `I1`：`required_capabilities:["implementation"]`，**`write_scope:["witness-probe-a.txt"]`**
   （**未被 git 忽略的路径**，见 §0.5），objective 写「用 write 创建 `witness-probe-a.txt`，内容写 ok」。
2. `advance` → 子会话被**绑定**写作用域、写出该文件。
3. 断言：
   - 加载报告里出现 `witness-turn`（带 `coverage` 字段）；
   - 证据日志里出现一条 `tool`/`source` 为 `workspace-changes` 的记录，其 `workspace.in_scope` 含
     `witness-probe-a.txt`、`out_of_scope` 为空；
   - `governing_session_id` 是该子会话自己（它自己声明了作用域），`task_id`/`node_id` 齐全。
4. **用完删除该文件**（否则它会被 `git status` 看到）。

## 3. 用例 B：**间接写入** → `out_of_scope` 命中（AC4、AC5、AC7）

**场景必须选对，而第一轮的写法是错的。** 三种看起来可行、实际都不行的写法：

| 写法 | 为什么不行 |
| --- | --- |
| 父会话在作用域下跑生成器 | 作用域生效期间 **shell 被整体拒绝**，命令根本跑不起来 |
| 未被绑定的子会话（`write_scope: []`）跑脚本 | 它的派遣文本写死「本节点不得写任何文件」，**子会话会正确地拒绝**（第一轮实测：V1 报告「目标与授权冲突，我在会话内部无权扩权」并阻塞） |
| 往被 git 忽略的路径写 | 生产者按 `check-ignore` 过滤，**连事件都不产生**（§0.5） |

**能走通的写法是「作用域声明之前就已经启动的进程」**——它正是第二层存在的理由：门禁是按**工具调用**
生效的，不是按进程（README 已知局限 2），一个先跑起来的进程不会被之后声明的作用域约束。

1. **先**（还没有任何作用域时）用 `pwsh` 起一个后台作业：
   `Start-Sleep -Seconds 15; Set-Content -Path witness-probe-b.txt -Value x`
   （`run_in_background: true`，拿到 job id）。此时父会话的 shell 可用。
2. **紧接着**用 `gac_scope` 声明 `write_scope:["witness-probe-a.txt"]`——父会话自己的 shell 从此被拒，
   但**第 1 步那个进程照跑**。
3. 等 20 秒以上（不要用 shell 等，它在作用域下被拒；用 `job_output` 或干脆再走一轮）。
4. 用 `read` 确认 `witness-probe-b.txt` **确实存在**（`read` 属于只读工具，作用域下允许）。
5. 断言（这就是整条链的证明）：
   - 加载报告出现 `witness-out-of-scope`（`files` ≥ 1）；
   - 证据记录里 `workspace.out_of_scope` 含 `witness-probe-b.txt`，
     `governing_session_id` 是**父会话**（它就是声明作用域的那个会话），`task_id`/`node_id` 来自那份声明；
   - 该证据按 `isPassingEvidence(...)` 判定为**不可用**，理由里带越界数量（AC7）；
   - 盘上那个文件确实存在（证明这是「观测到了真实落盘」，不是纸面推断）。
6. **用完删除两个探针文件**（先 `gac_scope clear` 释放作用域，再用 shell 删）。
     `governing_session_id` 是**父会话**（子会话借用了先代的作用域），`task_id`/`node_id` 来自那份声明；
   - 该证据 `isPassingEvidence(...)` 判定为 **不可用**，理由里带越界数量（AC7）；
   - 盘上那个文件**确实存在**（证明这是「观测到了真实落盘」，不是纸面推断）。

## 4. 用例 C：降级路径（在实验室里做，进日常之后就没法做了）

把 producer 从 `gac-verify/package.json` 的 `bundles` 里**临时**去掉、重载宿主，然后断言：

- 插件**照常加载**，写作用域闸门、角色收权、协调器、原生子会话**照常工作**（§11）；
- 加载报告里 `witness-seam: available: false`——**降级可见**，不是「没有 Witness 但看起来一切正常」（§12）；
- `gac_metrics` 里这一层显示为不可用，而不是显示「零越界」。

验完把 bundle 加回去并重载。**这一步只有在 validation profile 里好做**：进了日常 profile 之后，
要么就得动生产配置，要么就永远不验。

**`gac_metrics` 目前只显示「工作区观测 N 轮（越界改动 M 个）」——缺一个「不可用」状态**：源不在时
`N=0` 与「真的没有观测」在读数上分不开。这是 AC 之外的一条真缺口，本轮先记在这里。

## 5. 第 4 轮：**通过**（2026-10-06，validation profile）

前三轮全都没跑通，而且前三次的失败**各自指向了不同的错因**——这正是活体验收不可替代的地方：

| 轮次 | 表现 | 真因 |
| --- | --- | --- |
| 1 | 插件侧 0 条 witness 记录 | 探针写在 `.dsh/gac/local/`，**被 gitignore** → 生产者按 `check-ignore` 过滤 → 无事件 |
| 2 | 仍然 0 条 | 探针**同一轮内建完又删** → 净变化为零 → 生产者不追加 |
| 3 | 仍然 0 条 | 探针跑在**子会话**里，而生产者 `eligible()` **只记录根会话**（`origin === "subagent"` 直接排除） |
| 4 | **通了** | 前三轮之外还有一条真缺陷：**摘要读得太早**（见下），修完才通 |

**第 4 轮实测到的顺序竞态（已修，提交 `f589bde`）**：生产者先
`session.append("workspace/changes", …)`（`append` **同步**发布 `session/event`）、**再**把摘要按
`event.seq` 存进自己的记录表。本插件的处理函数跑在两者之间，于是**每一次**同步读到的都是空——
字节级证据：会话日志里 seq 8560 的 `workspace/changes` 确实存在（turn 35），而加载报告对**同一个
seq** 记的是 `witness-summary-missing`。修法是先同步试一次、没有再**有界地**让出几步重读。

**第 4 轮的逐字结果**（根会话声明 `write_scope:["witness-probe-a.txt"]`；`witness-probe-a.txt` 由
结构化 `write` 在范围内改；`witness-probe-b.txt` 由**作用域声明之前启动的进程**改，守卫从未见过它）：

```json
{"event":"witness-turn","turn":36,"listed":5,"total":5,"coverage":"complete","out_of_scope":4,"outside_project":0}
{"event":"witness-out-of-scope","turn":36,"files":4,"outside_project":0}
```

证据记录 `ev-1789` 的 `workspace` 载荷：

```json
{"turn":36,"listed":5,"total":5,"truncated":false,"coverage":"complete",
 "in_scope":["witness-probe-a.txt"],"in_scope_count":1,
 "out_of_scope":["lib/index.js","lib/workspace-witness.js","test/workspace-witness.test.js","witness-probe-b.txt"],
 "outside_project":[],"files_digest":"a5f9e1a0",
 "governing_session_id":"session-961bd12e-…","task_id":"REQ-WIT-D4","node_id":"REQ-WIT-D4"}
```

逐条对照：**范围内**只有那个在作用域下改的文件 ✓（AC3 要的正是这份**清单**，只有计数核不出来）；
**范围外**既包含那个「守卫看不见的进程」写出的文件、也包含同一轮里在声明作用域之前改掉的三个
真实源码/测试文件 ✓✓ ——**第二层抓到了事前拦截抓不到的东西**，这是整个 Witness 层存在的理由，现在
有了活体证据（AC4、AC5）；身份字段齐全（AC6）；`isPassingEvidence(ev-1789)` = **不可用**，理由
「这一轮有 4 个越界改动」（AC7），对照实验（只清空越界清单）立刻变可用，证明判定读的正是那个字段。

**仍未做的**：日常 profile 的安装与重跑（AC8、AC9）、降级用例 C。前者见 §6，后者可以**在切回日常
profile 时顺带做**——日常 profile 本来就没装生产者，切回去就是一次现成的降级现场：断言
`witness-seam: available: false` 且守卫照常工作，不必再改任何配置。

## 6. 通过之后

按同一份 `package.json` 的做法把 producer 装进**日常 profile**，在日常 profile 里**重跑同一组探针**
（AC8、AC9）——只在 validation profile 里成立的能力**不算支持**。重跑时要逐字记下四样东西（否则这轮
验收等于没做）：加载报告里的 `witness-turn` / `witness-out-of-scope` 行；证据记录（id + 整个
`workspace` 载荷）；`isPassingEvidence(...)` 的返回值；以及**验收前后各起一次会话、确认历史能打开**
（这是 §13 那场「会话历史打不开」事故的回归检查，AC10）。然后：

- 更新 README「生产能力契约」：工作区观测从「必需（validation profile 已活体验证）」改成
  「必需，已在日常 profile 启用」；
- 更新 `docs/CUTOVER.md` §5 的门槛表：`工作区观测 live` 改为 PASS；
- 删除或冻结 validation profile（它是实验室，不是第二个生产运行时）。
