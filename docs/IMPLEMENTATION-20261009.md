# 默认直接编辑与受控协作实施记录

本轮固定顺序为 S0 基线 → S1 模式授权 → S2 任务与权限 → S3 验证输入及证据 → S4 异步派遣 → S5 专家助手 → S6 回归与宿主验收。每步独立本地提交，不推送、不发布 npm。

## 代码实施

| 步骤 | 本地提交 | 行为 |
| --- | --- | --- |
| S0 | `9459dd8` | 经用户确认保存原有七个文件的基线 |
| S1 | `38564da` | begin/assess/request_upgrade/end；默认 direct，明确宿主问答授权升级 |
| S2 | `dfb05ed` | 任务绑定操作、模式与所有者；standard 独立验证与收口门禁 |
| S3 | `27dca93` | 真实工程输入、TAP 逐项证据、最新结果及完整工程指纹 |
| S4 | `e260cf3` | 派遣立即返回、后台串行结算、取消、中断恢复与持久化通知 |
| S5 | `9640ee3` | 有效设计专家的一层只读助手、盲化、预算与父生命周期 |

工程通过 `verification_context` 声明测试入口、命令、能力、限制与环境身份。不得填入不存在的能力；环境身份应随工具链或依赖变化而更新。工程文件指纹不覆盖 `.git/`、`.dsh/`、`node_modules/`；外部环境必须由声明身份区分。遇到符号链接、扫描超过上限或读取失败，不复用验证。

普通目标先 `gac_project begin`，再 `assess` 登记 change_kind、behavior_summary 和 target_paths。非代码、注释、普通局部改动直接完成，不创建 Task。仅复杂非核心工作提议 standard；仅影响整个项目核心行为的改动提议 high_risk。目录命中不会自动升级。request_upgrade 必须取得宿主问答明确同意；拒绝或评估换版后无 Task 授权。

standard 的实现由 Builder 完成，Verifier 依赖全部实现节点；涉及测试写入时另设 Test Builder。high_risk 保留四类设计、设计包批准、独立实施、验证及复核。主会话自报验证不能替代当前 attempt 的独立报告。

advance 返回 awaiting_results 后等待宿主通知，不用 sleep 或轮询。后台结算先核对最新 dispatch_id、attempt 和设计身份，再写语义产物及任务。重启后遗留 in_progress 标记为中断失败，不假装子会话仍在运行。通知进入 GAC 本地账本，交付使用有稳定消息身份的原生 steer/followup；不向 Host Session Log 写自定义事件。

gac_expert start/status 仅供有效直属 software_design、test_design、verification_design 专家使用。固定 root=0、专家=1、助手=2；同时最多 2 个，每次父派遣累计最多 4 次。助手无写入、审批、任务创建/收口及再次委派权；盲化角色的助手不能读实现。助手只通知父专家，父专家综合后交付最终产物。

## 宿主验收状态与执行路径

S6 代码侧回归：1515 项测试通过，包括注册入口贯通的模式授权、后台派遣、逐项 Evidence 和独立收口。安装面及 Host Session 完整性测试包含在全仓测试中。真实宿主 E1—E7 尚未执行。

目标 Profile 已由用户确认为 `core-020`。只读 deploy:status 核查表明依赖与锁文件均为 GitHub v0.1.1，真实模块落点不在开发工作区，模式 NORMAL，宿主正在运行。工具对非本地包的旧警告不能据此解释为源码链接。本轮尚未切换 Profile、启动源码验收或发布不可变包。代码测试与模拟宿主接线不等于真实 E2E。真实外部核心业务验收需求仍待用户提供。

取得真实需求后按以下顺序执行，任一步失败都不发布：

1. 确认代码已提交且工作区干净，执行 npm test 和 deploy:status，核实实际 Profile 与插件落点。
2. 彻底退出 DSH，设置目标 Profile，执行 deploy:validate -- --apply --confirm-verify。
3. 重启 DSH，执行下面全部场景并保留真实 Evidence、会话及加载报告。验收期间不改源码。
4. 全部通过后再次退出 DSH，以真实 Evidence ID 执行 deploy:publish -- --apply --confirmed-pass --evidence；复查 deploy:status 后重启核对加载报告。
5. 任一场景失败，退出 DSH，执行 deploy:restore -- --apply，复查安装落点；修复代码后重新开始验收。

| 场景 | 必须证明 |
| --- | --- |
| E1 普通非代码、注释、局部 bug | direct；0 Task、0 child、无升级提问 |
| E2 高风险目录只读及注释 | 不升级，读写范围正确 |
| E3 复杂非核心业务 | 同意前无 Task/派遣；同意后 standard；拒绝不执行 |
| E4 真实核心业务变更 | high_risk 全设计、批准、Builder、验证、复核和真实交付 |
| E5 快慢子任务及失败 | 各自及时结算和通知，不等待整批、不轮询 |
| E6 专家助手 | 一层成功、下一层拒绝、权限盲化与取消回收成立 |
| E7 重启、重复通知、旧 attempt、设计换版 | 不重复结算、不伪造完成、不接受跨版本结果 |

未执行的场景不能标记通过；历史 REQ-HR-5 不能代替本轮验收。未测得性能收益不填写百分比。日常 Profile 只能使用已验收、带 Git SHA 的不可变本地包。
