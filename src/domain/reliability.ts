import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import * as t from '../db/schema.js';
import type { QueryDatabase } from '../db/client.js';
import { DomainError, schemas, type Actor } from './contracts.js';

/** Audit, outbox and recipients are inserted in the caller's business transaction. */
export async function publish(db: QueryDatabase, actor: Actor, action: string, aggregateId: string, data: Record<string, unknown>, clock: () => Date) {
  const id = randomUUID(), at = clock().toISOString();
  await db.insert(t.events).values({ id, repo: actor.repo, actor: actor.member, action, aggregate_id: aggregateId, data, created_at: at });
  if (action === 'claim.renewed' || action === 'runtime.heartbeat') return;
  const [project] = await db.select().from(t.projects).where(and(eq(t.projects.id, aggregateId), eq(t.projects.repo, actor.repo)));
  const [goal] = await db.select().from(t.goals).where(and(eq(t.goals.id, aggregateId), eq(t.goals.repo, actor.repo)));
  const [change] = await db.select().from(t.changes).where(and(eq(t.changes.id, aggregateId), eq(t.changes.repo, actor.repo)));
  const [milestone] = await db.select().from(t.milestones).where(and(eq(t.milestones.id, aggregateId), eq(t.milestones.repo, actor.repo)));
  const [runtime] = await db.select().from(t.runtimes).where(and(eq(t.runtimes.session_id, aggregateId), eq(t.runtimes.repo, actor.repo)));
  const impacted = await db.select({ project_id: t.goals.project_id }).from(t.decisionImpacts).innerJoin(t.changes, eq(t.changes.id, t.decisionImpacts.change_id)).innerJoin(t.goals, eq(t.goals.id, t.changes.goal_id)).where(and(eq(t.decisionImpacts.decision_id, aggregateId), eq(t.goals.repo, actor.repo)));
  const [changeGoal] = change ? await db.select().from(t.goals).where(eq(t.goals.id, change.goal_id)) : [];
  const projectId = project?.id ?? goal?.project_id ?? changeGoal?.project_id ?? milestone?.project_id ?? runtime?.project_id ?? impacted[0]?.project_id;
  if (!projectId) return;
  // No prompts, findings text, full before/after snapshots or credentials in notifications.
  const payload = { goal_id: goal?.id ?? change?.goal_id ?? null, change_id: change?.id ?? null, plan_state: goal?.plan_state ?? null, project_state: project?.state ?? null, status: change?.status ?? data.status ?? null };
  const version = project?.version ?? goal?.version ?? change?.version ?? milestone?.version ?? (typeof data.version === 'number' ? data.version : null);
  await db.insert(t.coordinationEvents).values({ id, repo: actor.repo, project_id: projectId, action, aggregate_id: aggregateId, entity_version: version, payload, created_at: at, priority: /goal.updated|project.updated/.test(action) ? 1 : 2 });
  let recipients = await db.select({ runtime: t.runtimes, member: t.sessions.member }).from(t.runtimes).innerJoin(t.sessions, eq(t.sessions.id, t.runtimes.session_id)).where(and(eq(t.runtimes.repo, actor.repo), eq(t.runtimes.project_id, projectId)));
  if (action === 'findings.published' && change) {
    const linked = await db.select({ goal_id: t.changes.goal_id }).from(t.dependencies).innerJoin(t.changes, eq(t.changes.id, t.dependencies.change_id)).where(eq(t.dependencies.depends_on_id, change.id));
    const goalIds = [...new Set([change.goal_id, ...linked.map(c => c.goal_id)])];
    const participants = await db.select({ session_id: t.changeSessions.session_id }).from(t.changeSessions).innerJoin(t.changes, eq(t.changes.id, t.changeSessions.change_id)).where(and(eq(t.changes.repo, actor.repo), inArray(t.changes.goal_id, goalIds)));
    recipients = recipients.filter(r => participants.some(p => p.session_id === r.runtime.session_id));
  }
  recipients = recipients.filter(r => r.member !== actor.member || action === 'goal.updated' || action === 'project.updated');
  if (recipients.length) await db.insert(t.deliveries).values(recipients.map(r => ({ id: randomUUID(), repo: actor.repo, event_id: id, session_id: r.runtime.session_id, created_at: at })));
}

export class Reliability {
  constructor(private db: QueryDatabase, private actor: Actor, private clock: () => Date) {}
  private time() { return this.clock().toISOString(); }
  private expiry() { return new Date(this.clock().getTime() + 120000).toISOString(); }
  async owned(sessionId: string) {
    const [session] = await this.db.select().from(t.sessions).where(and(eq(t.sessions.id, sessionId), eq(t.sessions.repo, this.actor.repo), eq(t.sessions.member, this.actor.member)));
    if (!session) throw new DomainError('SESSION_NOT_FOUND', 'Your session was not found', 404);
    const [runtime] = await this.db.select().from(t.runtimes).where(eq(t.runtimes.session_id, sessionId));
    return { session, runtime };
  }
  async guard(raw: unknown, allowStopped = false) {
    const d = raw as { session_id?: string; runtime_id?: string; runtime_epoch?: number; goal_id?: string; change_id?: string; project_id?: string };
    let runtime: typeof t.runtimes.$inferSelect | undefined;
    if (d.session_id) {
      [runtime] = await this.db.select().from(t.runtimes).where(and(eq(t.runtimes.session_id, d.session_id), eq(t.runtimes.repo, this.actor.repo)));
      if (runtime) await this.owned(d.session_id);
    }
    if (d.runtime_id && !runtime) [runtime] = await this.db.select().from(t.runtimes).innerJoin(t.sessions, eq(t.sessions.id, t.runtimes.session_id)).where(and(eq(t.runtimes.repo, this.actor.repo), eq(t.runtimes.instance_id, d.runtime_id), eq(t.sessions.member, this.actor.member))).then(rows => rows.map(r => r.session_runtimes));
    if (!runtime) {
      if (d.runtime_id || d.runtime_epoch) throw new DomainError('RUNTIME_STALE', 'Runtime instance was not found', 409);
      return;
    }
    if (runtime.instance_id !== d.runtime_id || runtime.epoch !== d.runtime_epoch) throw new DomainError('RUNTIME_STALE', 'Use the current runtime instance and epoch', 409);
    if ((!allowStopped && ['stopped','error','budget_exhausted'].includes(runtime.state)) || Date.parse(runtime.expires_at) <= this.clock().getTime()) throw new DomainError('RUNTIME_EXPIRED', 'Recover the runtime before continuing', 409);
    let projectId = d.project_id;
    let goalId = d.goal_id;
    if (d.change_id) { const [c] = await this.db.select().from(t.changes).where(and(eq(t.changes.id, d.change_id), eq(t.changes.repo, this.actor.repo))); goalId = c?.goal_id; }
    if (goalId) { const [g] = await this.db.select().from(t.goals).where(and(eq(t.goals.id, goalId), eq(t.goals.repo, this.actor.repo))); projectId = g?.project_id; }
    if (projectId && runtime.project_id !== projectId) throw new DomainError('RUNTIME_PROJECT_MISMATCH', 'Runtime is subscribed to another project', 403);
  }
  async manage(raw: unknown) {
    if (this.actor.role !== 'agent') throw new DomainError('FORBIDDEN', 'Only agents open execution sessions', 403);
    const d = schemas.preflight_manage_session.parse(raw);
    if (d.operation === 'open') {
      if (!d.project_id || !d.instance_id || d.session_id) throw new DomainError('VALIDATION_ERROR', 'Open requires project_id and instance_id without session_id');
      const [project] = await this.db.select().from(t.projects).where(and(eq(t.projects.repo, this.actor.repo), eq(t.projects.id, d.project_id)));
      if (!project || project.state !== 'active') throw new DomainError('PROJECT_NOT_FOUND', 'Active project not found', 404);
      const [session] = await this.db.insert(t.sessions).values({ id: randomUUID(), repo: this.actor.repo, member: this.actor.member, agent_type: d.agent_type, last_seen_at: this.time() }).returning();
      const [runtime] = await this.db.insert(t.runtimes).values({ session_id: session!.id, repo: this.actor.repo, project_id: project.id, instance_id: d.instance_id, epoch: 1, version: 1, state: 'waiting', heartbeat_at: this.time(), expires_at: this.expiry(), capabilities: d.capabilities ?? {} }).returning();
      await publish(this.db, this.actor, 'runtime.opened', session!.id, {}, this.clock);
      return { session, runtime, initial_snapshot_required: true };
    }
    if (!d.session_id) throw new DomainError('VALIDATION_ERROR', 'Operation requires session_id');
    const { session, runtime } = await this.owned(d.session_id);
    if (!runtime) throw new DomainError('RUNTIME_NOT_FOUND', 'Session is manually managed', 404);
    if (d.operation === 'recover') {
      if (!d.instance_id || d.expected_version !== runtime.version) throw new DomainError('STALE_VERSION', 'Recover requires a new instance and current version', 409);
      if (Date.parse(runtime.expires_at) > this.clock().getTime() && !['stopped','error','budget_exhausted'].includes(runtime.state)) throw new DomainError('RUNTIME_BUSY', 'Previous runtime still owns this session', 409);
      const [updated] = await this.db.update(t.runtimes).set({ instance_id: d.instance_id, epoch: runtime.epoch + 1, version: runtime.version + 1, state: 'waiting', heartbeat_at: this.time(), expires_at: this.expiry(), missing_notified: false, capabilities: d.capabilities ?? runtime.capabilities }).where(eq(t.runtimes.session_id, session.id)).returning();
      await publish(this.db, this.actor, 'runtime.recovered', session.id, { epoch: updated!.epoch }, this.clock);
      return { session, runtime: updated, initial_snapshot_required: true };
    }
    await this.guard(d, d.operation === 'close');
    if (d.operation === 'heartbeat' && d.state && !['waiting','running'].includes(d.state)) throw new DomainError('VALIDATION_ERROR', 'Terminal states require close so leases are released');
    const state = d.operation === 'close' ? d.state ?? 'stopped' : d.state ?? runtime.state;
    if (d.operation === 'close' && !['stopped','error','budget_exhausted'].includes(state)) throw new DomainError('VALIDATION_ERROR', 'Close requires a terminal runtime state');
    const [updated] = await this.db.update(t.runtimes).set({ state, version: runtime.version + 1, heartbeat_at: this.time(), expires_at: this.expiry(), missing_notified: false }).where(eq(t.runtimes.session_id, session.id)).returning();
    await this.db.update(t.sessions).set({ last_seen_at: this.time() }).where(eq(t.sessions.id, session.id));
    if (d.operation === 'close') {
      const leases = await this.db.select().from(t.claims).where(and(eq(t.claims.repo, this.actor.repo), eq(t.claims.session_id, session.id), isNull(t.claims.released_at)));
      for (const lease of leases) {
        await this.db.update(t.claims).set({ released_at: this.time(), release_reason: 'runtime_closed' }).where(eq(t.claims.id, lease.id));
        await this.db.update(t.changes).set({ version: sql`${t.changes.version}+1` }).where(eq(t.changes.id, lease.change_id));
        await publish(this.db, this.actor, 'claim.released', lease.change_id, { lease_id: lease.id, reason: 'runtime_closed' }, this.clock);
      }
      await publish(this.db, this.actor, 'runtime.closed', session.id, { state }, this.clock);
    }
    return { session, runtime: updated };
  }
  async updates(raw: unknown) {
    const d = schemas.preflight_get_updates.parse(raw); await this.guard(d);
    const { runtime } = await this.owned(d.session_id);
    if (!runtime) throw new DomainError('RUNTIME_NOT_FOUND', 'Updates require a subscribed session', 404);
    const rows = await this.db.select({ delivery: t.deliveries, event: t.coordinationEvents }).from(t.deliveries).innerJoin(t.coordinationEvents, eq(t.coordinationEvents.id, t.deliveries.event_id))
      .where(and(eq(t.deliveries.repo, this.actor.repo), eq(t.deliveries.session_id, d.session_id), isNull(t.deliveries.acked_at))).orderBy(t.coordinationEvents.priority, t.deliveries.created_at, t.deliveries.id).limit(d.limit + 1);
    return { updates: rows.slice(0, d.limit).map(r => ({ delivery_id: r.delivery.id, ...r.event })), has_more: rows.length > d.limit, semantics: 'at_least_once_until_ack' };
  }
  async ack(raw: unknown) {
    const d = schemas.preflight_ack_updates.parse(raw); await this.guard(d);
    const ids = d.updates.map(u => u.delivery_id);
    const owned = await this.db.select().from(t.deliveries).where(and(eq(t.deliveries.repo, this.actor.repo), eq(t.deliveries.session_id, d.session_id), inArray(t.deliveries.id, ids)));
    if (new Set(ids).size !== ids.length || owned.length !== ids.length) throw new DomainError('DELIVERY_NOT_FOUND', 'Every delivery must belong to this session', 404);
    const { runtime } = await this.owned(d.session_id);
    for (const u of d.updates) {
      if (u.outcome === 'stopped' && runtime?.state !== 'waiting') throw new DomainError('STOP_NOT_OBSERVED', 'Stop feedback requires an idle runtime after interruption', 409);
      if (u.outcome === 'stopped') {
        const row = owned.find(r => r.id === u.delivery_id)!;
        const [event] = await this.db.select().from(t.coordinationEvents).where(eq(t.coordinationEvents.id, row.event_id));
        if (!event || !['goal.updated','project.updated'].includes(event.action) || event.entity_version !== u.observed_version) throw new DomainError('STOP_VERSION_REQUIRED', 'Stop feedback must reference the observed plan version', 409);
      }

      await this.db.update(t.deliveries).set({ acked_at: this.time(), outcome: u.outcome, observed_version: u.observed_version }).where(and(eq(t.deliveries.id, u.delivery_id), isNull(t.deliveries.acked_at)));
    }
    return { acked: ids, source: 'adapter_report', execution_completed: false };
  }
  async maintain() {
    const expired = await this.db.select().from(t.claims).where(and(eq(t.claims.repo, this.actor.repo), isNull(t.claims.released_at), lte(t.claims.expires_at, this.time()))).orderBy(t.claims.expires_at, t.claims.id).limit(100);
    for (const lease of expired) {
      await this.db.update(t.claims).set({ released_at: this.time(), release_reason: 'expired' }).where(eq(t.claims.id, lease.id));
      await publish(this.db, this.actor, 'claim.expired', lease.change_id, { lease_id: lease.id, epoch: lease.epoch }, this.clock);
    }
    const missing = await this.db.select().from(t.runtimes).where(and(eq(t.runtimes.repo, this.actor.repo), eq(t.runtimes.missing_notified, false), inArray(t.runtimes.state, ['waiting','running']), lte(t.runtimes.expires_at, this.time()))).orderBy(t.runtimes.expires_at, t.runtimes.session_id).limit(100);
    for (const runtime of missing) {
      await this.db.update(t.runtimes).set({ missing_notified: true }).where(eq(t.runtimes.session_id, runtime.session_id));
      await publish(this.db, this.actor, 'runtime.unresponsive', runtime.session_id, { execution_stopped: 'unknown' }, this.clock);
    }
    const overdue = await this.db.select().from(t.decisions).where(and(eq(t.decisions.repo, this.actor.repo), eq(t.decisions.status, 'negotiating'), lte(t.decisions.round_deadline_at, this.time()))).orderBy(t.decisions.round_deadline_at, t.decisions.id).limit(100);
    for (const d of overdue) {
      await this.db.update(t.decisions).set({ status: 'deferred', deferred_reason: 'unanswered_timeout', round_deadline_at: null, version: d.version + 1 }).where(eq(t.decisions.id, d.id));
      await publish(this.db, this.actor, 'decision.deferred', d.id, { reason: 'unanswered_timeout', review_round: d.review_round, version: d.version + 1 }, this.clock);
    }
    return { expired_claims: expired.length, unresponsive_runtimes: missing.length, overdue_decisions: overdue.length };
  }
}
