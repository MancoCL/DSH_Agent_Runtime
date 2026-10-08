# PTC 内层调用真实验收配方

用途：在 DSH 的实际 PTC 模式下验证**外层 `run_code` 传输放行，内层每次工具调用仍受 GAC Guard**。PTC 是可选执行方式，不是切旧 Runtime 的必需条件；本机 2026-10-06 曾真实通过，升级内核后应重新测，而不是默认照搬旧结论。

## 前提

- 当前会话呈现的工具面应是 `run_code` + 生成 SDK。若仍看到原生 `write`、`pwsh`、`read` 等，不要把原生工具测试当作 PTC 内层测试。
- DSH Profile 加载了 GAC 且报告有 `plugin-loaded`；实际 SDK 调用形状以**当前模型提示里的 SDK** 为准，下例仅示意。
- 使用专用测试项目的未占用路径，确认 `ptc-probe-ok.txt` 和 `ptc-probe-bad.txt` 原先均不存在。

## 真实验证步骤

1. **声明范围**：通过 PTC 内层 `gac_scope` 为测试会话声明 `["ptc-probe-ok.txt"]`，预期允许。
2. **范围内写入**：内层 `write({file_path:"ptc-probe-ok.txt",content:"ok"})`，预期允许，文件确实存在。
3. **范围外写入**：内层 `write({file_path:"ptc-probe-bad.txt",content:"bad"})`，预期 `GAC_WRITE_SCOPE_DENIED`，文件确实不存在；**外层 `run_code` 不应因此被整体拒绝**。
4. **内层 Shell**：作用域仍在时调用 `pwsh`，预期按当前 Shell 策略返回 `GAC_SHELL_DENIED_UNDER_SCOPE`。
5. **释放与清理**：内层 `gac_scope({task_id:"REQ-PTC-PROBE",clear:true})`，确认释放；之后再安全删除范围内测试文件。

## 通过标准

必须有真实的 `run_code` 外层返回、每次内层工具结果、两个稳定拒绝码、scope 声明/释放响应和磁盘上的存在/不存在检查。至少证明**每个内层原生调用均走了 pre-execute**，而非仅看到代码执行完成。

若 PTC Provider 或实际模式缺席，标记 **Not applicable**，不算 GAC 缺失；如果在场却发生越界放行，按真实安全失败处理。历史误判（“run_code 没显示所以 PTC 没安装”）已被宿主实际加载结构否定，详见 ADR §19 和 [CUTOVER](CUTOVER.md)。
