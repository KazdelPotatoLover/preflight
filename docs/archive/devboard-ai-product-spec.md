# DevBoard AI

> 面向 AI 编程时代的无感代码协作基础设施  
> 让每一个 Coding Agent 都知道：团队正在做什么、哪里可能重复、哪些地方会冲突、哪些问题真正需要人来决定。

---

## 一句话介绍

**DevBoard AI 是一个面向 AI Coding 场景的协作控制层。**

开发者不需要先创建 Issue、Task 或手动登记工作，只需要像平时一样打开 Codex、Claude Code、Cursor 或其他 Coding Agent，直接告诉 AI 要解决什么问题。

DevBoard AI 会在后台自动理解开发意图，发现团队中是否有人正在处理相似问题，持续追踪 Agent 实际修改的代码范围，识别潜在重复劳动与冲突，并把真正需要人类判断的问题汇总到统一的 Decision Inbox。

它不是一个要求开发者维护状态的项目管理工具，而是一层**自动感知开发行为、理解协作关系、减少重复劳动和人工协调成本的 AI-native Collaboration Infrastructure**。

---

# 产品背景

AI 正在快速提升单个开发者的代码产出。

过去，一个开发者一天可能完成少量功能和若干次提交；现在，一个开发者可以同时运行多个 Coding Agent，在一天内产生几十次甚至上百次代码修改。

当 Coding throughput 大幅提升后，新的瓶颈开始出现：

- 两个人分别让 AI 处理了同一个问题，直到半小时后才发现重复劳动；
- 多个 Agent 同时修改同一个模块，却直到 Merge 时才发现冲突；
- 一个 Agent 做出的架构决策，另一个 Agent 完全不知道；
- Agent 遇到问题时频繁打断开发者，导致人类注意力成为新的瓶颈；
- 大量 Issue、Task、MR 状态需要人工维护，而这些状态很快就已经过期；
- 团队真正缺少的，不是更多代码，而是对「现在整个系统正在发生什么」的实时理解。

传统 DevBoard、Issue Tracker 和 Git Flow 的核心假设是：

> 人的开发速度较慢，因此可以依靠人主动登记任务、同步状态、Review 和协调。

AI Coding 改变了这个前提。

DevBoard AI 的目标，是把代码协作从：

> **人工流程管理**

转变成：

> **自动协作感知 + 冲突控制 + 决策路由。**

---

# 核心设计原则

## 1. 无感优先

开发者不应该为了“协作”而额外工作。

不要求：

- 开工前先创建 Task；
- 修改前手动登记文件；
- 在 DevBoard 更新 Doing / Review / Done；
- 每次发现问题都去通知团队；
- 手动同步 Agent 当前状态。

理想体验是：

```text
开发者
  ↓
打开 Coding Agent
  ↓
“登录接口偶尔超时，你帮我查一下并修掉”
  ↓
Agent 开始工作
```

与此同时，DevBoard AI 在后台自动完成：

```text
理解 Intent
↓
查询团队 Active Work
↓
发现重复工作
↓
加载相关 Decision
↓
检测潜在冲突
↓
持续追踪代码变化
↓
必要时才通知开发者
```

---

## 2. Agent 是入口，DevBoard 不是入口

开发者日常工作的主界面仍然可以是：

- Codex
- Claude Code
- Cursor
- GitHub Copilot
- OpenHands
- 自研 Coding Agent
- CLI / IDE Agent

DevBoard AI 通过 Agent Gateway、MCP、Hook 或 API 接入这些 Agent。

绝大部分时间，开发者甚至不需要打开 DevBoard UI。

UI 的主要用途只有两个：

1. **查看团队当前整体状态；**
2. **处理真正需要人类判断的 Decision。**

---

## 3. 自动发现，而不是人工登记

Change 不应该依赖人工创建。

DevBoard AI 会结合两类信号自动识别当前工作。

### Intent Signal

来自 Agent：

- 用户给 Agent 的任务描述；
- Agent 对问题的理解；
- Agent 当前假设；
- Agent 的计划；
- Agent 判断可能修改的模块；
- Agent 当前发现。

### Code Signal

来自实际开发行为：

- 打开的 Repository；
- Worktree / Branch；
- Files Read；
- Files Modified；
- Symbols Modified；
- Git Diff；
- Tests；
- Commits；
- Pull Request。

两者结合形成实时的 Change State：

```text
Agent Intent
     +
Actual Code Activity
     =
Current Change State
```

---

# 核心对象模型

DevBoard AI 的核心对象不再是传统的 Task，而是以下几个对象。

---

## Goal

Goal 表示一个较稳定的业务或工程目标。

例如：

```yaml
goal:
  id: G-102
  title: Improve login reliability
  objective: Reduce transient login failures
  owner: alice

  acceptance:
    - retry transient DB errors
    - no public API break
    - p99 latency increase < 20ms

  status: active
```

Goal 描述：

> **我们想达到什么结果。**

而不是规定：

> **具体应该修改哪些文件。**

Agent 可以根据执行过程中获得的新信息不断调整实现计划。

---

## Intent

Intent 表示开发者或 Agent 当前正在尝试解决的问题。

Intent 可以是不确定的。

例如刚开始：

```yaml
intent:
  summary: investigate intermittent login timeout
  status: exploring
  confidence: 0.42
```

随着 Agent 调查：

```yaml
intent:
  summary: add retry handling for DB pool timeout
  status: confirmed
  confidence: 0.91
```

Intent 生命周期：

```text
Observed
↓
Exploring
↓
Confirmed
↓
Implementing
↓
Verifying
↓
Done
```

---

## Change

Change 是真正的软件变化单元。

它可以由系统从 Agent 行为中自动生成。

例如：

```yaml
change:
  id: CHG-128

  goal: G-102

  intent:
    add retry handling for transient login failure

  agent:
    agent-17

  likely_scope:
    - auth
    - RetryPolicy

  actual_scope:
    - AuthService.login
    - RetryPolicy

  status:
    implementing
```

Change 不等于 PR。

一个 Change 可以包含：

- 一个或多个 Agent Session；
- 多个 Commit；
- 一个 Branch；
- 一个 Pull Request；
- 多轮 Verification；
- 多次 Replan。

---

## Claim

Claim 表示某个 Agent 当前准备修改的资源范围。

例如：

```yaml
claim:
  change: CHG-128
  agent: agent-17

  scope:
    - AuthService.login
    - RetryPolicy

  ttl: 30m
```

Claim 是**软声明**，不是硬锁。

它的作用是让其他 Agent 提前知道：

> 某个区域已经有 Active Writer。

---

## Decision

Decision 是需要做出的重要判断。

例如：

```yaml
decision:
  id: DEC-182

  question:
    Should AuthService.login expose RetryResult?

  raised_by:
    agent-17

  affected_changes:
    - CHG-128
    - CHG-131
    - CHG-144

  options:
    - keep current exception semantics
    - introduce internal LoginResult
    - change public API

  recommendation:
    introduce internal LoginResult

  reversibility:
    low

  authority:
    human

  status:
    pending
```

Decision 是 DevBoard AI 最重要的一等对象之一。

---

# 核心功能

# 1. Agent Observer

Agent Observer 用于无感捕获 Agent 当前正在做什么。

支持观察：

- 用户 Prompt；
- Agent Plan；
- Agent Tool Calls；
- Agent 当前读取文件；
- Agent 当前修改文件；
- Agent Git Diff；
- Agent Tests；
- Agent Commit；
- Agent Session 生命周期。

目标不是完整记录 Agent 对话，而是提取：

```text
What is this agent trying to do?
What has it discovered?
What is it likely to change?
What is it actually changing?
```

---

# 2. Ambient Change Detection

系统自动从开发行为中生成和更新 Change。

第一阶段：

```text
Probable Change
confidence: 35%
```

当 Agent 真正开始修改代码：

```text
Confirmed Change
confidence: 93%
```

开发者不需要点击：

```text
Create Change
```

系统自动维护：

- Change Title；
- Intent；
- Goal；
- Agent；
- Status；
- Scope；
- Branch；
- Commit；
- PR；
- Verification；
- Related Decisions。

---

# 3. Team Intent Registry

系统实时维护整个团队当前正在做什么。

例如：

```text
Alice / Agent-17
Investigating login timeout
Exploring AuthService / RetryPolicy

Bob / Agent-23
Fixing auth 500 caused by DB pool timeout
Implementing RetryPolicy

Charlie / Agent-31
Adding MFA flow
Modifying AuthService.login
```

这形成一个实时的团队工作图谱，而不是依赖人工维护的 Task Board。

---

# 4. Similar Work Detection

系统自动发现：

> 是否有人正在做相似的事情？

匹配不依赖标题完全一致。

可以结合：

- Intent Semantic Similarity；
- Likely Scope；
- Actual Files；
- Symbols；
- Error Fingerprint；
- Runtime Trace；
- Related Issue；
- Related API；
- Git Diff。

例如：

```text
Alice:
“登录偶尔 timeout，看看 retry”

Bob:
“auth 偶发 500，怀疑 DB connection”
```

系统发现：

```text
Common runtime fingerprint:
trace-7812

Common symbols:
AuthService.login
DBPool.acquire

Duplicate probability:
0.91
```

---

# 5. Duplicate Work Prevention

发现高概率重复劳动后，优先通知 Agent，而不是通知人。

例如 Agent 得到：

```text
Related active work found.

CHG-128
Bob / agent-23

Goal:
Fix transient login timeout

Current findings:
DB pool occasionally exceeds timeout.
Retry policy does not cover this failure mode.

Status:
implementation in progress
```

Agent 可以选择：

- Join Existing Change；
- Read Existing Findings；
- Review Existing Implementation；
- Split Scope；
- Work on Missing Path；
- Wait for Upstream Change。

目标是减少：

> “两个 Agent 各做半小时，最后才发现做的是同一件事。”

---

# 6. Collaboration Preflight

Coding Agent 在真正开始大规模修改之前，自动执行：

```text
collab.preflight()
```

输入：

```yaml
objective:
  fix login timeout

likely_scope:
  - AuthService.login
  - RetryPolicy
```

系统返回：

```yaml
related_work:
  - CHG-128

relevant_decisions:
  - DEC-42

potential_collisions:
  - CHG-131

recommended_action:
  join_existing_change
```

Preflight 对开发者应当完全透明。

---

# 7. Progressive Collision Detection

冲突检测不是简单的 File Lock。

系统分层检测。

## Level 1：文件冲突

```text
A modifies auth/login.ts
B modifies auth/login.ts
```

---

## Level 2：Symbol 冲突

```text
A modifies AuthService.login
B modifies AuthService.login
```

即使两个 Symbol 位于不同文件，也可以发现。

---

## Level 3：Dependency 冲突

```text
A changes AuthResult
B consumes AuthResult
```

---

## Level 4：Semantic Conflict

例如：

```text
A changes login failure semantics

B assumes old failure semantics
```

Git 可能没有文本冲突，但业务语义已经发生冲突。

---

# 8. Claim / Soft Lease

Agent 可以自动声明：

```text
我当前预计会修改这些区域。
```

例如：

```text
AuthService.login
RetryPolicy
```

其他 Agent 如果进入相同区域，系统可以：

- 提醒；
- 建议建立依赖；
- 建议基于对方 Change；
- 建议拆分 Scope；
- 必要时串行执行。

Claim 默认不阻止开发。

否则很容易形成大量误报和阻塞。

---

# 9. Shared Findings

Agent 不需要通过长对话互相聊天。

每个 Change 可以维护结构化 Findings：

```yaml
findings:
  - DBPool acquisition occasionally exceeds 3 seconds
  - RetryPolicy only handles ECONNRESET
  - TimeoutError is currently treated as fatal
```

其他 Agent 可以直接读取：

```text
change.get_findings(CHG-128)
```

降低重复调查和 Agent-to-Agent Chat 成本。

---

# 10. Decision Inbox

当 Agent 遇到真正需要人类判断的问题时，提交：

```text
decision.propose()
```

系统不会立刻打扰人。

首先检查：

```text
已有 Decision 是否能回答？
↓
Decision Policy 是否允许 AI 自己决定？
↓
这是低风险且容易回滚的问题吗？
↓
其他 Agent 是否提出过同一个问题？
↓
这个问题是否其实被其他 Decision 阻塞？
↓
是否值得占用 Human Attention？
```

只有必要的问题才进入：

```text
Decision Inbox
```

---

# 11. Decision Compression

多个 Agent 可能提出实际上属于同一个问题的 Decision。

例如：

```text
Agent A:
Should login return RetryResult?

Agent B:
How should MFA distinguish retryable failures?

Agent C:
Should auth errors expose retry metadata?
```

系统识别这些问题共享同一个根决策：

```text
What is the authentication failure model?
```

于是：

```text
3 questions
↓
1 decision
```

最终目标：

```text
1000 micro decisions
↓
70 material decisions
↓
12 unique decisions
↓
3 human decisions
```

减少人类决策负担。

---

# 12. Decision Impact Analysis

Decision 不只是一个问答记录。

系统维护：

```text
这个决定影响哪些 Change？
```

例如：

```text
DEC-182
Auth failure semantics
   │
   ├── CHG-128
   ├── CHG-131
   └── CHG-144
```

开发者做出一次判断后：

```text
DEC-182 → Option B
```

系统自动触发：

```text
Agent-17 resumed
Agent-23 replanning
Agent-31 assumptions updated
CHG-144 unblocked
```

实现：

> **One Human Decision → Many Agent Actions**

---

# 13. Decision Authority Policy

系统支持定义：

> 什么事情 AI 可以决定，什么事情必须由人决定。

例如：

```yaml
authority:

  variable_naming:
    agent

  local_implementation:
    agent

  internal_refactor:
    agent

  low_risk_dependency:
    agent

  public_api:
    human

  database_schema:
    human

  auth_semantics:
    human

  backward_compatibility:
    human

  product_behavior:
    human
```

未来可以进一步支持：

- Team Policy；
- Repo Policy；
- Directory Policy；
- Risk-based Policy；
- Role-based Authority。

---

# 14. Decision Memory

已经做过的重要判断成为团队长期知识。

例如：

```yaml
decision:
  id: DEC-42

  scope:
    backend/**

  rule:
    Do not introduce repository abstraction over Prisma.

  rationale:
    Keep database access explicit.

  status:
    active
```

以后 Agent 准备创建：

```text
UserRepository abstraction
```

系统自动发现：

```text
Planned change conflicts with DEC-42.
```

Agent 可以直接 Replan，而不是再次打扰人。

---

# 15. Executable Engineering Decisions

Decision 不只是文档。

系统可以让 Decision 成为机器可执行约束。

例如：

```text
DEC-42
Do not introduce repository abstraction.
```

可以进入 Agent Context 和 Preflight。

因此团队架构约束从：

```text
README / Wiki / ADR
```

升级成：

```text
Machine-readable engineering policy
```

---

# 16. Context Compiler

每个 Agent 开始工作时，DevBoard AI 自动生成：

```text
Context Package
```

例如：

```text
Goal:
Improve login reliability

Current Change:
Add retry handling for transient DB timeout

Relevant Decisions:
DEC-12
DEC-42
DEC-91

Related Active Work:
CHG-131 MFA refactor

Known Findings:
DBPool acquisition occasionally exceeds 3 sec

Potential Conflict:
AuthService.login

Constraints:
No public API break
No DB schema changes

Relevant Tests:
auth/login/*
```

Agent 不需要自己从整个 Repository 和历史聊天中寻找上下文。

---

# 17. Change Graph

系统维护实时 Change Graph：

```text
                    Goal
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       CHG-21     CHG-22     CHG-23
       Retry      Errors    Telemetry
          │
          ▼
       CHG-31
        MFA
```

叠加 Decision：

```text
             DEC-182
          Auth semantics
           /    |    \
          ▼     ▼     ▼
       CHG21  CHG31  CHG41
```

叠加 Agent：

```text
agent-17 → CHG21
agent-22 → CHG31
agent-38 → CHG41
```

团队可以实时理解：

> 当前整个软件系统正在如何被改变。

---

# 18. Git Integration

DevBoard AI 不替代 GitHub / GitLab。

Git 继续负责：

- Repository；
- Commit；
- Branch；
- Pull Request；
- Merge。

DevBoard AI 负责在上层建立关系：

```text
Goal
 └─ Change
      ├─ Agent Session
      ├─ Branch
      ├─ Commit
      ├─ Pull Request
      ├─ Verification
      └─ Decision
```

可以理解为：

> **Git 是 Code Ledger，DevBoard AI 是 Coordination Ledger。**

---

# 19. CI / Verification Integration

第一阶段不重新实现 CI。

直接接入：

- GitHub Actions；
- GitLab CI；
- Jenkins；
- Buildkite；
- CircleCI；
- 自研 Pipeline。

系统记录：

```yaml
verification:
  change: CHG-128

  required:
    - typecheck
    - auth/unit
    - auth/integration

  results:
    typecheck: pass
    auth/unit: pass
    auth/integration: pass
```

未来可以进一步发展成：

> **Verification Planner**

根据 Change Scope 和 Risk 自动选择最低成本且足够的验证集合。

---

# 20. Agent Gateway

DevBoard AI 提供统一 Agent Protocol。

例如：

```text
goal.get()

intent.observe()
intent.update()

change.get_context()
change.report_progress()

claim.acquire()
claim.release()

decision.propose()

findings.publish()

verification.report()
```

底层可以通过：

- MCP；
- CLI Hook；
- IDE Plugin；
- Agent SDK；
- REST / GraphQL；
- Git Hook。

接入不同 Coding Agent。

---

# 产品界面

## 首页：Needs Attention

首页不应该是传统：

```text
Todo
Doing
Review
Done
```

而应该是：

```text
Project Atlas

18 active agents
9 active changes
3 decisions pending
2 potential collisions
```

核心区域：

### Needs Your Decision

```text
DEC-182
Auth return semantics

BLOCKING 3 CHANGES

Recommendation:
Use internal LoginResult

[Accept] [View Context]
```

---

### Active Work

```text
Login Reliability

✓ Error classification
● Retry policy — Agent-17
● MFA integration — Agent-22
◐ Integration tests — verifying
```

---

### Duplicate Work

```text
HIGH CONFIDENCE

Alice / Agent-17
Investigating login timeout

Bob / Agent-23
Fixing DB timeout in auth

92% likely same root issue
```

---

### Collisions

```text
HIGH
CHG-21 ↔ CHG-31

Shared Symbol:
AuthService.login
```

---

# Change Detail

一个 Change 页面包含：

```text
CHG-128
Fix transient login timeout

Goal
G-102 Login Reliability

Agent
agent-17

Status
Implementing

Intent
Fix transient DB timeout retries

Current Findings
- DBPool may exceed 3 sec
- TimeoutError not retryable

Scope
AuthService.login
RetryPolicy

Related Work
CHG-131 MFA

Decisions
DEC-182

Git
Branch
Commits
PR

Verification
Unit ✓
Integration running
```

---

# Decision Detail

Decision 页面重点不是展示长对话，而是帮助人快速判断。

例如：

```text
DEC-182

How should login expose retryable failures?

Why this matters
3 active changes currently depend on this behavior.

Affected
CHG-128
CHG-131
CHG-144

Option A
Keep exception model
+ backward compatible
- retry semantics remain implicit

Option B
Introduce internal LoginResult
+ explicit semantics
+ no public API break
- requires internal migration

Option C
Change public API
+ cleanest model
- breaking change

Agent Recommendation
Option B

[Choose A] [Choose B] [Choose C]
```

---

# 一个完整使用场景

Alice 打开 Coding Agent：

```text
登录偶尔 timeout，你帮我查一下并修掉。
```

Agent 开始调查。

DevBoard AI 自动创建：

```text
INT-128
Investigate intermittent login timeout
```

系统发现：

```text
Bob / Agent-23

正在处理：
Auth 500 caused by DB pool timeout

Similarity:
92%
```

Alice 的 Agent 自动读取 Bob 的 Findings：

```text
DBPool acquisition occasionally exceeds 3 sec.
RetryPolicy does not handle TimeoutError.
```

于是 Alice 的 Agent 告诉 Alice：

```text
团队已有 Agent 在调查高度相似的问题。
我会复用它的调查结果，并重点检查 webhook login path，
避免重复做相同工作。
```

随后 Alice 的 Agent 发现：

```text
需要调整 auth failure model。
```

Agent 提交 DEC-182。

DevBoard AI 发现：

```text
Agent-23 和 Agent-31 也存在相同决策问题。
```

三个问题合并成一个 Decision。

Alice 在 Decision Inbox 选择：

```text
Option B
Internal LoginResult
```

系统自动：

```text
Agent-17 resumed
Agent-23 replanning
Agent-31 updated assumptions
```

所有 Change 继续执行。

开发者没有：

- 创建 Task；
- 更新状态；
- 去 Slack 问谁在做；
- 搜 Issue；
- 手动同步 Agent；
- 重复解释同一个架构决定。

这就是 DevBoard AI 想实现的协作体验。

---

# MVP 范围

第一版建议非常克制。

## 必做

### 1. Agent Observer

接入至少一种主流 Coding Agent，捕获：

- Prompt Intent；
- Agent Plan；
- Files Read；
- Files Changed；
- Git Diff。

---

### 2. Ambient Change Registry

自动生成和维护 Active Change。

---

### 3. Similar Work Detection

使用：

```text
Intent Embedding
+
Code Scope Overlap
```

完成第一版重复劳动检测。

---

### 4. File / Symbol Collision Detection

先做到：

- File-level；
- Symbol-level。

不急着解决完整 semantic conflict。

---

### 5. Shared Findings

Agent 能发布和读取结构化 Findings。

---

### 6. Decision Inbox

Agent 可以：

```text
decision.propose()
```

人可以统一处理。

---

### 7. Decision Memory

解决后的重要 Decision 自动成为未来 Agent 的 Context。

---

### 8. GitHub / GitLab Integration

同步：

- Branch；
- Commit；
- PR；
- Merge；
- CI 状态。

---

# MVP 暂时不要做

第一版不建议做：

- 自己的 Coding Agent；
- 自己的 IDE；
- 自己的 Git Hosting；
- 自己的完整 CI；
- Story Point；
- Sprint Planning；
- 工时统计；
- 复杂 Scrum；
- 资源排期；
- 通用 Agent Scheduler；
- 1024 Agent Control Plane；
- 复杂组织管理。

核心只解决：

> **高频 AI Coding 下，如何避免重复劳动、减少冲突，并减少人类决策负担。**

---

# 技术架构建议

```text
                    DevBoard UI
                         │
                         ▼
                 Control Plane API
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
 Intent Service    Decision Service   Change Service
        │                │                 │
        └────────────────┼─────────────────┘
                         │
                   Conflict Engine
                         │
                   Similarity Engine
                         │
                         ▼
                      Postgres
                         │
                  Event / Worker Layer
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
   Git Integration   Agent Gateway    CI Integration
        │                │
 GitHub / GitLab   Coding Agents
```

第一阶段完全可以使用：

- Postgres；
- 一个 API Service；
- Worker Queue；
- Embedding Search；
- Tree-sitter / LSP 做 Symbol 分析；
- GitHub / GitLab Webhook；
- MCP / Agent Hook。

不需要一开始引入复杂分布式架构。

---

# 核心指标

DevBoard AI 不应该主要优化：

- Task 数量；
- Commit 数量；
- Agent Session 数量；
- Story Point；
- Coding Time。

更应该关注：

## Duplicate Work Avoided

```text
避免了多少重复调查 / 重复实现。
```

---

## Collision Detected Before Merge

```text
多少冲突在真正写完代码之前就被发现。
```

---

## Human Interruptions per Change

```text
Human Interruptions
───────────────────
Accepted Changes
```

越低越好。

---

## Decision Reuse Rate

```text
一个历史 Decision
避免了多少次重复询问。
```

---

## Human Decision Leverage

核心北极星指标：

```text
Accepted Changes
────────────────
Human Decisions
```

例如：

```text
Today

43 accepted changes
7 human decisions

= 6.1 changes / human decision
```

长期目标是不断提高：

```text
10
20
50
100
```

意味着：

> 一个开发者可以驾驭越来越大的 AI 工程产能。

---

# 产品定位总结

DevBoard AI 不是：

> 一个给 AI Agent 用的 Jira。

也不是：

> 一个可以展示 Agent 状态的 Dashboard。

更不是：

> 又一个 Multi-Agent Framework。

它真正想成为的是：

> **AI Coding 时代的协作感知层。**

让每一个 Coding Agent 在开始工作之前都知道：

```text
团队正在做什么？
有没有人在解决同一个问题？
哪些代码正在被修改？
哪些决定已经做过？
哪些区域存在潜在冲突？
哪些问题需要人做判断？
```

最终，开发者只需要继续做一件最自然的事情：

```text
打开 Agent
告诉它你想解决什么
```

剩下的协作、去重、同步、冲突检测和决策传播，由 DevBoard AI 在后台完成。

---

# Vision

今天，一个开发者同时运行 3～10 个 Coding Agent，就已经开始出现协作问题。

未来，一个团队可能同时运行几十甚至数百个 Agent。

届时，最大的瓶颈不会是：

> AI 能不能写更多代码。

而会变成：

> 人类是否还能理解、协调并控制这么多并行的软件变化。

DevBoard AI 希望解决的，就是这个问题。

**让 Agent 负责高速执行，让系统负责自动协作，让人只负责真正重要的决定。**
