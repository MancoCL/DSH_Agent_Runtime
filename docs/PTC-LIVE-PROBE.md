# PTC 内层调用验收配方（自包含，任何会话可执行）

**这份文档是可执行的验收依据**，不是说明文。目标：证明**「放行外层传输 + 内层子调用按自己的名字受管」**
在真实 PTC 模式下成立——这是本项目**唯一还挂着「契约已核实、活体未做」**的能力。

**为什么必须验**：这条路径曾经被错误地收缩成「明确拒绝」（依据是一个假前提：以为日常 profile 不装 PTC
运行时），而 `dsh-base/cordis.patch.yml:390-391` 明确插入 `ptc-runtime` 与 `workflow-ptc`——**PTC 一直在场**，
`run_code` 只是只在 PTC 模式下才呈现给模型。那次收缩会打断 PTC 模式下声明了作用域的活能力，已撤回
（`docs/ADR-0001-子会话执行载体.md` §19）。**撤回之后它到底还能不能跑，只能由这份配方来回答。**

## 0. 前提（先确认，不确认就不要往下做）

| 检查 | 通过的样子 |
| --- | --- |
| 会话的 preset 是 `ptc` | 工具面里**只有 `run_code` 加一份生成的 SDK**（这是 PTC 模式的形状：`dsh-tools/README.md:64` 写着 `ptc` 模式下模型「only `run_code` plus a generated SDK」） |
| 若还看得到 `write`/`pwsh`/`read` 等**原生**工具 | **preset 没生效**：停下，如实报告，不要把原生工具的调用当成 PTC 的内层子调用（那是两件事） |
| SDK 的调用形态 | **以提示里那份生成的 SDK 为准**——下面的 `tools.<名字>(参数)` 只是占位写法，实际形态照它给的来 |
| 本插件处于启用状态 | 加载报告里有 `plugin-loaded`；`gac_scope` 能被 SDK 调到（它已注册） |

## 1. 五步

**第 1 步：声明写作用域**（只允许一个探针文件）。在代码里调：

```js
await tools.gac_scope({ task_id: 'REQ-PTC-PROBE', node_id: 'REQ-PTC-PROBE', scope: ['ptc-probe-ok.txt'] })
```

预期：返回「现在可以写入 [ptc-probe-ok.txt]」。**这一步本身就是一次内层子调用**，而 `gac_scope` 属于
运行时自己的记账工具（不碰产品文件），所以它**必须被放行**——否则作用域会变成一个自己解不开的陷阱
（本仓库在 `gac_scope` 上踩过这个形状）。

**第 2 步：范围内写入**（预期**放行**）：

```js
await tools.write({ file_path: 'ptc-probe-ok.txt', content: 'ok' })
```

**第 3 步：范围外写入**（预期**内层被拒**）：

```js
await tools.write({ file_path: 'ptc-probe-bad.txt', content: 'bad' })
```

预期：抛错或返回拒绝，原文含 `GAC_WRITE_SCOPE_DENIED` 与「只能写入 [ptc-probe-ok.txt]」。**关键**：被拒的是
**内层这一次子调用**，不是外层的 `run_code`——外层如果被拒，整段代码根本不会开始跑，那是「把通道关掉」，
不是更严的守卫。

**第 4 步：内层 shell**（预期**按 shell 拒**）：

```js
await tools.pwsh({ command: 'echo hi' })
```

预期：`GAC_SHELL_DENIED_UNDER_SCOPE`——作用域生效期间 shell 被整体拒绝，因为命令字符串里的重定向与生成
目标无法对照作用域检查。

**第 5 步：释放作用域并清理**：

```js
await tools.gac_scope({ task_id: 'REQ-PTC-PROBE', clear: true })
await tools.pwsh({ command: 'Remove-Item ptc-probe-ok.txt -ErrorAction SilentlyContinue' })
```

（清理必须在**释放作用域之后**：作用域还在时 shell 是被拒的。）

## 2. 必须记下来的东西（否则这轮验收等于没做）

- **外层 `run_code` 每次调用的返回**（逐字）——它必须是被**放行**的；
- **内层被拒的原文**（逐字），尤其是拒因里的工具名与作用域；
- 第 1 步与第 5 步 `gac_scope` 的返回（逐字）：它证明「运行时工具在内层也被放行」；
- 盘上事实：第 2 步的文件**存在**、第 3 步的文件**不存在**（用 SDK 里的读/探测工具确认）；
- 你的工具面里到底有哪些工具（这决定上面 §0 的前提成立与否）。

## 3. 通过之后

- 更新 `docs/CUTOVER.md` §4 的 PTC 那一行：把「活体仍未做」改成已验 + 逐字证据；
- 更新 `README.md` 已知局限第 6 条（那条现在写的是「这条保证若不成立，PTC 就成了绕过写作用域的通道」——
  验完之后要把「若」字去掉，或写明实测结果）；
- 在 `docs/ADR-0001-子会话执行载体.md` §19 里补一句实测结论（撤回是对的、且撤回后的行为已活体验证）。

## 4. 做不到就如实停下

任何一步与预期不符（尤其：**外层 `run_code` 被拒**、或**内层子调用根本没被检查**），都说明这条路径有
真问题。**不要**用「契约已核实 + 单测过了」把这一格写成已验——本轮已经反复吃过这个形状的亏：
`witness-seam available=true` 与「订阅接通」是两件事，`run_code` 不在工具面里与「PTC 不在场」也是两件事。
