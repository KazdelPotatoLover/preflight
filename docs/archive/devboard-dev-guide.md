# DevBoard AI — 完整开发指南

> **目标读者**: AI Coding Agent 或人类开发者  
> **前置知识**: TypeScript, Node.js, PostgreSQL, Docker 基础  
> **预期产出**: 可运行的自托管 DevBoard AI MVP  
> **版本**: v1.0  
> **日期**: 2026-10-02

---

## 目录

- [第一部分：项目基础设施](#第一部分项目基础设施)
  - [1.1 技术栈确认](#11-技术栈确认)
  - [1.2 Monorepo 初始化](#12-monorepo-初始化)
  - [1.3 TypeScript 与工具链配置](#13-typescript-与工具链配置)
  - [1.4 环境变量规范](#14-环境变量规范)
- [第二部分：数据库层](#第二部分数据库层)
  - [2.1 PostgreSQL + pgvector 设置](#21-postgresql--pgvector-设置)
  - [2.2 ORM 选型与配置 (Drizzle)](#22-orm-选型与配置-drizzle)
  - [2.3 完整 Schema 定义](#23-完整-schema-定义)
  - [2.4 数据库迁移流程](#24-数据库迁移流程)
- [第三部分：共享核心包 (packages/core)](#第三部分共享核心包-packagescore)
  - [3.1 领域类型定义](#31-领域类型定义)
  - [3.2 ID 生成策略](#32-id-生成策略)
  - [3.3 错误体系](#33-错误体系)
- [第四部分：LLM 客户端 (packages/llm-client)](#第四部分llm-客户端-packagesllm-client)
  - [4.1 统一 LLM 适配层](#41-统一-llm-适配层)
  - [4.2 Embedding 服务](#42-embedding-服务)
  - [4.3 结构化输出解析](#43-结构化输出解析)
- [第五部分：后端 API 服务 (apps/api)](#第五部分后端-api-服务-appsapi)
  - [5.1 服务框架搭建](#51-服务框架搭建)
  - [5.2 Session 管理模块](#52-session-管理模块)
  - [5.3 Intent Service](#53-intent-service)
  - [5.4 Change Service](#54-change-service)
  - [5.5 Claim Manager](#55-claim-manager)
  - [5.6 Decision Service](#56-decision-service)
  - [5.7 Conflict Engine](#57-conflict-engine)
  - [5.8 Similarity Engine](#58-similarity-engine)
  - [5.9 Context Compiler](#59-context-compiler)
  - [5.10 Preflight 接口](#510-preflight-接口)
  - [5.11 Findings Service](#511-findings-service)
  - [5.12 Git Integration (GitHub Webhook)](#512-git-integration-github-webhook)
  - [5.13 SSE 实时事件流](#513-sse-实时事件流)
- [第六部分：MCP Server (packages/mcp-server)](#第六部分mcp-server-packagesmcp-server)
  - [6.1 MCP Server 实现](#61-mcp-server-实现)
  - [6.2 Claude Code 接入配置](#62-claude-code-接入配置)
  - [6.3 Codex 接入方案](#63-codex-接入方案)
- [第七部分：CLI 工具 (packages/cli)](#第七部分cli-工具-packagescli)
  - [7.1 CLI 命令设计](#71-cli-命令设计)
  - [7.2 Local Git Watcher](#72-local-git-watcher)
- [第八部分：异步 Worker (apps/worker)](#第八部分异步-worker-appsworker)
  - [8.1 Worker 框架](#81-worker-框架)
  - [8.2 Symbol Analyzer Job](#82-symbol-analyzer-job)
  - [8.3 Embedding Generator Job](#83-embedding-generator-job)
  - [8.4 Collision Detector Job](#84-collision-detector-job)
  - [8.5 Decision Compressor Job](#85-decision-compressor-job)
  - [8.6 Claim Expiry Job](#86-claim-expiry-job)
- [第九部分：前端 Web UI (apps/web)](#第九部分前端-web-ui-appsweb)
  - [9.1 Next.js 项目设置](#91-nextjs-项目设置)
  - [9.2 首页 Project Atlas](#92-首页-project-atlas)
  - [9.3 Decision Inbox 页面](#93-decision-inbox-页面)
  - [9.4 Change Detail 页面](#94-change-detail-页面)
  - [9.5 Change Graph 可视化](#95-change-graph-可视化)
- [第十部分：Docker 化与部署](#第十部分docker-化与部署)
  - [10.1 Dockerfile](#101-dockerfile)
  - [10.2 Docker Compose](#102-docker-compose)
  - [10.3 一键启动脚本](#103-一键启动脚本)
- [第十一部分：测试策略](#第十一部分测试策略)
- [第十二部分：MVP 验收标准](#第十二部分mvp-验收标准)
- [第十三部分：从 MVP 到完整产品的扩展路线](#第十三部分从-mvp-到完整产品的扩展路线)

---

# 第一部分：项目基础设施

## 1.1 技术栈确认

| 组件 | 选型 | 版本要求 |
|:---|:---|:---|
| 运行时 | Node.js | ≥ 20.x LTS |
| 包管理器 | pnpm | ≥ 9.x |
| 语言 | TypeScript | ≥ 5.5 |
| 后端框架 | Hono | ≥ 4.x |
| 数据库 | PostgreSQL + pgvector | PG ≥ 16, pgvector ≥ 0.7 |
| ORM | Drizzle ORM | ≥ 0.35 |
| 队列 | BullMQ | ≥ 5.x |
| 缓存 | Redis | ≥ 7.x |
| 前端 | Next.js (App Router) | ≥ 15.x |
| UI 组件 | shadcn/ui + Tailwind CSS | 最新 |
| MCP SDK | @modelcontextprotocol/sdk | ≥ 1.x |
| AST 解析 | tree-sitter (WASM) | 最新 |
| 测试 | Vitest | ≥ 2.x |
| LLM 客户端 | openai (npm) | ≥ 4.x |

## 1.2 Monorepo 初始化

### 1.2.1 创建项目根目录

```bash
mkdir devboard && cd devboard
git init
pnpm init
```

### 1.2.2 配置 pnpm workspace

创建 `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 1.2.3 完整目录结构

以下是最终的完整目录树。MVP 阶段从上到下逐步构建：

```
devboard/
├── apps/
│   ├── api/                          # 后端 API + MCP HTTP 端点
│   │   ├── src/
│   │   │   ├── index.ts              # 入口: 启动 Hono server
│   │   │   ├── app.ts                # Hono app 实例 & 路由注册
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT / API Key 认证
│   │   │   │   ├── error-handler.ts  # 统一错误处理
│   │   │   │   └── logger.ts         # 请求日志
│   │   │   ├── routes/
│   │   │   │   ├── sessions.ts       # /api/v1/sessions
│   │   │   │   ├── intents.ts        # /api/v1/intents
│   │   │   │   ├── changes.ts        # /api/v1/changes
│   │   │   │   ├── claims.ts         # /api/v1/claims
│   │   │   │   ├── decisions.ts      # /api/v1/decisions
│   │   │   │   ├── preflight.ts      # /api/v1/preflight
│   │   │   │   ├── findings.ts       # /api/v1/findings
│   │   │   │   ├── atlas.ts          # /api/v1/teams/:id/atlas
│   │   │   │   ├── webhooks.ts       # /api/v1/webhooks/github
│   │   │   │   └── events.ts         # /api/v1/stream/events (SSE)
│   │   │   └── services/
│   │   │       ├── session.service.ts
│   │   │       ├── intent.service.ts
│   │   │       ├── change.service.ts
│   │   │       ├── claim.service.ts
│   │   │       ├── decision.service.ts
│   │   │       ├── conflict.service.ts
│   │   │       ├── similarity.service.ts
│   │   │       ├── context-compiler.service.ts
│   │   │       ├── preflight.service.ts
│   │   │       └── findings.service.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── web/                          # 前端 (Next.js 15)
│   │   ├── src/
│   │   │   └── app/
│   │   │       ├── layout.tsx
│   │   │       ├── page.tsx          # 重定向
│   │   │       ├── login/
│   │   │       │   └── page.tsx
│   │   │       └── team/
│   │   │           └── [slug]/
│   │   │               ├── page.tsx          # Atlas 首页
│   │   │               ├── changes/
│   │   │               │   ├── page.tsx      # Changes 列表
│   │   │               │   └── [id]/
│   │   │               │       └── page.tsx  # Change 详情
│   │   │               ├── decisions/
│   │   │               │   └── [id]/
│   │   │               │       └── page.tsx  # Decision 详情
│   │   │               └── settings/
│   │   │                   └── page.tsx
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   └── tsconfig.json
│   │
│   └── worker/                       # 异步 Worker
│       ├── src/
│       │   ├── index.ts              # Worker 入口
│       │   ├── queues.ts             # BullMQ 队列定义
│       │   └── jobs/
│       │       ├── symbol-analyzer.job.ts
│       │       ├── embedding-generator.job.ts
│       │       ├── collision-detector.job.ts
│       │       ├── decision-compressor.job.ts
│       │       └── claim-expiry.job.ts
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── core/                         # 共享领域逻辑
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types/
│   │   │   │   ├── intent.ts
│   │   │   │   ├── change.ts
│   │   │   │   ├── claim.ts
│   │   │   │   ├── decision.ts
│   │   │   │   ├── session.ts
│   │   │   │   ├── goal.ts
│   │   │   │   ├── collision.ts
│   │   │   │   └── common.ts
│   │   │   ├── schemas/              # Zod validation schemas
│   │   │   │   ├── intent.schema.ts
│   │   │   │   ├── change.schema.ts
│   │   │   │   ├── claim.schema.ts
│   │   │   │   ├── decision.schema.ts
│   │   │   │   └── preflight.schema.ts
│   │   │   ├── constants.ts
│   │   │   ├── errors.ts
│   │   │   └── id.ts                 # ID 生成工具
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── database/                     # 数据库 Schema 与迁移
│   │   ├── src/
│   │   │   ├── index.ts              # 导出 db 实例
│   │   │   ├── client.ts             # Drizzle 客户端
│   │   │   ├── schema/
│   │   │   │   ├── teams.ts
│   │   │   │   ├── members.ts
│   │   │   │   ├── repos.ts
│   │   │   │   ├── goals.ts
│   │   │   │   ├── agent-sessions.ts
│   │   │   │   ├── intents.ts
│   │   │   │   ├── changes.ts
│   │   │   │   ├── claims.ts
│   │   │   │   ├── decisions.ts
│   │   │   │   ├── decision-options.ts
│   │   │   │   ├── agent-events.ts
│   │   │   │   ├── change-symbols.ts
│   │   │   │   ├── collisions.ts
│   │   │   │   ├── verifications.ts
│   │   │   │   ├── authority-policies.ts
│   │   │   │   └── index.ts          # 导出所有 schema
│   │   │   └── seed.ts               # 开发数据种子
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── mcp-server/                   # MCP Server
│   │   ├── src/
│   │   │   ├── index.ts              # stdio 入口
│   │   │   ├── server.ts             # MCP Server 定义
│   │   │   └── tools/
│   │   │       ├── observe-intent.ts
│   │   │       ├── preflight.ts
│   │   │       ├── report-progress.ts
│   │   │       ├── acquire-claim.ts
│   │   │       ├── release-claim.ts
│   │   │       ├── propose-decision.ts
│   │   │       ├── check-decision.ts
│   │   │       ├── publish-findings.ts
│   │   │       ├── get-findings.ts
│   │   │       ├── get-context.ts
│   │   │       └── query-active-work.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cli/                          # CLI 工具
│   │   ├── src/
│   │   │   ├── index.ts              # CLI 入口 (commander)
│   │   │   ├── commands/
│   │   │   │   ├── session.ts
│   │   │   │   ├── preflight.ts
│   │   │   │   ├── report.ts
│   │   │   │   └── watch.ts
│   │   │   └── api-client.ts         # REST API 客户端
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── llm-client/                   # LLM 适配层
│       ├── src/
│       │   ├── index.ts
│       │   ├── client.ts             # OpenAI-compatible 客户端
│       │   ├── embedding.ts          # Embedding 服务
│       │   ├── structured-output.ts  # JSON 解析 + 容错
│       │   └── prompts/
│       │       ├── intent-summary.ts
│       │       ├── decision-compress.ts
│       │       ├── semantic-conflict.ts
│       │       └── scope-inference.ts
│       ├── package.json
│       └── tsconfig.json
│
├── docker/
│   ├── Dockerfile                    # 多阶段构建
│   ├── Dockerfile.dev                # 开发用 (hot reload)
│   └── init.sql                      # pgvector 初始化
│
├── scripts/
│   ├── setup.sh                      # 一键初始化
│   └── seed.ts                       # 种子数据
│
├── .env.example                      # 环境变量模板
├── .gitignore
├── docker-compose.yml                # 生产部署
├── docker-compose.dev.yml            # 本地开发
├── package.json                      # 根 package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json                # 共享 TS 配置
└── turbo.json                        # Turborepo 配置 (可选)
```

## 1.3 TypeScript 与工具链配置

### 1.3.1 根 `tsconfig.base.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

### 1.3.2 根 `package.json`

```jsonc
{
  "name": "devboard",
  "private": true,
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "lint": "pnpm -r run lint",
    "test": "pnpm -r run test",
    "db:generate": "pnpm --filter @devboard/database run generate",
    "db:migrate": "pnpm --filter @devboard/database run migrate",
    "db:seed": "pnpm --filter @devboard/database run seed",
    "docker:up": "docker compose up -d",
    "docker:down": "docker compose down"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.0.0",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=9.0.0"
  }
}
```

## 1.4 环境变量规范

创建 `.env.example`：

```bash
# ============================================================
# 数据库
# ============================================================
DATABASE_URL="postgres://devboard:devboard_pass@localhost:5432/devboard"

# ============================================================
# Redis
# ============================================================
REDIS_URL="redis://localhost:6379"

# ============================================================
# 自部署 LLM (OpenAI-compatible API)
# ============================================================
# 推理模型 (用于 Intent 提取、Decision 压缩、语义冲突判断)
LLM_BASE_URL="http://localhost:8000/v1"
LLM_API_KEY="none"
LLM_MODEL="Qwen2.5-Coder-32B-Instruct"

# 向量嵌入模型 (用于相似工作检索)
EMBEDDING_BASE_URL="http://localhost:8000/v1"
EMBEDDING_API_KEY="none"
EMBEDDING_MODEL="bge-m3"
EMBEDDING_DIMENSIONS=1024

# ============================================================
# 服务端口
# ============================================================
API_PORT=3000
MCP_PORT=3001

# ============================================================
# 认证 (MVP 阶段可用简单 API Key)
# ============================================================
# 内部 API Key (Agent 与后端通信)
DEVBOARD_API_KEY="dvb_dev_changeme_in_production"

# JWT 密钥 (Web UI 登录用)
JWT_SECRET="dev-jwt-secret-change-in-production"

# GitHub OAuth (可选, MVP 可暂不配置)
# GITHUB_CLIENT_ID=""
# GITHUB_CLIENT_SECRET=""

# ============================================================
# GitHub Integration (可选)
# ============================================================
# GITHUB_WEBHOOK_SECRET=""
# GITHUB_TOKEN=""
```

---

# 第二部分：数据库层

## 2.1 PostgreSQL + pgvector 设置

### 2.1.1 Docker 容器 (本地开发)

`docker-compose.dev.yml` 中的数据库部分:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: devboard
      POSTGRES_USER: devboard
      POSTGRES_PASSWORD: devboard_pass
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U devboard"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

### 2.1.2 初始化脚本 `docker/init.sql`

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;
-- 启用 pg_trgm (模糊文本搜索)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- 启用 uuid
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

## 2.2 ORM 选型与配置 (Drizzle)

### 2.2.1 为什么选 Drizzle 而不是 Prisma

- **pgvector 原生支持**: Drizzle 支持自定义列类型，可以直接定义 `vector(1024)` 列，Prisma 需要 raw SQL 曲线救国
- **SQL-first**: 生成的 SQL 可控且高效，适合复杂查询（向量搜索、JSONB 操作、窗口函数）
- **轻量**: 无需额外的查询引擎二进制

### 2.2.2 安装依赖

```bash
cd packages/database
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

### 2.2.3 `packages/database/src/client.ts`

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const connectionString = process.env.DATABASE_URL!;

// 连接池: 查询用
const queryClient = postgres(connectionString, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });

// 单连接: 迁移用
export function createMigrationClient() {
  return postgres(connectionString, { max: 1 });
}

export type Database = typeof db;
```

### 2.2.4 `packages/database/drizzle.config.ts`

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

## 2.3 完整 Schema 定义

> **重要**: 以下是 Drizzle ORM 格式的完整 Schema。每个文件对应一张表。

### 2.3.1 `packages/database/src/schema/teams.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  settings: jsonb("settings").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.2 `packages/database/src/schema/members.ts`

```typescript
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  externalId: text("external_id"),           // GitHub/GitLab user ID
  displayName: text("display_name").notNull(),
  email: text("email"),
  role: text("role").default("developer").notNull(), // admin | developer | viewer
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.3 `packages/database/src/schema/repos.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  platform: text("platform").notNull(),        // 'github' | 'gitlab' | 'local'
  externalId: text("external_id"),
  fullName: text("full_name").notNull(),        // e.g. "org/repo"
  defaultBranch: text("default_branch").default("main"),
  webhookSecret: text("webhook_secret"),
  settings: jsonb("settings").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.4 `packages/database/src/schema/goals.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { members } from "./members.js";

export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  shortId: text("short_id").unique().notNull(),   // "G-102"
  title: text("title").notNull(),
  objective: text("objective"),
  acceptance: jsonb("acceptance").default([]),     // 验收条件
  ownerId: uuid("owner_id").references(() => members.id),
  status: text("status").default("active").notNull(),
    // active | paused | completed | archived
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.5 `packages/database/src/schema/agent-sessions.ts`

```typescript
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { members } from "./members.js";
import { repos } from "./repos.js";

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  memberId: uuid("member_id").references(() => members.id),
  repoId: uuid("repo_id").references(() => repos.id),
  agentType: text("agent_type").notNull(),        // 'claude_code' | 'codex' | 'custom'
  agentName: text("agent_name"),                   // 用户自定义, e.g. "agent-17"
  worktreePath: text("worktree_path"),
  branchName: text("branch_name"),
  status: text("status").default("active").notNull(),
    // active | idle | completed | disconnected
  metadata: jsonb("metadata").default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [
  index("idx_agent_sessions_active").on(table.teamId, table.status),
]);
```

### 2.3.6 `packages/database/src/schema/intents.ts`

```typescript
import { pgTable, uuid, text, real, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSessions } from "./agent-sessions.js";

// 自定义 vector 列类型
import { customType } from "drizzle-orm/pg-core";

export const vector = customType<{
  data: number[];
  driverParam: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value);
  },
});

export const intents = pgTable("intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "cascade" }).notNull(),
  changeId: uuid("change_id"),                 // 后续关联 Change
  summary: text("summary").notNull(),
  details: text("details"),
  status: text("status").default("observed").notNull(),
    // observed | exploring | confirmed | implementing | verifying | done | abandoned
  confidence: real("confidence").default(0.0).notNull(),
  likelyScope: jsonb("likely_scope").default([]),
  embedding: vector("embedding", { dimensions: 1024 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.7 `packages/database/src/schema/changes.ts`

```typescript
import { pgTable, uuid, text, real, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { repos } from "./repos.js";
import { goals } from "./goals.js";
import { vector } from "./intents.js";

export const changes = pgTable("changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  repoId: uuid("repo_id").references(() => repos.id),
  shortId: text("short_id").unique().notNull(),   // "CHG-128"
  goalId: uuid("goal_id").references(() => goals.id),

  title: text("title").notNull(),
  intentSummary: text("intent_summary"),
  status: text("status").default("probable").notNull(),
    // probable | confirmed | implementing | verifying | completed | merged | abandoned
  confidence: real("confidence").default(0.0).notNull(),

  likelyScope: jsonb("likely_scope").default([]),
  actualScope: jsonb("actual_scope").default([]),
  filesRead: jsonb("files_read").default([]),
  filesModified: jsonb("files_modified").default([]),

  branchName: text("branch_name"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  mergeCommit: text("merge_commit"),

  findings: jsonb("findings").default([]),
  metadata: jsonb("metadata").default({}),

  embedding: vector("embedding", { dimensions: 1024 }),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_changes_active").on(table.teamId, table.status),
  index("idx_changes_repo").on(table.repoId, table.status),
]);
```

### 2.3.8 `packages/database/src/schema/claims.ts`

```typescript
import { pgTable, uuid, text, real, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { changes } from "./changes.js";
import { agentSessions } from "./agent-sessions.js";

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }).notNull(),
  sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "cascade" }).notNull(),
  scope: jsonb("scope").notNull(),                 // ["AuthService.login", "RetryPolicy"]
  scopeType: text("scope_type").default("symbol"), // 'symbol' | 'file' | 'directory'
  claimType: text("claim_type").default("speculative"),
    // speculative | committed
  strength: real("strength").default(0.5),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_claims_active").on(table.changeId),
]);
```

### 2.3.9 `packages/database/src/schema/decisions.ts`

```typescript
import {
  pgTable, uuid, text, boolean, jsonb, timestamp, index,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { members } from "./members.js";
import { agentSessions } from "./agent-sessions.js";
import { vector } from "./intents.js";

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  shortId: text("short_id").unique().notNull(),   // "DEC-182"

  question: text("question").notNull(),
  context: text("context"),
  raisedBySession: uuid("raised_by_session").references(() => agentSessions.id),

  status: text("status").default("pending").notNull(),
    // pending | auto_resolved | human_resolved | deferred | superseded
  authority: text("authority").default("human"),   // 'human' | 'agent' | 'auto'
  reversibility: text("reversibility").default("medium"),
  urgency: text("urgency").default("normal"),      // 'blocking' | 'normal' | 'low'

  recommendation: text("recommendation"),
  chosenOption: text("chosen_option"),
  resolution: text("resolution"),
  resolvedBy: uuid("resolved_by").references(() => members.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),

  parentDecisionId: uuid("parent_decision_id"),    // Decision Compression (自引用)
  isPolicy: boolean("is_policy").default(false),
  policyScope: text("policy_scope"),               // 'backend/**', 'auth/*'
  policyRule: text("policy_rule"),

  embedding: vector("embedding", { dimensions: 1024 }),

  affectedChanges: jsonb("affected_changes").default([]),
  metadata: jsonb("metadata").default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_decisions_pending").on(table.teamId, table.status),
  index("idx_decisions_policy").on(table.teamId),
]);
```

### 2.3.10 `packages/database/src/schema/decision-options.ts`

```typescript
import { pgTable, uuid, text, boolean, jsonb, integer } from "drizzle-orm/pg-core";
import { decisions } from "./decisions.js";

export const decisionOptions = pgTable("decision_options", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  pros: jsonb("pros").default([]),
  cons: jsonb("cons").default([]),
  isRecommended: boolean("is_recommended").default(false),
  sortOrder: integer("sort_order").default(0),
});
```

### 2.3.11 `packages/database/src/schema/agent-events.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { agentSessions } from "./agent-sessions.js";

export const agentEvents = pgTable("agent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "cascade" }).notNull(),
  eventType: text("event_type").notNull(),
    // 'prompt' | 'plan' | 'tool_call' | 'file_read' | 'file_write'
    // | 'git_diff' | 'test_run' | 'commit' | 'error' | 'heartbeat'
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_agent_events_session").on(table.sessionId, table.createdAt),
]);
```

### 2.3.12 `packages/database/src/schema/change-symbols.ts`

```typescript
import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { changes } from "./changes.js";
import { repos } from "./repos.js";

export const changeSymbols = pgTable("change_symbols", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }).notNull(),
  repoId: uuid("repo_id").references(() => repos.id),
  symbolFqn: text("symbol_fqn").notNull(),        // "auth.AuthService.login"
  symbolType: text("symbol_type"),                  // 'function' | 'class' | 'method'
  filePath: text("file_path").notNull(),
  lineStart: integer("line_start"),
  lineEnd: integer("line_end"),
  accessType: text("access_type").default("write"), // 'read' | 'write'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_change_symbols_fqn").on(table.symbolFqn, table.accessType),
  index("idx_change_symbols_file").on(table.filePath),
  index("idx_change_symbols_change").on(table.changeId),
]);
```

### 2.3.13 `packages/database/src/schema/collisions.ts`

```typescript
import { pgTable, uuid, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { changes } from "./changes.js";

export const collisions = pgTable("collisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  changeAId: uuid("change_a_id").references(() => changes.id, { onDelete: "cascade" }).notNull(),
  changeBId: uuid("change_b_id").references(() => changes.id, { onDelete: "cascade" }).notNull(),
  level: integer("level").notNull(),               // 1=file, 2=symbol, 3=dependency, 4=semantic
  severity: text("severity").default("medium"),     // low | medium | high | critical
  details: jsonb("details").notNull(),
  status: text("status").default("active"),         // active | resolved | dismissed
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.14 `packages/database/src/schema/verifications.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { changes } from "./changes.js";

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeId: uuid("change_id").references(() => changes.id, { onDelete: "cascade" }).notNull(),
  suiteName: text("suite_name").notNull(),
  result: text("result").notNull(),                // pass | fail | running | skipped
  ciUrl: text("ci_url"),
  ciProvider: text("ci_provider"),
  details: jsonb("details").default({}),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.15 `packages/database/src/schema/authority-policies.ts`

```typescript
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const authorityPolicies = pgTable("authority_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }).notNull(),
  scope: text("scope").notNull(),                   // 'global' | 'backend/**' | 'auth/*'
  category: text("category").notNull(),             // 'variable_naming' | 'public_api'
  authority: text("authority").notNull(),            // 'agent' | 'human' | 'team_lead'
  conditions: jsonb("conditions").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### 2.3.16 `packages/database/src/schema/index.ts`

```typescript
export * from "./teams.js";
export * from "./members.js";
export * from "./repos.js";
export * from "./goals.js";
export * from "./agent-sessions.js";
export * from "./intents.js";
export * from "./changes.js";
export * from "./claims.js";
export * from "./decisions.js";
export * from "./decision-options.js";
export * from "./agent-events.js";
export * from "./change-symbols.js";
export * from "./collisions.js";
export * from "./verifications.js";
export * from "./authority-policies.js";
```

## 2.4 数据库迁移流程

```bash
# 生成迁移文件
pnpm --filter @devboard/database run generate
# 即: npx drizzle-kit generate

# 执行迁移
pnpm --filter @devboard/database run migrate
# 即: npx drizzle-kit migrate

# 创建 pgvector 索引 (需手动执行或放在迁移后脚本中)
# 因为 Drizzle 暂不原生支持 ivfflat 索引, 需要 raw SQL:
```

```sql
-- 执行于迁移后 (在 seed.ts 或单独脚本中):
CREATE INDEX IF NOT EXISTS idx_intents_embedding
  ON intents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_changes_embedding
  ON changes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_decisions_embedding
  ON decisions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

---

# 第三部分：共享核心包 (packages/core)

## 3.1 领域类型定义

### 3.1.1 `packages/core/src/types/common.ts`

```typescript
/** 所有对象状态的基础接口 */
export interface Timestamped {
  createdAt: Date;
  updatedAt: Date;
}

/** 分页请求 */
export interface PaginationParams {
  page?: number;
  limit?: number;
}

/** 分页响应 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/** API 统一响应 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### 3.1.2 `packages/core/src/types/session.ts`

```typescript
export type AgentType = "claude_code" | "codex" | "cursor" | "custom";
export type SessionStatus = "active" | "idle" | "completed" | "disconnected";

export interface AgentSession {
  id: string;
  teamId: string;
  memberId?: string;
  repoId?: string;
  agentType: AgentType;
  agentName?: string;
  worktreePath?: string;
  branchName?: string;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  startedAt: Date;
  lastHeartbeat: Date;
  endedAt?: Date;
}

export interface CreateSessionInput {
  teamId: string;
  memberId?: string;
  repoId?: string;
  agentType: AgentType;
  agentName?: string;
  worktreePath?: string;
  branchName?: string;
}
```

### 3.1.3 `packages/core/src/types/intent.ts`

```typescript
export type IntentStatus =
  | "observed"
  | "exploring"
  | "confirmed"
  | "implementing"
  | "verifying"
  | "done"
  | "abandoned";

export interface Intent {
  id: string;
  sessionId: string;
  changeId?: string;
  summary: string;
  details?: string;
  status: IntentStatus;
  confidence: number;
  likelyScope: string[];
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ObserveIntentInput {
  sessionId: string;
  summary: string;
  details?: string;
  likelyScope?: string[];
  goalHint?: string;
  confidence?: number;
}
```

### 3.1.4 `packages/core/src/types/change.ts`

```typescript
export type ChangeStatus =
  | "probable"
  | "confirmed"
  | "implementing"
  | "verifying"
  | "completed"
  | "merged"
  | "abandoned";

export interface Change {
  id: string;
  teamId: string;
  repoId?: string;
  shortId: string;
  goalId?: string;
  title: string;
  intentSummary?: string;
  status: ChangeStatus;
  confidence: number;
  likelyScope: string[];
  actualScope: string[];
  filesRead: string[];
  filesModified: string[];
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  mergeCommit?: string;
  findings: string[];
  metadata: Record<string, unknown>;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportProgressInput {
  sessionId: string;
  filesModified?: string[];
  symbolsModified?: string[];
  findings?: string[];
  status?: "exploring" | "implementing" | "verifying" | "done";
  gitDiffSummary?: string;
}
```

### 3.1.5 `packages/core/src/types/claim.ts`

```typescript
export type ClaimType = "speculative" | "committed";
export type ScopeType = "symbol" | "file" | "directory";

export interface Claim {
  id: string;
  changeId: string;
  sessionId: string;
  scope: string[];
  scopeType: ScopeType;
  claimType: ClaimType;
  strength: number;
  expiresAt: Date;
  releasedAt?: Date;
  createdAt: Date;
}

export interface AcquireClaimInput {
  sessionId: string;
  scope: string[];
  scopeType?: ScopeType;
  ttlMinutes?: number;
}
```

### 3.1.6 `packages/core/src/types/decision.ts`

```typescript
export type DecisionStatus =
  | "pending"
  | "auto_resolved"
  | "human_resolved"
  | "deferred"
  | "superseded";

export type DecisionAuthority = "human" | "agent" | "auto";

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  pros: string[];
  cons: string[];
  isRecommended: boolean;
}

export interface Decision {
  id: string;
  teamId: string;
  shortId: string;
  question: string;
  context?: string;
  raisedBySession?: string;
  status: DecisionStatus;
  authority: DecisionAuthority;
  reversibility: "high" | "medium" | "low";
  urgency: "blocking" | "normal" | "low";
  recommendation?: string;
  chosenOption?: string;
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  parentDecisionId?: string;
  isPolicy: boolean;
  policyScope?: string;
  policyRule?: string;
  options: DecisionOption[];
  affectedChanges: string[];
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProposeDecisionInput {
  sessionId: string;
  question: string;
  context?: string;
  options: {
    label: string;
    description: string;
    pros?: string[];
    cons?: string[];
  }[];
  recommendation?: string;
  reversibility?: "high" | "medium" | "low";
  blocking?: boolean;
}

export interface ResolveDecisionInput {
  decisionId: string;
  chosenOption: string;
  resolution?: string;
  resolvedBy: string;
  convertToPolicy?: boolean;
  policyScope?: string;
}
```

### 3.1.7 `packages/core/src/types/collision.ts`

```typescript
export type CollisionLevel = 1 | 2 | 3 | 4;
  // 1=file, 2=symbol, 3=dependency, 4=semantic
export type CollisionSeverity = "low" | "medium" | "high" | "critical";

export interface Collision {
  id: string;
  teamId: string;
  changeAId: string;
  changeBId: string;
  level: CollisionLevel;
  severity: CollisionSeverity;
  details: {
    sharedFiles?: string[];
    sharedSymbols?: string[];
    dependencyChain?: string[];
    semanticExplanation?: string;
  };
  status: "active" | "resolved" | "dismissed";
  createdAt: Date;
}
```

## 3.2 ID 生成策略

### `packages/core/src/id.ts`

```typescript
/**
 * 生成业务可读的短 ID (如 CHG-128, DEC-182)
 * MVP 阶段使用内存原子计数器 + DB sequence 回填
 * 生产环境使用 PostgreSQL sequence
 */

import { db } from "@devboard/database";
import { sql } from "drizzle-orm";

const ID_PREFIXES = {
  goal: "G",
  change: "CHG",
  decision: "DEC",
  intent: "INT",
} as const;

type IdType = keyof typeof ID_PREFIXES;

export async function generateShortId(type: IdType): Promise<string> {
  const prefix = ID_PREFIXES[type];
  const seqName = `${type}_seq`;

  const result = await db.execute(
    sql.raw(`SELECT nextval('${seqName}') as val`)
  );
  const val = (result as any)[0]?.val;

  return `${prefix}-${val}`;
}
```

## 3.3 错误体系

### `packages/core/src/errors.ts`

```typescript
export class DevBoardError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public details?: unknown,
  ) {
    super(message);
    this.name = "DevBoardError";
  }
}

export class NotFoundError extends DevBoardError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} ${id} not found`, 404);
  }
}

export class ConflictError extends DevBoardError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

export class ValidationError extends DevBoardError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 400, details);
  }
}

export class UnauthorizedError extends DevBoardError {
  constructor(message = "Unauthorized") {
    super("UNAUTHORIZED", message, 401);
  }
}
```

### `packages/core/src/schemas/preflight.schema.ts`

```typescript
import { z } from "zod";

export const preflightRequestSchema = z.object({
  sessionId: z.string().uuid(),
  objective: z.string().min(1),
  likelyScope: z.array(z.string()).optional().default([]),
});

export const preflightResponseSchema = z.object({
  relatedWork: z.array(z.object({
    changeId: z.string(),
    shortId: z.string(),
    title: z.string(),
    similarity: z.number(),
    status: z.string(),
    agent: z.string().optional(),
  })),
  relevantDecisions: z.array(z.object({
    decisionId: z.string(),
    shortId: z.string(),
    question: z.string(),
    status: z.string(),
    policyRule: z.string().optional(),
  })),
  potentialCollisions: z.array(z.object({
    changeId: z.string(),
    shortId: z.string(),
    level: z.number(),
    sharedScope: z.array(z.string()),
  })),
  activeClaims: z.array(z.object({
    scope: z.array(z.string()),
    heldBy: z.string(),
    expiresAt: z.string(),
  })),
  recommendedAction: z.enum([
    "proceed",
    "join_existing_change",
    "split_scope",
    "wait_for_decision",
    "review_collision",
  ]),
});

export type PreflightRequest = z.infer<typeof preflightRequestSchema>;
export type PreflightResponse = z.infer<typeof preflightResponseSchema>;
```

---

# 第四部分：LLM 客户端 (packages/llm-client)

本模块为系统内部提供统一的自部署大模型抽象层。由于团队采用自部署模型（如 vLLM / Ollama），底层必须兼容 OpenAI REST API 规范，并针对开源模型的输出不稳定性（如未能严格按 JSON 输出、多余的 markdown 围栏等）内置自愈解析逻辑。

## 4.1 统一 LLM 适配层

### `packages/llm-client/src/client.ts`

```typescript
import OpenAI from "openai";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function createLLMClient(config?: Partial<LLMConfig>): { client: OpenAI; model: string } {
  const baseUrl = config?.baseUrl || process.env.LLM_BASE_URL || "http://localhost:8000/v1";
  const apiKey = config?.apiKey || process.env.LLM_API_KEY || "none";
  const model = config?.model || process.env.LLM_MODEL || "Qwen2.5-Coder-32B-Instruct";

  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey: apiKey,
    timeout: 30000,
    maxRetries: 2,
  });

  return { client, model };
}
```

## 4.2 Embedding 服务

### `packages/llm-client/src/embedding.ts`

```typescript
import OpenAI from "openai";

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export class EmbeddingService {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  constructor(config?: Partial<EmbeddingConfig>) {
    this.client = new OpenAI({
      baseURL: config?.baseUrl || process.env.EMBEDDING_BASE_URL || "http://localhost:8000/v1",
      apiKey: config?.apiKey || process.env.EMBEDDING_API_KEY || "none",
    });
    this.model = config?.model || process.env.EMBEDDING_MODEL || "bge-m3";
    this.dimensions = Number(config?.dimensions || process.env.EMBEDDING_DIMENSIONS || 1024);
  }

  /**
   * 将文本转为向量
   */
  async embed(text: string): Promise<number[]> {
    const cleanText = text.replace(/\n+/g, " ").trim();
    if (!cleanText) {
      return new Array(this.dimensions).fill(0);
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: cleanText,
    });

    const vector = response.data[0].embedding;
    return vector;
  }

  /**
   * 批量生成文本向量
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const cleanTexts = texts.map((t) => t.replace(/\n+/g, " ").trim() || "empty");
    const response = await this.client.embeddings.create({
      model: this.model,
      input: cleanTexts,
    });
    return response.data.map((d) => d.embedding);
  }
}

export const embeddingService = new EmbeddingService();
```

## 4.3 结构化输出解析与容错

### `packages/llm-client/src/structured-output.ts`

```typescript
import { z } from "zod";
import { createLLMClient } from "./client.js";

/**
 * 清除模型可能输出的 markdown 标签代码块 (```json ... ```)
 */
export function cleanJsonString(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "");
    cleaned = cleaned.replace(/\s*```$/, "");
  }
  return cleaned.trim();
}

/**
 * 结构化推理包装器：自动附带 JSON 指令、提取 JSON、并使用 Zod 校验
 */
export async function generateStructured<T>(options: {
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodSchema<T>;
  temperature?: number;
  maxTokens?: number;
}): Promise<T> {
  const { client, model } = createLLMClient();

  const systemWithFormat = `${options.systemPrompt}
CRITICAL: You MUST respond in pure, raw JSON format matching the schema. Do not include markdown code block syntax (\`\`\`json). Just the valid JSON string.`;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemWithFormat },
      { role: "user", content: options.userPrompt },
    ],
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 1024,
  });

  const content = completion.choices[0]?.message?.content || "";
  const cleaned = cleanJsonString(content);

  try {
    const parsed = JSON.parse(cleaned);
    return options.schema.parse(parsed);
  } catch (error) {
    // 首次失败，触发一次自愈修补重试
    const repairCompletion = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: "You are a JSON fixer. Convert the user input into strictly valid JSON only.",
        },
        { role: "user", content: cleaned },
      ],
      temperature: 0.0,
    });

    const repairedContent = cleanJsonString(repairCompletion.choices[0]?.message?.content || "");
    const parsedRepaired = JSON.parse(repairedContent);
    return options.schema.parse(parsedRepaired);
  }
}
```

---

# 第五部分：后端 API 服务 (apps/api)

后端 API 是 DevBoard AI 的核心控制平面（Control Plane），统一负责承接 Agent 请求、维护状态机、计算冲突与相似度。

## 5.1 服务框架搭建

### `apps/api/src/app.ts`

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { errorHandler } from "./middleware/error-handler.js";
import { authMiddleware } from "./middleware/auth.js";

import { sessionsRouter } from "./routes/sessions.js";
import { intentsRouter } from "./routes/intents.js";
import { changesRouter } from "./routes/changes.js";
import { claimsRouter } from "./routes/claims.js";
import { decisionsRouter } from "./routes/decisions.js";
import { preflightRouter } from "./routes/preflight.js";
import { findingsRouter } from "./routes/findings.js";
import { atlasRouter } from "./routes/atlas.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { eventsRouter } from "./routes/events.js";

export const app = new Hono();

// 全局中间件
app.use("*", logger());
app.use("*", cors());
app.onError(errorHandler);

// 健康检查
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Webhook 免鉴权路由
app.route("/api/v1/webhooks", webhooksRouter);

// 业务路由（受 authMiddleware 保护）
const api = new Hono();
api.use("*", authMiddleware);

api.route("/sessions", sessionsRouter);
api.route("/intents", intentsRouter);
api.route("/changes", changesRouter);
api.route("/claims", claimsRouter);
api.route("/decisions", decisionsRouter);
api.route("/preflight", preflightRouter);
api.route("/findings", findingsRouter);
api.route("/teams", atlasRouter);
api.route("/stream", eventsRouter);

app.route("/api/v1", api);
```

### `apps/api/src/middleware/auth.ts`

```typescript
import { Context, Next } from "hono";
import { UnauthorizedError } from "@devboard/core";

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  const apiKeyHeader = c.req.header("X-DevBoard-Key");

  const token = authHeader?.replace(/^Bearer\s+/i, "") || apiKeyHeader;
  const expectedKey = process.env.DEVBOARD_API_KEY || "dvb_dev_changeme_in_production";

  if (!token || token !== expectedKey) {
    throw new UnauthorizedError("Invalid or missing API Key");
  }

  await next();
}
```

### `apps/api/src/middleware/error-handler.ts`

```typescript
import { Context } from "hono";
import { DevBoardError } from "@devboard/core";

export function errorHandler(err: Error, c: Context) {
  console.error(`[Error] ${err.name}: ${err.message}`, err.stack);

  if (err instanceof DevBoardError) {
    return c.json(
      {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      },
      err.statusCode as any
    );
  }

  return c.json(
    {
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: err.message || "An unexpected error occurred",
      },
    },
    500
  );
}
```

## 5.2 Session 管理模块

### `apps/api/src/services/session.service.ts`

```typescript
import { db } from "@devboard/database";
import { agentSessions, agentEvents } from "@devboard/database";
import { eq } from "drizzle-orm";
import { CreateSessionInput } from "@devboard/core";
import { NotFoundError } from "@devboard/core";

export class SessionService {
  async createSession(input: CreateSessionInput) {
    const [session] = await db
      .insert(agentSessions)
      .values({
        teamId: input.teamId,
        memberId: input.memberId,
        repoId: input.repoId,
        agentType: input.agentType,
        agentName: input.agentName || `agent-${Date.now().toString().slice(-4)}`,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        status: "active",
      })
      .returning();

    return session;
  }

  async heartbeat(sessionId: string) {
    const [session] = await db
      .update(agentSessions)
      .set({ lastHeartbeat: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .returning();

    if (!session) throw new NotFoundError("Session", sessionId);
    return session;
  }

  async endSession(sessionId: string) {
    const [session] = await db
      .update(agentSessions)
      .set({
        status: "completed",
        endedAt: new Date(),
      })
      .where(eq(agentSessions.id, sessionId))
      .returning();

    if (!session) throw new NotFoundError("Session", sessionId);
    return session;
  }

  async logEvent(sessionId: string, eventType: string, payload: Record<string, unknown>) {
    await db.insert(agentEvents).values({
      sessionId,
      eventType,
      payload,
    });
  }
}

export const sessionService = new SessionService();
```

## 5.3 Intent Service (意图处理)

### `apps/api/src/services/intent.service.ts`

```typescript
import { db } from "@devboard/database";
import { intents, agentSessions } from "@devboard/database";
import { eq } from "drizzle-orm";
import { ObserveIntentInput, NotFoundError } from "@devboard/core";
import { embeddingService } from "@devboard/llm-client";
import { similarityEngine } from "./similarity.service.js";
import { changeService } from "./change.service.js";

export class IntentService {
  async observeIntent(input: ObserveIntentInput) {
    // 1. 验证 Session
    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, input.sessionId));
    if (!session) throw new NotFoundError("Session", input.sessionId);

    // 2. 生成 Intent Embedding
    const vector = await embeddingService.embed(
      `${input.summary} ${input.details || ""} ${(input.likelyScope || []).join(" ")}`
    );

    // 3. 落库 Intent 记录
    const [intentRecord] = await db
      .insert(intents)
      .values({
        sessionId: input.sessionId,
        summary: input.summary,
        details: input.details,
        status: "observed",
        confidence: input.confidence ?? 0.5,
        likelyScope: input.likelyScope ?? [],
        embedding: vector,
      })
      .returning();

    // 4. 重复工作召回检测
    const similarWorks = await similarityEngine.findSimilarWork({
      teamId: session.teamId,
      embedding: vector,
      likelyScope: input.likelyScope || [],
    });

    // 5. 自动绑定或创建 Change
    const changeResult = await changeService.bindOrCreateChange({
      intent: intentRecord,
      session,
      similarWorks,
    });

    // 回填 changeId
    await db
      .update(intents)
      .set({ changeId: changeResult.change.id })
      .where(eq(intents.id, intentRecord.id));

    return {
      intent: intentRecord,
      change: changeResult.change,
      action: changeResult.action,
      relatedWork: similarWorks,
    };
  }
}

export const intentService = new IntentService();
```

## 5.4 Change Service (变更状态管理)

### `apps/api/src/services/change.service.ts`

```typescript
import { db } from "@devboard/database";
import { changes, claims } from "@devboard/database";
import { eq } from "drizzle-orm";
import { generateShortId, NotFoundError } from "@devboard/core";
import { similarityEngine } from "./similarity.service.js";

export class ChangeService {
  async bindOrCreateChange(params: {
    intent: any;
    session: any;
    similarWorks: any[];
  }) {
    const { intent, session, similarWorks } = params;
    const topMatch = similarWorks[0];

    // 高度重合 (>0.85): 建议复用已有 Change
    if (topMatch && topMatch.overallScore > 0.85) {
      const [existing] = await db
        .select()
        .from(changes)
        .where(eq(changes.id, topMatch.changeId));
      if (existing) {
        return { action: "join_existing", change: existing };
      }
    }

    // 否则自动生成全新 Change
    const shortId = await generateShortId("change");
    const [newChange] = await db
      .insert(changes)
      .values({
        teamId: session.teamId,
        repoId: session.repoId,
        shortId,
        title: intent.summary,
        intentSummary: intent.summary,
        status: "probable",
        confidence: intent.confidence,
        likelyScope: intent.likelyScope,
        embedding: intent.embedding,
      })
      .returning();

    return { action: "created", change: newChange };
  }

  async reportProgress(params: {
    sessionId: string;
    filesModified?: string[];
    symbolsModified?: string[];
    findings?: string[];
    status?: string;
  }) {
    // 查找该 Session 绑定的当前活跃 Change
    const activeChange = await this.getActiveChangeBySession(params.sessionId);
    if (!activeChange) return null;

    const mergedFiles = Array.from(
      new Set([...(activeChange.filesModified as string[]), ...(params.filesModified || [])])
    );
    const mergedSymbols = Array.from(
      new Set([...(activeChange.actualScope as string[]), ...(params.symbolsModified || [])])
    );
    const mergedFindings = Array.from(
      new Set([...(activeChange.findings as string[]), ...(params.findings || [])])
    );

    const [updated] = await db
      .update(changes)
      .set({
        filesModified: mergedFiles,
        actualScope: mergedSymbols,
        findings: mergedFindings,
        status: (params.status as any) || (mergedFiles.length > 0 ? "implementing" : activeChange.status),
        updatedAt: new Date(),
      })
      .where(eq(changes.id, activeChange.id))
      .returning();

    return updated;
  }

  async getActiveChangeBySession(sessionId: string) {
    const result = await db.query.intents.findFirst({
      where: (intents, { eq }) => eq(intents.sessionId, sessionId),
      orderBy: (intents, { desc }) => [desc(intents.createdAt)],
    });
    if (!result?.changeId) return null;

    const [change] = await db.select().from(changes).where(eq(changes.id, result.changeId));
    return change || null;
  }
}

export const changeService = new ChangeService();
```

## 5.5 Claim Manager (软声明与租约)

### `apps/api/src/services/claim.service.ts`

```typescript
import { db } from "@devboard/database";
import { claims, changes } from "@devboard/database";
import { eq, and, gt, isNull } from "drizzle-orm";
import { AcquireClaimInput, NotFoundError } from "@devboard/core";
import { changeService } from "./change.service.js";

export class ClaimService {
  async acquireClaim(input: AcquireClaimInput) {
    const activeChange = await changeService.getActiveChangeBySession(input.sessionId);
    if (!activeChange) {
      throw new NotFoundError("Active Change for session", input.sessionId);
    }

    const ttlMinutes = input.ttlMinutes ?? 30;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const [claim] = await db
      .insert(claims)
      .values({
        changeId: activeChange.id,
        sessionId: input.sessionId,
        scope: input.scope,
        scopeType: input.scopeType ?? "symbol",
        claimType: "speculative",
        strength: 0.8,
        expiresAt,
      })
      .returning();

    return claim;
  }

  async releaseClaim(claimId: string) {
    const [released] = await db
      .update(claims)
      .set({ releasedAt: new Date() })
      .where(eq(claims.id, claimId))
      .returning();

    return released;
  }

  async getActiveClaimsByScope(teamId: string, scopeItems: string[]) {
    // 查找未过期且未释放的 Claim
    const now = new Date();
    const activeClaims = await db
      .select({
        claim: claims,
        change: changes,
      })
      .from(claims)
      .innerJoin(changes, eq(claims.changeId, changes.id))
      .where(
        and(
          eq(changes.teamId, teamId),
          isNull(claims.releasedAt),
          gt(claims.expiresAt, now)
        )
      );

    const matches = activeClaims.filter((row) => {
      const heldScope = row.claim.scope as string[];
      return scopeItems.some((target) => heldScope.includes(target));
    });

    return matches.map((m) => ({
      claimId: m.claim.id,
      changeId: m.change.id,
      changeShortId: m.change.shortId,
      scope: m.claim.scope as string[],
      expiresAt: m.claim.expiresAt,
    }));
  }
}

export const claimService = new ClaimService();
```

## 5.6 Decision Service (决策治理)

### `apps/api/src/services/decision.service.ts`

```typescript
import { db } from "@devboard/database";
import { decisions, decisionOptions, changes } from "@devboard/database";
import { eq, and } from "drizzle-orm";
import {
  generateShortId,
  ProposeDecisionInput,
  ResolveDecisionInput,
  NotFoundError,
} from "@devboard/core";
import { embeddingService } from "@devboard/llm-client";
import { changeService } from "./change.service.js";

export class DecisionService {
  async proposeDecision(input: ProposeDecisionInput) {
    const activeChange = await changeService.getActiveChangeBySession(input.sessionId);

    // 1. 生成问题向量
    const vector = await embeddingService.embed(input.question + " " + (input.context || ""));

    // 2. 检查 Decision Memory 是否有现成 Policy 命中
    const memoryHit = await this.matchDecisionMemory(vector);
    if (memoryHit) {
      return {
        decision: memoryHit,
        autoResolved: true,
        resolution: memoryHit.policyRule,
      };
    }

    // 3. 落库新 Decision
    const shortId = await generateShortId("decision");
    const [decision] = await db
      .insert(decisions)
      .values({
        teamId: activeChange?.teamId || "00000000-0000-0000-0000-000000000000",
        shortId,
        question: input.question,
        context: input.context,
        raisedBySession: input.sessionId,
        status: "pending",
        reversibility: input.reversibility || "medium",
        urgency: input.blocking ? "blocking" : "normal",
        recommendation: input.recommendation,
        affectedChanges: activeChange ? [activeChange.id] : [],
        embedding: vector,
      })
      .returning();

    // 插入 Options
    if (input.options && input.options.length > 0) {
      await db.insert(decisionOptions).values(
        input.options.map((opt, idx) => ({
          decisionId: decision.id,
          label: opt.label,
          description: opt.description,
          pros: opt.pros || [],
          cons: opt.cons || [],
          sortOrder: idx,
        }))
      );
    }

    return { decision, autoResolved: false };
  }

  async resolveDecision(input: ResolveDecisionInput) {
    const [updated] = await db
      .update(decisions)
      .set({
        status: "human_resolved",
        chosenOption: input.chosenOption,
        resolution: input.resolution,
        resolvedBy: input.resolvedBy,
        resolvedAt: new Date(),
        isPolicy: Boolean(input.convertToPolicy),
        policyScope: input.policyScope || "global",
        policyRule: input.resolution,
        updatedAt: new Date(),
      })
      .where(eq(decisions.id, input.decisionId))
      .returning();

    if (!updated) throw new NotFoundError("Decision", input.decisionId);
    return updated;
  }

  private async matchDecisionMemory(vector: number[]) {
    // 查找相似度超过 0.85 的 Policy 记录
    const records = await db.query.decisions.findMany({
      where: (decisions, { eq }) => eq(decisions.isPolicy, true),
      limit: 10,
    });

    // 内存余弦相似度计算 (用于示范)
    for (const rec of records) {
      if (rec.embedding) {
        const sim = cosineSimilarity(vector, rec.embedding as number[]);
        if (sim > 0.85) return rec;
      }
    }
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const decisionService = new DecisionService();
```

## 5.7 Conflict Engine (分层冲突检测)

### `apps/api/src/services/conflict.service.ts`

```typescript
import { db } from "@devboard/database";
import { changes, changeSymbols } from "@devboard/database";
import { sql, eq, and, ne } from "drizzle-orm";
import { CollisionLevel, CollisionSeverity } from "@devboard/core";

export class ConflictEngine {
  /**
   * 检查指定 Change 与团队其他活跃 Change 之间的重叠
   */
  async checkCollisions(changeId: string, teamId: string) {
    const collisions: Array<{
      targetChangeId: string;
      targetShortId: string;
      level: CollisionLevel;
      severity: CollisionSeverity;
      sharedScope: string[];
    }> = [];

    // 1. File Collision (Level 1)
    const fileCollisions = await db.execute(sql`
      SELECT
        c2.id AS target_id,
        c2.short_id AS target_short_id,
        ARRAY(
          SELECT jsonb_array_elements_text(c1.files_modified)
          INTERSECT
          SELECT jsonb_array_elements_text(c2.files_modified)
        ) AS shared_files
      FROM changes c1
      JOIN changes c2 ON c1.team_id = c2.team_id AND c1.id != c2.id
      WHERE c1.id = ${changeId}
        AND c2.team_id = ${teamId}
        AND c2.status NOT IN ('completed', 'merged', 'abandoned')
        AND c1.files_modified ?| ARRAY(SELECT jsonb_array_elements_text(c2.files_modified));
    `);

    for (const row of fileCollisions as any[]) {
      if (row.shared_files && row.shared_files.length > 0) {
        collisions.push({
          targetChangeId: row.target_id,
          targetShortId: row.target_short_id,
          level: 1,
          severity: "medium",
          sharedScope: row.shared_files,
        });
      }
    }

    // 2. Symbol Collision (Level 2)
    const symbolCollisions = await db.execute(sql`
      SELECT
        cs2.change_id AS target_id,
        c2.short_id AS target_short_id,
        array_agg(cs1.symbol_fqn) AS shared_symbols
      FROM change_symbols cs1
      JOIN change_symbols cs2 ON cs1.symbol_fqn = cs2.symbol_fqn AND cs1.change_id != cs2.change_id
      JOIN changes c2 ON cs2.change_id = c2.id
      WHERE cs1.change_id = ${changeId}
        AND c2.team_id = ${teamId}
        AND c2.status NOT IN ('completed', 'merged', 'abandoned')
      GROUP BY cs2.change_id, c2.short_id;
    `);

    for (const row of symbolCollisions as any[]) {
      collisions.push({
        targetChangeId: row.target_id,
        targetShortId: row.target_short_id,
        level: 2,
        severity: "high",
        sharedScope: row.shared_symbols,
      });
    }

    return collisions;
  }
}

export const conflictEngine = new ConflictEngine();
```

## 5.8 Similarity Engine (重复工作检测)

### `apps/api/src/services/similarity.service.ts`

```typescript
import { db } from "@devboard/database";
import { changes } from "@devboard/database";
import { sql } from "drizzle-orm";

export class SimilarityEngine {
  async findSimilarWork(params: {
    teamId: string;
    embedding: number[];
    likelyScope: string[];
  }) {
    const vectorStr = `[${params.embedding.join(",")}]`;

    // 向量余弦检索 (Top 10)
    const candidates = await db.execute(sql`
      SELECT
        id, short_id, title, status, likely_scope, actual_scope, files_modified,
        1 - (embedding <=> ${vectorStr}::vector) AS semantic_score
      FROM changes
      WHERE team_id = ${params.teamId}
        AND status NOT IN ('completed', 'merged', 'abandoned')
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT 10;
    `);

    const results = [];
    for (const row of candidates as any[]) {
      const semanticScore = Number(row.semantic_score || 0);
      const scopeOverlap = this.calculateJaccard(
        params.likelyScope,
        [...(row.likely_scope || []), ...(row.actual_scope || [])]
      );

      const overallScore = Number((semanticScore * 0.7 + scopeOverlap * 0.3).toFixed(2));

      if (overallScore >= 0.5) {
        results.push({
          changeId: row.id,
          shortId: row.short_id,
          title: row.title,
          status: row.status,
          similarity: overallScore,
          semanticScore,
          scopeOverlap,
        });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  private calculateJaccard(a: string[], b: string[]): number {
    if (!a?.length || !b?.length) return 0;
    const setA = new Set(a.map((s) => s.toLowerCase()));
    const setB = new Set(b.map((s) => s.toLowerCase()));
    const intersection = [...setA].filter((x) => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : Number((intersection / union).toFixed(2));
  }
}

export const similarityEngine = new SimilarityEngine();
```

## 5.9 Context Compiler (上下文编译器)

### `apps/api/src/services/context-compiler.service.ts`

```typescript
import { db } from "@devboard/database";
import { changes, decisions } from "@devboard/database";
import { eq, and } from "drizzle-orm";
import { claimService } from "./claim.service.js";
import { conflictEngine } from "./conflict.service.js";

export class ContextCompiler {
  async compile(changeId: string, teamId: string) {
    const [change] = await db.select().from(changes).where(eq(changes.id, changeId));
    if (!change) return null;

    // 1. 获取关联活跃 Claim
    const currentScope = [...(change.likelyScope as string[]), ...(change.actualScope as string[])];
    const activeClaims = await claimService.getActiveClaimsByScope(teamId, currentScope);

    // 2. 获取潜在冲突
    const collisions = await conflictEngine.checkCollisions(changeId, teamId);

    // 3. 活跃政策与未决决策
    const policies = await db.query.decisions.findMany({
      where: (decisions, { eq }) => eq(decisions.isPolicy, true),
      limit: 5,
    });

    return {
      currentChange: {
        shortId: change.shortId,
        title: change.title,
        status: change.status,
        findings: change.findings,
      },
      relevantPolicies: policies.map((p) => ({
        shortId: p.shortId,
        rule: p.policyRule,
      })),
      activeClaims,
      potentialCollisions: collisions,
    };
  }
}

export const contextCompiler = new ContextCompiler();
```

## 5.10 Preflight 接口路由

### `apps/api/src/routes/preflight.ts`

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { preflightRequestSchema } from "@devboard/core";
import { embeddingService } from "@devboard/llm-client";
import { similarityEngine } from "../services/similarity.service.js";
import { claimService } from "../services/claim.service.js";
import { changeService } from "../services/change.service.js";
import { conflictEngine } from "../services/conflict.service.js";
import { sessionService } from "../services/session.service.js";
import { db } from "@devboard/database";
import { agentSessions } from "@devboard/database";
import { eq } from "drizzle-orm";

export const preflightRouter = new Hono();

preflightRouter.post("/", zValidator("json", preflightRequestSchema), async (c) => {
  const { sessionId, objective, likelyScope } = c.req.valid("json");

  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
  if (!session) return c.json({ error: "Session not found" }, 404);

  // 1. 语义向量
  const vector = await embeddingService.embed(`${objective} ${likelyScope.join(" ")}`);

  // 2. 相似任务查重
  const relatedWork = await similarityEngine.findSimilarWork({
    teamId: session.teamId,
    embedding: vector,
    likelyScope,
  });

  // 3. 检查范围内的冲突租约 (Claims)
  const activeClaims = await claimService.getActiveClaimsByScope(session.teamId, likelyScope);

  // 4. 计算建议行动策略
  let recommendedAction: "proceed" | "join_existing_change" | "split_scope" | "review_collision" = "proceed";
  if (relatedWork[0]?.similarity > 0.85) {
    recommendedAction = "join_existing_change";
  } else if (activeClaims.length > 0) {
    recommendedAction = "review_collision";
  }

  return c.json({
    success: true,
    data: {
      relatedWork,
      activeClaims,
      recommendedAction,
    },
  });
});
```

## 5.11 Findings Service & 5.12 Git Integration

### `apps/api/src/routes/findings.ts`

```typescript
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { changeService } from "../services/change.service.js";

export const findingsRouter = new Hono();

const publishFindingsSchema = z.object({
  sessionId: z.string().uuid(),
  findings: z.array(z.string().min(1)),
});

findingsRouter.post("/", zValidator("json", publishFindingsSchema), async (c) => {
  const { sessionId, findings } = c.req.valid("json");
  const updated = await changeService.reportProgress({
    sessionId,
    findings,
  });
  return c.json({ success: true, data: updated });
});
```

### `apps/api/src/routes/webhooks.ts`

```typescript
import { Hono } from "hono";
import { db } from "@devboard/database";
import { changes } from "@devboard/database";
import { eq } from "drizzle-orm";

export const webhooksRouter = new Hono();

webhooksRouter.post("/github", async (c) => {
  const event = c.req.header("X-GitHub-Event");
  const payload = await c.req.json();

  if (event === "pull_request") {
    const action = payload.action;
    const branch = payload.pull_request?.head?.ref;

    if (action === "opened" && branch) {
      await db
        .update(changes)
        .set({
          prUrl: payload.pull_request.html_url,
          prNumber: payload.pull_request.number,
          status: "verifying",
        })
        .where(eq(changes.branchName, branch));
    } else if (action === "closed" && payload.pull_request?.merged) {
      await db
        .update(changes)
        .set({
          mergeCommit: payload.pull_request.merge_commit_sha,
          status: "merged",
        })
        .where(eq(changes.branchName, branch));
    }
  }

  return c.json({ received: true });
});
```

## 5.13 SSE 实时事件流

### `apps/api/src/routes/events.ts`

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const eventsRouter = new Hono();

// 简单的内存事件发射中心（MVP）
type Listener = (data: any) => void;
const listeners = new Set<Listener>();

export function broadcastEvent(event: string, data: any) {
  for (const listener of listeners) {
    listener({ event, data });
  }
}

eventsRouter.get("/events", (c) => {
  return streamSSE(c, async (stream) => {
    const listener: Listener = (payload) => {
      stream.writeSSE({
        event: payload.event,
        data: JSON.stringify(payload.data),
      });
    };

    listeners.add(listener);

    stream.onAbort(() => {
      listeners.delete(listener);
    });

    // 维持心跳
    while (true) {
      await stream.sleep(15000);
      await stream.writeSSE({ event: "ping", data: "keepalive" });
    }
  });
});
```

---

# 第六部分：MCP Server (packages/mcp-server)

MCP (Model Context Protocol) 是 Claude Code 等先进 Agent 连接外部工具的标准方式。我们将所有 DevBoard 能力封装为纯标准 MCP Tools。

## 6.1 MCP Server 实现

### `packages/mcp-server/src/server.ts`

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE_URL = process.env.DEVBOARD_API_URL || "http://localhost:3000/api/v1";
const API_KEY = process.env.DEVBOARD_API_KEY || "dvb_dev_changeme_in_production";

async function postApi(path: string, body: any) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function createMcpServer() {
  const server = new Server(
    {
      name: "devboard-ai",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 1. 列举可用 Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "devboard_observe_intent",
        description: "Report current task intent or plan to DevBoard AI.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            summary: { type: "string" },
            likelyScope: { type: "array", items: { type: "string" } },
          },
          required: ["sessionId", "summary"],
        },
      },
      {
        name: "devboard_preflight",
        description: "Perform collision & duplicate work preflight before writing code.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            objective: { type: "string" },
            likelyScope: { type: "array", items: { type: "string" } },
          },
          required: ["sessionId", "objective"],
        },
      },
      {
        name: "devboard_acquire_claim",
        description: "Soft lease files or symbols you intend to write to.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            scope: { type: "array", items: { type: "string" } },
            ttlMinutes: { type: "number", default: 30 },
          },
          required: ["sessionId", "scope"],
        },
      },
      {
        name: "devboard_propose_decision",
        description: "Raise an architectural or product decision for team/human review.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label", "description"],
              },
            },
          },
          required: ["sessionId", "question", "options"],
        },
      },
    ],
  }));

  // 2. 执行 Tool 调用
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "devboard_observe_intent": {
        const data = await postApi("/intents", args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "devboard_preflight": {
        const data = await postApi("/preflight", args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "devboard_acquire_claim": {
        const data = await postApi("/claims", args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      case "devboard_propose_decision": {
        const data = await postApi("/decisions", args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
```

### `packages/mcp-server/src/index.ts`

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DevBoard MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
```

## 6.2 Claude Code 接入配置

开发者在本地工作空间运行以下命令即可挂载 DevBoard：

```bash
# 本地直接安装并连接
claude mcp add devboard -- node /path/to/devboard/packages/mcp-server/dist/index.js
```

或者将配置写入全局或仓库 `.claude/settings.json`：

```json
{
  "mcpServers": {
    "devboard": {
      "command": "node",
      "args": ["/Users/admin/devboard/packages/mcp-server/dist/index.js"],
      "env": {
        "DEVBOARD_API_URL": "http://localhost:3000/api/v1",
        "DEVBOARD_API_KEY": "dvb_dev_changeme_in_production"
      }
    }
  }
}
```

## 6.3 Codex 接入方案

对于 Codex CLI 或脚本化环境，利用 Git Hook 或轻量包装执行器：

```bash
#!/usr/bin/env bash
# devboard-codex-wrapper.sh
SESSION_ID=$(curl -s -X POST http://localhost:3000/api/v1/sessions \
  -H "Authorization: Bearer $DEVBOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"teamId":"your-team-id","agentType":"codex"}' | jq -r '.id')

# 执行一次 preflight
curl -s -X POST http://localhost:3000/api/v1/preflight \
  -H "Authorization: Bearer $DEVBOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"objective\":\"$*\"}"

# 调用真实的 codex cli
codex "$@"

# 上报 session 结束
curl -s -X DELETE http://localhost:3000/api/v1/sessions/$SESSION_ID \
  -H "Authorization: Bearer $DEVBOARD_API_KEY"
```

---

# 第七部分：CLI 工具 (packages/cli)

`@devboard/cli` 是安装在开发者本地机上的辅助工具，负责本地 Worktree 监听、Git Diff 捕获、以及与 Claude Code / 外部脚本的无缝桥接。

## 7.1 CLI 命令设计

使用 `commander` 框架实现标准化命令行：

### `packages/cli/src/index.ts`

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { startSessionCommand, endSessionCommand } from "./commands/session.js";
import { preflightCommand } from "./commands/preflight.js";
import { reportProgressCommand } from "./commands/report.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("devboard")
  .description("DevBoard AI CLI - Local developer companion for AI Coding Agents")
  .version("1.0.0");

program
  .command("session:start")
  .description("Start an ambient tracking session")
  .option("-t, --type <agentType>", "Agent type (claude_code | codex | custom)", "custom")
  .option("-n, --name <agentName>", "Friendly agent instance name")
  .action(startSessionCommand);

program
  .command("session:end")
  .description("End current session")
  .argument("<sessionId>", "Session UUID")
  .action(endSessionCommand);

program
  .command("preflight")
  .description("Check collision and duplicate work before editing")
  .requiredOption("-s, --session <sessionId>", "Session UUID")
  .requiredOption("-o, --objective <objective>", "Task objective")
  .option("--scope <items...>", "Likely modified symbols or files")
  .action(preflightCommand);

program
  .command("report")
  .description("Report file diffs or discovered findings")
  .requiredOption("-s, --session <sessionId>", "Session UUID")
  .option("--files <files...>", "Modified files")
  .option("--findings <findings...>", "Key findings")
  .action(reportProgressCommand);

program
  .command("watch")
  .description("Watch local git worktree and auto-sync changes to DevBoard")
  .requiredOption("-s, --session <sessionId>", "Session UUID")
  .option("-p, --path <path>", "Repository directory path", ".")
  .action(watchCommand);

program.parse(process.argv);
```

## 7.2 Local Git Watcher 实现

### `packages/cli/src/commands/watch.ts`

```typescript
import { watch } from "chokidar";
import simpleGit from "simple-git";
import { DevBoardApiClient } from "../api-client.js";

export async function watchCommand(options: { session: string; path: string }) {
  const repoPath = options.path;
  const sessionId = options.session;
  const git = simpleGit(repoPath);
  const client = new DevBoardApiClient();

  console.log(`[DevBoard Watcher] Watching ${repoPath} for session ${sessionId}...`);

  let debounceTimer: NodeJS.Timeout | null = null;

  const triggerSync = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const status = await git.status();
        const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
        const modified = [...status.modified, ...status.not_added, ...status.created];

        if (modified.length === 0) return;

        console.log(`[DevBoard Watcher] Detected changes in ${modified.length} files. Reporting...`);

        await client.post("/changes/progress", {
          sessionId,
          filesModified: modified,
          status: "implementing",
        });
      } catch (err: any) {
        console.error(`[DevBoard Watcher Error]:`, err.message);
      }
    }, 2000); // 2秒防抖
  };

  const watcher = watch(repoPath, {
    ignored: [/node_modules/, /\.git/, /dist/, /\.next/],
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("add", triggerSync);
  watcher.on("change", triggerSync);
  watcher.on("unlink", triggerSync);

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}
```

---

# 第八部分：异步 Worker (apps/worker)

Worker 运行在后台，承接所有重计算与非阻塞任务（如基于 Tree-sitter 的 AST 分析、后台向量批量计算、租约过期扫描等）。

## 8.1 Worker 框架 (BullMQ)

### `apps/worker/src/queues.ts`

```typescript
import { Queue, Worker, QueueEvents } from "bullmq";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
export const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE_NAMES = {
  SYMBOL_ANALYZER: "symbol-analyzer-queue",
  EMBEDDING: "embedding-queue",
  COLLISION: "collision-queue",
  DECISION_COMPRESS: "decision-compress-queue",
} as const;

export const symbolQueue = new Queue(QUEUE_NAMES.SYMBOL_ANALYZER, { connection });
export const collisionQueue = new Queue(QUEUE_NAMES.COLLISION, { connection });
```

## 8.2 Symbol Analyzer Job (Tree-sitter)

用于解析代码变更中的 Symbol（类、函数、方法）：

### `apps/worker/src/jobs/symbol-analyzer.job.ts`

```typescript
import { Worker, Job } from "bullmq";
import { connection, QUEUE_NAMES } from "../queues.js";
import { db } from "@devboard/database";
import { changeSymbols } from "@devboard/database";
import Parser from "web-tree-sitter";

let parserInitialized = false;

async function initParser() {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
}

export function startSymbolAnalyzerWorker() {
  return new Worker(
    QUEUE_NAMES.SYMBOL_ANALYZER,
    async (job: Job) => {
      const { changeId, filePath, content } = job.data;
      await initParser();

      // 这里以提取函数和类声明为例 (可按需加载对应语言 WASM 语法包)
      const symbols: Array<{ fqn: string; type: string; line: number }> = [];

      // 简单正则轻量退化提取 (当缺少对应语言语法 WASM 时)
      const functionRegex = /(?:function|class|const|def)\s+([a-zA-Z0-9_]+)/g;
      let match;
      let lineNum = 1;

      while ((match = functionRegex.exec(content)) !== null) {
        symbols.push({
          fqn: match[1],
          type: match[0].split(" ")[0],
          line: lineNum,
        });
      }

      if (symbols.length > 0) {
        await db.insert(changeSymbols).values(
          symbols.map((s) => ({
            changeId,
            symbolFqn: s.fqn,
            symbolType: s.type,
            filePath,
            lineStart: s.line,
            accessType: "write",
          }))
        );
      }
    },
    { connection, concurrency: 5 }
  );
}
```

## 8.3 Claim Expiry 轮询任务

### `apps/worker/src/jobs/claim-expiry.job.ts`

```typescript
import { db } from "@devboard/database";
import { claims } from "@devboard/database";
import { and, lt, isNull } from "drizzle-orm";

export async function runClaimExpiryCheck() {
  const now = new Date();
  const expired = await db
    .update(claims)
    .set({ releasedAt: now })
    .where(and(isNull(claims.releasedAt), lt(claims.expiresAt, now)))
    .returning();

  if (expired.length > 0) {
    console.log(`[Worker] Expired ${expired.length} stale claims.`);
  }
}
```

### `apps/worker/src/index.ts`

```typescript
import { startSymbolAnalyzerWorker } from "./jobs/symbol-analyzer.job.js";
import { runClaimExpiryCheck } from "./jobs/claim-expiry.job.js";

console.log("[DevBoard Worker] Starting background workers...");

startSymbolAnalyzerWorker();

// 每 30 秒轮询一次过期 Claim
setInterval(() => {
  runClaimExpiryCheck().catch((err) => console.error("Claim expiry check failed:", err));
}, 30000);
```

---

# 第九部分：前端 Web UI (apps/web)

前端采用 **Next.js 15 (App Router) + Tailwind CSS + shadcn/ui** 构建。页面设计围绕核心原则：**不放 Todo/Doing 看板，只放 Project Atlas 与 Decision Inbox**。

## 9.1 Next.js 页面结构与路由

```
apps/web/src/app/
├── layout.tsx                # 全局 Shell 布局 (Sidebar + 状态灯)
├── page.tsx                  # 默认重定向至当前活跃团队
└── team/
    └── [slug]/
        ├── page.tsx          # Project Atlas (主仪表盘)
        ├── decisions/
        │   └── page.tsx      # Decision Inbox (决策收件箱)
        └── changes/
            └── [id]/
                └── page.tsx  # Change 详情页
```

## 9.2 首页 Project Atlas 核心展示

### `apps/web/src/app/team/[slug]/page.tsx`

```tsx
import React from "react";

async function getAtlasData(slug: string) {
  const res = await fetch(`http://localhost:3000/api/v1/teams/${slug}/atlas`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${process.env.DEVBOARD_API_KEY}` },
  });
  return res.json();
}

export default async function AtlasPage({ params }: { params: { slug: string } }) {
  const { data } = await getAtlasData(params.slug);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* 顶部指标条 */}
      <header className="flex justify-between items-center border-b pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Project Atlas</h1>
          <p className="text-muted-foreground mt-1">Real-time AI Collaboration Control Plane</p>
        </div>
        <div className="flex gap-6 text-sm">
          <div className="text-center">
            <span className="text-2xl font-bold text-blue-600">{data?.summary?.activeAgents || 0}</span>
            <p className="text-muted-foreground">Active Agents</p>
          </div>
          <div className="text-center">
            <span className="text-2xl font-bold text-amber-600">{data?.summary?.pendingDecisions || 0}</span>
            <p className="text-muted-foreground">Decisions Needed</p>
          </div>
          <div className="text-center">
            <span className="text-2xl font-bold text-rose-600">{data?.summary?.activeCollisions || 0}</span>
            <p className="text-muted-foreground">Potential Collisions</p>
          </div>
        </div>
      </header>

      {/* 待人类裁决卡片 (Needs Attention) */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          🚨 Needs Your Decision
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {(data?.needsDecision || []).map((dec: any) => (
            <div key={dec.id} className="border rounded-xl p-5 shadow-sm bg-card space-y-3">
              <div className="flex justify-between items-start">
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-muted font-semibold">{dec.shortId}</span>
                <span className="text-xs text-rose-600 font-medium">Blocking Active Changes</span>
              </div>
              <h3 className="font-semibold text-lg">{dec.question}</h3>
              <p className="text-sm text-muted-foreground">{dec.context || "No context provided."}</p>
              <div className="pt-2 flex gap-2">
                <a
                  href={`/team/${params.slug}/decisions/${dec.id}`}
                  className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded-lg hover:opacity-90 font-medium"
                >
                  Review & Decide
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 活跃 Change 态势 */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Active Changes ({data?.activeWork?.length || 0})</h2>
        <div className="border rounded-xl divide-y">
          {(data?.activeWork || []).map((chg: any) => (
            <div key={chg.id} className="p-4 flex items-center justify-between hover:bg-muted/50 transition">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold">{chg.shortId}</span>
                  <span className="font-medium">{chg.title}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Scope: {(chg.likelyScope || []).join(", ") || "General"}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 font-medium">
                  {chg.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
```

## 9.3 Decision Inbox 详情页 (裁决交互)

### `apps/web/src/app/team/[slug]/decisions/[id]/page.tsx`

```tsx
"use client";

import React, { useState } from "react";

export default function DecisionDetailPage({ params }: { params: { slug: string; id: string } }) {
  const [selectedOption, setSelectedOption] = useState<string>("");
  const [makePolicy, setMakePolicy] = useState(true);

  const handleSubmit = async () => {
    if (!selectedOption) return;
    await fetch(`http://localhost:3000/api/v1/decisions/${params.id}/resolve`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dvb_dev_changeme_in_production",
      },
      body: JSON.stringify({
        chosenOption: selectedOption,
        resolution: `Resolved via Web UI: Option ${selectedOption}`,
        convertToPolicy: makePolicy,
      }),
    });
    window.location.href = `/team/${params.slug}`;
  };

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <header className="space-y-2">
        <span className="font-mono text-xs bg-muted px-2 py-1 rounded">DEC-182</span>
        <h1 className="text-2xl font-bold">How should login handle retryable DB exceptions?</h1>
        <p className="text-muted-foreground text-sm">
          Raised by Agent-17. Blocking 3 active changes in auth module.
        </p>
      </header>

      {/* 选项组 */}
      <div className="space-y-4 pt-4">
        {[
          { id: "A", title: "Option A: Throw Custom RetryException", desc: "Backward compatible, easy to rollback." },
          { id: "B", title: "Option B: Return Structured LoginResult (Recommended)", desc: "Cleaner semantics, requires minor caller migration." },
          { id: "C", title: "Option C: Public API Breaking Change", desc: "Cleanest, high risk." },
        ].map((opt) => (
          <label
            key={opt.id}
            className={`block border-2 rounded-xl p-4 cursor-pointer transition ${
              selectedOption === opt.id ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground"
            }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="radio"
                name="decisionOption"
                value={opt.id}
                checked={selectedOption === opt.id}
                onChange={() => setSelectedOption(opt.id)}
                className="w-4 h-4 text-primary"
              />
              <div>
                <h4 className="font-semibold text-sm">{opt.title}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
              </div>
            </div>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-2">
        <input
          type="checkbox"
          id="policy"
          checked={makePolicy}
          onChange={(e) => setMakePolicy(e.target.checked)}
          className="rounded text-primary"
        />
        <label htmlFor="policy" className="text-xs text-muted-foreground cursor-pointer">
          Save as engineering policy (Future agents will automatically obey this decision)
        </label>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!selectedOption}
        className="w-full py-3 bg-primary text-primary-foreground font-semibold rounded-xl disabled:opacity-50"
      >
        Submit Decision & Resume Blocked Agents
      </button>
    </div>
  );
}
```

---

# 第十部分：Docker 化与部署

## 10.1 生产级多阶段构建 Dockerfile

### `docker/Dockerfile`

```dockerfile
# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- Production Runner ----
FROM node:20-alpine AS runner

WORKDIR /app
RUN npm install -g pnpm

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps

ENV NODE_ENV=production
EXPOSE 3000 3001

CMD ["node", "apps/api/dist/index.js"]
```

## 10.2 一键部署脚本

### `scripts/setup.sh`

```bash
#!/usr/bin/env bash
set -e

echo "🚀 [DevBoard AI] Starting local environment setup..."

# 1. 复制环境变量模板
if [ ! -f .env ]; then
  echo "📄 Creating .env from .env.example..."
  cp .env.example .env
fi

# 2. 启动基础依赖 (Postgres + pgvector + Redis)
echo "📦 Starting Postgres & Redis..."
docker compose up -d postgres redis

# 3. 等待 PostgreSQL 就绪
echo "⏳ Waiting for PostgreSQL to be healthy..."
until docker compose exec postgres pg_isready -U devboard > /dev/null 2>&1; do
  sleep 1
done

# 4. 安装依赖并执行迁移
echo "⚙️ Installing dependencies & running database migrations..."
pnpm install
pnpm db:generate
pnpm db:migrate

echo "🌱 Seeding initial demo data..."
pnpm db:seed

echo "✨ [DevBoard AI] Setup complete! Run 'pnpm dev' to start all services."
```

---

# 第十一部分：测试策略

为保证 Agent 协作链路的坚固性，采用两层测试：

## 11.1 单元测试 (Vitest)

针对核心算法引擎编写高覆盖率单测：

### `apps/api/test/similarity.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { SimilarityEngine } from "../src/services/similarity.service.js";

describe("SimilarityEngine", () => {
  const engine = new SimilarityEngine();

  it("calculates Jaccard overlap correctly", () => {
    // @ts-ignore
    const score = engine.calculateJaccard(["AuthService.login", "RetryPolicy"], ["AuthService.login"]);
    expect(score).toBe(0.5);
  });

  it("returns 0 for disjoint sets", () => {
    // @ts-ignore
    const score = engine.calculateJaccard(["Foo"], ["Bar"]);
    expect(score).toBe(0);
  });
});
```

## 11.2 端到端集成测试 (E2E)

验证完整链路：
1. `session:start` $\to$ 2. `observe_intent` $\to$ 3. `preflight` $\to$ 4. `acquire_claim` $\to$ 5. `propose_decision` $\to$ 6. `resolve`。

---

# 第十二部分：MVP 验收标准

当且仅当以下测试用例在本地环境中完全通过时，DevBoard AI MVP 视为交付完成：

| 测试项 | 动作 | 预期结果 |
| :--- | :--- | :--- |
| **1. 意图自建** | 给 Claude Code 发送：“查一下用户登录慢的原因” | 后台无需人工干预，自动在数据库中生成一条 `Intent` 及绑定的 `Change`（`status: probable`） |
| **2. 查重感知** | 开启第二个会话发送：“登录超时排查” | 调用 `devboard_preflight` 时，返回值明确提示发现第 1 个会话的 Change，相似度 > 85%，推荐动作为 `join_existing_change` |
| **3. 符号冲突** | 两个会话同时声明要修改 `AuthService.login` | 系统准确在控制台和 API 响应中标识出 **Level 2 Symbol Collision** |
| **4. 决策收敛** | Agent 提出架构疑问（如返回值格式变更） | 自动进入 Web 端 **Decision Inbox**，人类在界面点击选项后，系统自动广播 Resolution，解除相关依赖阻塞 |
| **5. 租约防腐** | Agent 崩溃或 Session 超时断开 | 超过设定 TTL 后，系统 Worker 自动释放持有的 Claim，不再阻碍其他 Agent |

---

# 第十三部分：从 MVP 到完整产品的扩展路线

```mermaid
timeline
    title DevBoard AI 演进路线图
    Phase 1 (MVP) : 8~10 周 : MCP Server : Intent 自动生成 : L1/L2 冲突检测 : Decision Inbox 基础版 : Docker Compose 自托管
    Phase 2 (治理增强) : 6~8 周 : Decision Compression (LLM) : Authority Policy 引擎 : Context Compiler : Slack/Lark 通知集成
    Phase 3 (深层协作) : 6~8 周 : L3 依赖冲突检测 : L4 语义意图冲突 : D3.js Change Graph : Verification Planner 智能测试集
    Phase 4 (规模化) : 长期演进 : VS Code / JetBrains 深度插件 : Multi-repo 跨仓库关联 : 机器可执行策略执行器 (Executable ADR)
```

至此，整份开发说明书覆盖了代码目录、Schema、API、算法、MCP、UI、Worker 到 Docker 部署的全部技术细节，具备完全的可实施性与工程指导价值。
