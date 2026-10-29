# CodeBuddy 原生隔离交付说明

本机 Windows 原生执行链已接入正式调度入口。executor=codebuddy 使用独立宿主与原生沙箱，不再使用旧的 headless CLI 执行路径。WorkBuddy 桌面手动 MCP 接入保持独立。

## 使用方式

1. 在“自动协作”页明确填写 CodeBuddy 模型，或在任务中覆盖。未选择模型会停止，不会使用客户端默认模型、自动更换模型或降低强度。
2. 任务详情“调整执行目录”可选择已有的项目内目录，默认所属项目目录。桌面 create_planned_task 可传 sandboxDirectory 指定更窄的目录；计划文字不会扩大边界。
3. 开启任务自动协作和全局调度。范围内正常文件操作与沙箱命令自动执行；成果进入待验收，由人工确认。
4. 客户端要求工具审批时，工作台顶部显示工具、参数及“仅允许本次 / 拒绝”。允许本次不会解除沙箱边界；拒绝、超时或撤回自动授权会停止自动流转。
5. 越界时宿主中断并转人工核对，不反复重试。确认进程退出后，在执行记录释放预约；在任务详情确认原执行停止并重新安排，再调整目录、重新授权执行。新范围只影响下一次派发。

当前仅支持项目内目录授权。跨项目操作请另建任务；网络默认阻断，尚不提供按域名扩大网络权限的按钮。工具审批不能代替网络或目录授权。

## 边界与记录

- 每次派发固定模型、强度和执行目录；运行中的会话不受设置变更影响。
- 执行记录分别展示请求配置、客户端报告配置和本轮目录；未回报的强度显示“未确认”。
- 工作台数据目录、工作目录中的凭据/配置目录及 .env* 不随普通目录授权开放。
- Node、Git、Windows 及语言资源仅提供运行所需的只读例外，不提供整盘写权限。
- 文件、命令、网络三组规则均显式构造；禁止无沙箱命令与排除命令，沙箱启动失败直接退出。
- 不叠加项目或用户客户端 settings 的权限，不加载其他 MCP/插件，不启用子代理或后台团队。
- 服务断开时控制管道关闭并中断查询；未确认结束的任务保留人工核对状态，不恢复旧审批或自动重放。
- 这是 CodeBuddy Windows 原生后端，不是虚拟机。验收覆盖具体文件读写、junction 和 HTTP 探针，不代表所有协议和所有 Windows 行为都已验证。

## 本机验收（2026-10-28，洛杉矶时间）

真实调用均使用用户在工作台保存的 deepseek-v4.1-flash，客户端报告与请求一致，没有选择替代模型。

| 检查 | 结果 |
| --- | --- |
| 派发 → MCP 领取/心跳 → Node JSON 断言 → 提交 | 通过，任务 review，执行 finished |
| Chrome 页面允许 Read → 实际内容 → MCP 提交 | 通过，读到标记，任务 review |
| 页面拒绝 Read | 通过，没有获得内容，未换工具读取 |
| 窄目录外写入 | 通过，EPERM，文件不变，中断转人工 |
| 页面授权扩大测试目录 → 同计划重试 | 通过，新旧目录快照保留，写入/独立断言/提交成功 |
| 内置 Write 工具越界 | 通过，Sandbox rule denied writing，文件不变 |
| junction 越界 | 通过，读写拦截，目标不变 |
| HTTP 网络探针 | 沙箱外对照可达，沙箱内阻断，服务命中 0 |
| 沙箱后端缺失 | 通过，退出 1，明确拒绝无沙箱回退 |
| 等待审批时撤回自动授权 | 通过，管道关闭并中断真实宿主，转人工且没有提交成果 |
| 自动化回归 | 75 项通过，0 失败 |

本地服务已通过退出接口与 Start.ps1 重新启动。新实例为 `5a1356a4e8b9f2c0`，页面显示“CodeBuddy 原生沙箱独立会话”；任务与模型设置和重启前逐项一致。数据库与源码哈希记录位于 `.qa/native-delivery-release-1793248888328/`；源码修改前备份位于 `.qa/native-delivery-baseline/`。没有恢复原阻塞任务、自动验收或推送 GitHub。

本机原始证据保存在 .qa/native-sandbox-probe/，不上传 GitHub：delivery-e2e.log、approval-ui-second.log、approval-ui-denied.log、scope-ui-final.log、file-tool-events.log、failure-final.txt、revoke-e2e.log、regression-delivery.txt。

## 安装与登录

已验收版本：CodeBuddy Code 2.177.1、官方 Agent SDK 0.3.294。其他版本明确报错，升级需重新验收。

```powershell
node scripts/setup-native-codebuddy.mjs
node scripts/login-codebuddy-host.mjs
```

安装脚本固定版本、不执行包安装脚本、不改写现有启动器配置。官方 SDK 国内站鉴权复用 CLI 登录，需要时打开浏览器登录；无需 API Key，不把令牌写入工作台配置。保留 data/launchers.json 的 executor=codebuddy 和正确 CLI 路径。旧 Configure-CodeBuddyHost.ps1 是早期 API Key 路线遗留工具，本交付不使用。

## 修复原因

早期只设置 sandbox.enabled，没有显式设置 query.sandboxEnabled；orderedRules 缺少 command/network 组，客户端加载失败可能使用默认规则。现补齐三组规则、显式启用原生沙箱、固定验收版本，并通过真实命令验证。
