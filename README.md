# 跨应用协作系统

运行在本机的 Codex / WorkBuddy 任务交接工作台。支持计划、实施、阻塞诊断、修订、人工接手与验收；任务数据保存在本地 SQLite，不接任何额外模型 API。

## 启动

需要 Node.js 24+，无需 npm install、Docker、云服务器或显卡。当前桌面客户端协作在 Windows 上验证；HTTP 服务与 MCP 桥使用 Node.js 运行。

```powershell
git clone https://github.com/hua1736463307-debug/cross-app-collaboration.git
cd cross-app-collaboration
npm start
```

浏览器访问 http://127.0.0.1:4318 。首次启动自动创建本地 data 目录、数据库和应用令牌，默认没有项目或任务；GitHub 仓库不携带任何现有任务数据或客户端登录配置。

双击 **启动系统.cmd**，随后浏览器打开 http://127.0.0.1:4318 。服务在后台运行，日志位于 data/server.out.log 与 data/server.err.log。

也可在此目录打开终端执行：

```powershell
node src/server.mjs
```

前台运行时 Ctrl+C 停止服务。后台运行的服务可在任务管理器核对 data/server.lock 内的 PID 后结束对应进程；结束前请先停止客户端的相关工作。重新启动时，未交接的活跃任务进入“需要人工处理”，不会自动重复执行。

## 第一次使用

1. 在“项目目录”中添加真实项目的绝对目录。平台仅记录目录，不自动改动文件。
2. 在“任务工作台”中新建任务，写清目标、范围和验收标准。
3. 在“应用接入”中查看当前实例的 MCP 接入信息，添加到对应应用。
4. 在 Codex 内要求调用 list_tasks、claim_task。保存 **本轮返回的 leaseId**，阅读任务单后制定计划，并用 taskId、leaseId、plan 调用 submit_plan。
5. 在 WorkBuddy 内领取 ready 任务，保存该轮新返回的 leaseId。每个实施步骤前显式调用 heartbeat(taskId, leaseId) 检查暂停状态；阻塞时停止相关工作并 report_blocked；完成后停止相关写入与子任务并 submit_result。
6. 问题回到 Codex 诊断；超过修复轮数则转人工。人工可以确认停止后指定 Codex 接手。每次重新领取都会产生新租约，不能继续使用上一轮 leaseId。
7. 实施结果只进入“待验收”，检查成果后在工作台填写验收说明。

## Codex 接入

Codex CLI 原生配置使用 TOML，不要把通用 mcpServers JSON 直接粘贴进 config.toml。推荐复制工作台“应用接入”页生成的 **Codex 命令**，其中包含当前实例的 Node 绝对路径、桥脚本、HUB_URL、HUB_DATA_DIR 和角色参数，再按需要手动执行。

命令结构如下，尖括号内容仅解释结构，不是可直接运行的命令：

```text
codex mcp add cross-app-codex --env 'HUB_URL=<当前实例地址>' --env 'HUB_DATA_DIR=<当前实例数据目录>' -- '<Node 绝对路径>' '<桥脚本绝对路径>' '--actor' 'codex'
```

不要只复制默认端口的简化命令去接入另一个实例；HUB_URL 与 HUB_DATA_DIR 必须配套。若桌面应用和 CLI 使用不同配置目录，需在实际桌面设置中核对。添加后可能需要打开新会话或重新载入 MCP。

接入配置需要在每台电脑上分别安装。保存配置后，在目标 Codex 对话中主动要求调用 list_tasks / get_task，确认当前聊天能读取协作系统；配置存在、后台桥在线和当前聊天可以调用工具是不同的检查项。完整验收流程见 [验收指南](docs/acceptance-guide.md)。

## WorkBuddy 接入

在当前版本的连接器 / MCP 设置中添加自定义 stdio 服务。使用工作台“应用接入”页的 WorkBuddy JSON 配置，其中 command 指向本机 Node，args 指向 src/mcp.mjs 并带 --actor workbuddy，env 中保留当前实例的 HUB_URL 与 HUB_DATA_DIR。不要把 WorkBuddy 与 WorkBuddy AI 的配置和历史目录混用。

本项目的客户端实测针对 WorkBuddy 国内版。正常信任并启用后，应显示八个工具；还需通过真实对话领取和回传任务，才能确认协作链路可用。不同客户端版本的设置入口可能不同，以实际应用为准。

## MCP 0.2 的租约与暂停规则

- claim_task 成功后返回 taskId 所对应的 **leaseId**。客户端必须保存并在本轮所有任务级提交中显式填写。
- submit_plan、report_blocked、submit_result、acknowledge_pause 均须提供 taskId 与 leaseId。任务级 heartbeat 也须同时提供这两项；heartbeat({}) 仅更新桥连接时间，不能代表检查了某项任务的暂停状态。
- 桥内部的租约缓存只用于自动心跳，**不会替工具调用补齐 leaseId**。同一个客户端的多个聊天可能共享 MCP 桥；共享桥不等于独立聊天，更不能借用其他聊天的租约。
- 每个实施步骤前显式检查 heartbeat 返回的 pauseRequested。自动心跳只能证明桥仍连接，不能证明模型推进了工作，也不能保证模型已收到暂停提示。
- 收到暂停请求后，先停止相关文件写入与子任务，再调用 acknowledge_pause(taskId, leaseId, summary)。平台不会替你杀进程。
- 成功 submit_plan、report_blocked、submit_result 或 acknowledge_pause 后，该轮交接已经结束。之后要继续执行，必须符合当前状态并重新领取，不能重放旧租约。

调用示例中的 TASK_ID 与 LEASE_ID 应替换为当前任务和本轮领取结果：

```json
{
  "taskId": "TASK_ID",
  "leaseId": "LEASE_ID"
}
```

以上是任务级 heartbeat 的参数。提交计划时增加 plan，提交结果或阻塞时增加 summary 与 evidence，确认暂停时增加 summary。

## 取消、断连与协议兼容

- 请求尚未派发到本地 HTTP 服务前，取消会阻止它执行。
- 请求已经派发后，取消或超时**不能保证操作被撤销**。不能把“聊天取消”视作“提交一定没发生”；重新连接后先 get_task 核对最终状态，再决定下一步，避免盲目重复提交或领取。
- stdin EOF / 连接关闭会丢弃尚未派发的排队操作，但不会自动释放已领取的租约。已经派发的操作仍可能生效；结果不确定时也先核对任务状态。
- MCP 桥 serverInfo 版本为 0.2.0；支持协商 2024-11-05、2025-03-26、2025-06-18 协议版本。先完成单条 initialize 握手，再发送工具调用。
- 批量请求只接受已协商的 2024-11-05 / 2025-03-26 版本；2025-06-18 不接受批处理。批次中仍按队列执行，不能据此推断并行工作。

## 能力与边界

- 支持真实 SQLite 持久化、HTTP 工作台、stdio MCP 八个工具及本地交接。
- 开发期间验证过人为发起的一轮最小真实模型交接：Codex CLI 出计划，WorkBuddy 国内版实施并提交到 review；Codex 桌面对话也验证过只读任务查询。这些结果不保证其他电脑已接入，也不代表复杂项目、真实客户端阻塞/暂停回环或全自动桌面调度已通过。
- **不会自动唤醒或遥控任意已有桌面聊天。** 需要先在客户端发起协作，客户端才能主动领取和回传。自动调度入口属于后续接入工作。
- “最近在线”只表示 MCP 桥在最近90秒内有活动，不能证明模型正在推理或任务有进展。
- 暂停是协作请求，不是杀进程。执行端确认停止后才释放协调占用；默认90秒未确认转人工，并保留占用。
- 同一项目或重叠目录不允许通过系统重复领取；系统不能阻止两边绕过平台直接写同一文件。
- 工作台按本机同一用户信任边界运行。MCP 不提供人工验收工具，但拥有本机 shell 的程序并不受“真实人工身份”隔离；x-hub-ui 是防跨站标记，非独立权限系统。
- 只监听 127.0.0.1，不向公网发布。模型推理仍遵循各应用的联网和数据策略。
- 不自动执行验收命令，不会把客户端提交的测试文本当作平台已经验证。
- 本版不保存完整项目代码快照，也不替代 Git。建议每次交接记录提交号或变更文件，并保存测试结果。

## 数据与备份

- data/hub.sqlite：项目、任务、事件及连接时间。
- data/codex.token、data/workbuddy.token：本地应用身份令牌，不是模型 API Key；不要公开。
- data/server.lock：服务实例锁，防止两个服务同时操作同一数据目录。
- 停止服务后备份整个 data 目录；服务运行时不要只复制主 sqlite 文件而漏掉 WAL。
- 接入配置只给出令牌文件所在目录，不在页面展示令牌内容。
- HUB_PORT / HUB_DATA_DIR 可用于独立部署；MCP 的 HUB_URL / HUB_DATA_DIR 必须对应同一实例。
- 双击启动器固定使用默认端口 4318 和项目内 data 目录。运行自定义实例时，设置环境变量后直接执行 `node src/server.mjs`。

## 验证

```powershell
node --test test/hub.test.mjs test/mcp.test.mjs
```

测试覆盖状态流转、租约/角色、同目录与嵌套目录互斥、暂停确认、失联与重启恢复、反复阻塞转人工、HTTP 跨站拒绝、真实 MCP 子进程通过 HTTP 访问 SQLite 的双角色交接。测试使用隔离临时目录，不向正式看板注入示例任务。

也可以运行 `npm test` 执行全部测试。程序回归与真实客户端验收需要分别记录；请按 [验收指南](docs/acceptance-guide.md) 检查当前电脑和实际任务。不要用协议测试通过推定真实客户端已完成任务。

## 只读接入诊断

```powershell
node scripts/check-integrations.mjs
node scripts/check-integrations.mjs --help
```

使用非默认本机地址时可传 --hub-url，并确保 HUB_DATA_DIR 指向同一实例。诊断只读取目标配置、桥文件和本地状态，输出脱敏JSON；不运行模型、不发心跳、不改任务或配置，不读取auth、trust、令牌文件，不访问WorkBuddy AI或外网。

总ok与退出码仅依据配置及服务检查：退出0表示这些检查通过，退出1表示存在配置或服务问题。近期桥活动单独通过allClientsRecentlyActive等信息展示；闲置或退出的桥不会仅因心跳不活跃使配置诊断失败。心跳信息不代表模型有进展，此诊断不能代替真实任务验收。

## 辅助配置脚本

推荐使用“应用接入”页的命令完成安装。`scripts/install-codex-mcp.py` 是可选的增量配置辅助工具，需要 Python 3.11+ 和已经存在的 Codex config.toml；它只适用于本项目默认的 `127.0.0.1:4318` 与项目内 data 目录。

不带参数时只检查并输出计划；显式添加 `--apply` 才会备份原文件并追加本项目配置。同名配置不一致时停止，不覆盖原配置。使用自定义端口或数据目录时，请使用工作台生成的配置。

## 开源许可

Copyright (c) 2026 術の虎

本项目采用 GNU Affero General Public License v3.0（仅第 3 版，SPDX：`AGPL-3.0-only`），完整条款见 [LICENSE](LICENSE)。

- 允许使用、修改和商业使用；本项目不附加禁止商用的限制。
- 再分发本项目或其受协议覆盖的修改版本时，应遵守 AGPL-3.0 的许可及对应源码提供要求，并保留适用的原始版权、许可和免责声明；修改版本应按协议标明修改。
- 如果修改本项目并通过计算机网络供用户远程交互，应按协议第 13 条向这些用户提供获取该修改版本对应源码的机会。
- 仅在本地私下修改并不意味着必须向全网公开源码，也不要求将修改提交回本仓库。
- 第三方组件仍受其各自许可证约束。本项目按现状提供，不提供协议所排除的担保。

以上为便于理解的说明，具体权利与义务以 LICENSE 全文为准。

## 目录

- public/：中文工作台，无外部前端依赖。
- src/store.mjs：SQLite 持久化与状态机。
- src/server.mjs：本机 HTTP API。
- src/mcp.mjs：标准 stdio MCP 桥。
- test/：协议和状态机回归测试。
- scripts/check-integrations.mjs：只读、脱敏的本地接入诊断。
- scripts/install-codex-mcp.py：可选的默认实例 Codex 配置辅助工具。
- docs/acceptance-guide.md：可复用的客户端与任务验收步骤。
- CONTRACT.md：HTTP / MCP 接口与状态流转约定。

运行数据、令牌、日志、备份、本机安装回执及开发实施记录保留在本地，由 .gitignore 排除。提交前可用 `git status --short` 检查文件范围；发布截图或诊断输出前也应移除本机路径与任务内容。
