# Phase 0 验证：门禁真的会在执行之前就拒绝吗？

整个 GAC 架构都压在一个尚未被证实的假设上：DSH 插件能否在越界写入**发生之前**就把它拦下。
下面这套流程就是用来给出定论的。请在一次重启之后运行它，因为 harness 监视的是配置而不是模块
文件，否则它仍然在跑一个更旧的构建。

如果这套流程失败，后面的一切都不重要——不要在它之上搭建 coordinator。

---

## Step 0 —— 插件已加载，并带上了它的作用域来源

```powershell
Get-Content "$env:USERPROFILE\.dsh\gac-runtime-report.jsonl" -Encoding UTF8 | Select-Object -Last 3
```

应当看到一条 `plugin-loaded` 记录，其 `scope_tool` 为 `registered`，且 `enforcement` 为
`生效中 —— 已声明的写作用域会在派遣前强制执行`：

```jsonc
{"event":"plugin-loaded","services":{"tools":true,"sessions":true},
 "scope_tool":"registered",
 "scope_tool_note":"可以声明执行模式、写作用域、任务 DAG、证据清单与带证据的指标；派遣会真正路由并调用",
 "enforcement":"生效中 —— 已声明的写作用域会在派遣前强制执行"}
```

如果 `scope_tool` 是 `unavailable` 或 `failed`，门禁虽然装上了，但没有任何会话能被管辖。
`scope_tool_note` 字段会说明原因。**就此停下**——这套流程的其余部分不可能通过。

同时确认上一轮运行的计数器，它们证明拦截确实在生效：

```jsonc
{"event":"plugin-unloaded","observed":{"calls":17,"denials":0}}
```

`observed.calls` 统计门禁看到过的每一次工具调用。上一轮卸载时的计数非零，说明这个 hook 真的在
流水线里，而不只是被注册了。

---

## Step 1 —— 声明一个写作用域

写作用域是**按会话**的。在这里声明它不会影响任何其它会话，这也是这一步可以在一个正在使用的
GUI 里安全运行的原因。

```text
gac_scope { task_id: "REQ-VERIFY-1", scope: ["docs/scratch.md"] }
```

应当看到一份点名 `docs/scratch.md` 的摘要。如果找不到这个工具，说明 Step 0 失败了，或者并没有
重启。

---

## Step 2 —— 拒绝（这才是真正的测试）

让 agent 去写一个已声明作用域之外的文件：

```text
写这两个文件：
  1. docs/scratch.md        （作用域之内）
  2. docs/outside.md        （作用域之外）
```

预期：`docs/scratch.md` 被创建；对 `docs/outside.md` 的写入被拒绝，并且这条拒绝信息会点名已
声明的作用域：

```text
GAC: 任务 REQ-VERIFY-1 的节点 REQ-VERIFY-1 只能写入 [docs/scratch.md]。
"docs/outside.md" 在该作用域之外（已声明的写作用域为 [docs/scratch.md]）。
```

从报告里确认这次拒绝已被记录：

```powershell
Get-Content "$env:USERPROFILE\.dsh\gac-runtime-report.jsonl" -Encoding UTF8 |
  Select-String 'guard-denied' | Select-Object -Last 3
```

```jsonc
{"event":"guard-denied","tool":"write","code":"GAC_WRITE_SCOPE_DENIED", ...}
```

**决定性检查**：`docs/outside.md` 在磁盘上必须**不存在**。一个拒绝了却仍然把文件写出来的门禁，
是事后观察，而不是执行前的拦截；那将意味着要把强制执行挪到 `fs/write-intent`
（一个无法拒绝的接缝——适配方案 §7，边界 3）。

```powershell
Test-Path docs/outside.md     # must be False
```

---

## Step 3 —— shell 拒绝

在作用域仍然生效时：

```text
运行这个：echo test > docs/shell-mark.md
```

预期：以 `GAC_SHELL_DENIED_UNDER_SCOPE` 被拒绝。这是诚实的边界，不是 bug：命令字符串里的重定向
目标无法被工具流水线的门禁看到，所以门禁直接拒绝这一整类，而不是假装检查过了。

---

## Step 4 —— 呈现路径的围堵（大纲 §21）

用一个裸文件名重新声明，并确认别名绕过已被封住：

```text
gac_scope { task_id: "REQ-VERIFY-2", scope: ["mod.c"] }
```

然后尝试写入 `./mod.c`（允许）、`sub/mod.c`（拒绝）与 `SRC/MOD.C`（拒绝——大小写折叠）。
`sub/mod.c` 必须没有被创建。

---

## Step 5 —— 释放作用域，并确认会话重新回到无管辖状态

```text
gac_scope { clear: true }
```

然后再做一次越界写入。这次它应当成功，因为默认情况下没有会话被管辖。这一步和拒绝那一步同样
重要：它证明门禁不会干扰已声明任务之外的普通工作。

---

## 记录结果

结果应当落到仓库里，而不只是留在对话里。用通过与未通过的项目更新 `README.md` 里的状态表，并
记下任何「明明拒绝了却还是产生了文件」的情况——那是唯一会推翻本方案的结果，绝不能被粉饰过去。

---

## 如果它失败了

| 症状 | 可能原因 |
| --- | --- |
| 找不到 `gac_scope` | 插件没有被重新加载（需要重启），或者 Step 0 报告了 `unavailable` |
| 已声明作用域之后写入仍然成功 | 门禁不在派遣路径上；检查 `observed.calls` 是否在增长 |
| 出现了拒绝，但文件存在 | 强制执行是事后的，不是执行前的——设计需要重新审视 |
| `scope_tool: unavailable` | 从链接安装里无法解析 `@deepseek-ai/dsh-tools`；见 `lib/resolve-dsh.js` |
| 每一次写入都被拒绝 | 作用域被声明成了 `[]`，或者更早的 `task_id` 仍然生效——用 `gac_scope {}` 检查 |
