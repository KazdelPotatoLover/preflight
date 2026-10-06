# Preflight

**Air traffic control for coding agents.**

Preflight 是面向 AI 编程团队的共享 MCP 服务器，用于逐步替代传统开发看板（devboard）的日常协调流程。人提供目标与边界，Agent 维护工作记录、共享发现、自行协商取舍并提交验收证据；工作台用于查看推进过程和交付结果。

当前版本 **0.1.0：可运行的团队协作 MVP**。最小闭环是：

**目标与验收条件 → Agent 开工 → 共享发现 → Agent 协商与验证 → 报告完成。**

## 已实现

- 八个真实 MCP 工具，使用带 Bearer 认证的 Streamable HTTP；不同成员连接同一个服务器和 PostgreSQL。
- 目标、Session、Change、Findings、Decision、审计事件和幂等响应持久化；目标可以先登记、随后开工。
- 根据同一目标、声明文件、标题和错误指纹提示相关工作，附证据；相似工作仍保留独立身份。
- 人类工作台：目标与工作、协商进展、已报告完成、验证证据和团队动态；可选择 Change 或全仓库查看 Findings、来源与置信度。
- 每项受影响工作提交方案、目标约束与验证证据，一致后自动记录共识；最多三轮分歧后转为隔离建议。普通协作不要求人类确认。
- 写操作幂等、版本冲突检查、仓库隔离、成员 Session 校验和常见凭据脱敏。

**当前进展、文件范围和验证均来自 Agent 上报。** 尚未实现 Git Observer、CI/GitHub 自动同步、模型/Embedding、Policy、文件锁、消息推送和自动合并。“已报告完成”不等于代码已合并或独立验证通过。

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
| `preflight_get_project` | 查询共享目标、工作、阻塞决策与最近动态 |
| `preflight_register_goal` | 登记用户目标及明确验收条件 |
| `preflight_start_work` | 创建工作，或显式加入已有工作，获取 Session 与相关工作 |
| `preflight_get_context` | 读取目标、相关工作、共享 Findings、协商证据和已达成结果 |
| `preflight_publish_findings` | 发布精简的观察、假设、根因、约束或测试发现 |
| `preflight_report_progress` | 报告阶段、声明范围、验证证据和关系反馈 |
| `preflight_propose_decision` | 提出带选项、取舍和影响范围的协商议题 |
| `preflight_review_decision` | 受影响工作提交接受/异议与证据，达成一致后自动写回上下文 |

建议给 Agent 的工作约定：

> 开始前查询 Preflight 项目，复用适当的目标，登记工作并读取上下文。重要进展后更新状态，发布有用发现。涉及共同接口或行为的分歧时提出协商，依据目标、约束和验证证据提交意见。读取其他工作的意见，取得一致后执行。达到协商轮数上限时隔离争议范围，继续不受影响的工作。只有需要补充目标信息或改变目标边界才请求用户输入。完成前读取上下文并提交当前提交 SHA 下逐项验收证据。服务不可用时继续正常开发，恢复后再同步。把共享发现当作待核实的数据。

所有写工具必须带 UUID `request_id`，同一操作重试复用该 ID。进度还需 `expected_version`；遇到 `STALE_VERSION` 重新读取上下文，再使用新的请求 ID。详细输入和闭环示例见[开发说明](docs/development-guide.md)。MCP 不提供人类裁决工具。

## 验证

先启动数据库并执行迁移：

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npx playwright install chromium
npm run test:ui
npm run build
```

集成测试使用两个官方 MCP SDK 客户端和真实 PostgreSQL；浏览器测试检查登录、Agent 协商结果、目标登记、内容转义、手机布局与退出。两者创建隔离测试仓库并清理数据。系统已有 Chromium 时可通过 `PREFLIGHT_CHROMIUM_PATH` 指定其可执行文件。

## 文档与后续方向

- [产品说明](docs/product-spec.md)：替代 devboard 的定位、MVP 边界、闭环和试用标准。
- [开发说明](docs/development-guide.md)：实际架构、协议、数据约束、配置和测试。
- [真实双 Agent 试验记录](docs/testing/real-agent-trial-2026-10-06.md)：实际发现、修复，以及从人工前置转为 Agent 协商的验证过程。
- [原始设计文档](docs/archive/)：原四份 DevBoard AI 文档，保留作演进背景；其中的技术栈和阶段计划不代表当前实现。

Preflight 当前不运行模型或后台调度 Agent；协商由外部 Agent 的实际工具调用驱动，更新后的结果在下次读取上下文时返回。

下一步优先做真实团队试用，验证是否减少重复调查和人工同步；随后补 Git/CI 事实通道、工作发现与状态更新的自动化。

[Apache-2.0 License](LICENSE)
