import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import type { Database, QueryDatabase } from '../db/client.js';
import * as t from '../db/schema.js';
import { canonical, DomainError, redact, schemas, type Action, type Actor } from './contracts.js';
import { relatedWork } from './related.js';
const now = () => new Date().toISOString();

export class CollaborationService {
  constructor(public db: Database) {}
  private async change(db: QueryDatabase, actor: Actor, id: string) {
    const [change] = await db.select().from(t.changes).where(and(eq(t.changes.id, id), eq(t.changes.repo, actor.repo)));
    if (!change) throw new DomainError('CHANGE_NOT_FOUND', 'Change was not found', 404);
    return change;
  }
  private async participant(db: QueryDatabase, actor: Actor, changeId: string, sessionId: string) {
    const change = await this.change(db, actor, changeId);
    const [session] = await db.select().from(t.sessions).where(and(eq(t.sessions.id, sessionId), eq(t.sessions.repo, actor.repo), eq(t.sessions.member, actor.member)));
    const [link] = await db.select().from(t.changeSessions).where(and(eq(t.changeSessions.change_id, changeId), eq(t.changeSessions.session_id, sessionId)));
    if (!session || !link) throw new DomainError('FORBIDDEN', 'Session is not your participant in this change', 403);
    return change;
  }
  private async blocking(db: QueryDatabase, actor: Actor, changeId: string) {
    return db.select({ decision: t.decisions }).from(t.decisionImpacts).innerJoin(t.decisions, eq(t.decisionImpacts.decision_id, t.decisions.id))
      .where(and(eq(t.decisionImpacts.change_id, changeId), eq(t.decisions.repo, actor.repo), eq(t.decisions.status, 'pending'), eq(t.decisions.urgency, 'blocking')));
  }
  private async record(db: QueryDatabase, actor: Actor, action: string, aggregateId: string, data: Record<string, unknown>) {
    await db.insert(t.events).values({ id: randomUUID(), repo: actor.repo, actor: actor.member, action, aggregate_id: aggregateId, data });
  }
  async execute(actor: Actor, action: Action, raw: unknown): Promise<unknown> {
    const parsed = schemas[action].parse(raw);
    if (action === 'preflight_get_project') return this.project(actor);
    if (action === 'preflight_get_context') {
      const input = schemas.preflight_get_context.parse(parsed);
      return this.context(actor, input.change_id, input.session_id);
    }
    const requestId = (parsed as { request_id: string }).request_id;
    const hash = createHash('sha256').update(canonical(parsed)).digest('hex');
    const actorKey = `${actor.role}:${actor.member}`;
    return this.db.transaction(async db => {
      // One consistent repository lock keeps retries, decisions and completions atomic in this small MVP.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.repo}, 0))`);
      const [existing] = await db.select().from(t.mutations).where(and(eq(t.mutations.repo, actor.repo), eq(t.mutations.actor, actorKey), eq(t.mutations.action, action), eq(t.mutations.request_id, requestId)));
      if (existing) {
        if (existing.request_hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Request ID was already used with different input', 409);
        return existing.response;
      }
      const result = await this.perform(db, actor, action, redact(parsed));
      await db.insert(t.mutations).values({ id: randomUUID(), repo: actor.repo, actor: actorKey, action, request_id: requestId, request_hash: hash, response: result });
      return result;
    });
  }
  private async perform(db: QueryDatabase, actor: Actor, action: Action, input: unknown): Promise<Record<string, unknown>> {
    switch (action) {
      case 'preflight_register_goal': {
        const data = schemas.preflight_register_goal.parse(input);
        const [goal] = await db.insert(t.goals).values({ id: randomUUID(), repo: actor.repo, title: data.title,
          objective: data.objective, acceptance: data.acceptance, created_by: actor.member }).returning();
        if (!goal) throw new Error('Missing inserted goal');
        await this.record(db, actor, 'goal.created', goal.id, { title: goal.title });
        return { goal };
      }
      case 'preflight_start_work': {
        const data = schemas.preflight_start_work.parse(input);
        const [goal] = await db.select().from(t.goals).where(and(eq(t.goals.id, data.goal_id), eq(t.goals.repo, actor.repo)));
        if (!goal) throw new DomainError('GOAL_NOT_FOUND', 'Goal was not found', 404);
        let session;
        if (data.session_id) {
          [session] = await db.select().from(t.sessions).where(and(eq(t.sessions.id, data.session_id), eq(t.sessions.repo, actor.repo), eq(t.sessions.member, actor.member)));
          if (!session) throw new DomainError('SESSION_NOT_FOUND', 'Session was not found', 404);
        } else {
          [session] = await db.insert(t.sessions).values({ id: randomUUID(), repo: actor.repo, member: actor.member, agent_type: data.agent_type }).returning();
        }
        if (!session) throw new Error('Missing session');
        let change;
        if (data.existing_change_id) {
          change = await this.change(db, actor, data.existing_change_id);
          if (change.goal_id !== goal.id || ['completed', 'abandoned'].includes(change.status)) throw new DomainError('CONFLICT', 'Can only join active work under this goal', 409);
        } else {
          [change] = await db.insert(t.changes).values({ id: randomUUID(), repo: actor.repo, goal_id: goal.id,
            title: data.title, created_by: actor.member, status: 'probable', likely_scope: data.likely_scope,
            error_fingerprints: data.error_fingerprints, branch: data.branch, summary: data.title }).returning();
        }
        if (!change) throw new Error('Missing change');
        await db.insert(t.changeSessions).values({ change_id: change.id, session_id: session.id }).onConflictDoNothing();
        await db.update(t.sessions).set({ last_seen_at: now() }).where(eq(t.sessions.id, session.id));
        await this.record(db, actor, data.existing_change_id ? 'change.joined' : 'change.created', change.id, { goal_id: goal.id, session_id: session.id });
        const candidates = await db.select().from(t.changes).where(eq(t.changes.repo, actor.repo));
        return { session_id: session.id, change, related_work: relatedWork(change, candidates), blocking: (await this.blocking(db, actor, change.id)).length > 0 };
      }
      case 'preflight_report_progress': {
        const data = schemas.preflight_report_progress.parse(input);
        const change = await this.participant(db, actor, data.change_id, data.session_id);
        if (data.expected_version !== change.version) throw new DomainError('STALE_VERSION', `Refresh context; current version is ${change.version}`, 409);
        const transitions: Record<string, string[]> = {
          probable: ['probable', 'implementing', 'abandoned'],
          implementing: ['implementing', 'verifying', 'abandoned'],
          verifying: ['verifying', 'implementing', 'completed', 'abandoned'],
          completed: [], abandoned: [],
        };
        if (!transitions[change.status]?.includes(data.status)) throw new DomainError('INVALID_TRANSITION', `Cannot change ${change.status} to ${data.status}`, 409);
        if (data.status === 'completed') {
          if ((await this.blocking(db, actor, change.id)).length) throw new DomainError('DECISION_PENDING', 'Resolve the blocking decision before reporting completion', 409);
          const [goal] = await db.select().from(t.goals).where(eq(t.goals.id, change.goal_id));
          const v = data.verification;
          if (!goal || !v || v.result !== 'passed' || v.criteria.length !== goal.acceptance.length ||
            new Set(v.criteria.map(c => c.index)).size !== goal.acceptance.length ||
            v.criteria.some(c => !c.passed || c.index >= goal.acceptance.length)) {
            throw new DomainError('VERIFICATION_REQUIRED', 'Completion requires a passing SHA-specific verification for every acceptance criterion');
          }
        }
        if (data.feedback) {
          if (data.feedback.change_id === change.id) throw new DomainError('VALIDATION_ERROR', 'Cannot relate work to itself');
          await this.change(db, actor, data.feedback.change_id);
          await db.insert(t.feedback).values({ id: randomUUID(), repo: actor.repo, from_change_id: change.id, to_change_id: data.feedback.change_id, member: actor.member, relation: data.feedback.relation });
        }
        const [updated] = await db.update(t.changes).set({ status: data.status, summary: data.summary,
          likely_scope: data.likely_scope ?? change.likely_scope,
          verification: data.verification ? { ...data.verification, source: 'agent_report' as const } : null,
          pr_url: data.pr_url ?? change.pr_url, version: change.version + 1, updated_at: now(),
        }).where(eq(t.changes.id, change.id)).returning();
        await db.update(t.sessions).set({ last_seen_at: now() }).where(eq(t.sessions.id, data.session_id));
        await this.record(db, actor, 'change.updated', change.id, { status: data.status, source: 'agent_report', version: change.version + 1 });
        return { change: updated, status_source: 'agent_report' };
      }
      case 'preflight_publish_findings': {
        const data = schemas.preflight_publish_findings.parse(input);
        await this.participant(db, actor, data.change_id, data.session_id);
        const findings = await db.insert(t.findings).values(data.findings.map(f => ({ ...f, id: randomUUID(), repo: actor.repo, change_id: data.change_id, session_id: data.session_id }))).returning();
        await db.update(t.sessions).set({ last_seen_at: now() }).where(eq(t.sessions.id, data.session_id));
        await this.record(db, actor, 'findings.published', data.change_id, { count: findings.length });
        return { findings };
      }
      case 'preflight_propose_decision': {
        const data = schemas.preflight_propose_decision.parse(input);
        await this.participant(db, actor, data.change_id, data.session_id);
        const affected = [...new Set([data.change_id, ...data.affected_change_ids])];
        for (const id of affected) await this.change(db, actor, id);
        if (data.recommendation && !data.options.some(o => o.label === data.recommendation)) throw new DomainError('VALIDATION_ERROR', 'Recommendation must be one of the option labels');
        // Only exactly matching proposals are grouped; never semantic auto-rewriting of decisions.
        const candidates = await db.select({ decision: t.decisions }).from(t.decisions).innerJoin(t.decisionImpacts, eq(t.decisionImpacts.decision_id, t.decisions.id)).where(and(eq(t.decisions.repo, actor.repo), eq(t.decisions.status, 'pending'), eq(t.decisions.question, data.question), eq(t.decisions.context, data.context), eq(t.decisions.category, data.category), inArray(t.decisionImpacts.change_id, affected)));
        const existing = candidates.map(c => c.decision).find(d =>
          canonical(d.options.map(({ id: _id, ...o }) => o)) === canonical(data.options) &&
          (d.recommendation ?? undefined) === data.recommendation);
        const identicalOptions = Boolean(existing);
        let decision = identicalOptions ? existing : undefined;
        if (!decision) {
          [decision] = await db.insert(t.decisions).values({ id: randomUUID(), repo: actor.repo,
            question: data.question, context: data.context, category: data.category, urgency: data.urgency,
            options: data.options.map(o => ({ id: randomUUID(), ...o })), recommendation: data.recommendation, raised_by: actor.member }).returning();
        } else {
          const impacts = await db.select().from(t.decisionImpacts).where(eq(t.decisionImpacts.decision_id, decision.id));
          const newImpact = affected.some(id => !impacts.some(i => i.change_id === id));
          const escalating = data.urgency === 'blocking' && decision.urgency !== 'blocking';
          if (newImpact || escalating) [decision] = await db.update(t.decisions).set({
            urgency: escalating ? 'blocking' : decision.urgency, version: decision.version + 1,
          }).where(eq(t.decisions.id, decision.id)).returning();
        }
        if (!decision) throw new Error('Missing decision');
        await db.insert(t.decisionImpacts).values(affected.map(change_id => ({ decision_id: decision.id, change_id }))).onConflictDoNothing();
        await this.record(db, actor, identicalOptions ? 'decision.attached' : 'decision.created', decision.id, { affected_change_ids: affected, context: data.context });
        return { decision, attached: Boolean(identicalOptions), affected_change_ids: affected };
      }
      case 'resolve_decision': {
        if (actor.role !== 'human') throw new DomainError('FORBIDDEN', 'Only a human credential may resolve decisions', 403);
        const data = schemas.resolve_decision.parse(input);
        const [decision] = await db.select().from(t.decisions).where(and(eq(t.decisions.id, data.decision_id), eq(t.decisions.repo, actor.repo)));
        if (!decision) throw new DomainError('DECISION_NOT_FOUND', 'Decision was not found', 404);
        if (decision.status !== 'pending') {
          if (decision.option_id === data.option_id) return { decision, already_resolved: true };
          throw new DomainError('DECISION_ALREADY_RESOLVED', 'Another choice already resolved this decision', 409);
        }
        if (decision.version !== data.expected_version) throw new DomainError('STALE_VERSION', 'Decision changed; refresh before resolving', 409);
        if (!decision.options.some(o => o.id === data.option_id)) throw new DomainError('VALIDATION_ERROR', 'Option does not belong to this decision');
        const [resolved] = await db.update(t.decisions).set({ status: 'human_resolved', option_id: data.option_id,
          resolution: data.resolution, resolved_by: actor.member, resolved_at: now(), version: decision.version + 1 }).where(eq(t.decisions.id, decision.id)).returning();
        await this.record(db, actor, 'decision.resolved', decision.id, { option_id: data.option_id, resolution: data.resolution });
        return { decision: resolved };
      }
      default: throw new DomainError('VALIDATION_ERROR', 'Unsupported mutation');
    }
  }
  async context(actor: Actor, changeId: string, sessionId: string) {
    return this.db.transaction(async db => {
      const change = await this.participant(db, actor, changeId, sessionId);
      const candidates = await db.select().from(t.changes).where(eq(t.changes.repo, actor.repo));
      const feedback = await db.select().from(t.feedback).where(and(eq(t.feedback.repo, actor.repo), eq(t.feedback.from_change_id, change.id))).orderBy(desc(t.feedback.created_at));
      const latestFeedback = new Map<string, string>();
      for (const f of feedback) if (!latestFeedback.has(f.to_change_id)) latestFeedback.set(f.to_change_id, f.relation);
      const related = relatedWork(change, candidates).filter(r => latestFeedback.get(r.change_id) !== 'not_related').map(r => ({ ...r, feedback: latestFeedback.get(r.change_id) ?? null }));
      const relevantIds = [change.id, ...related.map(r => r.change_id)];
      const findings = await db.select().from(t.findings).where(and(eq(t.findings.repo, actor.repo), inArray(t.findings.change_id, relevantIds))).orderBy(desc(t.findings.created_at)).limit(30);
      const impacted = await db.select({ decision: t.decisions }).from(t.decisionImpacts).innerJoin(t.decisions, eq(t.decisionImpacts.decision_id, t.decisions.id)).where(and(eq(t.decisionImpacts.change_id, change.id), eq(t.decisions.repo, actor.repo))).orderBy(desc(t.decisions.created_at));
      const pending = impacted.map(r => r.decision).filter(d => d.status === 'pending');
      const blocking = pending.filter(d => d.urgency === 'blocking');
      const [goal] = await db.select().from(t.goals).where(eq(t.goals.id, change.goal_id));
      return { version: '1', generated_at: now(), repo: actor.repo, goal, current_change: change,
        related_work: related, findings, pending_decisions: pending,
        resolved_decisions: impacted.map(r => r.decision).filter(d => d.status === 'human_resolved').slice(0, 20),
        blocking: blocking.length > 0, recommended_action: blocking.length ? 'wait_for_decision' : related.length ? 'inspect_related_work' : 'continue',
        policies: [], capabilities: { git_observer: false, semantic_matching: false, policy_reuse: false },
        warnings: ['Scope, progress and verification are agent reports; no Git facts have been verified.'],
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async project(actor: Actor) {
    return this.db.transaction(async db => {
      const [goals, changes, sessions, decisions, impacts, events] = await Promise.all([
        db.select().from(t.goals).where(eq(t.goals.repo, actor.repo)).orderBy(desc(t.goals.created_at)).limit(200),
        db.select().from(t.changes).where(eq(t.changes.repo, actor.repo)).orderBy(desc(t.changes.updated_at)).limit(500),
        db.select().from(t.sessions).where(eq(t.sessions.repo, actor.repo)).limit(500),
        db.select().from(t.decisions).where(eq(t.decisions.repo, actor.repo)).orderBy(desc(t.decisions.created_at)).limit(200),
        db.select({ decision_id: t.decisionImpacts.decision_id, change_id: t.decisionImpacts.change_id }).from(t.decisionImpacts).innerJoin(t.decisions, eq(t.decisionImpacts.decision_id, t.decisions.id)).where(eq(t.decisions.repo, actor.repo)),
        db.select().from(t.events).where(eq(t.events.repo, actor.repo)).orderBy(desc(t.events.created_at)).limit(30),
      ]);
      const blockers = new Set(impacts.filter(i => decisions.some(d => d.id === i.decision_id && d.status === 'pending' && d.urgency === 'blocking')).map(i => i.change_id));
      const work = changes.map(c => ({ ...c, waiting_for_decision: blockers.has(c.id), status_source: 'agent_report' }));
      return { repo: actor.repo, actor: { member: actor.member, role: actor.role },
        goals: goals.map(g => {
          const children = work.filter(c => c.goal_id === g.id);
          return { ...g, progress: !children.length ? 'planned' : children.every(c => c.status === 'completed') ? 'reported_completed' : children.some(c => c.waiting_for_decision) ? 'waiting_for_decision' : 'active' };
        }), changes: work, sessions, decisions: decisions.map(d => ({ ...d, affected_change_ids: impacts.filter(i => i.decision_id === d.id).map(i => i.change_id) })), events,
        summary: { goals: goals.length, active_changes: changes.filter(c => !['completed', 'abandoned'].includes(c.status)).length,
          pending_decisions: decisions.filter(d => d.status === 'pending').length, completed_changes: changes.filter(c => c.status === 'completed').length },
        limits: { goals: 200, changes: 500, decisions: 200, events: 30 },
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
