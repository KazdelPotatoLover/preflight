# Preflight 开发说明

> 当前实现：0.1.0 团队 MCP MVP。更新日期：2026-10-06。
> 产品范围见[产品说明](product-spec.md)，安装命令见[README](../README.md)。

本文描述仓库当前实现。原始文档中的 pnpm workspace、Next.js、Redis、Observer、SSE、Embedding、Claim 和 Policy 是演进候选，尚未创建对应运行模块。MVP 优先完成共享目标、工作、发现、自主协商和验收记录。

## 1. 架构与目录

Node.js 22.13+、TypeScript strict、Hono、官方 MCP SDK、Drizzle 和 PostgreSQL 16。依赖由 npm 11 与 `package-lock.json` 管理。一个应用进程同时服务人类工作台、REST 和 Streamable HTTP MCP；领域状态全部存入数据库。

```text
src/
  index.ts                  # 启动、配置、关闭
  app.ts                    # Hono、认证、同源与输入大小限制、静态资源
  config.ts                 # 凭据格式、令牌哈希认证、过期检查
  mcp/server.ts             # 八个工具、SDK transport、结果与错误映射
  domain/
    contracts.ts            # Zod 契约、脱敏、稳定请求序列化
    service.ts              # 共享领域规则、事务、上下文与看板快照
    related.ts              # 确定性相关工作提示
  db/
    client.ts               # PostgreSQL 连接与 Drizzle
    schema.ts               # 数据模型
    migrate.ts              # 初始迁移入口
migrations/001_initial.sql
public/                     # HTML、CSS、原生 JS 人类工作台
scripts/
  setup.mjs                 # 私有初始化
  integration.ts            # 两个真实 MCP 客户端的数据库集成测试
  browser.ts                # Chromium 工作台与协商结果测试
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

`human` 可以查看工作台和登记目标；普通协商由 `agent` 通过自己的参与 Session 答复。只有 `needs_input` 的目标边界/信息缺口仍可使用 human 补充接口，普通协商的人工 resolve 会被拒绝。已分发的 human 令牌是一项人类管理权限，不能交给 Agent。MCP 工具列表不暴露裁决工具。

允许的 Host 来自 `PREFLIGHT_ALLOWED_HOSTS`。存在 Origin 时必须与请求 URL 同源；没有跨域开放访问。远程代理需正确保留公开 Host/协议，使服务器看到的 URL 与浏览器 Origin 一致；部署后必须验证登录和协商读取，不能通过放宽为任意 Origin 解决代理配置问题。

## 3. 传输与工具契约

`POST /mcp` 是无状态 Streamable HTTP endpoint。每个请求建立 SDK server/transport，业务 Session 存入 PostgreSQL，不使用 MCP 传输会话存业务数据。响应使用 JSON；不提供 SSE/GET 流，GET、DELETE 返回 405。客户端初始化后可以列出并调用八个工具。

输入以 `src/domain/contracts.ts` 为准。字段长度、数组数量、UUID、URL 和枚举由 Zod 校验，顶层拒绝未知字段。所有写工具必须传 `request_id` UUID。

| 工具 | 必填业务输入 | 关键可选输入 |
| --- | --- | --- |
| `preflight_get_project` | 空对象 | 无 |
| `preflight_register_goal` | `title`、`objective`、`acceptance[]` | 无 |
| `preflight_start_work` | `goal_id`、`title`、`agent_type` | `session_id`、`existing_change_id`、`likely_scope[]`、`branch`、`error_fingerprints[]` |
| `preflight_get_context` | `change_id`、`session_id` | 无 |
| `preflight_report_progress` | `change_id`、`session_id`、`expected_version`、`status`、`summary` | `likely_scope[]`、`verification`、`feedback`、`pr_url` |
| `preflight_publish_findings` | `change_id`、`session_id`、`findings[]` | 无 |
| `preflight_propose_decision` | `change_id`、`session_id`、`question`、`context`、`category`、`urgency`、`options[]` | `recommendation`、`affected_change_ids[]`、`authority` |
| `preflight_review_decision` | `change_id`、`session_id`、`decision_id`、`expected_version`、`stance`、`rationale`、`evidence` | `option_id`（接受时必填） |

`likely_scope` 是仓库相对路径，不是已验证变更范围；拒绝绝对路径、`..`、`.env` 和 PEM 路径。`pr_url` 仅接受 HTTPS，服务器不抓取 URL 或验证 PR。Findings 类型为 `observation | hypothesis | root_cause | constraint | test_result`，每条带精简 `content` 和 `[0,1]` 置信度。

决策类别为 `public_api_behavior | database_schema | auth_security | product_behavior | architecture_boundary | unknown`，紧迫程度为 `blocking | normal | low`。选项 2～5 个，具有唯一 `label`、`description`、可选 `pros[]` 与 `cons[]`。`recommendation` 如提供，必须是其中一个 label。

MCP 成功响应同时带文本内容和 `structuredContent`：

```json
{
  "data": { "...": "tool-specific result" },
  "meta": { "source": "preflight", "repo": "KazdelPotatoLover/preflight" }
}
```

领域错误返回 `isError: true`，文本内容为 `{ "error": { "code": "...", "message": "..." } }`。不要把错误响应当作成功上报；数据库失败没有离线待同步缓存。Agent 可以继续正常开发，恢复后使用同一请求 ID 重试尚未确认的写操作。

## 4. 一次 Agent 工作流程

1. `preflight_get_project {}`，查找已有 Goal。没有适当目标时，调用 `preflight_register_goal`，保存 `goal.id`。
2. `preflight_start_work` 带该 Goal，保存 `session_id`、`change.id`、`change.version`。默认创建独立工作；只有确实要共同参与同一工作时才传 `existing_change_id`。
3. 调用 `preflight_get_context`，检查相关工作、Findings、协商事项与已达成结果和 `recommended_action`。
4. 报告 `implementing`，发布有用 Findings；重要进展后更新状态并再次读取上下文。
5. 共同取舍调用 `preflight_propose_decision`，每项受影响工作通过 `preflight_review_decision` 提交意见与目标/约束/验证证据。读取其他工作意见后进行下一轮或取得一致；结果进入共享上下文。三轮仍分歧则隔离争议范围，完成时提交隔离证据。只有真正目标信息/边界缺口才需要用户补充。没有服务器推送或自动唤醒。
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

Context 在 repeatable-read 只读事务中读取：当前 Goal/Change、相关活跃工作、最近 30 条相关 Findings、明确关联的待定决策、最近 20 个已达成结果、能力标记与报告来源提醒。当前不做历史完成工作的知识检索，未实现 token 预算或语义编译。

完全相同的待定决策提案只有在 question、context、category、options、recommendation、authority 一致，且影响范围有交集时才复用。选项、背景或建议不同则独立保存。不会根据语义相似度自动共享阻塞。

项目快照限制最近 200 个 Goal、500 个 Change、500 个 Session、200 个 Decision、30 个 Event。超过限制时是截断视图，汇总数字也对应当前返回集合，不是全库总数。当前适合小团队试用，正式规模化需分页、稳定汇总和长期保留策略。

## 8. 人类工作台与 REST

| 接口 | 用途 |
| --- | --- |
| `GET /`、`/app.js`、`/style.css` | 人类工作台静态资源 |
| `GET /health` | 进程存活，**不检查数据库可用性** |
| `POST /auth/login` | `{ token }`，仅接受 human 凭据 |
| `POST /auth/logout` | 删除浏览器会话 |
| `GET /api/v1/atlas` | 项目快照 |
| `GET /api/v1/findings?scope=repo` | 当前仓库最近 Findings |
| `GET /api/v1/findings?scope=change&change_id=...` | 当前仓库指定 Change 的 Findings |
| `GET /api/v1/context?change_id=...&session_id=...` | 工作上下文 |
| `POST /api/v1/tools/:action` | 与八个 MCP 工具共享输入/规则 |
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
npx playwright install chromium
npm run test:ui
npm run build
```

集成测试必须使用真实 PostgreSQL：两客户端初始化和发现工具、并发重试、共享发现脱敏、成员越权、显式共同参与、保留既有阻塞、不同背景/选项不合并、过期版本、逐工作共识、三轮上限与隔离证据、目标信息例外、独立阻塞、逐项验收、跨仓库隔离、跨域拒绝、令牌撤销、持久化重建。

Chromium 测试跑真实工作台：登录、只读协商进展与 Agent 一致结果、登记计划目标、HTML 转义、浏览器不存令牌、手机宽度不溢出和退出。测试使用随机仓库隔离，并在 finally 清理。浏览器截图只写入被忽略的 `.preflight/screenshots/`。

修改业务规则时优先在领域层实现，增加覆盖真实失败场景的验证。不要为静态文案创建镜像测试。不要声称已有 Git/CI 事实、后台 Agent 调度或完整项目管理，除非对应接口、证据和集成验证已经实现。

## 11. 自主协商契约

`authority` 为 `within_goal`（默认）、`goal_boundary` 或 `missing_information`。默认议题从 `negotiating` 开始，后两种直接 `needs_input`。旧 pending 数据迁移为 negotiating，旧 human_resolved 保留历史来源，不能改写为 Agent 共识。

`preflight_review_decision` 的 `stance` 为 `accept | object`；accept 必须选择该议题的 option UUID。`evidence` 为 `{ goal_alignment, constraints_check, verification }`，三项均为非空摘要。服务器校验参与者、范围、版本、选项和证据完整性，不证明文本陈述本身真实。

Decision 视图附 `review_round`、`review_epoch`、`round_limit=3`、`current_reviews[]`、`review_history[]`、`required_change_ids[]`、`missing_change_ids[]`。所有当前轮工作接受同选项自动 `agent_resolved`；不同选择或异议在当前轮全部答复后推进，第三轮仍不同则 `deferred`。普通协商失败不自动升级为用户待办。Context 建议行动为 coordinate/isolate_disputed_scope/clarify_goal/continue 等；兼容字段 pending_decisions 表示未完结的协商，不表示人工裁决队列。

新的迁移文件为 `002_agent_coordination.sql`，包含协商字段、审议表与旧状态兼容升级。集成测试清理时先删除 decision_reviews，再删除 decision_impacts、Session 和 Change 的父表。

## 12. 演进顺序与原文

下一轮先做实际团队试用和一种 Agent 客户端的稳定集成，再决定以下能力的顺序：

1. Git/CI 事实通道，对报告完成增加独立状态与证据；只读 Observer 不执行 checkout/reset/rebase/merge。
2. 目标优先级、负责人、子任务验收分配、人类验收与重新打开，减少第二块看板的维护。
3. 历史 Findings 检索、明确保存的 Policy、上下文 token 预算和带证据的语义检索。
4. 多实例会话、OAuth、分页、保留策略、推送和吞吐优化。

原四份文档未经改写保存在 [archive](archive/)：

- [产品原稿](archive/devboard-ai-product-spec.md)
- [技术原稿](archive/devboard-ai-technical-spec.md)
- [v1.1 技术原稿](archive/devboard-ai-technical-spec-v1.1.md)
- [开发指南原稿](archive/devboard-dev-guide.md)

原文用于理解设计背景。MVP 按用户明确的 MCP-first、替代 devboard 和完整共享闭环实施，不将原稿中的 Observer-first 阶段、计划技术栈或代码片段视为已经实现。
