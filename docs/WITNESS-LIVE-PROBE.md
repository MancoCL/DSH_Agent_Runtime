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

## 2. 用例 A：范围内写入 → `in_scope` 命中（AC3、AC6）

1. `gac_task action:"create"`，`task_id:"REQ-WIT-A"`，`mode:"standard_task"`，一个节点
   `I1`：`required_capabilities:["implementation"]`，`write_scope:[".dsh/gac/local/wit-a.txt"]`。
2. `advance` → 子会话被**绑定**写作用域、写出该文件。
3. 断言：
   - 加载报告里出现 `witness-turn`（`coverage` 字段）；
   - 证据日志里出现一条 `source: workspace` 的记录，其 `workspace.in_scope` 含
     `.dsh/gac/local/wit-a.txt`、`out_of_scope` 为空；
   - `governing_session_id` 是该子会话自己（它自己声明了作用域），`task_id`/`node_id` 齐全。

## 3. 用例 B：**间接写入** → `out_of_scope` 命中（AC4、AC5、AC7）

**这一步的关键在于场景选对。** 不能用「父会话在作用域下跑一个生成器」——**作用域生效期间 shell 被
整体拒绝**，那条路在设计上就走不通。正确的场景是「**未被绑定的只读子会话**跑受控脚本」：

1. 父会话用 `gac_scope` 声明 `write_scope:[".dsh/gac/local/allowed.txt"]`（父会话自己的 shell 从此被拒）。
2. `gac_task action:"create"`，`task_id:"REQ-WIT-B"`，`mode:"standard_task"`，一个节点
   `V1`：`required_capabilities:["verification"]`，**`write_scope: []`**（→ 不被绑定 → shell 可用），
   objective 写死一句话：「用 pwsh 执行 `New-Item -ItemType File -Path .dsh/gac/local/denied-by-witness.txt -Force`，
   然后把退出码原样回报；不要做别的事」。
3. `advance` → 子会话跑脚本，文件落在父会话作用域**之外**。
4. 断言（这就是整条链的证明）：
   - 加载报告出现 `witness-out-of-scope`（`files` ≥ 1）；
   - 证据记录里 `workspace.out_of_scope` 含 `.dsh/gac/local/denied-by-witness.txt`，
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

## 5. 记录什么（否则这轮验收等于没做）

- 每条断言的**逐字**证据：加载报告行、证据记录（id + `workspace` 字段）、`isPassingEvidence` 的返回值；
- 用例 B 里那个越界文件在盘上的存在性；
- 用例 C 里「守卫仍工作」的具体一次拒绝（工具名 + 拒因原文）；
- **宿主是否被插件重载破坏**：验收前后各起一次会话，确认历史可打开（这是 §13 那场事故的回归检查，AC10）。

## 6. 通过之后

按同一份 `package.json` 的做法把 producer 装进**日常 profile**，在日常 profile 里**重跑同一组探针**
（AC8、AC9）——只在 validation profile 里成立的能力**不算支持**。然后：

- 更新 README「生产能力契约」：工作区观测从「必需（待装）」改成「必需，已在日常 profile 启用」；
- 更新 `docs/CUTOVER.md` §5 的门槛表：`工作区观测 live` 改为 PASS；
- 删除或冻结 validation profile（它是实验室，不是第二个生产运行时）。
