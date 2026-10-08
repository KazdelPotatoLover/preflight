import { publish } from './reliability.js';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import * as t from '../db/schema.js';
import type { QueryDatabase } from '../db/client.js';
import { DomainError, schemas, type Action, type Actor } from './contracts.js';

const closed = (status: string) => ['completed', 'abandoned'].includes(status);
export class Management {
  constructor(private db: QueryDatabase, private actor: Actor, private clock: () => Date) {}
  private time() { return this.clock().toISOString(); }
  async event(action: string, aggregate_id: string, data: Record<string, unknown>) {
    await publish(this.db, this.actor, action, aggregate_id, data, this.clock);
  }
  async project(id: string) {
    const [p] = await this.db.select().from(t.projects).where(and(eq(t.projects.id, id), eq(t.projects.repo, this.actor.repo)));
    if (!p) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
    return p;
  }
  planning(p: typeof t.projects.$inferSelect) {
    if (this.actor.role !== 'human' && !p.planning_agents.includes(this.actor.member)) throw new DomainError('FORBIDDEN', 'Project planning requires a human or an explicitly authorized agent', 403);
  }
  async defaultProject() {
    const [existing] = await this.db.select().from(t.projects).where(and(eq(t.projects.repo, this.actor.repo), eq(t.projects.is_default, true)));
    if (existing) return existing;
    const [p] = await this.db.insert(t.projects).values({ id: randomUUID(), repo: this.actor.repo, title: '默认项目', is_default: true }).returning();
    return p!;
  }
  async goal(id: string) {
    const [g] = await this.db.select().from(t.goals).where(and(eq(t.goals.id, id), eq(t.goals.repo, this.actor.repo)));
    if (!g) throw new DomainError('GOAL_NOT_FOUND', 'Goal not found', 404);
    return g;
  }
  async work(id: string) {
    const [c] = await this.db.select().from(t.changes).where(and(eq(t.changes.id, id), eq(t.changes.repo, this.actor.repo)));
    if (!c) throw new DomainError('CHANGE_NOT_FOUND', 'Work not found', 404);
    return c;
  }
  async milestone(id: string, projectId: string) {
    const [m] = await this.db.select().from(t.milestones).where(and(eq(t.milestones.id, id), eq(t.milestones.repo, this.actor.repo), eq(t.milestones.project_id, projectId)));
    if (!m || m.state !== 'planned') throw new DomainError('MILESTONE_NOT_FOUND', 'Active milestone in this project not found', 404);
    return m;
  }
  version(actual: number, expected?: number) {
    if (actual !== expected) throw new DomainError('STALE_VERSION', `Refresh state; current version is ${actual}`, 409);
  }
  async ready(g: typeof t.goals.$inferSelect) {
    const p = await this.project(g.project_id);
    if (p.state !== 'active' || g.plan_state !== 'ready') throw new DomainError('GOAL_NOT_READY', 'Goal is not ready for execution', 409);
  }
  criteria(indices: number[], g: typeof t.goals.$inferSelect) {
    if (!indices.length || new Set(indices).size !== indices.length || indices.some(i => i >= g.acceptance.length)) throw new DomainError('VALIDATION_ERROR', 'Goal criteria mapping must be nonempty, unique and in range');
  }
  async setDependencies(c: t.Change, ids: string[]) {
    if (new Set(ids).size !== ids.length || ids.includes(c.id)) throw new DomainError('INVALID_DEPENDENCY', 'Dependencies must be unique and cannot include self');
    const g = await this.goal(c.goal_id);
    for (const id of ids) {
      const other = await this.work(id), otherGoal = await this.goal(other.goal_id);
      if (otherGoal.project_id !== g.project_id) throw new DomainError('INVALID_DEPENDENCY', 'Dependencies must be in the same project');
    }
    const edges = await this.db.select({ from: t.dependencies.change_id, to: t.dependencies.depends_on_id }).from(t.dependencies)
      .innerJoin(t.changes, and(eq(t.changes.id, t.dependencies.change_id), eq(t.changes.repo, this.actor.repo)));
    const graph = new Map<string, string[]>();
    for (const e of edges) if (e.from !== c.id) graph.set(e.from, [...(graph.get(e.from) ?? []), e.to]);
    graph.set(c.id, ids);
    const seen = new Set<string>(), pending = [...ids];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === c.id) throw new DomainError('DEPENDENCY_CYCLE', 'Dependencies would form a cycle', 409);
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...(graph.get(id) ?? []));
    }
    await this.db.delete(t.dependencies).where(eq(t.dependencies.change_id, c.id));
    if (ids.length) await this.db.insert(t.dependencies).values(ids.map(depends_on_id => ({ change_id: c.id, depends_on_id })));
  }
  async currentClaim(changeId: string) {
    const [claim] = await this.db.select().from(t.claims).where(and(eq(t.claims.repo, this.actor.repo), eq(t.claims.change_id, changeId), isNull(t.claims.released_at)));
    return claim;
  }
  async requireLease(c: t.Change, sessionId?: string, leaseId?: string, epoch?: number) {
    const claim = await this.currentClaim(c.id);
    if (!claim || Date.parse(claim.expires_at) <= this.clock().getTime() || claim.id !== leaseId || claim.epoch !== epoch || claim.session_id !== sessionId || claim.member !== this.actor.member) {
      throw new DomainError('LEASE_REQUIRED', 'Use your current unexpired responsibility lease; refresh or reclaim work', 409);
    }
    return claim;
  }
  async session(id?: string, agentType = 'coding-agent') {
    if (id) {
      const [s] = await this.db.select().from(t.sessions).where(and(eq(t.sessions.id, id), eq(t.sessions.repo, this.actor.repo), eq(t.sessions.member, this.actor.member)));
      if (!s) throw new DomainError('SESSION_NOT_FOUND', 'Your session was not found', 404);
      return s;
    }
    const [s] = await this.db.insert(t.sessions).values({ id: randomUUID(), repo: this.actor.repo, member: this.actor.member, agent_type: agentType, last_seen_at: this.time() }).returning();
    return s!;
  }
  async claim(c: t.Change, sessionId: string) {
    if (this.actor.role !== 'agent') throw new DomainError('FORBIDDEN', 'Only an agent can claim execution responsibility', 403);
    if (c.lifecycle !== 'managed' || closed(c.status)) throw new DomainError('CLAIM_NOT_ALLOWED', 'Only active managed tasks can be claimed', 409);
    const g = await this.goal(c.goal_id); await this.ready(g);
    if (c.goal_definition_version !== g.definition_version) throw new DomainError('REPLAN_REQUIRED', 'Task must be updated against the current goal definition', 409);
    const deps = await this.db.select({ work: t.changes, goal_definition_version: t.goals.definition_version }).from(t.dependencies).innerJoin(t.changes, eq(t.changes.id, t.dependencies.depends_on_id)).innerJoin(t.goals, eq(t.goals.id, t.changes.goal_id)).where(eq(t.dependencies.change_id, c.id));
    if (deps.some(d => d.work.status !== 'completed' || d.work.goal_definition_version !== d.goal_definition_version)) throw new DomainError('DEPENDENCY_PENDING', 'Dependencies must report completion against the current goal definition before this task can be claimed', 409);
    const [runtime] = await this.db.select().from(t.runtimes).where(eq(t.runtimes.session_id, sessionId));
    if (runtime) {
      const active = await this.db.select({ claim: t.claims }).from(t.claims).innerJoin(t.changes, eq(t.changes.id, t.claims.change_id)).innerJoin(t.goals, eq(t.goals.id, t.changes.goal_id)).where(and(eq(t.claims.repo, this.actor.repo), isNull(t.claims.released_at), eq(t.goals.project_id, g.project_id)));
      const current = active.filter(r => Date.parse(r.claim.expires_at) > this.clock().getTime());
      if (current.some(r => r.claim.session_id === sessionId)) throw new DomainError('SESSION_CAPACITY', 'Session may own one primary task at a time', 409);
      if (current.length >= 2) throw new DomainError('PROJECT_CAPACITY', 'Project currently permits two primary tasks', 409);
    }
    const old = await this.currentClaim(c.id);
    if (old && Date.parse(old.expires_at) > this.clock().getTime()) throw new DomainError('ALREADY_CLAIMED', 'Task already has a current responsibility lease', 409);
    if (old) {
      await this.db.update(t.claims).set({ released_at: this.time(), release_reason: 'expired' }).where(eq(t.claims.id, old.id));
      await this.event('claim.expired', c.id, { lease_id: old.id, epoch: old.epoch });
    }
    const [lease] = await this.db.insert(t.claims).values({ id: randomUUID(), repo: this.actor.repo, change_id: c.id, session_id: sessionId, member: this.actor.member,
      epoch: c.claim_epoch + 1, expires_at: new Date(this.clock().getTime() + 600000).toISOString() }).returning();
    const [change] = await this.db.update(t.changes).set({ claim_epoch: c.claim_epoch + 1, version: c.version + 1, updated_at: this.time() }).where(eq(t.changes.id, c.id)).returning();
    await this.db.insert(t.changeSessions).values({ change_id: c.id, session_id: sessionId }).onConflictDoNothing();
    if (c.claim_epoch > 0) {
      const affected = await this.db.select({ decision: t.decisions }).from(t.decisionImpacts).innerJoin(t.decisions, eq(t.decisions.id, t.decisionImpacts.decision_id)).where(and(eq(t.decisionImpacts.change_id, c.id), eq(t.decisions.repo, this.actor.repo), eq(t.decisions.status, 'negotiating')));
      for (const { decision: d } of affected) {
        await this.db.update(t.decisions).set({ review_epoch: d.review_epoch+1, version: d.version+1 }).where(eq(t.decisions.id, d.id));
        await this.event('decision.owner_changed', d.id, { review_epoch: d.review_epoch+1, version: d.version+1 });
      }
    }
    await this.event('claim.created', c.id, { lease_id: lease!.id, epoch: lease!.epoch, session_id: sessionId });
    return { change: change!, claim: lease!, session_id: sessionId };
  }
  async execute(action: Action, raw: unknown): Promise<Record<string, unknown>> {
    switch (action) {
      case 'preflight_manage_project': {
        const d = schemas.preflight_manage_project.parse(raw);
        if (this.actor.role !== 'human') throw new DomainError('FORBIDDEN', 'Only a human manages projects and planning delegation', 403);
        if (d.operation === 'create') {
          if (!d.title || d.project_id || d.expected_version) throw new DomainError('VALIDATION_ERROR', 'Create requires title and no existing identity');
          const [project] = await this.db.insert(t.projects).values({ id: randomUUID(), repo: this.actor.repo, title: d.title, description: d.description, planning_agents: d.planning_agents, state: d.state }).returning();
          await this.event('project.created', project!.id, { title: d.title }); return { project };
        }
        if (!d.project_id) throw new DomainError('VALIDATION_ERROR', 'Update requires project_id');
        const p = await this.project(d.project_id); this.version(p.version, d.expected_version);
        const [project] = await this.db.update(t.projects).set({ title: d.title ?? p.title, description: d.description ?? p.description, state: d.state ?? p.state, planning_agents: d.planning_agents ?? p.planning_agents, version: p.version + 1 }).where(eq(t.projects.id, p.id)).returning();
        await this.event('project.updated', p.id, { before: p, after: project }); return { project };
      }
      case 'preflight_manage_milestone': {
        const d = schemas.preflight_manage_milestone.parse(raw); const p = await this.project(d.project_id); this.planning(p);
        if (p.state !== 'active') throw new DomainError('PROJECT_ARCHIVED', 'Project is archived', 409);
        if (d.operation === 'create') {
          if (!d.title || d.milestone_id || d.expected_version) throw new DomainError('VALIDATION_ERROR', 'Create requires title');
          const [milestone] = await this.db.insert(t.milestones).values({ id: randomUUID(), repo: this.actor.repo, project_id: p.id, title: d.title, due_date: d.due_date, state: d.state }).returning();
          await this.event('milestone.created', milestone!.id, { title: d.title }); return { milestone };
        }
        if (!d.milestone_id) throw new DomainError('VALIDATION_ERROR', 'Update requires milestone_id');
        const [m] = await this.db.select().from(t.milestones).where(and(eq(t.milestones.id, d.milestone_id), eq(t.milestones.repo, this.actor.repo), eq(t.milestones.project_id, p.id)));
        if (!m) throw new DomainError('MILESTONE_NOT_FOUND', 'Milestone not found', 404);
        this.version(m.version, d.expected_version);
        const [milestone] = await this.db.update(t.milestones).set({ title: d.title ?? m.title, due_date: d.due_date === undefined ? m.due_date : d.due_date, state: d.state ?? m.state, version: m.version + 1 }).where(eq(t.milestones.id, m.id)).returning();
        await this.event('milestone.updated', m.id, { before: m, after: milestone }); return { milestone };
      }
      case 'preflight_manage_goal': {
        const d = schemas.preflight_manage_goal.parse(raw), g = await this.goal(d.goal_id), p = await this.project(g.project_id); this.planning(p); this.version(g.version, d.expected_version);
        if (d.milestone_id && d.milestone_id !== g.milestone_id) await this.milestone(d.milestone_id, g.project_id);
        const updates = { title: d.title, objective: d.objective, acceptance: d.acceptance, plan_state: d.plan_state, priority: d.priority, rank: d.rank, milestone_id: d.milestone_id, owner: d.owner, due_date: d.due_date };
        const definitionChanged = (d.acceptance !== undefined && JSON.stringify(d.acceptance) !== JSON.stringify(g.acceptance)) || (d.objective !== undefined && d.objective !== g.objective);
        const [goal] = await this.db.update(t.goals).set({ ...updates, version: g.version + 1, definition_version: g.definition_version + (definitionChanged ? 1 : 0) }).where(eq(t.goals.id, g.id)).returning();
        await this.event('goal.updated', g.id, { before: g, after: goal }); return { goal };
      }
      case 'preflight_manage_work': {
        const d = schemas.preflight_manage_work.parse(raw), c = await this.work(d.change_id), g = await this.goal(c.goal_id), p = await this.project(g.project_id);
        if (c.lifecycle !== 'managed' || closed(c.status)) throw new DomainError('WORK_NOT_EDITABLE', 'Only active managed task definitions can be edited', 409);
        this.version(c.version, d.expected_version);
        const current = await this.currentClaim(c.id);
        if (current && Date.parse(current.expires_at) > this.clock().getTime()) await this.requireLease(c, d.session_id, d.lease_id, d.lease_epoch);
        else if (this.actor.role === 'human') this.planning(p);
        else if (c.created_by !== this.actor.member) {
          if (!d.session_id) throw new DomainError('FORBIDDEN', 'Join task participation before editing', 403);
          await this.session(d.session_id);
          const [participation] = await this.db.select().from(t.changeSessions).where(and(eq(t.changeSessions.change_id, c.id), eq(t.changeSessions.session_id, d.session_id)));
          if (!participation) throw new DomainError('FORBIDDEN', 'You are not participating in this task', 403);
        }
        const indices = d.goal_criteria_indices ?? c.goal_criteria_indices; this.criteria(indices, g);
        if (d.depends_on_change_ids) await this.setDependencies(c, d.depends_on_change_ids);
        const [change] = await this.db.update(t.changes).set({ title: d.title ?? c.title, task_acceptance: d.task_acceptance ?? c.task_acceptance, goal_criteria_indices: indices,
          definition_version: c.definition_version + 1, goal_definition_version: g.definition_version, verification: null, version: c.version + 1, updated_at: this.time() }).where(eq(t.changes.id, c.id)).returning();
        await this.event('task.updated', c.id, { before: c, after: change, depends_on_change_ids: d.depends_on_change_ids }); return { change };
      }
      case 'preflight_manage_claim': {
        const d = schemas.preflight_manage_claim.parse(raw), c = await this.work(d.change_id);
        if (this.actor.role !== 'agent' || c.lifecycle !== 'managed') throw new DomainError('FORBIDDEN', 'Agent lease management applies only to managed tasks', 403);
        if (d.operation === 'claim') {
          this.version(c.version, d.expected_version); const s = await this.session(d.session_id, d.agent_type); return this.claim(c, s.id);
        }
        const lease = await this.requireLease(c, d.session_id, d.lease_id, d.lease_epoch);
        if (d.operation === 'renew') {
          if (closed(c.status)) throw new DomainError('CLAIM_NOT_ALLOWED', 'Closed task cannot renew a lease', 409);
          const [claim] = await this.db.update(t.claims).set({ expires_at: new Date(this.clock().getTime() + 600000).toISOString() }).where(eq(t.claims.id, lease.id)).returning();
          await this.db.update(t.sessions).set({ last_seen_at: this.time() }).where(eq(t.sessions.id, lease.session_id));
          await this.event('claim.renewed', c.id, { lease_id: lease.id, epoch: lease.epoch }); return { claim, change: c };
        }
        await this.db.update(t.claims).set({ released_at: this.time(), release_reason: 'released' }).where(eq(t.claims.id, lease.id));
        const [change] = await this.db.update(t.changes).set({ version: c.version + 1, updated_at: this.time() }).where(eq(t.changes.id, c.id)).returning();
        await this.event('claim.released', c.id, { lease_id: lease.id, epoch: lease.epoch }); return { change };
      }
      default: throw new DomainError('VALIDATION_ERROR', 'Unknown management action');
    }
  }
  async workViews(changes: t.Change[]) {
    if (!changes.length) return [];
    const ids = changes.map(c => c.id);
    const [leases, edges, allGoals] = await Promise.all([
      this.db.select().from(t.claims).where(and(eq(t.claims.repo, this.actor.repo), inArray(t.claims.change_id, ids))).orderBy(desc(t.claims.epoch)),
      this.db.select({ change_id: t.dependencies.change_id, work: t.changes }).from(t.dependencies).innerJoin(t.changes, eq(t.changes.id, t.dependencies.depends_on_id)).where(inArray(t.dependencies.change_id, ids)),
      this.db.select({ goal: t.goals, project: t.projects }).from(t.goals).innerJoin(t.projects, eq(t.projects.id, t.goals.project_id)).where(eq(t.goals.repo, this.actor.repo)),
    ]);
    return changes.map(c => {
      const g = allGoals.find(row => row.goal.id === c.goal_id)!;
      const lease = leases.find(l => l.change_id === c.id), active = lease && !lease.released_at && Date.parse(lease.expires_at) > this.clock().getTime() && !closed(c.status);
      const dependencies = edges.filter(e => e.change_id === c.id).map(e => ({ change_id: e.work.id, title: e.work.title, status: e.work.status, definition_current: e.work.goal_definition_version === allGoals.find(row => row.goal.id === e.work.goal_id)?.goal.definition_version }));
      const blocked_reasons = [
        ...(g.project.state !== 'active' ? ['project_archived'] : []), ...(g.goal.plan_state !== 'ready' ? [`goal_${g.goal.plan_state}`] : []),
        ...(c.lifecycle === 'managed' && c.goal_definition_version !== g.goal.definition_version ? ['replan_required'] : []),
        ...dependencies.filter(d => d.status !== 'completed' || !d.definition_current).map(d => `dependency:${d.change_id}`),
      ];
      return { ...c, project_id: g.goal.project_id, dependencies, blocked_reasons,
        claim: active ? lease : null, claim_state: closed(c.status) ? 'closed' : c.lifecycle === 'legacy' ? 'legacy' : active ? 'claimed' : lease && (!lease.released_at || lease.release_reason === 'expired') ? 'expired' : 'unclaimed',
        available_to_claim: c.lifecycle === 'managed' && !closed(c.status) && !active && !blocked_reasons.length };
    });
  }
  async search(raw: unknown) {
    const d = schemas.preflight_search_findings.parse(raw);
    if (d.project_id) await this.project(d.project_id);
    if (d.goal_id) await this.goal(d.goal_id);
    if (d.change_id) await this.work(d.change_id);
    const filters = [eq(t.findings.repo, this.actor.repo), eq(t.changes.repo, this.actor.repo), eq(t.sessions.repo, this.actor.repo), eq(t.goals.repo, this.actor.repo)];
    if (d.project_id) filters.push(eq(t.goals.project_id, d.project_id));
    if (d.goal_id) filters.push(eq(t.goals.id, d.goal_id));
    if (d.change_id) filters.push(eq(t.findings.change_id, d.change_id));
    if (d.finding_id) filters.push(eq(t.findings.id, d.finding_id));
    if (d.kind) filters.push(eq(t.findings.kind, d.kind));
    if (d.query) filters.push(sql`strpos(lower(${t.findings.content} || ' ' || coalesce(${t.findings.detail}, '') || ' ' || coalesce(${t.findings.conditions}, '')), lower(${d.query})) > 0`);
    if (d.cursor) {
      try {
        const { at, id } = JSON.parse(Buffer.from(d.cursor, 'base64url').toString()) as { at: string; id: string };
        if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]/.test(at) || !Number.isFinite(Date.parse(at)) || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid cursor');
        filters.push(sql`(${t.findings.created_at}, ${t.findings.id}) < (${at}::timestamptz, ${id}::uuid)`);
      } catch { throw new DomainError('VALIDATION_ERROR', 'Invalid findings cursor'); }
    }
    const rows = await this.db.select({ finding: t.findings, change_title: t.changes.title, member: t.sessions.member, agent_type: t.sessions.agent_type }).from(t.findings)
      .innerJoin(t.changes, eq(t.changes.id, t.findings.change_id)).innerJoin(t.goals, eq(t.goals.id, t.changes.goal_id)).innerJoin(t.sessions, eq(t.sessions.id, t.findings.session_id))
      .where(and(...filters)).orderBy(desc(t.findings.created_at), desc(t.findings.id)).limit(d.limit + 1);
    const page = rows.slice(0, d.limit), last = page.at(-1);
    const ids = page.map(r => r.finding.id);
    const amendments = ids.length ? await this.db.select({ id: t.findings.id, refutes_id: t.findings.refutes_id, supersedes_id: t.findings.supersedes_id }).from(t.findings)
      .where(and(eq(t.findings.repo, this.actor.repo), or(inArray(t.findings.refutes_id, ids), inArray(t.findings.supersedes_id, ids)))) : [];
    return { findings: page.map(({ finding, ...source }) => ({ ...finding, ...source, source: 'agent_report', amended_by: amendments.filter(a => a.refutes_id === finding.id || a.supersedes_id === finding.id) })),
      next_cursor: rows.length > d.limit && last ? Buffer.from(JSON.stringify({ at: last.finding.created_at, id: last.finding.id })).toString('base64url') : null, limit: d.limit };
  }
}
