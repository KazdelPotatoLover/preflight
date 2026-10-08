# Preflight 开发说明

> 当前实现：0.1.0 团队 MCP MVP + v0.2 阶段 A 与阶段 B 首版。更新日期：2026-10-08。
> 产品范围见[产品说明](product-spec.md)，安装命令见[README](../README.md)。

本文描述仓库当前实现。pnpm workspace、Next.js、Redis、Observer、SSE、Embedding 和 Policy 仍是演进候选。当前新增项目/里程碑、业务计划、独立子任务验收、依赖、主责任租约与历史检索，项目管理协议见第 13 节，可靠推进见第 14 节。

## 1. 架构与目录

Node.js 22.13+、TypeScript strict、Hono、官方 MCP SDK、Drizzle 和 PostgreSQL 16。依赖由 npm 11 与 `package-lock.json` 管理。一个应用进程同时服务人类工作台、REST 和 Streamable HTTP MCP；领域状态全部存入数据库。

```text
src/
  index.ts                  # 启动、配置、关闭
  app.ts                    # Hono、认证、同源与输入大小限制、静态资源
  config.ts                 # 凭据格式、令牌哈希认证、过期检查
  mcp/server.ts             # 十七个工具、SDK transport、结果与错误映射
  domain/
    contracts.ts            # Zod 契约、脱敏、稳定请求序列化
    service.ts              # 共享领域规则、事务、上下文与看板快照
    management.ts           # 规划、依赖、主责任租约和历史检索
    related.ts              # 确定性相关工作提示
  db/
    client.ts               # PostgreSQL 连接与 Drizzle
    schema.ts               # 数据模型
    migrate.ts              # 初始迁移入口
migrations/                 # 001 初始、002 协商、003 项目管理
public/                     # HTML、CSS、原生 JS 人类工作台
scripts/
  setup.mjs                 # 私有初始化
  integration.ts            # 两个真实 MCP 客户端的数据库集成测试
  browser.ts                # Chromium 工作台与协商结果测试
  management-integration.ts # MCP 管理/租约/依赖/升级测试
  management-browser.ts     # Chromium 项目管理测试
tests/                     # Vitest 契约、相关提示、脱敏和认证测试
```

REST 和 MCP 调用同一个 `CollaborationService`，不能在 transport 层重新实现身份、状态机或协商规则。静态工作台通过 REST 访问，不直接访问数据库。当前采用 10 秒轮询，表单编辑时暂停自动刷新。

## 2. 身份与接入

所有私有接口需要 `Authorization: Bearer <token>`，人类登录也可换取 HttpOnly、SameSite=Strict 的会话 Cookie。认证从服务端凭据派生 `{ member, role, repo }`，请求体不接受任意仓库身份。

`.preflight/auth.json` 的一条记录：

```json
{
  "member": "alice",
  "role": "agent",
  "repo": "KazdelPotatoLover/preflight",
  "token_hash": "<64-character-lowercase-sha256>",
  "expires_at": "2027-01-01T00:00:00.000Z"
}
```

令牌明文只在本地私有 `client-tokens.json` 和分发给客户端的配置中，认证文件只存 SHA-256。每次请求重新读取认证文件；删除记录或令牌过期立即失效，包括已登录工作台的 Cookie。初始化生成一个 human、两个不同成员的 agent，默认有效 90 天；过期后需生成新随机令牌并更新哈希、期限和客户端配置。没有自动续期或用户管理 UI。

`human` 管理项目和规划授权，维护目标/里程碑；项目授权的 Agent 也可维护规划，执行 Agent 可自行提出/认领任务。普通协商由参与 Agent 答复，只有 `needs_input` 可使用 human 补充接口。human 令牌不能交给 Agent；使用项目的 `planning_agents` 为 Agent 授权。MCP 不暴露人类裁决工具。

允许的 Host 来自 `PREFLIGHT_ALLOWED_HOSTS`。存在 Origin 时必须与请求 URL 同源；没有跨域开放访问。远程代理需正确保留公开 Host/协议，使服务器看到的 URL 与浏览器 Origin 一致；部署后必须验证登录和协商读取，不能通过放宽为任意 Origin 解决代理配置问题。

## 3. 传输与工具契约

`POST /mcp` 是无状态 Streamable HTTP endpoint。每个请求建立 SDK server/transport，业务 Session 存入 PostgreSQL，不使用 MCP 传输会话存业务数据。响应使用 JSON；不提供 SSE/GET 流，GET、DELETE 返回 405。客户端可发现十七个工具。

输入以 `src/domain/contracts.ts` 为准。字段长度、数组数量、UUID、URL 和枚举由 Zod 校验，顶层拒绝未知字段。所有写工具必须传 `request_id` UUID。

| 工具 | 必填业务输入 | 关键可选输入 |
| --- | --- | --- |
| `preflight_get_project` | 空对象 | `project_id` |
| `preflight_register_goal` | `title`、`objective`、`acceptance[]` | `project_id`、`milestone_id`、`plan_state`、`priority`、`owner`、`due_date`、`kind` |
| `preflight_start_work` | `goal_id`、`title`、`agent_type` | `mode`、`task_acceptance[]`、`goal_criteria_indices[]`、`depends_on_change_ids[]`，以及 `session_id`、`existing_change_id`、`likely_scope[]`、`branch`、`error_fingerprints[]` |
| `preflight_get_context` | `goal_id` 或 `change_id` + `session_id` | 开工前也可读目标上下文 |
| `preflight_report_progress` | `change_id`、`session_id`、`expected_version`、`status`、`summary` | 受管理任务还需 `lease_id,lease_epoch`；另有 `likely_scope[]`、`verification`、`feedback`、`pr_url` |
| `preflight_publish_findings` | `change_id`、`session_id`、`findings[]` | 无 |
| `preflight_propose_decision` | `change_id`、`session_id`、`question`、`context`、`category`、`urgency`、`options[]` | `recommendation`、`affected_change_ids[]`、`authority` |
| `preflight_review_decision` | `change_id`、`session_id`、`decision_id`、`expected_version`、`stance`、`rationale`、`evidence` | `option_id`（接受时必填） |

`likely_scope` 是仓库相对路径，不是已验证变更范围；拒绝绝对路径、`..`、`.env` 和 PEM 路径。`pr_url` 仅接受 HTTPS，服务器不抓取或验证 PR。Findings 类型为 `observation | hypothesis | root_cause | constraint | test_result | failed_attempt | patch_summary`，含 content、置信度与第 13 节的条件/证据/纠正字段。

决策类别为 `public_api_behavior | database_schema | auth_security | product_behavior | architecture_boundary | unknown`，紧迫程度为 `blocking | normal | low`。选项 2～5 个，具有唯一 `label`、`description`、可选 `pros[]` 与 `cons[]`。`recommendation` 如提供，必须是其中一个 label。

MCP 成功响应同时带文本内容和 `structuredContent`：

```json
{
  "data": { "...": "tool-specific result" },
  "meta": { "source": "preflight", "repo": "KazdelPotatoLover/preflight" }
}
```

领域错误返回 `isError: true`，文本内容为 `{ "error": { "code": "...", "message": "..." } }`。不要把错误响应当作成功上报；数据库失败没有离线待同步缓存。Agent 可以继续正常开发，恢复后使用同一请求 ID 重试尚未确认的写操作。

## 4. 旧模式兼容流程

以下示例保留默认项目中的旧调用方式，不需要租约。新项目必须使用受管理任务模式，见第 13 节；新客户端即使使用默认项目也应传 `mode`。

1. `preflight_get_project {}`，查找已有 Goal。没有适当目标时，调用 `preflight_register_goal`，保存 `goal.id`。
2. `preflight_start_work` 带该 Goal，保存 `session_id`、`change.id`、`change.version`。默认创建独立工作；只有确实要共同参与同一工作时才传 `existing_change_id`。
3. 调用 `preflight_get_context`，检查相关工作、Findings、协商事项与已达成结果和 `recommended_action`。
4. 报告 `implementing`，发布有用 Findings；重要进展后更新状态并再次读取上下文。
5. 共同取舍调用 `preflight_propose_decision`，每项受影响工作通过 `preflight_review_decision` 提交意见与目标/约束/验证证据。读取其他工作意见后进行下一轮或取得一致；结果进入共享上下文。三轮仍分歧则隔离争议范围，完成时提交隔离证据。只有真正目标信息/边界缺口才需要用户补充。普通 MCP 调用本身不唤醒模型；可选适配器通过可靠更新触发下一轮。
6. 报告 `verifying`，本地自行执行验证；用最新版本报告 `completed`，提交当前 SHA 和完整验收证据。

目标示例，所有 UUID 示例需要由客户端实际生成：

```json
{
  "request_id": "<fresh UUID>",
  "title": "修复登录超时",
  "objective": "保持公共接口兼容",
  "acceptance": ["相关测试通过", "公共接口行为保持不变"]
}
```

`preflight_report_progress` 的完成输入示例：

```json
{
  "request_id": "<fresh UUID>",
  "change_id": "<returned change ID>",
  "session_id": "<returned session ID>",
  "expected_version": 3,
  "status": "completed",
  "summary": "修复已实现，相关验证通过",
  "verification": {
    "head_sha": "0123456789abcdef0123456789abcdef01234567",
    "command": "npm test",
    "result": "passed",
    "criteria": [
      { "index": 0, "passed": true, "evidence": "相关用例全部通过" },
      { "index": 1, "passed": true, "evidence": "公共接口差异已检查，行为保持兼容" }
    ]
  }
}
```

`criteria.index` 从 0 开始，每项必须有通过结果与非空证据；覆盖全部 Goal 条件，无重复、越界或缺失。实际 `expected_version` 必须来自最新读取/更新结果。服务器标记 `source: agent_report`，不会运行 `command`、读取工作区或验证 SHA 的远程归属。

## 5. 事务、重试与版本

- 领域写操作、审计 Event、幂等响应在同一个 PostgreSQL 事务中提交。
- 幂等键是 `(repo, role:member, action, request_id)`，请求经校验、填默认值和稳定序列化后计算哈希。相同输入返回原响应；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。
- 小规模 MVP 用仓库级 transaction advisory lock 串行化写入，使重试、审议与完成校验原子化。不同仓库可并行；同仓库大量写入的吞吐需后续评估。
- Change 每次更新递增版本，要求 `expected_version`；过期返回 `STALE_VERSION`。读取新版本并确认当前状态后，用新请求 ID 提交新的操作。
- Decision 每次审议、紧迫程度或影响范围改变都递增版本。审议使用 `expected_version`；新增影响工作递增 `review_epoch` 并重置轮次，旧范围的意见不构成新范围共识。
- 每项工作每个 epoch/round 只能答复一次，重试返回原响应，新请求不覆盖既有答复。当前轮全部工作接受同选项，事务内自动记录结果；分歧进入下一轮，最多三轮。
- 幂等重放返回原始快照，可能不是当前状态；需要最新状态时读取 Context/Project。

当前幂等记录没有自动过期或清理，不可在仍可能重试的窗口内手工删除。迁移按文件版本顺序执行，以 advisory lock 和 `schema_migrations` 保证重复执行安全；后续 schema 修改应添加版本迁移，而非修改已应用的 `001_initial.sql`。

## 6. 数据与权限约束

| 表 | 内容 |
| --- | --- |
| `projects` | 项目、状态、规划授权、默认项目与版本 |
| `milestones` | 项目内计划节点、日期、状态与版本 |
| `work_claims` | 执行责任、Session、epoch、过期与释放时间 |
| `change_dependencies` | 同项目内跨 Goal 的任务依赖 |
| `goals` | 目标、验收条件、创建成员 |
| `sessions` | 成员、Agent 类型、最近参与时间 |
| `changes` | 目标关联、阶段、版本、声明范围、验证、PR URL |
| `change_sessions` | Change 与 Session 的显式参与关系 |
| `findings` | 工作发现、内容、置信度和 Session 来源 |
| `decisions` | 提案、权限范围、选项、建议、版本、协商轮次/周期与结果 |
| `decision_reviews` | 每项受影响工作的答复、参与身份、选择和证据 |
| `decision_impacts` | 决策影响的 Change 集合 |
| `relation_feedback` | 工作对相关提示的反馈 |
| `domain_events` | 事务内审计和最近动态 |
| `mutation_requests` | 幂等键、请求哈希和原响应 |

所有读取和 ID 查找限定凭据仓库。进度、发布 Findings 和提出决策要求 Session 属于当前成员且显式参与对应 Change。显式加入同仓库活跃 Change 是团队协作行为；并非只能修改自己创建的 Change。跨仓库目标、工作或决策不允许关联。

工作状态机：`probable → implementing → verifying → completed`，允许阶段内更新，`verifying → implementing`，活动阶段可放弃。完成和放弃是终态。每次进度更新不携带验证时清空旧验证，避免沿用过期证据。

关联的 negotiating/blocking 会返回 `COORDINATION_PENDING`；needs_input/blocking 返回 `GOAL_INPUT_REQUIRED`。deferred/blocking 必须通过 `verification.isolated_decisions[]` 对所有对应记录提供 `{ decision_id, mitigation, evidence }`，缺失返回 `ISOLATION_REQUIRED`，未知或重复 ID 拒绝。解决一个不清除其他议题；完成/放弃工作不再显示等待协商。新加入工作返回当前协商状态。当前允许参与成员显式把同仓库其他 Change 列入决策影响范围；细粒度影响权限和拒绝提案机制属于后续能力。

## 7. 相关工作与上下文

相关工作使用同 Goal、标题词项/中文 bigram、共享声明路径、错误指纹的确定性分数。同 Goal 提供 `same_goal` 证据，即使文件与标题不同也能发现相关活跃工作。最多返回 10 项活跃候选，附来源与证据；标题相似不会自动变成 `same_work`。`possible_duplicate` 需要共同路径与错误指纹，但仍是提示，不创建锁或合并身份。

反馈可取 `same_work | related_but_distinct | not_related | intentional_parallel`。`not_related` 在该 Change 后续上下文中隐藏对应候选；其他反馈附带展示，不自动重写 Change 归属或身份。

Context 在 repeatable-read 只读事务中读取：当前 Goal/Change、相关活跃工作、最近 30 条相关 Findings、明确关联的待定决策、最近 20 个已达成结果、能力标记与报告来源提醒。阶段 A 还提供任务的依赖/租约视图与最近 20 条目标历史知识，包含完成工作；完整历史检索用 `preflight_search_findings`。未实现 token 预算或语义编译。

完全相同的待定决策提案只有在 question、context、category、options、recommendation、authority 一致，且影响范围有交集时才复用。选项、背景或建议不同则独立保存。不会根据语义相似度自动共享阻塞。

项目快照限制按优先级/计划顺序的 200 个 Goal、最近 500 个 Change、500 个 Session、200 个 Decision、30 个 Event。超过限制时是截断视图，汇总数字对应返回集合，不是全库总数。当前适合小团队试用，正式规模化需分页、稳定汇总和长期保留策略。

## 8. 人类工作台与 REST

| 接口 | 用途 |
| --- | --- |
| `GET /`、`/app.js`、`/style.css` | 人类工作台静态资源 |
| `GET /health` | 进程存活，**不检查数据库可用性** |
| `POST /auth/login` | `{ token }`，仅接受 human 凭据 |
| `POST /auth/logout` | 删除浏览器会话 |
| `GET /api/v1/atlas` | 项目快照，可带 `project_id` |
| `GET /api/v1/findings?scope=repo` | 当前仓库最近 Findings |
| `GET /api/v1/findings?scope=change&change_id=...` | 当前仓库指定 Change 的 Findings |
| `GET /api/v1/context?change_id=...&session_id=...` | 工作上下文 |
| `POST /api/v1/tools/:action` | 与十七个 MCP 工具共享输入/规则 |
| `POST /api/v1/decisions/:id/resolve` | 仅 human，可补充 needs_input；拒绝普通协商 |

Findings 查询必须显式选择 `scope=repo` 或 `scope=change`，后者要求 UUID `change_id`；拒绝未知/重复参数，不接受客户端自选仓库。返回 Findings 含 Change 标题、Session、成员、Agent 类型和置信度，按时间及 UUID 从新到旧，最多 100 条；`truncated` 标记是否有更多。已完成/放弃工作仍可读取 Findings，当前没有分页。工作台使用该独立接口切换范围，未选择时不加载。

裁决输入：`request_id`、`expected_version`、`option_id`、`resolution`。Option UUID 来自读取到的决策，不能传 label 或其他决策的选项。例外补充结果、影响范围和审计一起持久化；它不用于日常 Agent 协商，工作台没有普通裁决表单。

REST 返回 `{ data, meta: { request_id } }`，领域失败返回 `{ error, meta }`。认证 401，越权 403，未找到 404，版本/幂等/已裁决冲突 409，输入错误 400，超限 413，数据库或其他内部失败 503。服务端不会将数据库异常详情或认证令牌返回客户端。

工作台内容做 HTML 转义，限制脚本与样式为同源；PR 链接仅使用契约允许的 HTTPS。Cookie 会话保存在单个应用内存中，8 小时有效，重启需重新登录，不使用 localStorage/sessionStorage 保存令牌。当前没有多实例会话存储、登录限速或细粒度权限，远程试用应通过可信访问层控制访问。

## 9. 配置与数据保护

| 配置 | 默认/用途 |
| --- | --- |
| `DATABASE_URL` | 必填，PostgreSQL 连接 |
| `POSTGRES_PASSWORD` / `POSTGRES_PORT` | Compose 数据库密码和本机映射端口，默认 55432 |
| `PREFLIGHT_HOST` / `PREFLIGHT_PORT` | 默认 `127.0.0.1:3000` |
| `PREFLIGHT_AUTH_FILE` | 必填，初始化为 `.preflight/auth.json` |
| `PREFLIGHT_ALLOWED_HOSTS` | 默认 `127.0.0.1,localhost`，仅 hostname，不含协议/端口 |
| `PREFLIGHT_SECURE_COOKIES` | HTTPS 部署设置 `true` |
| `PREFLIGHT_CHROMIUM_PATH` | 仅浏览器测试，可选现有 Chromium 路径 |

所有命令从仓库根目录运行。`npm run setup` 生成随机数据库密码和成员令牌，私有文件权限 0600、目录 0700；已有配置不会覆盖。不要提交 `.env`、`.preflight` 或把令牌放入命令示例/日志。Docker 数据保留在命名卷中，备份数据库时同时按私有凭据处理。

输入在领域写入前递归过滤常见 GitHub/OpenAI token、JWT、Bearer、AWS key、凭据赋值和私钥片段。脱敏是尽力过滤，并非完整 DLP；避免上传源码、完整 diff、Prompt 和任何敏感信息。最大请求体 256 KiB。数据库连接采用短连接超时；当前没有外部 API/LLM 请求和异步任务队列。

## 10. 验证与开发约定

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:management
npx playwright install chromium
npm run test:ui
npm run test:management-ui
npm run build
```

集成测试必须使用真实 PostgreSQL：两客户端初始化和发现工具、并发重试、共享发现脱敏、成员越权、显式共同参与、保留既有阻塞、不同背景/选项不合并、过期版本、逐工作共识、三轮上限与隔离证据、目标信息例外、独立阻塞、逐项验收、跨仓库隔离、跨域拒绝、令牌撤销、持久化重建。

Chromium 测试跑真实工作台：登录、协商结果、项目/里程碑/目标/任务管理、列表/看板、依赖、认领、暂停/恢复、表单冲突、HTML 转义、浏览器不存令牌、手机布局和退出。集成与浏览器测试使用随机数据库 schema，并在 finally 清理。截图仅写入被忽略的 `.preflight/screenshots/`。

修改业务规则时优先在领域层实现，增加覆盖真实失败场景的验证。不要为静态文案创建镜像测试。不要声称已有 Git/CI 事实、后台 Agent 调度或完整项目管理，除非对应接口、证据和集成验证已经实现。

## 11. 自主协商契约

`authority` 为 `within_goal`（默认）、`goal_boundary` 或 `missing_information`。默认议题从 `negotiating` 开始，后两种直接 `needs_input`。旧 pending 数据迁移为 negotiating，旧 human_resolved 保留历史来源，不能改写为 Agent 共识。

`preflight_review_decision` 的 `stance` 为 `accept | object`；accept 必须选择该议题的 option UUID。`evidence` 为 `{ goal_alignment, constraints_check, verification }`，三项均为非空摘要。服务器校验参与者、范围、版本、选项和证据完整性，不证明文本陈述本身真实。

Decision 视图附 `review_round`、`review_epoch`、`round_limit=3`、`current_reviews[]`、`review_history[]`、`required_change_ids[]`、`missing_change_ids[]`。所有当前轮工作接受同选项自动 `agent_resolved`；不同选择或异议在当前轮全部答复后推进，第三轮仍不同则 `deferred`。普通协商失败不自动升级为用户待办。Context 建议行动为 coordinate/isolate_disputed_scope/clarify_goal/continue 等；兼容字段 pending_decisions 表示未完结的协商，不表示人工裁决队列。

新的迁移文件为 `002_agent_coordination.sql`，包含协商字段、审议表与旧状态兼容升级。集成测试清理时先删除 decision_reviews，再删除 decision_impacts、Session 和 Change 的父表。

## 12. 演进顺序与原文

按[v0.2 方案](plans/autonomous-collaboration-v0.2.md)推进。阶段 A 首版已实现，实际协议见第 13 节；阶段 B 首版已实现（第 14 节）；阶段 C 的事实验收尚未开发。管理 MCP 与工作台共享领域规则。

后续结合真实项目试用继续扩展：

1. Git/CI 事实通道，对报告完成增加独立状态与证据；只读 Observer 不执行 checkout/reset/rebase/merge。
2. 客户端可靠更新、自动心跳/恢复、协商超时、执行容量约束和完成任务重新打开。
3. 明确保存的 Policy、上下文 token 预算和带证据的语义检索。
4. 多实例会话、OAuth、分页、保留策略、推送和吞吐优化。

原四份文档未经改写保存在 [archive](archive/)：

- [产品原稿](archive/devboard-ai-product-spec.md)
- [技术原稿](archive/devboard-ai-technical-spec.md)
- [v1.1 技术原稿](archive/devboard-ai-technical-spec-v1.1.md)
- [开发指南原稿](archive/devboard-dev-guide.md)

原文用于理解设计背景。MVP 按用户明确的 MCP-first、替代 devboard 和完整共享闭环实施，不将原稿中的 Observer-first 阶段、计划技术栈或代码片段视为已经实现。

## 13. 阶段 A：项目管理与任务认领

### 13.1 管理对象与权限

一个凭据的 `repo` 下可有多个 Project，Project 内有可选 Milestone 和多个 Goal，Goal 下拆 Change。业务责任 `owner` 与实际执行租约分开。`003_project_management.sql` 为存量仓库创建唯一默认项目、回填 Goal；保留原 UUID、关系、历史记录和旧模式工作。迁移可重复执行，不重建已有数据。

只有 human 可以创建/编辑 Project 及其 `planning_agents[]` 授权列表。human 或名单中的 Agent 可修改目标计划和里程碑。执行 Agent 可提出任务和认领任务；任务创建者、参与者或 human 可编辑未认领任务，已有效认领的任务定义只能由当前租约持有人修改。共同参与者仍可发布发现、审议和协调；主租约不垄断知识署名。

| 新工具 | 输入与行为 |
| --- | --- |
| `preflight_manage_project` | `operation=create/update`；create 必须 `title`，update 必须 `project_id, expected_version`；可设 `description,state,planning_agents[]` |
| `preflight_manage_milestone` | `operation,project_id`；create 必须 `title`，update 必须 `milestone_id,expected_version`；可设 `title,due_date,state` |
| `preflight_manage_goal` | `goal_id,expected_version`；可编辑 `title,objective,acceptance[],plan_state,priority,rank,milestone_id,owner,due_date` |
| `preflight_manage_work` | `change_id,expected_version`；可编辑 `title,task_acceptance[],goal_criteria_indices[],depends_on_change_ids[]`；当前持有人还必须带 `session_id,lease_id,lease_epoch` |
| `preflight_manage_claim` | `operation=claim/renew/release,change_id`；claim 必须 `expected_version`，可复用自己的 `session_id`；renew/release 必须 `session_id,lease_id,lease_epoch` |
| `preflight_search_findings` | 可筛 `project_id,goal_id,change_id,finding_id,kind,query`；`limit` 默认 20、最大 50，响应 `next_cursor` 用于下一页 |

以上写入均要求 UUID `request_id`。日期采用 `YYYY-MM-DD`，可用 null 清除管理接口的日期/责任人/里程碑。优先级 1 最高、4 最低；相同优先级按 `rank`、创建时间和 ID 稳定排序。Goal 计划状态为 `backlog/ready/paused/cancelled/archived`，Project 状态为 `active/archived`，Milestone 状态为 `planned/archived`。新 Goal 指定项目时默认 backlog，未授权 Agent 可以捕获待办，但不能擅自修改业务优先级或将其设为 ready。

### 13.2 当前 Agent 闭环

1. `preflight_get_project {project_id}` 查询计划与 `available_work[]`。也可在无 Session 时调用 `preflight_get_context {goal_id}`，获取目标、任务、历史知识。
2. 优先认领适当的已有任务：`preflight_manage_claim {operation:"claim",change_id,expected_version,request_id}`，保存返回的 `session_id`、`change.version` 及 `claim.id/epoch/expires_at`。
3. 尚无适当任务时调用 `preflight_start_work`，传 `mode:"propose"`（仅提出）或 `mode:"claim"`（提出并认领）、独立 `task_acceptance[]`、`goal_criteria_indices[]` 和可选 `depends_on_change_ids[]`。保留原必填字段 `goal_id,title,agent_type,request_id`。新项目不接受无 mode 的新工作。
4. 读取上下文，执行并发布发现；持有人按当前版本上报阶段，必须额外传 `lease_id:claim.id,lease_epoch:claim.epoch`。同伴可以通过原 `existing_change_id` 机制参加同一任务，但不能凭参与身份代替当前责任租约更新阶段。
5. 定期 `renew`，不用等待模型完成整段工作才续租。手动客户端必须实现续租或主动调用；阶段 B 本地适配器已独立维护续租；默认有效期 10 分钟，暂不可配置。完成前报告 verifying，在本地执行测试，再报告 completed。
6. 不继续执行时 release。过期任务在下次读取时显示 expired，可被重新 claim；接管增加 epoch。旧租约上报被 `LEASE_REQUIRED` 拒绝。返回的幂等历史响应不证明租约仍有效，重试后应读取当前状态。

认领与依赖校验沿用仓库级事务锁，同一任务只允许一个有效主责任租约；不提供语义去重或文件硬锁。依赖必须同 Project，可跨 Goal，环与自引用被拒绝。依赖任务需报告 completed 才可认领下游；该状态仍为 Agent 报告，不能等同于 Git/CI 事实。暂停/取消/归档禁止新执行与阶段推进（可安全放弃），不终止外部进程。续租本身不授权继续执行被暂停的计划。

Goal/Project/Milestone 的 `version` 用于并发编辑。Goal 的 objective 或 acceptance 改变还增加 `definition_version`；旧任务映射需重新规划。任务定义修改增加自身 `definition_version`，绑定当前目标定义版本并清除旧验证。认领目标定义不匹配的任务返回 `REPLAN_REQUIRED`。

### 13.3 子任务验收与汇总

受管理任务完成要求有效租约、当前版本、没有未解决阻塞及每条 **task_acceptance** 的证据。verification 还必须包含当前 `definition_version` 和 `goal_definition_version`；保留 `head_sha,command,result,criteria[]` 和隔离证据。以下为格式示例，其中 SHA/证据必须由客户端换成实际验证记录：

```json
{
  "head_sha": "<actual-40-character-commit-sha>",
  "command": "npm test",
  "result": "passed",
  "definition_version": 1,
  "goal_definition_version": 1,
  "criteria": [{"index": 0, "passed": true, "evidence": "<actual-task-verification-evidence>"}]
}
```

Project 快照包含 `projects,milestones,goals,changes,available_work`；可用 `project_id` 限定。任务视图附 `dependencies,blocked_reasons,claim,claim_state,available_to_claim`，目标附 `uncovered_criteria,task_count,completed_tasks,progress`。条件映射仅表示定义覆盖；目标的 reported_completed 还要求全体任务报告完成、当前定义版本条件全覆盖且无依赖/重规划阻塞。Milestone 汇总使用相同目标判定，`delivery_state` 固定为 `not_independently_verified`。

当前快照有目标 200、任务 500、协商 200、动态 30 的上限；不是全量统计接口。阶段 B 已补容量控制、可靠更新与超时；分页、贡献/集成和正式目标验收继续演进。不把测试中格式合法的 fixture SHA 当作真实代码交付。

### 13.4 历史知识

Findings 增加 `failed_attempt/patch_summary`，可附 `detail,conditions,evidence[]` 与 `refutes_id/supersedes_id`。失败尝试必须有适用条件和至少一项证据。证据项含 description、可选 head_sha/command/result，均标为 Agent 报告；引用必须同仓库，保留原记录，不覆盖旧结论。

检索按内容、细节和适用条件进行文字匹配，按创建时间/UUID 倒序游标分页。返回 `amended_by[]` 指向反驳/替代记录，来源成员、任务和 Agent 类型可追溯；已完成/放弃工作仍可检索。首次查询使用相同筛选后续带 `next_cursor`，服务器不做语义匹配或自动裁定真假。

### 13.5 验证与当前限制

`npm run test:management` 使用真实 PostgreSQL 和四个独立 MCP SDK 客户端（两个 Agent、human、跨仓库成员），覆盖存量迁移、授权、优先级、跨目标依赖/环、并发认领、重试、续期、时间推进后的真实过期校验、接管、旧租约拒绝、暂停/取消、子任务验收、知识分页/纠正及持久化。时间由领域层可注入时钟推进，不等待十分钟；数据库、HTTP、身份与协议都是真实运行。

`npm run test:management-ui` 在真实 Chromium 中经 REST 操作规划，测试 fresh workspace、项目授权、里程碑、目标与任务/依赖、认领显示、暂停/筛选/恢复、有效租约下的编辑限制、并发编辑冲突保留输入、引号与 HTML 转义、手机看板。原 MCP 和浏览器协商测试继续运行。

阶段 A 此次验证并非外部模型持续自主运行实验。阶段 B 后续已有真实客户端、更新/心跳、恢复与超时验证，见第 14 节；Git/CI 独立事实仍待实现。首次使用可在工作台创建项目与里程碑，登记 ready 目标，再让两个已配置 Agent 读取同一项目自行拆解并认领；系统不会替它们调度模型。

## 14. 阶段 B：可靠更新与本地执行适配器

增量迁移 `004_reliable_progression.sql` 添加 `session_runtimes`、`coordination_events`、`event_deliveries`、租约释放原因、Decision 的 `round_deadline_at/deferred_reason`。001～003 保持原样。`domain/reliability.ts` 统一 audit/outbox 发布；service 和 management 在原业务事务中调用，失败时整体回滚。

### Session 和实例

`preflight_manage_session` 的 open 需要 `project_id/instance_id`，不需要先创建任务，返回 Session 和绑定该项目的 runtime。heartbeat/close 使用 `session_id/runtime_id/runtime_epoch`。heartbeat 状态仅 waiting/running；close 可 stopped/error/budget_exhausted，并释放本 Session 租约。

实例 120 秒过期，心跳每 30 秒。recover 需要自己的 Session、新 instance_id 和当前 runtime `expected_version`，原实例必须过期或已关闭；接管递增 epoch。所有受控 Session 的业务写在幂等缓存查找前校验实例；旧实例连已完成请求的重放也被拒绝。幂等业务 hash 排除 runtime 身份字段，合法恢复后使用同一业务请求 ID 可以取回原结果。手动旧 Session 不强制实例字段。

受控 Session 同时最多认领一个主任务；同项目最多两个未过期主责任租约。手动 Session 保留原兼容行为，因此该限制不是整个部署的硬资源隔离。

### 更新消费

`preflight_get_updates` 需要当前 Session/实例，默认 20 条、最多 50 条，先计划变化再按时间/UUID 排序。只返回未确认 delivery，`has_more` 表示需继续消费；没有序号高水位或 cursor，晚提交事务不会被跳过。持续返回同一项直到 ack。

`preflight_ack_updates` 的 `updates[]` 包含 delivery_id、outcome（handled/waiting/stopped/superseded）和可选 observed_version。所有 delivery 必须属于本 Session；重复请求幂等。stopped 必须处于 waiting 且引用该计划事件的 entity_version，来源仍是 adapter_report，不能当作独立外部进程证明。ack 不表示任务完成；waiting 的处理结果保留在投递记录中。

通知只保存项目、实体、版本与状态引用；完整 Findings、提示、源码和 before/after 快照不进入通知 payload。计划/任务变化仅在项目内路由；Findings 路由给同目标及直接下游目标的参与 Session。空闲订阅者靠任务/依赖变化通知与最新快照发现工作。首次订阅和恢复必须读取完整项目快照。心跳与续租不产生模型唤醒广播。

### 维护与协商

服务进程每 5 秒运行维护；每仓库事务 advisory lock，三类扫描分别最多 100 项并按期限排序。只转移仍满足条件的租约、实例和协商记录，重复维护不重复发事件。重启后从数据库期限继续，无需收到下一份 review。写入路径也即时核对期限，正确性不依赖 worker 准时。

within_goal 每轮期限 10 分钟；全体有分歧才推进下一轮并设新期限，三轮不同以 disagreement_limit 隔离。到期且未全体答复以 unanswered_timeout 隔离，保留当前轮次、历史证据与缺席项。主责任接管使仍在 negotiating 的审议 epoch 增加，要求当前责任者重新答复；不延长原 deadline，不撤回已达成结果。managed task 的 review 需要当前主责任 lease_id/lease_epoch。

### Codex 适配器

`adapter/codex.ts` 使用本机 CLI app-server JSONL 接口；`adapter/runtime.ts` 通过官方 MCP SDK 连接 Preflight，把服务端工具作为实验性 dynamic tools 提供给所属会话。默认不改变用户模型配置。CLI 入口为 `npm run agent:start`；参数见 README。Linux/WSL 的 `flock` 保证 journal 本地互斥，PostgreSQL runtime epoch 才是共享状态的身份约束。

journal 用 0600 文件与原子替换/fsync 保存 Session、实例、thread/turn、进程 PID+Linux start time、业务 call 请求 ID、已累计轮次和客户端提供的 token 计数；不保存凭据或原始模型内容。处理动态工具时注入自己的 Session/实例和持久 request ID，不让模型自行改变所属实例。启动最多重试三次；服务或租约失效会中断所属执行并记录 error，不静默伪装正常。

独立心跳/续租与模型调用并行。普通更新排队，到下一轮读取引用的当前状态；计划/定义变化中断当前轮，观察 turn/completed 后切回 waiting 并报告版本化停止结果。暂停/定义过期的主责任随后释放，未完成任务不会标作 completed。等待协商已答复或没有工作时不重复调用模型。预算达到后停止客户端并关闭 runtime，保留未完成工作。

恢复核对原宿主/客户端 PID 与 start time，只终止确定属于该 journal 的原客户端进程组。然后恢复原 thread，若 journal 留有进行中的 turn，则读取持久结果；结果仍未知时拒绝启动重复轮次。外部副作用和无法核实的进程不享有“恰好一次”保证。

### 管理投影与边界

Project/Atlas 增加 `reliability`：每实例心跳、失联标记、未确认数、最早积压、当前计划版本的停止反馈及来源。风险从任务依赖/定义/租约/协商传至 Goal/Milestone，含来源与时间。停止反馈最多 200 条并提供截断标记；未确认总数用聚合查询，不需要把全历史送给模型。工作台保留“执行状态未知”，不推算 ETA 或声称已经交付。

此版没有 SSE、通用客户端调度、自动合并、Git/CI 事实校验、正式 Goal/Milestone 验收、生产审计/队列保留策略或按费用阻断。默认轮询没有自适应 idle 退避/jitter；服务异常以安全停止和后续恢复处理，尚无长期网络故障容错运行。费用无法获得时明确 unavailable；CLI 提供 tokenUsage 时只保存数值。

验证入口：`test:reliability`（实际 PG+SDK）、`test:runtime-faults`（真实本地进程与明确模拟的模型 transport）、`test:management-ui`（真实 Chromium）、`test:client`、`test:agents`、`test:runtime-real`（真实 Codex 模型，使用账号额度）。后两者的结果、异常和限制见[验收记录](testing/reliable-progression-stage-b-2026-10-08.md)。
