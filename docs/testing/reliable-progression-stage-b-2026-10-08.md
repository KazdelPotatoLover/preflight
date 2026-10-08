# 阶段 B 首版验收记录

日期：2026-10-08。基线 main `4334d4d`，本次实现项目可靠更新、本地 Codex 适配器、协商期限与管理风险视图。产品继续定位为替代 devboard 的共享 MCP 项目管理服务。所有模型测试运行在隔离目录和随机 PostgreSQL schema，未推送测试产物，不改变日常项目计划。

## 真实客户端能力

本机 Codex CLI 0.161.0，使用既有 ChatGPT 登录及默认模型配置。核验[官方 app-server 接口](https://learn.chatgpt.com/docs/app-server)及本机生成的实验性 JSON schema，然后运行 `npm run test:client`：真实模型启动、退出 app-server 后以 thread ID 恢复、新轮正确回忆前轮随机标记、实际命令开始后中断并观察 interrupted 完成均通过。

普通事件通过下一轮注入，未宣称推送进正在推理的上下文。首次立即中断曾返回 no active turn，探针改成等待实际 commandExecution 开始再验证，保留此失败原因。恢复不仅检查存储中含标记，还检查新模型答复确实包含标记。

本地私有结果：`.preflight/client-probe/result.json`。原始生成协议、线程 ID、journal 和账号配置不纳入 Git。

## 三次连续真实双 Agent

入口 `npm run test:agents`。每次两个同实现、不同成员、独立 Git 工作目录的实际 Codex 会话；一个项目、一个里程碑、两个不同优先级 Goal、三个预置但未指派的任务，其中一条跨 Goal 依赖。固定夹具明确 normalization 验收要求；预先建立任务属于测试准备，不宣称已验证从任意自然语言自行拆任务。

Agent 自己选择、原子认领、实现、提交证据。没有指定前端/后端角色，没有私下向 Agent 派任务或催下一步；验收器只观察完成、检查产物，并在全部目标报告完成后停止测试运行。

| 试验 | 完成时间（UTC） | 结果 |
| --- | --- | --- |
| 1 | 2026-10-08 08:35:35 | 两 Agent 均认领任务；2 Goal/3 Task 报告完成；下游引用上游实际 finding UUID/随机标记；真实 node 测试及额外输入检查通过 |
| 2 | 2026-10-08 08:38:43 | 相同验收通过，无分派/催办 |
| 3 | 2026-10-08 08:41:24 | 相同验收通过，无分派/催办 |

三次连续试验后，新增租约丢失停止保护和恢复结果核对，又运行一次完整双 Agent 回归通过。

连续试验前另有一次配置读取失败：Windows 挂载目录的 Codex config.toml 返回 No data available，记录在私有 failure.json；随后加入最多三次启动重试。之后先有一次单独完整试验通过，再运行上表三次。失败没有被记为成功或从记录中删除。

真实模型使用共享知识的证据：上游发布包含本次 fixture marker 的契约 finding，下游 finding 必须同时引用该真实 finding ID 和 marker；验收器直接运行生成的 normalize.test.mjs，并额外验证 trim、大小写、空串和全空格输入。两个 Agent 均有真实认领记录。三次是固定小规模可行性检查，不代表真实大项目收益、并行加速或统计结论。

私有汇总 `.preflight/agent-trials/report.json`；各次工作目录、Git 提交、journal、失败与结果分别保留在 `.preflight/agent-trials/`。测试数据库 schema 在 finally 清理。费用未提供，明确 unavailable；后续适配器在收到客户端 tokenUsage 时记录数值，不把 token 数换算为费用。

## 实际暂停、退出与恢复

`npm run test:runtime-real` 使用真实 Codex，在认领后启动真实 sleep 45。管理者修改 Goal 为 paused，适配器经可靠更新中断执行，观察 interrupted 完成，回写该计划版本的停止反馈并释放责任。任务保持未完成；不会把暂停视为任务完成。

新 app-server 进程恢复同一个 Session/thread，以新 epoch 继续读取暂停后的计划并进入等待。另以实际独立适配器进程测试空闲时 SIGKILL，再在隔离 schema 中缩短 heartbeat 期限模拟到期，恢复原 journal/thread，实例 epoch 递增。硬退出测试没有伪造模型执行结果；期限缩短是明确的故障注入，不宣称真实等待了 120 秒。硬退出发生在空闲期，未验证执行外部副作用中途被杀的普遍恢复能力。实际恢复到 epoch 4，客户端报告累计 totalTokens=174326（inputTokens=173614、outputTokens=712），费用不可获得。

私有结果 `.preflight/real-control/<run>/result.json`，包含实际 token 计数（可用时）和费用缺失标记。

## 确定性与浏览器验证

- `typecheck/lint/build` 与原 9 项单元测试；原 MCP 与阶段 A 管理集成回归。
- `test:reliability`：官方 SDK 发现 17 个工具；空 Session 订阅、重复/恢复投递、确认越权/仓库隔离；在业务写后注入 outbox 插入失败，整笔事务回滚；旧 runtime 的写入及缓存重放拒绝；容量、暂停反馈与独立 worker 的失联/租约/Decision 超时。
- `test:runtime-faults`：真实 PG、SDK 和本地子进程，**模型 transport 明确为模拟**；长推理不阻塞心跳/续租、暂停中断后的停止反馈、未完成保留、本地重复运行拒绝、同 Session/thread 恢复；丢失执行租约时中断推理并记录 error。
- 真实 Chromium：原协商与 Findings、项目计划/列表/看板/表单冲突/XSS/手机回归；新增积压、未确认停止与适配器停止反馈、心跳中断的未知状态、超时原因，以及目标/里程碑风险。

迁移新增 004，不修改 001～003；随机测试 schema 连续迁移两次，保留旧数据。日常数据库已升级到 004 并重启本机服务；升级前后均保留 1 Goal、2 Change、23 Finding、1 Decision，模型测试记录不写入公开项目。

## 此版的交付边界

已经把“查询项目后手工催 Agent 下一步”推进为受控本地会话自行消费计划与依赖变化。服务器仍只承接共享记录，适配器仅控制自己所属的会话。手动/未接入客户端仍需自行读取和续租，不能被描述为已启用进程停止控制。

仍是 reported_completed 与 adapter_report。测试夹具的产物检查不等于产品已有通用 Git/CI 事实验收或正式里程碑交付。阶段 C 仍需贡献版本、集成、固定验证集、Goal 整体验收与正式交付/返工。

相对原 B 计划，此首版使用一个增量迁移；更新按未确认集合读取而没有 cursor/attempt/backoff 字段；固定轮询没有 idle 退避/jitter；只有轮数、时长和有限启动重试预算，无法提供费用阻断；未知旧 turn 结果会拒绝重复执行。规模化分页、保留/清理策略、生产监控、更多客户端、任意任务拆解质量与持续真实项目试用仍未验收。这些限制不会自动升级成人工审批每项普通工程取舍。
