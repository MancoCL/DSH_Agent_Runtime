# AGENTS.md

本仓库是 DSH 插件 `dsh-gac-runtime`。本文件只写**代理在本仓库提交时必须遵守的约定**；工程事实、
架构与分层边界见 `README.md` 与 `GAC-DSH-ADAPTATION-PLAN.md`。

口径来源：同机的车规工程 `00_GAC_Project` 在 `.claude/` 中固化的提交约定——根 `CLAUDE.md` §3、
`.claude/hooks/README.md`「提交与规范校验由 agent 自行执行」、`.claude/project/policy.json` 的
`checkpoint` 与 `authority.forbidden_command_substrings`——以及该工程在这些规则上踩过的坑
（记录在 `.claude/workflow/tasks/` 里）。本仓库 `.dsh/gac/project.json` 的 `checkpoint` 声明同一口径。

## 1. 提交信息格式

首行是主题行，空一行后写正文：

```text
feat(scope): 中文简述

第一段：改了什么行为、为什么、影响哪些场景。
第二段：需要时才加，同样一整段写在一行里。
```

- **主题行**：`type(scope): 中文简述`。type 取 `feat` / `fix` / `docs` / `refactor` / `test` /
  `chore` / `perf` / `build` / `ci`；scope 取本仓库的模块词，如 `scope`、`guard`、`adapter`、
  `tooling`、`docs`、`test`。简述用中文，只讲改了什么，不复述文件名。
- **正文**：写功能段落——改了什么行为、为什么、影响哪些场景。**不要逐文件罗列**，文件清单由
  `git show --stat` 给出。
- **段落内不折行**：一个段落写成一整行，不按列宽硬折行。折行位置不携带语义，只让 `git log` 变难读。
- **段间恰好一个空行**，主题行与正文之间也是恰好一个空行。
- **末尾不加署名行**：不写 `Co-Authored-By:`、`Generated with ...` 之类的尾注。

## 2. 提交纪律

- **只提交本任务负责的路径**：`git add <path>...` 逐条显式列出。
- **禁止 `git add .` / `git add -A` / `git add --all`**：会把其他会话或用户尚未提交的改动一起带走。
- **永不 `git push`，永不 `git commit --amend`**，不改写历史。
- 一个任务一提交；提交完成才算收口（本仓库 `.dsh/gac/project.json` 的
  `checkpoint.policy` 为 `required_per_task`）。

## 3. 写与复核提交信息时的坑

以下每条都是本仓库或来源工程实际踩过的：

- **提交后用 `git log -1 --format=%B` 逐行复核**段间空行与「末尾无署名行」。提交信息经过 heredoc、
  编辑器或写入工具时，段落之间的空行会被吞掉；复核是唯一能发现它的动作。
- **信息文件用本任务唯一的路径**，且放在仓库外或 `.gitignore` 覆盖的位置。两个会话共用同一个临时
  路径会把信息写串；本仓库历史上还发生过信息文件本身被提交（`.commitmsg`、`COMMIT_MSG_TMP.txt`），
  `.gitignore` 现已忽略 `.commitmsg`。
- **不写凭预估的计数**（测试数、断言数、文件数）。要写数字就从实际命令输出逐字复制；估出来的数字
  随提交固化后就改不掉（不能 amend）。
- **一处提交只描述它自己**：整个任务的过程总结留在任务记录里，提交信息只讲本提交的改动。

## 4. 收口自检

```bash
git show --stat HEAD        # 只含本任务的路径
git log -1 --format=%B      # 主题行格式、段间空行、末尾无署名行
git status --porcelain      # 不再有本任务的路径
```

`git status` 在并发会话的仓库里不会是空的：其他会话未提交的改动本来就留在工作区，这是正常的。
要断言的是**本任务的路径**已提交干净，且 `git show --stat HEAD` 里没有别人的文件。

## 5. 与运行时声明的关系

`.dsh/gac/project.json` 的 `checkpoint` 里同步声明了本节口径，让工程适配器自身描述提交约定。
该字段目前**没有代码消费**（`lib/` 只在适配器校验时放行 `checkpoint`，不读取其内容），所以它是
**约定，不是机器强制**：格式不达标不会被任何门禁拦下，只会在自检与后续会话的检查中暴露。
