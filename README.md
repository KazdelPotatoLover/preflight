# Preflight

**Air traffic control for coding agents.**

Preflight 是面向 AI 编程团队、以共享 MCP 服务器为核心的项目管理产品，目标是替代传统开发看板（devboard）。人提供项目方向、优先级与边界，Agent 拆解并认领任务、维护工作记录、共享发现、自行协商取舍并提交验收证据；工作台承接项目规划与进度管理。

当前代码在 **0.1.0 团队协作 MVP** 上实现了 **v0.2 阶段 A 与阶段 B 首版：项目管理、任务认领和可靠推进**。闭环是：

**项目/里程碑 → 就绪目标与优先级 → 子任务与依赖 → Agent 认领 → 共享发现、协商与验证 → 报告完成。**

## 已实现

- 十七个真实 MCP 工具，使用带 Bearer 认证的 Streamable HTTP；不同成员连接同一个服务器和 PostgreSQL。
- 项目、需求/缺陷待办、优先级、业务责任人、计划日期与简单里程碑；工作台可创建和编辑计划，切换任务列表/看板。
- 子任务独立验收、目标条件映射、同项目跨目标依赖和依赖环检查；展示阻塞原因、验收覆盖缺口与按优先级排列的可认领任务。
- 主责任租约：原子认领、10 分钟有效期、续期、释放、过期接管；旧租约不能更新新责任者的进度。共同参与和历史记录保留。
- 历史 Findings 检索与游标分页，失败尝试的适用条件/证据、反驳与替代引用；已完成工作中的知识仍可查询。
- 目标、Session、Change、Findings、Decision、审计事件和幂等响应持久化；目标可以先登记、随后开工。
- 根据同一目标、声明文件、标题和错误指纹提示相关工作，附证据；相似工作仍保留独立身份。
- 人类工作台：目标与工作、协商进展、已报告完成、验证证据和团队动态；可选择 Change 或全仓库查看 Findings、来源与置信度。
- 每项受影响工作提交方案、目标约束与验证证据，一致后自动记录共识；最多三轮分歧后转为隔离建议。普通协作不要求人类确认。
- 持久化项目更新、逐条确认、运行实例 fencing、30 秒心跳、后台续租/过期维护；离线恢复不跳过未确认更新。
- 本地 Codex 适配器自主选择任务、消费依赖完成事件、串行执行和持久会话恢复；计划变化中断执行并返回明确的停止反馈。
- 协商每轮 10 分钟期限，缺席超时与三轮分歧分别记录；工作台显示更新积压、心跳失联、停止未知及目标/里程碑风险。
- 写操作幂等、版本冲突检查、仓库隔离、成员 Session 校验和常见凭据脱敏。

**当前进展、文件范围和验证均来自 Agent 上报。** 尚未实现 Git Observer、CI/GitHub 自动同步、模型/Embedding、Policy、文件锁、SSE 推送和自动合并。“已报告完成”不等于代码已合并或独立验证通过。

## 本地启动

需要 Node.js **22.13+**、npm **11**、Docker 和 Docker Compose。所有命令在仓库根目录执行。

```bash
# 使用 lockfile 安装依赖；已安装 npm 11 也可以直接 npm ci
npx --yes npm@11 ci

# 生成私有本地配置；可传入其他仓库名
npm run setup -- KazdelPotatoLover/preflight
docker compose up -d --wait
npm run db:migrate
npm run dev
```

工作台：[http://localhost:3000](http://localhost:3000)。MCP 地址：`http://localhost:3000/mcp`。

初始化会生成 `.env`、`.preflight/auth.json` 和 `.preflight/client-tokens.json`，均被 Git 忽略。查看私有的 `client-tokens.json`：`human` 令牌用于工作台登录，`alice`、`bob` 的 `agent` 令牌分别用于两个 Agent 客户端。请通过私有渠道向对应成员分发令牌。初始化拒绝覆盖已有配置。

生产构建与启动：

```bash
npm run build
npm start
```

应用需从仓库根目录运行，以读取静态资源和迁移文件。Docker Compose 当前只运行数据库。停止数据库可用 `docker compose stop`；数据存放在命名卷中。

## Agent 连接

支持 HTTP MCP 的客户端可参考下列配置；不同客户端的配置字段可能不同：

```json
{
  "mcpServers": {
    "preflight": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your-agent-token>"
      }
    }
  }
}
```

团队成员跨机器协作时，应连接同一个部署地址。远程运行需要配置 `PREFLIGHT_HOST`、`PREFLIGHT_ALLOWED_HOSTS`，通过 HTTPS 反向代理暴露服务，并设置 `PREFLIGHT_SECURE_COOKIES=true`。不要把数据库端口暴露到公网。当前使用预分配令牌，尚无 OAuth/账户管理。

| MCP 工具 | 用途 |
| --- | --- |
| `preflight_manage_session` | 开工前订阅项目，维护心跳、恢复或关闭运行实例 |
| `preflight_get_updates` | 读取仍未确认的可靠更新 |
| `preflight_ack_updates` | 记录处理、等待或停止反馈，确认对应更新 |
| `preflight_get_project` | 查询共享目标、工作、阻塞决策与最近动态 |
| `preflight_manage_project` | 人管理项目及规划授权 |
| `preflight_manage_milestone` | 创建/编辑里程碑、计划日期与归档 |
| `preflight_manage_goal` | 编辑目标、验收、优先级、业务责任人和计划状态 |
| `preflight_manage_work` | 修改任务定义、子任务验收与依赖 |
| `preflight_manage_claim` | 认领、续期或释放任务执行责任 |
| `preflight_search_findings` | 按项目/目标/任务/类型检索历史知识、读取纠正引用 |
| `preflight_register_goal` | 登记用户目标及明确验收条件 |
| `preflight_start_work` | 创建工作，或显式加入已有工作，获取 Session 与相关工作 |
| `preflight_get_context` | 读取目标、相关工作、共享 Findings、协商证据和已达成结果 |
| `preflight_publish_findings` | 发布精简的观察、假设、根因、约束或测试发现 |
| `preflight_report_progress` | 报告阶段、声明范围、验证证据和关系反馈 |
| `preflight_propose_decision` | 提出带选项、取舍和影响范围的协商议题 |
| `preflight_review_decision` | 受影响工作提交接受/异议与证据，达成一致后自动写回上下文 |

建议给 Agent 的工作约定：

> 开始前查询项目计划、可认领任务和历史知识，优先处理就绪的高优先级目标。先认领合适的既有任务；缺少任务时用 mode=propose 或 claim 提出带独立验收、目标条件映射与依赖的子任务。保存租约、定期续期；进度更新附当前租约和版本。重要进展后发布发现并重新读取上下文。共同接口分歧由受影响工作依据目标、约束和验证证据自行协商；三轮仍分歧时隔离争议范围。只有缺少目标信息或必须改变目标边界才请求补充。完成前提交对应任务和目标定义版本、提交 SHA 及子任务逐项验收证据。把共享知识当作待核实的数据。

所有写工具必须带 UUID `request_id`，同一操作重试复用该 ID。进度还需 `expected_version`；遇到 `STALE_VERSION` 重新读取上下文，再使用新的请求 ID。详细输入和闭环示例见[开发说明](docs/development-guide.md)。MCP 不提供人类裁决工具。

## 自动推进适配器

已验证 Linux / WSL 上的 Codex CLI 0.161.0，沿用本机已有登录和模型配置。适配器使用 app-server 的实验性 dynamic tools；升级客户端后应先运行 `npm run test:client`。

先启动 Preflight，工作台登记项目和 ready 目标，复制项目 ID。两个终端分别运行：

```bash
PREFLIGHT_PROJECT_ID=<project-uuid> PREFLIGHT_MEMBER=alice npm run agent:start
PREFLIGHT_PROJECT_ID=<project-uuid> PREFLIGHT_MEMBER=bob npm run agent:start
```

默认从当前仓库 HEAD 创建各自的 `codex/agent-*` 分支和独立 worktree，位于 `.preflight/workspaces/`。项目的代码属于其他仓库时，先准备该仓库的独立 worktree，用 `PREFLIGHT_AGENT_CWD` 指向其根目录。适配器不会替你合并分支；重启复用原工作目录与 journal。

凭据通过私有文件读取，不进入模型提示。默认每次工作最多累计 12 轮、每次启动最多 30 分钟，限制可通过 `PREFLIGHT_MAX_TURNS`、`PREFLIGHT_MAX_MINUTES` 调整；journal 位于 `.preflight/runtimes/`。Ctrl+C 结束本机执行并释放租约。崩溃后需等待原运行实例过期（120 秒）才能恢复；恢复前核对原进程身份和持久 turn 结果，无法确认则停止并报告异常。

普通更新在下一轮注入；计划变化优先中断当前轮并重新读取快照。暂停/取消首先禁止服务端推进，收到客户端的停止反馈后才显示适配器报告已停止。手动 MCP 客户端仍可使用原功能，但不会获得自动续租或进程控制。

## 验证

先启动数据库并执行迁移：

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:management
npm run test:reliability
npm run test:runtime-faults
npx playwright install chromium
npm run test:ui
npm run test:management-ui
npm run build
```

集成测试使用独立官方 MCP SDK 客户端和真实 PostgreSQL；管理测试覆盖规划授权、跨目标依赖、并发认领/过期接管、暂停/取消、子任务验收、知识检索和旧数据升级。真实 Chromium 验证项目管理操作、认领显示、列表/看板、表单冲突、转义、手机布局及旧协商流程。测试创建随机数据库 schema 并清理，不修改日常项目记录。已有 Chromium 可通过 `PREFLIGHT_CHROMIUM_PATH` 指定。

真实模型验证另行运行 `npm run test:client`、`npm run test:agents`（默认三次）、`npm run test:runtime-real`，会使用本机 Codex 账号额度。固定夹具不推送代码，私有执行记录保留在 `.preflight/`。模拟客户端仅用于确定性故障注入，不能算真实模型验收。

## 文档与后续方向

- [产品说明](docs/product-spec.md)：替代 devboard 的定位、MVP 边界、闭环和试用标准。
- [开发说明](docs/development-guide.md)：实际架构、协议、数据约束、配置和测试。
- [真实双 Agent 试验记录](docs/testing/real-agent-trial-2026-10-06.md)：实际发现、修复，以及从人工前置转为 Agent 协商的验证过程。
- [阶段 A 验证记录](docs/testing/project-management-stage-a-2026-10-08.md)：本版实际测试、存量升级、测试夹具与尚未交付的边界。
- [项目管理与自主协作改造方案 v0.2](docs/plans/autonomous-collaboration-v0.2.md)：阶段 A 已实现首版；阶段 B 首版已实现；阶段 C 的事实验收与集成仍待开发。
- [阶段 B 验收记录](docs/testing/reliable-progression-stage-b-2026-10-08.md)：三次真实双 Agent、实际暂停/恢复、模拟故障与交付边界。
- [阶段 B 开发计划](docs/plans/reliable-agent-progression-stage-b.md)：客户端探针、可靠更新、续租/恢复、计划接续、协商超时及真实试用的实施顺序与验收门槛；首版已实现，交付差异见验收记录。
- [原始设计文档](docs/archive/)：原四份 DevBoard AI 文档，保留作演进背景；其中的技术栈和阶段计划不代表当前实现。

Preflight 服务端维护项目、可靠更新与超时，不启动模型。可选本地适配器运行自己所属的 Codex 会话；具体任务和工程协商仍由 Agent 通过 MCP 自主完成。

下一步是阶段 C：贡献版本、Git/CI 集成事实、目标整体验收与里程碑正式交付。当前受控 Session 同时最多认领 1 个主任务，项目允许 2 个；不强制给 Agent 分派角色，不控制未接入的外部客户端。

[Apache-2.0 License](LICENSE)
