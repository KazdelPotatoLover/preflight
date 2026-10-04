# DevBoard AI — 完整技术说明书

> **版本**: v1.0 Draft  
> **日期**: 2026-10-01  
> **状态**: 待评审

---

## 目录

1. [系统总览与技术选型](#1-系统总览与技术选型)
2. [整体架构](#2-整体架构)
3. [核心数据模型与 Schema 设计](#3-核心数据模型与-schema-设计)
4. [Agent Gateway 层](#4-agent-gateway-层)
5. [Agent Observer 模块](#5-agent-observer-模块)
6. [Intent Service — 意图理解引擎](#6-intent-service--意图理解引擎)
7. [Change Service — 变更生命周期管理](#7-change-service--变更生命周期管理)
8. [Conflict Engine — 分层冲突检测](#8-conflict-engine--分层冲突检测)
9. [Similarity Engine — 重复工作检测](#9-similarity-engine--重复工作检测)
10. [Decision Service — 决策治理引擎](#10-decision-service--决策治理引擎)
11. [Context Compiler — 上下文编译器](#11-context-compiler--上下文编译器)
12. [Git Integration 层](#12-git-integration-层)
13. [CI / Verification 集成](#13-ci--verification-集成)
14. [前端与 UI 架构](#14-前端与-ui-架构)
15. [安全与权限模型](#15-安全与权限模型)
16. [部署与运维架构](#16-部署与运维架构)
17. [可观测性与监控](#17-可观测性与监控)
18. [分阶段开发路线图](#18-分阶段开发路线图)
19. [技术风险与缓解策略](#19-技术风险与缓解策略)

---

## 1. 系统总览与技术选型

### 1.1 设计哲学

DevBoard AI 是一个 **后台运行的协作基础设施**，而不是一个要求用户主动操作的项目管理平台。它的核心运行模式是：

```
Agent 行为 → 自动感知 → 冲突/重复检测 → 决策路由 → 最小化人工干预
```

### 1.2 推荐技术栈

| 层级 | 技术选型 | 选型理由 |
|:---|:---|:---|
| **主语言** | TypeScript (Node.js) | Agent/MCP 生态一致性最强；前后端统一语言 |
| **辅助语言** | Rust | 高性能 Symbol 解析器（Tree-sitter binding）、Git Diff 分析 |
| **API 框架** | Hono / Fastify | 轻量高性能，适合事件密集型 API |
| **数据库** | PostgreSQL 16+ | JSONB、pg_trgm 全文搜索、pgvector 向量检索一体化 |
| **向量检索** | pgvector 扩展 | 避免引入独立向量数据库，降低运维复杂度 |
| **消息队列** | BullMQ (Redis) | 轻量级异步任务处理，支持延迟任务、重试、优先级 |
| **实时通信** | Server-Sent Events (SSE) / WebSocket | Agent 状态推送、UI 实时更新 |
| **缓存** | Redis | Session 状态、Claim TTL、热点 Change 缓存 |
| **Symbol 解析** | Tree-sitter (WASM / native) | 多语言 AST 解析，不依赖 LSP Server |
| **Embedding 模型** | OpenAI text-embedding-3-small 或本地 ONNX 模型 | Intent 语义匹配 |
| **LLM 推理** | GPT-4.1-mini / Claude Sonnet 4 | Decision Compression、Intent 摘要提炼 |
| **前端** | Next.js 15 (App Router) + Tailwind + shadcn/ui | SSR、React Server Components |
| **认证** | OAuth 2.0 (GitHub / GitLab SSO) | 与 Git 平台一致的身份体系 |
| **部署** | Docker Compose → Kubernetes | 渐进式容器化 |

> [!NOTE]
> 第一阶段采用 **单体服务 + 逻辑分层** 架构，不做微服务拆分。当单实例 QPS 超过 5000 或团队规模超过 200 Agent 时再考虑拆分。

---

## 2. 整体架构

### 2.1 架构总览

```mermaid
flowchart TD
    subgraph Agents["Coding Agents"]
        A1["Claude Code"]
        A2["Cursor"]
        A3["Codex"]
        A4["OpenHands"]
        A5["Custom CLI Agent"]
    end

    subgraph Gateway["Agent Gateway Layer"]
        MCP["MCP Server"]
        REST["REST/GraphQL API"]
        HOOK["Git/CLI Hooks"]
        SDK["Agent SDK (TS/Python)"]
    end

    subgraph Core["Core Services (单体)"]
        IS["Intent Service"]
        CS["Change Service"]
        DS["Decision Service"]
        CE["Conflict Engine"]
        SE["Similarity Engine"]
        CC["Context Compiler"]
        CM["Claim Manager"]
    end

    subgraph Storage["存储层"]
        PG[("PostgreSQL\n+ pgvector")]
        RD[("Redis\nQueue + Cache")]
    end

    subgraph Workers["异步处理层"]
        W1["Symbol Analyzer\n(Tree-sitter)"]
        W2["Embedding Worker\n(LLM)"]
        W3["Diff Watcher"]
        W4["Decision Compressor\n(LLM)"]
        W5["Notification Worker"]
    end

    subgraph External["外部集成"]
        GH["GitHub / GitLab"]
        CI["CI Systems"]
        NT["Slack / Lark / Email"]
    end

    subgraph UI["DevBoard UI"]
        WEB["Web Dashboard\n(Next.js)"]
    end

    A1 & A2 & A3 & A4 & A5 --> MCP & REST & HOOK & SDK
    MCP & REST & HOOK & SDK --> IS & CS & DS & CE & SE & CC & CM
    IS & CS & DS & CE & SE & CC & CM --> PG & RD
    RD --> W1 & W2 & W3 & W4 & W5
    W1 & W2 & W3 & W4 --> PG
    W5 --> NT
    GH --> CS
    CI --> CS
    WEB --> REST
```

### 2.2 数据流 — 一个 Agent Session 的完整生命周期

```mermaid
sequenceDiagram
    participant Dev as 开发者
    participant Agent as Coding Agent
    participant GW as Agent Gateway
    participant IS as Intent Service
    participant CS as Change Service
    participant SE as Similarity Engine
    participant CE as Conflict Engine
    participant CM as Claim Manager
    participant DS as Decision Service
    participant CC as Context Compiler
    participant UI as Decision Inbox

    Dev->>Agent: "登录偶尔超时, 帮我修掉"
    Agent->>GW: intent.observe(prompt, plan)
    GW->>IS: 解析 Intent
    IS->>SE: 查询相似 Intent
    SE-->>IS: 发现 CHG-128 相似度 92%
    IS-->>GW: 返回 related_work + findings
    GW-->>Agent: Context Package

    Agent->>GW: collab.preflight(scope)
    GW->>CE: 检测冲突
    GW->>CM: 查询活跃 Claim
    CE-->>GW: Level 2 冲突 (AuthService.login)
    CM-->>GW: Agent-23 持有 Claim
    GW-->>Agent: collision_warning + suggestions

    Agent->>GW: claim.acquire(scope, ttl=30m)
    GW->>CM: 注册 Claim
    CM-->>GW: claim_granted

    Agent->>GW: change.report_progress(diff, findings)
    GW->>CS: 更新 Change 状态
    CS->>CE: 重新评估冲突

    Agent->>GW: decision.propose(question, options)
    GW->>DS: 创建 Decision
    DS->>DS: 检查 Decision Memory
    DS->>DS: 尝试 Decision Compression
    DS-->>UI: 推送到 Decision Inbox

    Dev->>UI: 选择 Option B
    UI->>DS: decision.resolve(DEC-182, optionB)
    DS->>CS: 通知受影响 Changes
    DS->>GW: 广播 decision_resolved
    GW->>Agent: decision_result + updated_context
    Agent->>Agent: 继续执行
```

---

## 3. 核心数据模型与 Schema 设计

### 3.1 ER 关系图

```mermaid
erDiagram
    TEAM ||--o{ MEMBER : has
    TEAM ||--o{ REPO : owns
    TEAM ||--o{ GOAL : defines
    TEAM ||--o{ AUTHORITY_POLICY : configures

    GOAL ||--o{ CHANGE : drives
    GOAL ||--o{ DECISION : related_to

    CHANGE ||--o{ INTENT : has
    CHANGE ||--o{ CLAIM : has
    CHANGE ||--o{ FINDING : produces
    CHANGE ||--o{ DECISION : raises
    CHANGE ||--o{ AGENT_SESSION : involves
    CHANGE ||--o{ VERIFICATION : verifies
    CHANGE }o--|| REPO : targets
    CHANGE }o--o| BRANCH : uses
    CHANGE }o--o| PULL_REQUEST : links

    AGENT_SESSION }o--|| MEMBER : owned_by
    AGENT_SESSION ||--o{ AGENT_EVENT : logs

    DECISION ||--o{ DECISION_OPTION : has
    DECISION }o--o| DECISION : compressed_into

    CLAIM }o--|| AGENT_SESSION : held_by

```

### 3.2 数据库 Schema（PostgreSQL）

> [!IMPORTANT]
> 所有时间戳使用 `TIMESTAMPTZ`，所有 ID 使用 `UUID` 或 `ULID`（时间有序，适合分页）。JSONB 字段用于半结构化扩展数据。

#### 核心表定义

```sql
-- ============================================================
-- 团队与成员
-- ============================================================
CREATE TABLE teams (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    settings      JSONB DEFAULT '{}',  -- authority_policy, notification_prefs
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE members (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    external_id   TEXT,              -- GitHub/GitLab user ID
    display_name  TEXT NOT NULL,
    email         TEXT,
    role          TEXT DEFAULT 'developer', -- admin / developer / viewer
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 仓库
-- ============================================================
CREATE TABLE repos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    platform      TEXT NOT NULL,       -- 'github' | 'gitlab' | 'local'
    external_id   TEXT,                -- GitHub repo ID
    full_name     TEXT NOT NULL,       -- e.g. "org/repo"
    default_branch TEXT DEFAULT 'main',
    webhook_secret TEXT,
    settings      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Goal
-- ============================================================
CREATE TABLE goals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    short_id      TEXT UNIQUE NOT NULL,  -- e.g. "G-102"
    title         TEXT NOT NULL,
    objective     TEXT,
    acceptance    JSONB DEFAULT '[]',    -- 验收条件列表
    owner_id      UUID REFERENCES members(id),
    status        TEXT DEFAULT 'active', -- active | paused | completed | archived
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Agent Session
-- ============================================================
CREATE TABLE agent_sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    member_id     UUID REFERENCES members(id),
    repo_id       UUID REFERENCES repos(id),
    agent_type    TEXT NOT NULL,       -- 'claude_code' | 'cursor' | 'codex' | 'custom'
    agent_name    TEXT,                -- 用户自定义标识, e.g. "agent-17"
    worktree_path TEXT,
    branch_name   TEXT,
    status        TEXT DEFAULT 'active', -- active | idle | completed | disconnected
    metadata      JSONB DEFAULT '{}',
    started_at    TIMESTAMPTZ DEFAULT now(),
    last_heartbeat TIMESTAMPTZ DEFAULT now(),
    ended_at      TIMESTAMPTZ
);

CREATE INDEX idx_agent_sessions_active
    ON agent_sessions(team_id, status) WHERE status = 'active';

-- ============================================================
-- Intent
-- ============================================================
CREATE TABLE intents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID REFERENCES agent_sessions(id) ON DELETE CASCADE,
    change_id     UUID,               -- 后续关联到 Change, 可能为 NULL (早期阶段)
    summary       TEXT NOT NULL,
    details       TEXT,
    status        TEXT DEFAULT 'observed',
        -- observed | exploring | confirmed | implementing | verifying | done | abandoned
    confidence    REAL DEFAULT 0.0,   -- 0.0 ~ 1.0
    likely_scope  JSONB DEFAULT '[]', -- ["AuthService.login", "RetryPolicy"]
    embedding     vector(1536),       -- pgvector, Intent 语义向量
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_intents_embedding
    ON intents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- Change
-- ============================================================
CREATE TABLE changes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    repo_id       UUID REFERENCES repos(id),
    short_id      TEXT UNIQUE NOT NULL,  -- e.g. "CHG-128"
    goal_id       UUID REFERENCES goals(id),

    title         TEXT NOT NULL,
    intent_summary TEXT,
    status        TEXT DEFAULT 'probable',
        -- probable | confirmed | implementing | verifying | completed
        -- | merged | abandoned
    confidence    REAL DEFAULT 0.0,

    likely_scope  JSONB DEFAULT '[]',    -- 预估修改范围
    actual_scope  JSONB DEFAULT '[]',    -- 实际修改范围 (symbols)
    files_read    JSONB DEFAULT '[]',
    files_modified JSONB DEFAULT '[]',

    branch_name   TEXT,
    pr_url        TEXT,
    pr_number     INTEGER,
    merge_commit  TEXT,

    findings      JSONB DEFAULT '[]',    -- 结构化发现
    metadata      JSONB DEFAULT '{}',

    embedding     vector(1536),

    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_changes_active
    ON changes(team_id, status) WHERE status NOT IN ('completed', 'merged', 'abandoned');
CREATE INDEX idx_changes_embedding
    ON changes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_changes_repo
    ON changes(repo_id, status);

-- ============================================================
-- Claim (软租约)
-- ============================================================
CREATE TABLE claims (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id     UUID REFERENCES changes(id) ON DELETE CASCADE,
    session_id    UUID REFERENCES agent_sessions(id) ON DELETE CASCADE,
    scope         JSONB NOT NULL,       -- ["AuthService.login", "RetryPolicy"]
    scope_type    TEXT DEFAULT 'symbol', -- 'symbol' | 'file' | 'directory'
    claim_type    TEXT DEFAULT 'speculative',
        -- speculative (探索性, 权重低, 半衰期短)
        -- committed  (已有实际代码变动, 权重高)
    strength      REAL DEFAULT 0.5,     -- 0.0 ~ 1.0
    expires_at    TIMESTAMPTZ NOT NULL,
    released_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_claims_active
    ON claims(change_id) WHERE released_at IS NULL AND expires_at > now();

-- ============================================================
-- Decision
-- ============================================================
CREATE TABLE decisions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    short_id      TEXT UNIQUE NOT NULL,  -- e.g. "DEC-182"
    question      TEXT NOT NULL,
    context       TEXT,
    raised_by_session UUID REFERENCES agent_sessions(id),

    status        TEXT DEFAULT 'pending',
        -- pending | auto_resolved | human_resolved | deferred | superseded
    authority     TEXT DEFAULT 'human',  -- 'human' | 'agent' | 'auto'
    reversibility TEXT DEFAULT 'medium', -- 'high' | 'medium' | 'low'
    urgency       TEXT DEFAULT 'normal', -- 'blocking' | 'normal' | 'low'

    recommendation TEXT,
    chosen_option  TEXT,
    resolution     TEXT,
    resolved_by    UUID REFERENCES members(id),
    resolved_at    TIMESTAMPTZ,

    -- Decision Compression: 多个 Decision 可合并为一个根 Decision
    parent_decision_id UUID REFERENCES decisions(id),

    -- Decision Memory: 标记是否作为长期策略
    is_policy     BOOLEAN DEFAULT FALSE,
    policy_scope  TEXT,                  -- 'backend/**', 'auth/*'
    policy_rule   TEXT,

    embedding     vector(1536),

    affected_changes JSONB DEFAULT '[]', -- [change_id, ...]
    metadata      JSONB DEFAULT '{}',

    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_decisions_pending
    ON decisions(team_id, status) WHERE status = 'pending';
CREATE INDEX idx_decisions_policy
    ON decisions(team_id) WHERE is_policy = TRUE;

CREATE TABLE decision_options (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id   UUID REFERENCES decisions(id) ON DELETE CASCADE,
    label         TEXT NOT NULL,       -- "Option A", "Option B"
    description   TEXT NOT NULL,
    pros          JSONB DEFAULT '[]',
    cons          JSONB DEFAULT '[]',
    is_recommended BOOLEAN DEFAULT FALSE,
    sort_order    INTEGER DEFAULT 0
);

-- ============================================================
-- Agent Events (观测日志)
-- ============================================================
CREATE TABLE agent_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID REFERENCES agent_sessions(id) ON DELETE CASCADE,
    event_type    TEXT NOT NULL,
        -- 'prompt' | 'plan' | 'tool_call' | 'file_read' | 'file_write'
        -- | 'git_diff' | 'test_run' | 'commit' | 'error' | 'heartbeat'
    payload       JSONB NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- 按时间分区 (月), 避免单表过大
-- CREATE TABLE agent_events_2026_10 PARTITION OF agent_events
--     FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE INDEX idx_agent_events_session
    ON agent_events(session_id, created_at DESC);

-- ============================================================
-- Verification (CI 验证结果)
-- ============================================================
CREATE TABLE verifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id     UUID REFERENCES changes(id) ON DELETE CASCADE,
    suite_name    TEXT NOT NULL,       -- 'typecheck', 'unit', 'integration'
    result        TEXT NOT NULL,       -- 'pass' | 'fail' | 'running' | 'skipped'
    ci_url        TEXT,
    ci_provider   TEXT,               -- 'github_actions' | 'gitlab_ci' | 'jenkins'
    details       JSONB DEFAULT '{}',
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Collision Records (冲突检测结果)
-- ============================================================
CREATE TABLE collisions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    change_a_id   UUID REFERENCES changes(id) ON DELETE CASCADE,
    change_b_id   UUID REFERENCES changes(id) ON DELETE CASCADE,
    level         INTEGER NOT NULL,     -- 1=file, 2=symbol, 3=dependency, 4=semantic
    severity      TEXT DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'critical'
    details       JSONB NOT NULL,       -- 冲突的具体文件/符号/依赖
    status        TEXT DEFAULT 'active', -- 'active' | 'resolved' | 'dismissed'
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Authority Policy (决策权限策略)
-- ============================================================
CREATE TABLE authority_policies (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID REFERENCES teams(id) ON DELETE CASCADE,
    scope         TEXT NOT NULL,         -- 'global', 'backend/**', 'auth/*'
    category      TEXT NOT NULL,         -- 'variable_naming', 'public_api', 'db_schema'
    authority     TEXT NOT NULL,         -- 'agent' | 'human' | 'team_lead'
    conditions    JSONB DEFAULT '{}',    -- 额外条件
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Short ID 序列
-- ============================================================
CREATE SEQUENCE goal_seq START 100;
CREATE SEQUENCE change_seq START 100;
CREATE SEQUENCE decision_seq START 100;
```

### 3.3 Symbol 索引表（高频查询优化）

为支持 **Symbol-level 冲突检测**，需要一张倒排索引表，记录每个 Change 当前涉及的 Symbol：

```sql
CREATE TABLE change_symbols (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id     UUID REFERENCES changes(id) ON DELETE CASCADE,
    repo_id       UUID REFERENCES repos(id),
    symbol_fqn    TEXT NOT NULL,       -- 完全限定名, e.g. "auth.AuthService.login"
    symbol_type   TEXT,                -- 'function' | 'class' | 'method' | 'variable'
    file_path     TEXT NOT NULL,
    line_start    INTEGER,
    line_end      INTEGER,
    access_type   TEXT DEFAULT 'write', -- 'read' | 'write'
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_change_symbols_fqn ON change_symbols(symbol_fqn, access_type);
CREATE INDEX idx_change_symbols_file ON change_symbols(file_path);
CREATE INDEX idx_change_symbols_change ON change_symbols(change_id);
```

---

## 4. Agent Gateway 层

### 4.1 核心职责

Agent Gateway 是所有 Coding Agent 与 DevBoard AI 通信的统一入口。它提供**多协议接入**能力，使得不同类型的 Agent 都能以最自然的方式接入。

### 4.2 接入协议矩阵

| 协议 | 适用 Agent | 实现优先级 | 说明 |
|:---|:---|:---:|:---|
| **MCP Server** | Claude Code, Cline, OpenHands | P0 | 原生 MCP tool，Agent 直接调用 |
| **REST API** | 任意 Agent / 自研 Agent | P0 | 标准 HTTP，最通用 |
| **CLI Hook** | Claude Code (hooks), Git | P0 | 通过 shell script 注入 |
| **Agent SDK (TS)** | Node.js Agent | P1 | 封装 REST，类型安全 |
| **Agent SDK (Python)** | Python Agent | P1 | 封装 REST，Pythonic |
| **IDE Plugin** | VS Code / JetBrains | P2 | 被动收集 Code Signal |
| **WebSocket** | 长连接 Agent | P2 | 实时双向推送 |

### 4.3 MCP Server 实现

MCP Server 是 **MVP 最高优先级**的接入方式。以下是完整的 MCP Tool 定义：

```typescript
// ============================================================
// MCP Tools 定义 (JSON Schema)
// ============================================================

const mcpTools = [
  // ---- Intent & Change ----
  {
    name: "devboard_observe_intent",
    description: "Report what you (the agent) are currently trying to do. " +
      "Call this when you receive a new task or significantly change your plan.",
    inputSchema: {
      type: "object",
      properties: {
        summary:      { type: "string", description: "One-line summary of current intent" },
        details:      { type: "string", description: "Detailed explanation" },
        likely_scope: { type: "array", items: { type: "string" },
                        description: "Symbols/files you expect to modify" },
        goal_hint:    { type: "string", description: "Optional: related goal title" },
        confidence:   { type: "number", description: "0.0-1.0 confidence in intent" },
      },
      required: ["summary"],
    },
  },

  {
    name: "devboard_preflight",
    description: "Check for related work, potential conflicts, and relevant decisions " +
      "BEFORE starting significant code changes. Returns context package.",
    inputSchema: {
      type: "object",
      properties: {
        objective:    { type: "string", description: "What you plan to do" },
        likely_scope: { type: "array", items: { type: "string" },
                        description: "Symbols/files you plan to modify" },
      },
      required: ["objective"],
    },
  },

  {
    name: "devboard_report_progress",
    description: "Report current progress: files changed, findings discovered, " +
      "status updates. Call periodically during long tasks.",
    inputSchema: {
      type: "object",
      properties: {
        files_modified: { type: "array", items: { type: "string" } },
        symbols_modified: { type: "array", items: { type: "string" } },
        findings:     { type: "array", items: { type: "string" },
                        description: "Key discoveries during investigation" },
        status:       { type: "string", enum: ["exploring", "implementing", "verifying", "done"] },
        git_diff_summary: { type: "string" },
      },
    },
  },

  // ---- Claim ----
  {
    name: "devboard_acquire_claim",
    description: "Declare that you intend to modify specific symbols/files. " +
      "This is a soft lease, not a hard lock.",
    inputSchema: {
      type: "object",
      properties: {
        scope:     { type: "array", items: { type: "string" },
                     description: "Symbols or file paths you plan to modify" },
        ttl_minutes: { type: "number", default: 30,
                       description: "How long this claim should last" },
      },
      required: ["scope"],
    },
  },

  {
    name: "devboard_release_claim",
    description: "Release a previously acquired claim.",
    inputSchema: {
      type: "object",
      properties: {
        claim_id: { type: "string" },
      },
      required: ["claim_id"],
    },
  },

  // ---- Decision ----
  {
    name: "devboard_propose_decision",
    description: "Propose a decision that may require human judgment. " +
      "Include options with pros/cons. Low-risk decisions may be auto-resolved.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The decision question" },
        context:  { type: "string", description: "Why this decision matters" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label:       { type: "string" },
              description: { type: "string" },
              pros:        { type: "array", items: { type: "string" } },
              cons:        { type: "array", items: { type: "string" } },
            },
            required: ["label", "description"],
          },
        },
        recommendation:  { type: "string" },
        reversibility:   { type: "string", enum: ["high", "medium", "low"] },
        blocking:        { type: "boolean", default: false,
                           description: "If true, agent should wait for resolution" },
      },
      required: ["question", "options"],
    },
  },

  {
    name: "devboard_check_decision",
    description: "Check if a pending decision has been resolved.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string" },
      },
      required: ["decision_id"],
    },
  },

  // ---- Findings ----
  {
    name: "devboard_publish_findings",
    description: "Publish structured findings for other agents to consume.",
    inputSchema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { type: "string" } },
        tags:     { type: "array", items: { type: "string" } },
      },
      required: ["findings"],
    },
  },

  {
    name: "devboard_get_findings",
    description: "Retrieve findings from a specific change or related work.",
    inputSchema: {
      type: "object",
      properties: {
        change_id: { type: "string" },
        tags:      { type: "array", items: { type: "string" } },
      },
    },
  },

  // ---- Context ----
  {
    name: "devboard_get_context",
    description: "Get full context package: active work, decisions, constraints, " +
      "findings, potential conflicts relevant to your current task.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "array", items: { type: "string" },
                 description: "Optional: filter context by scope" },
      },
    },
  },

  // ---- Query ----
  {
    name: "devboard_query_active_work",
    description: "Query what the team is currently working on.",
    inputSchema: {
      type: "object",
      properties: {
        scope_filter: { type: "array", items: { type: "string" },
                        description: "Optional: filter by symbols/files" },
        status_filter: { type: "array", items: { type: "string" },
                         description: "Optional: filter by status" },
      },
    },
  },
];
```

### 4.4 CLI Hook 集成 (Claude Code 示例)

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "command": "devboard-cli preflight --scope=\"$TOOL_INPUT\""
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "command": "devboard-cli report-progress --auto-detect"
      }
    ],
    "SessionStart": [
      {
        "command": "devboard-cli session start --agent-type=claude_code"
      }
    ],
    "SessionEnd": [
      {
        "command": "devboard-cli session end"
      }
    ]
  }
}
```

### 4.5 REST API 概览

```
POST   /api/v1/sessions                    创建 Agent Session
PATCH  /api/v1/sessions/:id                更新 Session 状态
DELETE /api/v1/sessions/:id                结束 Session

POST   /api/v1/intents                     上报 Intent
PATCH  /api/v1/intents/:id                 更新 Intent

POST   /api/v1/changes                     创建/自动生成 Change
GET    /api/v1/changes                     查询活跃 Changes
GET    /api/v1/changes/:id                 获取 Change 详情
PATCH  /api/v1/changes/:id                 更新 Change
GET    /api/v1/changes/:id/findings        获取 Findings

POST   /api/v1/preflight                   协作预检
POST   /api/v1/claims                      获取 Claim
DELETE /api/v1/claims/:id                  释放 Claim

POST   /api/v1/decisions                   提出 Decision
GET    /api/v1/decisions                   查询 Decisions
PATCH  /api/v1/decisions/:id/resolve       解决 Decision

GET    /api/v1/teams/:id/atlas             团队全景 (首页数据)
GET    /api/v1/teams/:id/graph             Change Graph

POST   /api/v1/webhooks/github             GitHub Webhook
POST   /api/v1/webhooks/gitlab             GitLab Webhook

GET    /api/v1/stream/events               SSE 实时事件流
```

---

## 5. Agent Observer 模块

### 5.1 架构设计

Agent Observer 的目标是**从异构 Agent 行为中提取结构化信号**，而不是完整记录对话。

```
┌─────────────────────────────────────────────┐
│             Agent Observer Pipeline          │
│                                             │
│  Raw Signal → Normalize → Extract → Enrich  │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ MCP Event│  │ CLI Hook │  │ Git Watch│  │
│  │ Collector│  │ Collector│  │   er     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       └──────────────┼──────────────┘        │
│                      ▼                       │
│              Signal Normalizer               │
│                      ▼                       │
│              Intent Extractor                │
│                (LLM / Rules)                 │
│                      ▼                       │
│             Scope Enricher                   │
│              (Tree-sitter)                   │
│                      ▼                       │
│          Event Store (agent_events)          │
└─────────────────────────────────────────────┘
```

### 5.2 信号提取规则

```typescript
interface AgentSignal {
  sessionId: string;
  timestamp: Date;
  signalType: 'intent' | 'code' | 'discovery';
  data: IntentSignal | CodeSignal | DiscoverySignal;
}

interface IntentSignal {
  userPrompt?: string;         // 用户原始输入
  agentPlan?: string;          // Agent 的执行计划
  hypothesis?: string;         // Agent 的当前假设
  likelyScope?: string[];      // Agent 预估修改范围
}

interface CodeSignal {
  filesRead: string[];
  filesModified: string[];
  symbolsModified: SymbolRef[];
  gitDiff?: string;
  testResults?: TestResult[];
  commits?: CommitInfo[];
}

interface DiscoverySignal {
  findings: string[];
  errorFingerprint?: string;
  relatedTraces?: string[];
}
```

### 5.3 Intent 提取策略

```typescript
async function extractIntent(signals: AgentSignal[]): Promise<Intent> {
  // 策略 1: 如果有显式的 MCP observe_intent 调用, 直接使用
  const explicit = signals.find(s => s.signalType === 'intent' && s.data.userPrompt);
  if (explicit) {
    return {
      summary: explicit.data.userPrompt,
      confidence: 0.9,
      source: 'explicit',
    };
  }

  // 策略 2: 从 CLI Hook 捕获的 Agent Plan 中提取
  const planSignal = signals.find(s => s.data.agentPlan);
  if (planSignal) {
    const summary = await llm.summarize(planSignal.data.agentPlan, {
      instruction: "Extract the core intent in one sentence. " +
        "Focus on WHAT the developer wants to achieve, not HOW.",
      maxTokens: 100,
    });
    return { summary, confidence: 0.7, source: 'plan_inference' };
  }

  // 策略 3: 从 Git Diff + Modified Files 逆推
  const codeSignals = signals.filter(s => s.signalType === 'code');
  if (codeSignals.length > 0) {
    const files = [...new Set(codeSignals.flatMap(s => s.data.filesModified))];
    const diff = codeSignals.map(s => s.data.gitDiff).filter(Boolean).join('\n');
    const summary = await llm.summarize(
      `Files: ${files.join(', ')}\nDiff:\n${diff.slice(0, 4000)}`,
      { instruction: "What change is being made? One sentence.", maxTokens: 100 }
    );
    return { summary, confidence: 0.4, source: 'code_inference' };
  }

  return { summary: 'Unknown intent', confidence: 0.1, source: 'none' };
}
```

---

## 6. Intent Service — 意图理解引擎

### 6.1 核心流程

```mermaid
flowchart TD
    A["接收 Intent Signal"] --> B{"有显式 Prompt?"}
    B -- Yes --> C["提取摘要 & Embedding"]
    B -- No --> D["从 Code Signal 逆推"]
    D --> C
    C --> E["pgvector 相似度搜索"]
    E --> F{"存在高相似 Intent?\n(cosine > 0.85)"}
    F -- Yes --> G["标记 Related Work\n关联已有 Change"]
    F -- No --> H["创建新 Intent\n绑定新 Change"]
    G --> I["返回 Related Work\n+ Findings"]
    H --> I
```

### 6.2 关键算法 — 多维度相似匹配

```typescript
interface SimilarityResult {
  changeId: string;
  overallScore: number;
  breakdown: {
    semanticScore: number;     // Intent 向量余弦相似度
    scopeOverlap: number;      // Jaccard(likely_scope_A, likely_scope_B)
    fileOverlap: number;       // Jaccard(files_A, files_B)
    symbolOverlap: number;     // Jaccard(symbols_A, symbols_B)
    errorFingerprint: number;  // 错误指纹匹配 (0 or 1)
  };
}

async function findSimilarWork(
  intent: Intent,
  teamId: string
): Promise<SimilarityResult[]> {

  // Step 1: 语义向量召回 (粗筛, Top 20)
  const candidates = await db.query(`
    SELECT c.id, c.likely_scope, c.actual_scope, c.files_modified,
           c.intent_summary, c.embedding,
           1 - (c.embedding <=> $1) AS semantic_score
    FROM changes c
    WHERE c.team_id = $2
      AND c.status NOT IN ('completed', 'merged', 'abandoned')
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> $1
    LIMIT 20
  `, [intent.embedding, teamId]);

  // Step 2: 多维度精排
  return candidates.map(c => {
    const semanticScore = c.semantic_score;
    const scopeOverlap = jaccard(intent.likelyScope, [
      ...jsonParse(c.likely_scope), ...jsonParse(c.actual_scope)
    ]);
    const fileOverlap = jaccard(
      intent.filesHint || [],
      jsonParse(c.files_modified)
    );
    const symbolOverlap = jaccard(
      intent.symbolsHint || [],
      jsonParse(c.actual_scope)
    );

    // 加权得分
    const overallScore =
      semanticScore * 0.35 +
      scopeOverlap  * 0.25 +
      fileOverlap   * 0.15 +
      symbolOverlap * 0.25;

    return {
      changeId: c.id,
      overallScore,
      breakdown: { semanticScore, scopeOverlap, fileOverlap, symbolOverlap, errorFingerprint: 0 },
    };
  })
  .filter(r => r.overallScore > 0.5)
  .sort((a, b) => b.overallScore - a.overallScore);
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
```

---

## 7. Change Service — 变更生命周期管理

### 7.1 Change 状态机

```mermaid
stateDiagram-v2
    [*] --> Probable: Intent 被检测到
    Probable --> Confirmed: Agent 确认计划\n或开始修改文件
    Probable --> Abandoned: Agent 放弃\n或 Session 超时
    Confirmed --> Implementing: 有实际代码 Diff
    Implementing --> Verifying: 提交 PR\n或运行测试
    Verifying --> Implementing: 测试失败\nAgent 重新修改
    Verifying --> Completed: 所有验证通过
    Completed --> Merged: PR Merged
    Implementing --> Abandoned: Agent 放弃
    Confirmed --> Abandoned: 超时
```

### 7.2 自动 Change 生成逻辑

```typescript
async function processIntentForChange(intent: Intent, session: AgentSession) {
  // 1. 查找是否应该关联到已有 Change
  const similar = await findSimilarWork(intent, session.teamId);
  const bestMatch = similar[0];

  if (bestMatch && bestMatch.overallScore > 0.85) {
    // 高置信度匹配: 关联到已有 Change, 不创建新的
    await db.update('intents', intent.id, { change_id: bestMatch.changeId });

    // 通知 Agent: 发现高度相似的进行中工作
    return {
      action: 'join_existing',
      change: await getChangeDetails(bestMatch.changeId),
      findings: await getFindings(bestMatch.changeId),
    };
  }

  if (bestMatch && bestMatch.overallScore > 0.5) {
    // 中等置信度: 创建新 Change, 但标记 Related
    const change = await createChange(intent, session);
    await createCollision(change.id, bestMatch.changeId, 'related');
    return {
      action: 'new_change_with_related',
      change,
      relatedWork: [bestMatch],
    };
  }

  // 无匹配: 创建全新 Change
  const change = await createChange(intent, session);
  return { action: 'new_change', change };
}

async function createChange(intent: Intent, session: AgentSession) {
  const shortId = `CHG-${await nextVal('change_seq')}`;
  return db.insert('changes', {
    id: uuid(),
    team_id: session.teamId,
    repo_id: session.repoId,
    short_id: shortId,
    title: intent.summary,
    intent_summary: intent.summary,
    status: 'probable',
    confidence: intent.confidence,
    likely_scope: intent.likelyScope,
    embedding: intent.embedding,
  });
}
```

### 7.3 Change 自动更新 (Progressive Enrichment)

Change 的字段随着 Agent 行为逐步丰富，不需要一次性填充：

| 阶段 | 触发事件 | 自动更新字段 |
|:---|:---|:---|
| **Intent 检测** | `observe_intent` | `title`, `intent_summary`, `likely_scope`, `embedding` |
| **代码探索** | `file_read` 事件 | `files_read`, confidence ↑ |
| **开始修改** | `file_write` 事件 | `files_modified`, `actual_scope`, status → `implementing` |
| **Symbol 分析** | Tree-sitter 异步 Worker | `actual_scope` 精化为 Symbol 级 |
| **发现上报** | `publish_findings` | `findings` |
| **提交 Commit** | Git Hook | `branch_name`, Commit 关联 |
| **创建 PR** | GitHub Webhook | `pr_url`, `pr_number`, status → `verifying` |
| **CI 结果** | CI Webhook | Verification 记录 |
| **PR Merged** | GitHub Webhook | `merge_commit`, status → `merged` |

---

## 8. Conflict Engine — 分层冲突检测

### 8.1 四级冲突检测架构

```mermaid
flowchart LR
    subgraph L1["Level 1: File"]
        F["文件路径交集"]
    end
    subgraph L2["Level 2: Symbol"]
        S["Symbol FQN 交集"]
    end
    subgraph L3["Level 3: Dependency"]
        D["调用图/导入图\n上下游重叠"]
    end
    subgraph L4["Level 4: Semantic"]
        SM["语义意图冲突\n(LLM 判断)"]
    end

    F --> S --> D --> SM
```

### 8.2 各级检测实现

```typescript
// ==================================================
// Level 1: File Collision — O(n²) 但实际稀疏
// ==================================================
async function detectFileCollisions(teamId: string): Promise<Collision[]> {
  return db.query(`
    SELECT
      a.id AS change_a, b.id AS change_b,
      a.short_id AS a_sid, b.short_id AS b_sid,
      jsonb_array_elements_text(a.files_modified) AS shared_file
    FROM changes a
    CROSS JOIN changes b
    WHERE a.team_id = $1
      AND b.team_id = $1
      AND a.id < b.id
      AND a.status NOT IN ('completed','merged','abandoned')
      AND b.status NOT IN ('completed','merged','abandoned')
      AND a.files_modified ?| ARRAY(
            SELECT jsonb_array_elements_text(b.files_modified)
          )
  `, [teamId]);
}

// ==================================================
// Level 2: Symbol Collision — 基于倒排索引
// ==================================================
async function detectSymbolCollisions(teamId: string): Promise<Collision[]> {
  return db.query(`
    SELECT
      cs1.change_id AS change_a,
      cs2.change_id AS change_b,
      cs1.symbol_fqn,
      cs1.file_path
    FROM change_symbols cs1
    JOIN change_symbols cs2
      ON cs1.symbol_fqn = cs2.symbol_fqn
      AND cs1.change_id < cs2.change_id
    JOIN changes c1 ON c1.id = cs1.change_id AND c1.team_id = $1
    JOIN changes c2 ON c2.id = cs2.change_id AND c2.team_id = $1
    WHERE cs1.access_type = 'write'
      AND cs2.access_type = 'write'
      AND c1.status NOT IN ('completed','merged','abandoned')
      AND c2.status NOT IN ('completed','merged','abandoned')
  `, [teamId]);
}

// ==================================================
// Level 3: Dependency Collision — 调用图交叉
// ==================================================
// 使用 Tree-sitter 提取的 import/call graph
// A 修改了 Symbol X，B 消费了 Symbol X
async function detectDependencyCollisions(teamId: string): Promise<Collision[]> {
  return db.query(`
    SELECT
      writer.change_id AS change_a,
      reader.change_id AS change_b,
      writer.symbol_fqn,
      'dependency' AS collision_type
    FROM change_symbols writer
    JOIN change_symbols reader
      ON writer.symbol_fqn = reader.symbol_fqn
      AND writer.change_id != reader.change_id
    JOIN changes cw ON cw.id = writer.change_id AND cw.team_id = $1
    JOIN changes cr ON cr.id = reader.change_id AND cr.team_id = $1
    WHERE writer.access_type = 'write'
      AND reader.access_type = 'read'
      AND cw.status NOT IN ('completed','merged','abandoned')
      AND cr.status NOT IN ('completed','merged','abandoned')
  `, [teamId]);
}

// ==================================================
// Level 4: Semantic Collision — LLM 辅助判定
// ==================================================
// 仅在 Level 1-3 检出冲突且 Agent 活跃修改时触发
// 成本较高, 需要节流
async function detectSemanticCollision(
  changeA: Change, changeB: Change
): Promise<SemanticCollisionResult | null> {
  const prompt = `
You are a code conflict analyzer.

Change A: "${changeA.intentSummary}"
  Modified: ${changeA.actualScope.join(', ')}
  Findings: ${changeA.findings.join('; ')}

Change B: "${changeB.intentSummary}"
  Modified: ${changeB.actualScope.join(', ')}
  Findings: ${changeB.findings.join('; ')}

Question: Do these two changes have a SEMANTIC conflict?
A semantic conflict means they may merge cleanly at the text level
but break each other's assumptions or behavior.

Respond in JSON:
{
  "has_conflict": boolean,
  "confidence": 0.0-1.0,
  "explanation": "...",
  "severity": "low" | "medium" | "high"
}`;

  const result = await llm.complete(prompt, { responseFormat: 'json', maxTokens: 300 });
  return result.has_conflict ? result : null;
}
```

### 8.3 冲突检测调度策略

| 触发条件 | 执行的级别 | 延迟 | 频率限制 |
|:---|:---|:---|:---|
| Change 创建 / Intent 更新 | L1 + L2 | 即时 | 无 |
| `files_modified` 更新 | L1 | < 1s | 每 Change 每 5s 最多 1 次 |
| `change_symbols` 更新 | L2 + L3 | < 3s | 每 Change 每 10s 最多 1 次 |
| L1-L3 命中 + 两个 Change 都在 active | L4 | < 30s | 每对 Change 每 10min 最多 1 次 |

---

## 9. Similarity Engine — 重复工作检测

### 9.1 检测触发时机

```
Intent 上报 → 立即触发
Change 状态更新 → 5s 防抖后触发
周期扫描 → 每 5 分钟全量活跃 Change 互相比较
```

### 9.2 告警阈值与降噪

```typescript
const SIMILARITY_THRESHOLDS = {
  // 高置信度: 直接告警 + 通知 Agent
  HIGH: 0.85,
  // 中置信度: 静默关联 (Silent Linking), 不打断 Agent
  MEDIUM: 0.50,
  // 低置信度: 忽略
  LOW: 0.30,
};

// 降噪规则:
// 1. 同一 Member 的不同 Session 之间不告警 (自己跟自己不重复)
// 2. 同一 Goal 下的 Changes 降低告警权重 (预期有关联)
// 3. 最近 1 小时已告警过的 Change 对不重复告警
// 4. 仅 semantic 相似但 scope 完全不重叠的, 降级为静默关联
```

---

## 10. Decision Service — 决策治理引擎

### 10.1 Decision 处理流水线

```mermaid
flowchart TD
    A["Agent 提出 Decision"] --> B{"Decision Memory 命中?"}
    B -- Yes --> C["自动回复已有策略\n(auto_resolved)"]
    B -- No --> D{"Authority Policy\n允许 Agent 自决?"}
    D -- Yes --> E["Agent 自行决定\n记录 Decision"]
    D -- No --> F{"可否与已有\nPending Decision 合并?"}
    F -- Yes --> G["Decision Compression\n合并到父 Decision"]
    F -- No --> H["创建独立 Decision"]
    G --> I["推送到 Decision Inbox"]
    H --> I
    I --> J["人工裁决"]
    J --> K["广播 Resolution\n到受影响 Changes/Agents"]
    K --> L["评估是否转为\n长期 Policy"]
```

### 10.2 Decision Memory — 策略匹配

```typescript
async function checkDecisionMemory(
  question: string,
  scope: string[],
  embedding: number[]
): Promise<Decision | null> {

  // 1. 精确 scope 匹配 (路径前缀)
  const scopeMatches = await db.query(`
    SELECT * FROM decisions
    WHERE is_policy = TRUE
      AND status IN ('human_resolved', 'auto_resolved')
      AND ($1 LIKE policy_scope || '%' OR policy_scope = 'global')
    ORDER BY created_at DESC
  `, [scope[0]]);

  // 2. 语义匹配 (向量搜索)
  const semanticMatches = await db.query(`
    SELECT *, 1 - (embedding <=> $1) AS score
    FROM decisions
    WHERE is_policy = TRUE
      AND status IN ('human_resolved', 'auto_resolved')
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1
    LIMIT 5
  `, [embedding]);

  // 3. 合并结果, 最高分且 > 0.8 视为命中
  const best = [...scopeMatches, ...semanticMatches]
    .sort((a, b) => (b.score || 0.9) - (a.score || 0.9))[0];

  return best && (best.score || 0.9) > 0.8 ? best : null;
}
```

### 10.3 Decision Compression (LLM 驱动)

```typescript
async function compressDecisions(
  pendingDecisions: Decision[]
): Promise<CompressedDecision[]> {
  if (pendingDecisions.length < 2) return [];

  const prompt = `
You are analyzing pending engineering decisions to find ones that share
a common root question.

Decisions:
${pendingDecisions.map((d, i) => `${i+1}. [${d.shortId}] ${d.question}`).join('\n')}

Identify groups of decisions that are really asking the same underlying question.
For each group, provide:
1. The root question that subsumes all members
2. Which decision IDs belong in this group
3. A unified set of options

Respond in JSON:
{
  "groups": [
    {
      "root_question": "...",
      "member_ids": ["DEC-182", "DEC-185"],
      "unified_options": [
        { "label": "...", "description": "..." }
      ]
    }
  ]
}`;

  const result = await llm.complete(prompt, { responseFormat: 'json' });
  return result.groups;
}
```

### 10.4 Authority Policy Engine

```typescript
interface AuthorityCheck {
  category: string;
  authority: 'agent' | 'human' | 'team_lead';
  matchedPolicy?: AuthorityPolicy;
}

async function checkAuthority(
  teamId: string,
  decision: Decision,
  changeScope: string[]
): Promise<AuthorityCheck> {

  // 1. 硬编码高风险规则 (不可被策略覆盖)
  const HARD_RULES: Record<string, string> = {
    'public_api_break': 'human',
    'database_migration': 'human',
    'security_credential': 'human',
    'license_change': 'human',
  };

  // 检测是否命中硬编码规则
  const hardCategory = detectHardCategory(decision, changeScope);
  if (hardCategory && HARD_RULES[hardCategory]) {
    return { category: hardCategory, authority: HARD_RULES[hardCategory] as any };
  }

  // 2. 查询团队自定义策略
  const policies = await db.query(`
    SELECT * FROM authority_policies
    WHERE team_id = $1
    ORDER BY
      CASE WHEN scope = 'global' THEN 1 ELSE 0 END,
      length(scope) DESC  -- 更具体的 scope 优先
  `, [teamId]);

  for (const policy of policies) {
    if (matchesScope(changeScope, policy.scope) &&
        matchesCategory(decision, policy.category)) {
      return {
        category: policy.category,
        authority: policy.authority,
        matchedPolicy: policy,
      };
    }
  }

  // 3. 默认: 人工决定
  return { category: 'unknown', authority: 'human' };
}

function detectHardCategory(decision: Decision, scope: string[]): string | null {
  const q = decision.question.toLowerCase();
  const ctx = (decision.context || '').toLowerCase();

  if (q.includes('public api') || q.includes('breaking change')) return 'public_api_break';
  if (q.includes('migration') || q.includes('schema')) return 'database_migration';
  if (q.includes('secret') || q.includes('credential') || q.includes('api key'))
    return 'security_credential';

  // 检测 scope 中是否包含高风险路径
  if (scope.some(s => s.match(/migrations?\//i))) return 'database_migration';

  return null;
}
```

---

## 11. Context Compiler — 上下文编译器

### 11.1 Context Package 结构

```typescript
interface ContextPackage {
  // 当前工作
  currentChange?: ChangeSummary;
  goal?: GoalSummary;

  // 团队态势感知
  relatedWork: RelatedWorkItem[];
  potentialCollisions: CollisionItem[];

  // 决策上下文
  relevantDecisions: DecisionSummary[];  // 活跃策略
  pendingDecisions: DecisionSummary[];   // 等待中的决策

  // 知识复用
  knownFindings: Finding[];

  // 约束
  constraints: string[];

  // 代码上下文
  relevantTests: string[];
  activeClaims: ClaimSummary[];
}
```

### 11.2 编译逻辑

```typescript
async function compileContext(
  sessionId: string,
  scope?: string[]
): Promise<ContextPackage> {
  const session = await getSession(sessionId);
  const change = await getActiveChangeForSession(sessionId);
  const teamId = session.teamId;

  // 并行获取所有上下文
  const [
    relatedWork,
    collisions,
    decisions,
    findings,
    claims,
    policies,
  ] = await Promise.all([
    // 相关工作 (基于当前 Change 的 embedding)
    change
      ? findSimilarWork(change, teamId)
      : [],

    // 潜在冲突
    change
      ? detectCollisionsForChange(change.id, teamId)
      : [],

    // 相关决策 (活跃策略 + scope 匹配)
    findRelevantDecisions(teamId, scope || change?.actualScope || []),

    // 可复用的 Findings
    findRelevantFindings(teamId, scope || change?.actualScope || []),

    // 活跃 Claim
    getActiveClaimsInScope(teamId, scope || []),

    // Authority Policy
    getAuthorityPolicies(teamId, scope || []),
  ]);

  // 从 policies 提取约束
  const constraints = policies
    .filter(p => p.authority === 'human')
    .map(p => `${p.category}: requires human decision`);

  // 组装 Context Package (控制总 token 数, 避免过长)
  return truncateContextPackage({
    currentChange: change ? summarizeChange(change) : undefined,
    goal: change?.goalId ? await getGoal(change.goalId) : undefined,
    relatedWork: relatedWork.slice(0, 5),
    potentialCollisions: collisions.slice(0, 5),
    relevantDecisions: decisions.filter(d => d.isPolicy).slice(0, 10),
    pendingDecisions: decisions.filter(d => d.status === 'pending').slice(0, 5),
    knownFindings: findings.slice(0, 10),
    constraints,
    relevantTests: [],  // TODO: 从 Change scope 推断
    activeClaims: claims.slice(0, 10),
  }, MAX_CONTEXT_TOKENS);
}
```

---

## 12. Git Integration 层

### 12.1 GitHub Webhook 处理

```typescript
const GITHUB_EVENTS = {
  // PR 事件
  'pull_request.opened': async (payload) => {
    const change = await findChangeByBranch(payload.pull_request.head.ref);
    if (change) {
      await updateChange(change.id, {
        pr_url: payload.pull_request.html_url,
        pr_number: payload.pull_request.number,
        status: 'verifying',
      });
    }
  },

  'pull_request.closed': async (payload) => {
    if (payload.pull_request.merged) {
      const change = await findChangeByPR(payload.pull_request.number);
      if (change) {
        await updateChange(change.id, {
          merge_commit: payload.pull_request.merge_commit_sha,
          status: 'merged',
        });
        // 释放所有关联 Claim
        await releaseAllClaims(change.id);
      }
    }
  },

  // Push 事件 (Commit 追踪)
  'push': async (payload) => {
    const branch = payload.ref.replace('refs/heads/', '');
    const change = await findChangeByBranch(branch);
    if (change) {
      // 分析新 Commit 的 diff, 更新 actual_scope
      for (const commit of payload.commits) {
        await enqueueJob('analyze_commit', {
          changeId: change.id,
          commitSha: commit.id,
          filesAdded: commit.added,
          filesModified: commit.modified,
          filesRemoved: commit.removed,
        });
      }
    }
  },

  // CI Status (Check Suite)
  'check_suite.completed': async (payload) => {
    const branch = payload.check_suite.head_branch;
    const change = await findChangeByBranch(branch);
    if (change) {
      await recordVerification(change.id, {
        suiteName: payload.check_suite.app.name,
        result: payload.check_suite.conclusion === 'success' ? 'pass' : 'fail',
        ciUrl: payload.check_suite.url,
        ciProvider: 'github_actions',
      });
    }
  },
};
```

### 12.2 Local Git Watcher (针对无 Webhook 的场景)

```typescript
// 使用 chokidar + simple-git 监控本地 Git 仓库
import { watch } from 'chokidar';
import simpleGit from 'simple-git';

class LocalGitWatcher {
  private git: SimpleGit;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private repoPath: string, private sessionId: string) {
    this.git = simpleGit(repoPath);
  }

  start() {
    // 监控 .git/refs/heads/ 和工作区文件变化
    const watcher = watch([
      `${this.repoPath}/.git/refs/heads/`,
      `${this.repoPath}/**/*.{ts,js,py,go,rs,java}`,
    ], {
      ignored: /node_modules|\.git\/objects/,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 1000 },
    });

    watcher.on('change', (filePath) => {
      this.debouncedAnalyze();
    });
  }

  private debouncedAnalyze() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.analyze(), 3000);
  }

  private async analyze() {
    const status = await this.git.status();
    const diff = await this.git.diff();
    const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);

    await reportProgress(this.sessionId, {
      branch,
      filesModified: status.modified,
      filesCreated: status.created,
      diffSummary: diff.slice(0, 10000),
    });
  }
}
```

---

## 13. CI / Verification 集成

### 13.1 设计原则

> [!IMPORTANT]
> **第一阶段不自建 CI**。DevBoard AI 只做 CI 结果的消费者和记录者，不做 CI 的触发者和执行者。

### 13.2 集成方式

| CI 系统 | 集成方式 | 数据获取 |
|:---|:---|:---|
| GitHub Actions | Webhook (`check_suite`, `workflow_run`) | 自动 |
| GitLab CI | Webhook (`Pipeline Hook`) | 自动 |
| Jenkins | Jenkins Notification Plugin / HTTP POST | 需配置 |
| Buildkite | Webhook | 自动 |
| 通用 | REST API `POST /api/v1/verifications` | 手动 |

### 13.3 Verification Planner (Phase 2)

```typescript
// Phase 2 功能: 根据 Change Scope 智能选择验证集合
async function planVerification(change: Change): Promise<VerificationPlan> {
  const impactedModules = analyzeImpact(change.actualScope);

  return {
    required: [
      { suite: 'typecheck', reason: 'Always required' },
      ...impactedModules.map(m => ({
        suite: `${m}/unit`,
        reason: `Module ${m} was modified`,
      })),
    ],
    recommended: impactedModules.flatMap(m =>
      getDownstreamModules(m).map(dm => ({
        suite: `${dm}/integration`,
        reason: `Downstream of modified module ${m}`,
      }))
    ),
    skippable: [
      { suite: 'e2e/full', reason: 'No UI changes detected' },
    ],
  };
}
```

---

## 14. 前端与 UI 架构

### 14.1 技术方案

| 层级 | 选型 |
|:---|:---|
| 框架 | Next.js 15 (App Router, RSC) |
| 样式 | Tailwind CSS + shadcn/ui |
| 状态管理 | React Server Components + SWR (客户端) |
| 实时更新 | SSE (EventSource) |
| 图表 | D3.js (Change Graph) |
| 认证 | NextAuth.js (GitHub/GitLab OAuth) |

### 14.2 页面路由结构

```
/                           → 重定向到 /team/:slug
/login                      → OAuth 登录

/team/:slug                 → Project Atlas (首页)
  ├── ?tab=decisions        → Decision Inbox
  ├── ?tab=collisions       → 活跃冲突列表
  └── ?tab=duplicates       → 重复工作告警

/team/:slug/changes         → 所有 Changes
/team/:slug/changes/:id     → Change Detail
/team/:slug/decisions/:id   → Decision Detail
/team/:slug/goals           → Goals 列表
/team/:slug/goals/:id       → Goal Detail & Change Graph
/team/:slug/graph           → 全局 Change Graph (可视化)
/team/:slug/agents          → Agent Sessions 实时状态
/team/:slug/settings        → 团队设置 & Authority Policy
```

### 14.3 首页数据结构 (Project Atlas API)

```typescript
// GET /api/v1/teams/:slug/atlas
interface ProjectAtlas {
  summary: {
    activeAgents: number;
    activeChanges: number;
    pendingDecisions: number;
    activeCollisions: number;
    duplicateAlerts: number;
  };

  needsDecision: Decision[];        // Top 5, 按 urgency 排序
  activeWork: ChangeWithAgent[];    // 按 Goal 分组
  duplicateAlerts: DuplicateAlert[];
  collisions: Collision[];

  // 北极星指标 (过去 24h / 7d / 30d)
  metrics: {
    humanDecisionLeverage: number;  // accepted_changes / human_decisions
    duplicatesAvoided: number;
    collisionsDetectedBeforeMerge: number;
    decisionReuseRate: number;
    humanInterruptionsPerChange: number;
  };
}
```

---

## 15. 安全与权限模型

### 15.1 认证

```
OAuth 2.0 Flow:
Developer → GitHub/GitLab OAuth → JWT (access + refresh token)
Agent     → API Key (per team, per repo)
Webhook   → HMAC-SHA256 签名验证
MCP       → 本地 Unix Socket 或 API Key
```

### 15.2 权限矩阵

| 操作 | Admin | Developer | Viewer | Agent |
|:---|:---:|:---:|:---:|:---:|
| 查看 Atlas / Changes | ✅ | ✅ | ✅ | — |
| 创建/更新 Intent | ✅ | ✅ | — | ✅ |
| 管理 Claims | ✅ | ✅ | — | ✅ |
| 提出 Decision | ✅ | ✅ | — | ✅ |
| 解决 Decision | ✅ | ✅ | — | — |
| 管理 Goals | ✅ | ✅ | — | — |
| 修改 Authority Policy | ✅ | — | — | — |
| 团队设置 | ✅ | — | — | — |

### 15.3 API Key 管理

```typescript
// API Key 格式: dvb_{team_slug}_{random_32_chars}
// 存储: bcrypt hash in database
// 传递: Authorization: Bearer dvb_myteam_xxxx
//   或: X-DevBoard-Key: dvb_myteam_xxxx

// Agent SDK 初始化示例
const devboard = new DevBoardClient({
  apiKey: process.env.DEVBOARD_API_KEY,
  teamSlug: 'my-team',
  repoFullName: 'org/my-repo',
});
```

---

## 16. 部署与运维架构

### 16.1 Phase 1: Docker Compose (单机部署)

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"       # Web UI + API
      - "3001:3001"       # MCP Server (stdio/sse)
    environment:
      DATABASE_URL: postgres://devboard:password@postgres:5432/devboard
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      JWT_SECRET: ${JWT_SECRET}
    depends_on:
      - postgres
      - redis

  worker:
    build: .
    command: ["node", "dist/worker.js"]
    environment:
      DATABASE_URL: postgres://devboard:password@postgres:5432/devboard
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    depends_on:
      - postgres
      - redis

  postgres:
    image: pgvector/pgvector:pg16
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: devboard
      POSTGRES_USER: devboard
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

### 16.2 Phase 2: Kubernetes (团队/企业部署)

```
┌──────────────────────────────────────────┐
│              Kubernetes Cluster          │
│                                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │  API     │  │  Worker  │  │  Web UI │  │
│  │ (3 pods) │  │ (2 pods) │  │ (2 pods)│  │
│  └────┬─────┘  └────┬─────┘  └────┬────┘  │
│       │              │             │       │
│  ┌────┴──────────────┴─────────────┘       │
│  │        Internal Service Mesh            │
│  └────┬──────────────┬─────────────┐       │
│  ┌────┴─────┐  ┌─────┴────┐  ┌────┴────┐  │
│  │PostgreSQL│  │  Redis    │  │  PgBouncer│ │
│  │ (HA)     │  │ (Sentinel)│  │          │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│                                            │
│  Ingress: nginx / Cloudflare Tunnel        │
└──────────────────────────────────────────┘
```

---

## 17. 可观测性与监控

### 17.1 核心指标 (Prometheus / Grafana)

```
# 业务指标
devboard_active_agents_total{team}
devboard_active_changes_total{team, status}
devboard_pending_decisions_total{team}
devboard_active_collisions_total{team, level}
devboard_duplicate_alerts_total{team}

# 北极星指标
devboard_human_decision_leverage{team, period}
devboard_duplicates_avoided_total{team}
devboard_collisions_detected_before_merge_total{team}

# 性能指标
devboard_api_request_duration_seconds{method, path, status}
devboard_similarity_search_duration_seconds
devboard_conflict_detection_duration_seconds{level}
devboard_embedding_generation_duration_seconds

# Worker 指标
devboard_worker_queue_depth{queue_name}
devboard_worker_job_duration_seconds{job_type}
devboard_worker_job_failures_total{job_type}
```

### 17.2 日志策略

| 事件类型 | 日志级别 | 存储 |
|:---|:---|:---|
| API 请求 | INFO | stdout → Loki / CloudWatch |
| Agent 事件 (原始) | DEBUG | `agent_events` 表 (月分区) |
| 冲突检测结果 | INFO | `collisions` 表 + 日志 |
| Decision 生命周期 | INFO | 结构化日志 |
| LLM 调用 | DEBUG | 日志 (含 token 用量) |
| 错误 / 异常 | ERROR | Sentry |

---

## 18. 分阶段开发路线图

### Phase 1: Passive Ledger (MVP) — 8~10 周

> **目标**: 证明"看得准"。不阻塞任何开发流程，先建立可信的协作感知能力。

| 周次 | 里程碑 | 交付物 |
|:---:|:---|:---|
| **W1-2** | 基础脚手架 | Monorepo 搭建、DB Schema、API 框架、OAuth 登录 |
| **W3-4** | Agent Gateway (MCP + REST) | MCP Server 实现、CLI Hook 脚本、Session 管理 |
| **W5-6** | Intent & Change 自动生成 | Intent 提取、Embedding 生成、Change 状态机、Similar Work 检测 |
| **W7-8** | Conflict Detection (L1+L2) | File/Symbol 冲突检测、Tree-sitter Worker、Claim 管理 |
| **W9** | Decision Inbox (基础版) | Decision CRUD、Decision Memory、Web UI (Atlas + Decision) |
| **W10** | GitHub Integration + Dogfooding | Webhook 接入、PR 关联、内部团队试用 |

> [!TIP]
> **MVP 验证标准**: 团队在同一代码库同时运行 ≥3 个 Claude Code 实例时，系统能在 30 秒内准确识别出重复工作和 Symbol 冲突。

### Phase 2: Decision Convergence — 6~8 周

| 里程碑 | 内容 |
|:---|:---|
| Decision Compression | LLM 驱动的 Decision 合并 |
| Authority Policy Engine | 可配置的决策权限策略 |
| Context Compiler | 自动生成 Context Package |
| Notification Integration | Slack / Lark / Email 推送 |
| Shared Findings | 结构化 Findings 发布/消费 |
| GitLab Integration | 支持 GitLab Webhook |

### Phase 3: Active Collaboration — 6~8 周

| 里程碑 | 内容 |
|:---|:---|
| `collab.preflight()` | 完整的协作预检 |
| Dependency Collision (L3) | 调用图分析、上下游冲突 |
| Semantic Collision (L4) | LLM 辅助语义冲突判定 |
| Change Graph 可视化 | D3.js 交互式图谱 |
| Agent SDK (Python + TS) | 封装 SDK |
| Verification Planner | 智能验证集合推荐 |

### Phase 4: Scale & Ecosystem — 持续迭代

| 里程碑 | 内容 |
|:---|:---|
| IDE Plugin (VS Code) | 被动 Code Signal 收集 |
| Multi-repo 支持 | 跨仓库 Change 关联 |
| Executable Decisions | Decision → 机器可执行约束 |
| 企业级 RBAC | 角色、团队、组织层级 |
| SaaS 部署 | 多租户、计费 |

---

## 19. 技术风险与缓解策略

| 风险 | 严重度 | 概率 | 缓解策略 |
|:---|:---:|:---:|:---|
| **闭源 IDE (Cursor/Windsurf) 无法深度接入** | 高 | 高 | MVP 聚焦 CLI Agent (Claude Code/Codex)；闭源 IDE 退化为 Git Watcher 模式 |
| **Intent 误匹配导致假阳性告警过多** | 高 | 中 | 多维度加权评分；高阈值才告警；中阈值静默关联；用户反馈闭环调参 |
| **LLM 调用成本失控** | 中 | 中 | Embedding 用小模型；Semantic Collision 和 Compression 用高频节流；结果缓存 |
| **Claim 幽灵租约 (Agent 崩溃后未释放)** | 中 | 高 | TTL 强制过期；Session heartbeat 检测；Agent 断连自动释放 |
| **多 Agent 高并发下 DB 压力** | 中 | 低 | `agent_events` 按月分区；批量写入；热路径 Redis 缓存 |
| **Decision Compression 过度抽象丢失关键上下文** | 高 | 中 | 压缩后保留原始 Decision 链接；人工可展开查看原始问题；A/B 测试压缩效果 |
| **Symbol 解析不准确 (动态语言)** | 中 | 中 | Tree-sitter 覆盖主流语言；动态语言退化为文件级检测；允许 Agent 显式声明 scope |

---

> [!IMPORTANT]
> **下一步行动建议**:
> 1. 确认技术栈偏好（如果团队更熟悉 Go/Rust 后端，核心 API 可以调整）
> 2. 确定首批接入的 Agent 类型（建议 Claude Code + Codex CLI）
> 3. 搭建 Monorepo 脚手架，开始 Phase 1 Week 1-2
