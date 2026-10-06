# Witness 活体验收探针（validation profile）

**这份文档是可执行的验收依据，不是说明文。** 目标：证明
`Workspace Changes Producer → workspace/changes → GAC Witness → EvidenceLog`
这条链在**真实会话**里成立——而不是只证明 `ctx.get("workspaceChanges") !== undefined`。

**为什么需要它**：工作区观测是生产纵深防御层（见 README「生产能力契约」），它覆盖事前拦截够不着的
那一类落盘（shell 重定向、生成器、外部进程、间接写入）。它缺席时，「没有越界写入」这句话无从成立。
**它进入日常 profile 之前，旧运行时不能切。**

## 0. validation profile（2026-10-06 建好、预检、**用完后已删除**）——**它其实没有必要存在**

```text
~/.dsh/profiles/gac-verify/    ← 已删除；机器上现在只有 core-020 与 tauri
├─ package.json          与 core-020 同构，外加一条**多余**的 link: 依赖（见下）
├─ cordis.yml            []（树由 bundles + patch 组合）
├─ cordis.patch.yml      与 core-020 逐字节一致（插件开关就在里面）
├─ pnpm-workspace.yaml   nodeLinker: hoisted
├─ pnpm-lock.yaml        pnpm install 生成
└─ node_modules/         含 @deepseek-ai/dsh-workspace-changes（profile 内 junction）
```

**为什么「多装 producer」这一步是多余的**：生产者**一直在场**——它不在任何 profile 自己的依赖里，却是
`dsh-web-app` 的 bundle patch 插入的一行（`cordis.patch.yml:339`），因此每个含 `dsh-web-app` 的 profile
（包括日常 profile）都有它。当时判「不在场」用的是**解析层**（profile 的 `package.json` 与提升
junction 集合），而正确的判据是**已加载树**：服务在不在（加载报告的 `witness-seam` 一行）、事件来不来
（`workspace/changes` 有没有被追加）。两者给出的是相反答案——日常 profile 里 `witness-seam available=true`
且历史里早有 56 条 `workspace/changes`，那就是它一直在场的证据。

**所以这个 profile 的用途已经被日常 profile 直接取代**（见 §5），验收做完即删（见 §6）。当时的安装方式
本身是正规的：`link:` 依赖写进该 profile 的 `package.json` + 加进 `dsh.profile.bundles` + 在该目录
`pnpm install`（`link:` 不需要网络），**不是**手工往被提升的 `profiles/node_modules` 里塞 junction。

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

## 4. 用例 C：降级路径（**待办**，一条命令 + 重启）

**做法已经具体了**，而且**不必动 `package.json`**：生产者那一行是 `dsh-web-app` 的 bundle patch 插入的，
而 profile 自己的 `cordis.patch.yml` **在 bundles 之后应用**（`cordis.yml` 的文件头写着这个顺序：
bundles → `cordis.patch.yml` → overlays）。所以在那份 patch 末尾加两行就能把它关掉：

```yaml
- id: workspace-changes
  disabled: true
```

然后**重启宿主**（bundle 组合在启动时读，热应用不可靠——见 `AGENTS.md` §0 实测的三种情形），断言：

- 插件**照常加载**，写作用域闸门、角色收权、协调器、原生子会话**照常工作**（§11）——具体做法：声明一个
  写作用域，再让一个范围外的结构化写入被拒，逐字抄下拒因；
- 加载报告里 `witness-seam: available: false`——**降级可见**，不是「没有 Witness 但看起来一切正常」（§12）；
- **本仓库声明的能力会因此报缺项**：`capability-check` 一行里 `missing` 含 `workspace_observation`，
  且 `high_risk_task` 收口会被 `GAC_COMPLETION_CAPABILITY_MISSING` 拒（除非显式 `capability_ack`）。
  这一条是 `docs/ADR-0001-子会话执行载体.md` §20 那套机制在**真实降级现场**的验收；
- `gac_metrics` 里这一层显示为**不可用**，而不是显示「零越界」——**已经做了**：指标工具拿到「观测源
  此刻在不在」这个环境事实，源缺席时不再报那串 0，而是说「**工作区观测不可用**（观测源不在场）：这一层
  是惰性的，因此「0 轮」读不出任何东西」。三态：`true` 在场、`false` 不在场、`undefined` 没被告知
  （报告那时说「观测源是否在场未被告知」，而不是替它宣称可用）。

验完把那两行删掉并重启。**这一步在实验室（临时 profile）里做**：在日常 profile 里动它，等于拿生产配置
做实验。

### 4.1 结果：**五条全过**（2026-10-06，实验室 profile `gac-verify`）

实验室与日常**逐字节同构**，唯一差异是 patch 末尾那两行把 `workspace-changes` 关掉；`package.json`
的依赖列表与日常完全一致（不再像上一版那样多装一个包——那次是错的，生产者本来就在场）。

| 断言 | 逐字结果 |
| --- | --- |
| 插件照常加载 | `plugin-loaded`，`registered_tools = ["gac_project","gac_scope","gac_task","gac_metrics","gac_evidence"]` |
| 降级可见 | `witness-seam available=false`（`child-dispatch-seam available=true` 照旧） |
| 守卫照常工作 | 范围外结构化写入被逐字拒绝：`GAC: 任务 REQ-WIT-DEGRADE 的节点 REQ-WIT-DEGRADE 只能写入 [witness-probe-a.txt]。…在该作用域之外` |
| 能力契约报缺项 | `capability-check` 的 `missing = ["workspace_observation"]`、`ok = false` |
| 高风险收口被拒 | 拒因逐字到达模型：「…但本工程声明需要的能力里缺了：**工作区观测（纵深防御层）**（…「没有越界写入」无从成立）。**缺的是结论的凭据**，所以不能收口…」；带 `capability_ack` 后该门禁放行（拒绝理由变成「节点未完成」） |
| ⑥ 指标说不可用 | 「**工作区观测不可用**（观测源不在场）：这一层是惰性的，因此「0 轮」读不出任何东西…」 |
| 豁免可审计 | `gac_task action:"audit"` 里逐字出现：「收口时接受了能力缺口（workspace_observation）：…这不是缺口，是有意接受的条件。」 |

**这一轮还抓到四条只有活体能发现的缺陷**（全部「单测全绿而线上是坏的」，修复见提交 `8987dd1`）：

1. 指标里的 `available: undefined` **不是合法 JSON** → 宿主把整份指标判成 `value is not lossless JSON`；
2. `observationAvailableFor` 被转发给了 `gac_evidence` 而不是 `gac_metrics`（两处注册的参数形状一样，改错了地方）→ 指标说「观测源是否在场未被告知」；
3. 能力门禁的拒因带了 `missing_capabilities` 而输出 schema 没声明 → **模型看到的是校验错误，而不是「缺了什么、为什么不能收口」**（与 schema 注释里记的 `plan_id` 那次同一个坑）；
4. `gacEventLogFor` 定义在 `apply` 里、却在 `registerTools` 里被引用 → `audit` 动作抛「未定义」；修完又露出第二层——`audit` 的整份返回都没在 schema 里声明（`nodes` 还被声明成字符串数组而它返回对象），所以 **`audit` 从来就没能用过**。

四条盲区是同一个形状：**测试用的是透传的 `defineTool`，不做输出校验；传的是假依赖，接线断没断看不出来**。
所以钉子都改打在「真正注册的那一份」上，并加了一条**通用**的 schema 一致性断言（把 `status`/`list`/
`audit`/`advance`/`complete` 五个动作的返回逐字段逐类型对着 `output.schema` 核一遍）——这一类坑已经
踩了三次，通用断言比单点补丁更值得。

**它目前只有单测覆盖**（`test/workspace-witness.test.js`：服务缺席时插件照常加载、`witness-seam` 记
`available: false`、闸门仍在；`test/capabilities.test.js` 与 `test/tool-task.test.js`：缺项拒绝收口、
显式豁免可过）。原先打算「切回日常 profile 就是现成的降级现场」——**那个做法不成立**，因为生产者本来
就在日常 profile 里。

**`gac_metrics` 的「不可用」状态已补**（2026-10-06）：源缺席时不再报那串 0，而是说清「这一层是惰性的，
因此 0 读不出任何东西」；`available` 是三态，没被告知时不宣称可用。断言在 `test/evidence.test.js`
（观测源不在场 / 在场 / 没被告知三种读法），并用突变检查确认：去掉不可用分支或不再转发那个环境事实，
3 条相关测试里 2 条立刻红。

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

## 6. 日常 profile 重跑：**通过**（2026-10-06）

**这一步不需要安装任何东西**——生产者本来就在日常 profile 里（§0）。切回 `core-020` 之后，同一套探针
直接重跑（`write_scope:["witness-probe-a.txt"]` 声明在根会话；`witness-probe-a.txt` 由结构化 `write`
在范围内创建；`witness-probe-b.txt` 由**作用域声明之前启动的后台进程**创建）：

```json
{"event":"witness-turn","turn":38,"listed":2,"total":2,"coverage":"complete","out_of_scope":1,"outside_project":0}
{"event":"witness-out-of-scope","turn":38,"files":1,"outside_project":0}
```

证据 `ev-1820` 的 `workspace` 载荷：

```json
{"turn":38,"listed":2,"total":2,"truncated":false,"coverage":"complete",
 "in_scope":["witness-probe-a.txt"],"in_scope_count":1,
 "out_of_scope":["witness-probe-b.txt"],"outside_project":[],"files_digest":"d31c36a0",
 "governing_session_id":"session-961bd12e-…","task_id":"REQ-WIT-DAILY","node_id":"REQ-WIT-DAILY"}
```

一次**干净的两文件探针**：范围内的那个、范围外的那个，各归各位 ✓ ——AC8、AC9 在日常 profile 通过。
（`ev-1789` 是更丰富的一例：越界 4 个，含三个真实源码文件，`isPassingEvidence` 判为不可用。）

**AC10（会话历史未被破坏）的活体核对**：扫全部 101 个会话日志文件，插件自有事件类型共 97 条、涉及
23 个会话，**全部带 `ignorable` 标记**（可读），最新一条是 2026-10-05T13:16:29Z（早于本轮工作）；
**当前会话里 0 条**。那 97 条就是 AGENTS.md §0 记的历史事故与修复，不是新损害。

**仍未做的**：降级用例 C。做法**已经变了**：原计划是「切回日常 profile 就是现成的降级现场」，而生产者
本来就在日常 profile 里，所以现成的降级现场**不存在**——要验就得把生产者从某个 profile 的
`dsh.profile.bundles` 里摘掉再重启。**它目前只有单测覆盖**（`test/workspace-witness.test.js`：服务缺席
时插件照常加载、`witness-seam` 记 `available: false`、闸门仍在）。要做活体版就得改配置 + 重启，
因此列为待办而不是已验。

## 7. 收尾

- README「生产能力契约」与 `docs/CUTOVER.md` §5 的门槛表都已更新为**日常 profile PASS**；
- **validation profile 已无用途**（它存在的唯一理由是装生产者，而那一步是多余的）：验收做完即删。
  删它还有一个更重要的好处——它把一个**与日常不同**的 profile 从机器上移除，「验收一个运行时、运行
  另一个运行时」的隐患随之消失。
