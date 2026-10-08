import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, desc, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, QueryDatabase } from '../db/client.js';
import * as t from '../db/schema.js';
import { canonical, DomainError, redact, schemas, type Action, type Actor } from './contracts.js';
import { relatedWork } from './related.js';
import { Reliability, publish } from './reliability.js';
import { Management } from './management.js';
const now = () => new Date().toISOString();
const openDecisionStatuses = ['negotiating', 'deferred', 'needs_input'];

export class CollaborationService {
  constructor(public db: Database, private clock: () => Date = () => new Date()) {}
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
      .where(and(eq(t.decisionImpacts.change_id, changeId), eq(t.decisions.repo, actor.repo), inArray(t.decisions.status, openDecisionStatuses), eq(t.decisions.urgency, 'blocking')));
  }
  private async decisionViews(db: QueryDatabase, actor: Actor, decisions: (typeof t.decisions.$inferSelect)[]) {
    if (!decisions.length) return [];
    const ids = decisions.map(d => d.id);
    const [impacts, reviews] = await Promise.all([
      db.select({ decision_id: t.decisionImpacts.decision_id, change_id: t.decisionImpacts.change_id }).from(t.decisionImpacts)
        .innerJoin(t.changes, and(eq(t.changes.id, t.decisionImpacts.change_id), eq(t.changes.repo, actor.repo))).where(inArray(t.decisionImpacts.decision_id, ids)),
      db.select().from(t.decisionReviews).where(and(eq(t.decisionReviews.repo, actor.repo), inArray(t.decisionReviews.decision_id, ids))).orderBy(t.decisionReviews.created_at, t.decisionReviews.id),
    ]);
    return decisions.map(decision => {
      const required = impacts.filter(i => i.decision_id === decision.id).map(i => i.change_id).sort();
      const history = reviews.filter(r => r.decision_id === decision.id);
      const current = history.filter(r => r.review_epoch === decision.review_epoch && r.review_round === decision.review_round);
      return { ...decision, affected_change_ids: required, required_change_ids: required,
        current_reviews: current, review_history: history,
        missing_change_ids: required.filter(id => !current.some(r => r.change_id === id)), round_limit: 3 };
    });
  }
  private async record(db: QueryDatabase, actor: Actor, action: string, aggregateId: string, data: Record<string, unknown>) {
    await publish(db, actor, action, aggregateId, data, this.clock);
  }
  async execute(actor: Actor, action: Action, raw: unknown): Promise<unknown> {
    const parsed = schemas[action].parse(raw);
    if (action === 'preflight_get_project') return this.project(actor, schemas.preflight_get_project.parse(parsed).project_id);
    if (action === 'preflight_get_updates') return this.db.transaction(db => new Reliability(db, actor, this.clock).updates(parsed), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (action === 'preflight_search_findings') return this.db.transaction(db => new Management(db, actor, this.clock).search(parsed), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (action === 'preflight_get_context') {
      const input = schemas.preflight_get_context.parse(parsed);
      if (input.goal_id) {
        return this.db.transaction(async db => {
          const management = new Management(db, actor, this.clock), goal = await management.goal(input.goal_id!);
          const candidates = await db.select().from(t.changes).where(and(eq(t.changes.repo, actor.repo), eq(t.changes.goal_id, goal.id)));
          return { goal, project: await management.project(goal.project_id), current_change: null, tasks: await management.workViews(candidates), knowledge: await management.search({ goal_id: goal.id, limit: 20 }), warnings: ['Progress and evidence are agent reports.'] };
        }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
      }
      return this.context(actor, input.change_id!, input.session_id!);
    }
    const requestId = (parsed as { request_id: string }).request_id;
    const businessInput = Object.fromEntries(Object.entries(parsed).filter(([key]) => !['runtime_id','runtime_epoch'].includes(key)));
    const hash = createHash('sha256').update(canonical(businessInput)).digest('hex');
    const actorKey = `${actor.role}:${actor.member}`;
    return this.db.transaction(async db => {
      // One consistent repository lock keeps retries, decisions and completions atomic in this small MVP.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.repo}, 0))`);
      const reliability = new Reliability(db, actor, this.clock);
      if (action !== 'preflight_manage_session' || !['open','recover'].includes((parsed as { operation: string }).operation)) await reliability.guard(parsed, action === 'preflight_manage_session' && (parsed as { operation: string }).operation === 'close');
      await reliability.maintain();
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
    const management = new Management(db, actor, this.clock);
    if (action === 'preflight_manage_session') return new Reliability(db, actor, this.clock).manage(input);
    if (action === 'preflight_ack_updates') return new Reliability(db, actor, this.clock).ack(input);
    if (['preflight_manage_project', 'preflight_manage_milestone', 'preflight_manage_goal', 'preflight_manage_work', 'preflight_manage_claim'].includes(action)) return management.execute(action, input);
    switch (action) {
      case 'preflight_register_goal': {
        const data = schemas.preflight_register_goal.parse(input);
        const project = data.project_id ? await management.project(data.project_id) : await management.defaultProject();
        if (project.state !== 'active') throw new DomainError('PROJECT_ARCHIVED', 'Cannot add goals to an archived project', 409);
        if (actor.role === 'agent' && (data.plan_state || data.priority || data.milestone_id || data.owner || data.due_date)) management.planning(project);
        if (data.milestone_id) await management.milestone(data.milestone_id, project.id);
        const [goal] = await db.insert(t.goals).values({ id: randomUUID(), repo: actor.repo, project_id: project.id, milestone_id: data.milestone_id,
          plan_state: data.plan_state ?? (data.project_id ? 'backlog' : 'ready'), priority: data.priority, owner: data.owner, due_date: data.due_date, kind: data.kind, title: data.title,
          objective: data.objective, acceptance: data.acceptance, created_by: actor.member }).returning();
        if (!goal) throw new Error('Missing inserted goal');
        await this.record(db, actor, 'goal.created', goal.id, { title: goal.title });
        return { goal };
      }
      case 'preflight_start_work': {
        const data = schemas.preflight_start_work.parse(input);
        const [goal] = await db.select().from(t.goals).where(and(eq(t.goals.id, data.goal_id), eq(t.goals.repo, actor.repo)));
        if (!goal) throw new DomainError('GOAL_NOT_FOUND', 'Goal was not found', 404);
        const project = await management.project(goal.project_id);
        if (project.state !== 'active' || ['paused', 'cancelled', 'archived'].includes(goal.plan_state)) throw new DomainError('GOAL_NOT_READY', 'Goal is not available for new work', 409);
        if (data.mode && !data.existing_change_id && (!data.task_acceptance || !data.goal_criteria_indices)) throw new DomainError('VALIDATION_ERROR', 'Managed tasks require task acceptance and goal criteria mapping');
        if (!data.mode && !data.existing_change_id && !project.is_default) throw new DomainError('VALIDATION_ERROR', 'Use managed task mode');
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
          if (data.mode === 'propose') throw new DomainError('VALIDATION_ERROR', 'Propose creates a new task');
          change = await this.change(db, actor, data.existing_change_id);
          if (change.goal_id !== goal.id || ['completed', 'abandoned'].includes(change.status)) throw new DomainError('CONFLICT', 'Can only join active work under this goal', 409);
        } else {
          [change] = await db.insert(t.changes).values({ id: randomUUID(), repo: actor.repo, goal_id: goal.id,
            title: data.title, created_by: actor.member, status: 'probable', likely_scope: data.likely_scope,
            error_fingerprints: data.error_fingerprints, branch: data.branch, summary: data.title,
            lifecycle: data.mode ? 'managed' : 'legacy', task_acceptance: data.task_acceptance ?? [], goal_criteria_indices: data.goal_criteria_indices ?? [], goal_definition_version: goal.definition_version }).returning();
        }
        if (!change) throw new Error('Missing change');
        if (change.lifecycle === 'managed') {
          management.criteria(change.goal_criteria_indices, goal);
          if (!data.existing_change_id) await management.setDependencies(change, data.depends_on_change_ids);
        }
        await db.insert(t.changeSessions).values({ change_id: change.id, session_id: session.id }).onConflictDoNothing();
        await db.update(t.sessions).set({ last_seen_at: now() }).where(eq(t.sessions.id, session.id));
        await this.record(db, actor, data.existing_change_id ? 'change.joined' : 'change.created', change.id, { goal_id: goal.id, session_id: session.id });
        const claimed = data.mode === 'claim' ? await management.claim(change, session.id) : null;
        if (claimed) change = claimed.change;
        const candidates = await db.select().from(t.changes).where(eq(t.changes.repo, actor.repo));
        return { ...(claimed ? { claim: claimed.claim } : {}), session_id: session.id, change, related_work: relatedWork(change, candidates), blocking: (await this.blocking(db, actor, change.id)).length > 0 };
      }
      case 'preflight_report_progress': {
        const data = schemas.preflight_report_progress.parse(input);
        const change = await this.participant(db, actor, data.change_id, data.session_id);
        if (data.status !== 'abandoned') await management.ready(await management.goal(change.goal_id));
        if (change.lifecycle === 'managed') {
          const goal = await management.goal(change.goal_id);
          await management.requireLease(change, data.session_id, data.lease_id, data.lease_epoch);
          if (data.status !== 'abandoned') {
            await management.ready(goal);
            const [view] = await management.workViews([change]);
            if (view!.blocked_reasons.length) throw new DomainError('WORK_BLOCKED', view!.blocked_reasons.join(', '), 409);
          }
        }
        if (data.expected_version !== change.version) throw new DomainError('STALE_VERSION', `Refresh context; current version is ${change.version}`, 409);
        const transitions: Record<string, string[]> = {
          probable: ['probable', 'implementing', 'abandoned'],
          implementing: ['implementing', 'verifying', 'abandoned'],
          verifying: ['verifying', 'implementing', 'completed', 'abandoned'],
          completed: [], abandoned: [],
        };
        if (!transitions[change.status]?.includes(data.status)) throw new DomainError('INVALID_TRANSITION', `Cannot change ${change.status} to ${data.status}`, 409);
        if (data.status === 'completed') {
          const blockers = (await this.blocking(db, actor, change.id)).map(row => row.decision);
          if (blockers.some(d => d.status === 'needs_input')) throw new DomainError('GOAL_INPUT_REQUIRED', 'Goal boundary or missing information needs input', 409);
          if (blockers.some(d => d.status === 'negotiating')) throw new DomainError('COORDINATION_PENDING', 'Affected changes must review the blocking decision', 409);
          const deferredIds = blockers.filter(d => d.status === 'deferred').map(d => d.id);
          const isolation = data.verification?.isolated_decisions ?? [];
          if (isolation.some(i => !deferredIds.includes(i.decision_id)) || new Set(isolation.map(i => i.decision_id)).size !== isolation.length) {
            throw new DomainError('INVALID_ISOLATION', 'Isolation evidence must uniquely reference corresponding deferred blockers');
          }
          if (deferredIds.some(id => !isolation.some(i => i.decision_id === id))) throw new DomainError('ISOLATION_REQUIRED', 'Provide isolation or degradation evidence for every deferred blocker', 409);
          const [goal] = await db.select().from(t.goals).where(eq(t.goals.id, change.goal_id));
          const v = data.verification;
          const acceptance = change.lifecycle === 'managed' ? change.task_acceptance : goal?.acceptance ?? [];
          if (change.lifecycle === 'managed' && (v?.definition_version !== change.definition_version || v?.goal_definition_version !== goal?.definition_version)) throw new DomainError('VERIFICATION_REQUIRED', 'Verification must match current task and goal definitions');
          if (!goal || !v || v.result !== 'passed' || v.criteria.length !== acceptance.length ||
            new Set(v.criteria.map(c => c.index)).size !== acceptance.length ||
            v.criteria.some(c => !c.passed || c.index >= acceptance.length)) {
            throw new DomainError('VERIFICATION_REQUIRED', 'Completion requires a passing SHA-specific verification for every acceptance criterion');
          }
          for (const isolated of isolation) await this.record(db, actor, 'decision.scope_isolated', isolated.decision_id,
            { change_id: change.id, ...isolated, source: 'agent_report', head_sha: v.head_sha });
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
        if (change.lifecycle === 'managed' && ['completed', 'abandoned'].includes(data.status)) await db.update(t.claims).set({ released_at: this.clock().toISOString(), release_reason: data.status }).where(and(eq(t.claims.change_id, change.id), isNull(t.claims.released_at)));
        await db.update(t.sessions).set({ last_seen_at: now() }).where(eq(t.sessions.id, data.session_id));
        await this.record(db, actor, 'change.updated', change.id, { status: data.status, source: 'agent_report', version: change.version + 1 });
        return { change: updated, status_source: 'agent_report' };
      }
      case 'preflight_publish_findings': {
        const data = schemas.preflight_publish_findings.parse(input);
        await this.participant(db, actor, data.change_id, data.session_id);
        for (const f of data.findings) {
          if (f.kind === 'failed_attempt' && (!f.conditions || !f.evidence.length)) throw new DomainError('VALIDATION_ERROR', 'Failed attempts require conditions and evidence');
          for (const id of [f.refutes_id, f.supersedes_id].filter(Boolean)) {
            const [referenced] = await db.select().from(t.findings).where(and(eq(t.findings.id, id!), eq(t.findings.repo, actor.repo)));
            if (!referenced) throw new DomainError('FINDING_NOT_FOUND', 'Referenced finding not found', 404);
          }
        }
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
        const candidates = await db.select({ decision: t.decisions }).from(t.decisions).innerJoin(t.decisionImpacts, eq(t.decisionImpacts.decision_id, t.decisions.id)).where(and(eq(t.decisions.repo, actor.repo), inArray(t.decisions.status, openDecisionStatuses), eq(t.decisions.authority, data.authority), eq(t.decisions.question, data.question), eq(t.decisions.context, data.context), eq(t.decisions.category, data.category), inArray(t.decisionImpacts.change_id, affected)));
        const existing = candidates.map(c => c.decision).find(d =>
          canonical(d.options.map(({ id: _id, ...o }) => o)) === canonical(data.options) &&
          (d.recommendation ?? undefined) === data.recommendation);
        const identicalOptions = Boolean(existing);
        let decision = identicalOptions ? existing : undefined;
        if (!decision) {
          [decision] = await db.insert(t.decisions).values({ id: randomUUID(), repo: actor.repo,
            question: data.question, context: data.context, category: data.category, urgency: data.urgency,
            authority: data.authority, status: data.authority === 'within_goal' ? 'negotiating' : 'needs_input',
            round_deadline_at: data.authority === 'within_goal' ? new Date(this.clock().getTime()+600000).toISOString() : null,
            options: data.options.map(o => ({ id: randomUUID(), ...o })), recommendation: data.recommendation, raised_by: actor.member }).returning();
        } else {
          const impacts = await db.select().from(t.decisionImpacts).where(eq(t.decisionImpacts.decision_id, decision.id));
          const newImpact = affected.some(id => !impacts.some(i => i.change_id === id));
          const escalating = data.urgency === 'blocking' && decision.urgency !== 'blocking';
          if (newImpact || escalating) [decision] = await db.update(t.decisions).set({
            urgency: escalating ? 'blocking' : decision.urgency, version: decision.version + 1,
            ...(newImpact ? { review_epoch: decision.review_epoch + 1, review_round: 1,
              status: decision.authority === 'within_goal' ? 'negotiating' : 'needs_input', deferred_reason: null, round_deadline_at: decision.authority === 'within_goal' ? decision.round_deadline_at ?? new Date(this.clock().getTime()+600000).toISOString() : null } : {}),
          }).where(eq(t.decisions.id, decision.id)).returning();
          if (newImpact && decision) await this.record(db, actor, 'decision.review_scope_changed', decision.id,
            { affected_change_ids: affected, review_epoch: decision.review_epoch, review_round: decision.review_round, version: decision.version });
        }
        if (!decision) throw new Error('Missing decision');
        await db.insert(t.decisionImpacts).values(affected.map(change_id => ({ decision_id: decision.id, change_id }))).onConflictDoNothing();
        await this.record(db, actor, identicalOptions ? 'decision.attached' : 'decision.created', decision.id,
          { affected_change_ids: affected, context: data.context, authority: decision.authority, status: decision.status, urgency: decision.urgency, version: decision.version });
        return { decision: (await this.decisionViews(db, actor, [decision]))[0], attached: Boolean(identicalOptions), affected_change_ids: affected };
      }
      case 'preflight_review_decision': {
        if (actor.role !== 'agent') throw new DomainError('FORBIDDEN', 'Only agents may review coordination decisions', 403);
        const data = schemas.preflight_review_decision.parse(input);
        const reviewing = await this.participant(db, actor, data.change_id, data.session_id);
        if (reviewing.lifecycle === 'managed') await management.requireLease(reviewing, data.session_id, data.lease_id, data.lease_epoch);
        const [decision] = await db.select().from(t.decisions).where(and(eq(t.decisions.id, data.decision_id), eq(t.decisions.repo, actor.repo)));
        if (!decision) throw new DomainError('DECISION_NOT_FOUND', 'Decision was not found', 404);
        const impacts = await db.select({ change_id: t.decisionImpacts.change_id }).from(t.decisionImpacts)
          .innerJoin(t.changes, and(eq(t.changes.id, t.decisionImpacts.change_id), eq(t.changes.repo, actor.repo))).where(eq(t.decisionImpacts.decision_id, decision.id));
        const required = impacts.map(i => i.change_id);
        if (!required.includes(data.change_id)) throw new DomainError('FORBIDDEN', 'Only an affected change may review', 403);
        if (decision.version !== data.expected_version) throw new DomainError('STALE_VERSION', 'Decision changed; refresh context before reviewing', 409);
        if (decision.status !== 'negotiating' || decision.authority !== 'within_goal') throw new DomainError('REVIEW_NOT_ALLOWED', 'Only within-goal negotiating decisions accept reviews', 409);
        if (data.option_id && !decision.options.some(o => o.id === data.option_id)) throw new DomainError('VALIDATION_ERROR', 'Option does not belong to this decision');
        const reviews = await db.select().from(t.decisionReviews).where(and(eq(t.decisionReviews.repo, actor.repo), eq(t.decisionReviews.decision_id, decision.id), eq(t.decisionReviews.review_epoch, decision.review_epoch), eq(t.decisionReviews.review_round, decision.review_round)));
        if (reviews.some(r => r.change_id === data.change_id)) throw new DomainError('REVIEW_ALREADY_RECORDED', 'This change already reviewed the current round', 409);
        const [review] = await db.insert(t.decisionReviews).values({ id: randomUUID(), repo: actor.repo, decision_id: decision.id,
          review_epoch: decision.review_epoch, review_round: decision.review_round, change_id: data.change_id, session_id: data.session_id,
          member: actor.member, stance: data.stance, option_id: data.option_id, rationale: data.rationale, evidence: data.evidence }).returning();
        if (!review) throw new Error('Missing review');
        const all = [...reviews, review];
        const allAnswered = required.every(id => all.some(r => r.change_id === id));
        const agreed = allAnswered && all.every(r => r.stance === 'accept' && r.option_id === all[0]!.option_id);
        const nextRound = allAnswered && !agreed && decision.review_round < 3;
        const [updated] = await db.update(t.decisions).set({ version: decision.version + 1,
          ...(agreed ? { status: 'agent_resolved', option_id: all[0]!.option_id, resolution: 'All affected changes accepted the same option with evidence', resolved_by: 'agent_consensus', resolved_at: now(), round_deadline_at: null, deferred_reason: null }
            : nextRound ? { review_round: decision.review_round + 1, round_deadline_at: new Date(this.clock().getTime()+600000).toISOString() } : allAnswered ? { status: 'deferred', deferred_reason: 'disagreement_limit', round_deadline_at: null } : {}),
        }).where(eq(t.decisions.id, decision.id)).returning();
        if (!updated) throw new Error('Missing updated decision');
        await this.record(db, actor, 'decision.reviewed', decision.id, { change_id: data.change_id, session_id: data.session_id,
          review_epoch: decision.review_epoch, review_round: decision.review_round, stance: data.stance, option_id: data.option_id, rationale: data.rationale, evidence: data.evidence });
        if (allAnswered) await this.record(db, actor, agreed ? 'decision.agent_resolved' : nextRound ? 'decision.round_advanced' : 'decision.deferred', decision.id,
          { review_epoch: updated.review_epoch, review_round: updated.review_round, option_id: updated.option_id, review_ids: all.map(r => r.id) });
        return { decision: (await this.decisionViews(db, actor, [updated]))[0], review };
      }
      case 'resolve_decision': {
        if (actor.role !== 'human') throw new DomainError('FORBIDDEN', 'Only a human credential may resolve decisions', 403);
        const data = schemas.resolve_decision.parse(input);
        const [decision] = await db.select().from(t.decisions).where(and(eq(t.decisions.id, data.decision_id), eq(t.decisions.repo, actor.repo)));
        if (!decision) throw new DomainError('DECISION_NOT_FOUND', 'Decision was not found', 404);
        if (decision.status === 'human_resolved') {
          if (decision.option_id === data.option_id) return { decision: (await this.decisionViews(db, actor, [decision]))[0], already_resolved: true };
          throw new DomainError('DECISION_ALREADY_RESOLVED', 'Another choice already resolved this decision', 409);
        }
        if (decision.status !== 'needs_input') throw new DomainError('HUMAN_RESOLUTION_NOT_ALLOWED', 'Human input is limited to goal boundaries or missing information', 409);
        if (decision.version !== data.expected_version) throw new DomainError('STALE_VERSION', 'Decision changed; refresh before resolving', 409);
        if (!decision.options.some(o => o.id === data.option_id)) throw new DomainError('VALIDATION_ERROR', 'Option does not belong to this decision');
        const [resolved] = await db.update(t.decisions).set({ status: 'human_resolved', option_id: data.option_id,
          resolution: data.resolution, resolved_by: actor.member, resolved_at: now(), version: decision.version + 1 }).where(eq(t.decisions.id, decision.id)).returning();
        await this.record(db, actor, 'decision.resolved', decision.id, { option_id: data.option_id, resolution: data.resolution });
        if (!resolved) throw new Error('Missing resolved decision');
        return { decision: (await this.decisionViews(db, actor, [resolved]))[0] };
      }
      default: throw new DomainError('VALIDATION_ERROR', 'Unsupported mutation');
    }
  }
  async maintain() {
    const repos = await this.db.selectDistinct({ repo: t.projects.repo }).from(t.projects);
    for (const { repo } of repos) await this.db.transaction(async db => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${repo}, 0))`);
      await new Reliability(db, { repo, member: 'preflight-worker', role: 'agent' }, this.clock).maintain();
    });
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
      const views = await this.decisionViews(db, actor, impacted.map(r => r.decision));
      const pending = views.filter(d => openDecisionStatuses.includes(d.status));
      const blocking = pending.filter(d => d.urgency === 'blocking');
      const terminal = ['completed', 'abandoned'].includes(change.status);
      const [goal] = await db.select().from(t.goals).where(eq(t.goals.id, change.goal_id));
      const management = new Management(db, actor, this.clock);
      const [work] = await management.workViews([change]);
      return { task: work, knowledge: await management.search({ goal_id: change.goal_id, limit: 20 }), version: '1', generated_at: now(), repo: actor.repo, goal, current_change: change,
        related_work: related, findings, pending_decisions: pending,
        resolved_decisions: views.filter(d => ['agent_resolved', 'human_resolved'].includes(d.status)).slice(0, 20),
        blocking: !terminal && blocking.length > 0, recommended_action: terminal ? 'continue' : pending.some(d => d.status === 'needs_input') ? 'clarify_goal'
          : pending.some(d => d.status === 'deferred') ? 'isolate_disputed_scope' : pending.some(d => d.status === 'negotiating') ? 'coordinate' : 'continue',
        policies: [], capabilities: { git_observer: false, semantic_matching: false, policy_reuse: false },
        warnings: ['Scope, progress and verification are agent reports; no Git facts have been verified.'],
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async project(actor: Actor, projectId?: string) {
    return this.db.transaction(async db => {
      const management = new Management(db, actor, this.clock);
      if (projectId) await management.project(projectId);
      const [allGoals, allChanges, sessions, decisions, events, projects, milestones] = await Promise.all([
        db.select().from(t.goals).where(and(eq(t.goals.repo, actor.repo), projectId ? eq(t.goals.project_id, projectId) : undefined)).orderBy(t.goals.priority, t.goals.rank, t.goals.created_at, t.goals.id).limit(200),
        db.select().from(t.changes).where(and(eq(t.changes.repo, actor.repo), projectId ? inArray(t.changes.goal_id, db.select({ id: t.goals.id }).from(t.goals).where(and(eq(t.goals.repo, actor.repo), eq(t.goals.project_id, projectId)))) : undefined)).orderBy(desc(t.changes.updated_at)).limit(500),
        db.select().from(t.sessions).where(eq(t.sessions.repo, actor.repo)).limit(500),
        db.select().from(t.decisions).where(eq(t.decisions.repo, actor.repo)).orderBy(desc(t.decisions.created_at)).limit(200),
        db.select().from(t.events).where(eq(t.events.repo, actor.repo)).orderBy(desc(t.events.created_at)).limit(30),
        db.select().from(t.projects).where(eq(t.projects.repo, actor.repo)).orderBy(t.projects.created_at),
        db.select().from(t.milestones).where(eq(t.milestones.repo, actor.repo)).orderBy(t.milestones.created_at),
      ]);
      const goals = allGoals.filter(g => !projectId || g.project_id === projectId).sort((a,b) => a.priority - b.priority || a.rank - b.rank || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      const goalsSet = new Set(goals.map(g => g.id));
      const changes = allChanges.filter(c => goalsSet.has(c.goal_id));
      const changeIds = new Set(changes.map(c => c.id));
      const views = (await this.decisionViews(db, actor, decisions)).filter(d => !projectId || d.required_change_ids.some(id => changeIds.has(id)));
      const blockers = new Set(views.filter(d => openDecisionStatuses.includes(d.status) && d.urgency === 'blocking').flatMap(d => d.required_change_ids));
      const work = (await management.workViews(changes)).map(c => {
        const waiting = !['completed', 'abandoned'].includes(c.status) && blockers.has(c.id);
        return { ...c, waiting_for_coordination: waiting, waiting_for_decision: waiting, status_source: 'agent_report' };
      });
      const goalViews = goals.map(g => {
          const children = work.filter(c => c.goal_id === g.id);
          const covered = new Set(children.filter(c => c.status !== 'abandoned' && c.goal_definition_version === g.definition_version).flatMap(c => c.lifecycle === 'managed' ? c.goal_criteria_indices : g.acceptance.map((_, i) => i)));
          return { ...g, uncovered_criteria: g.acceptance.map((_,i) => i).filter(i => !covered.has(i)), completed_tasks: children.filter(c => c.status === 'completed').length, task_count: children.length, progress: g.plan_state !== 'ready' ? g.plan_state : !children.length ? 'planned' : children.every(c => c.status === 'completed' && !c.blocked_reasons.length) && covered.size === g.acceptance.length ? 'reported_completed' : children.some(c => c.waiting_for_coordination) ? 'coordinating' : 'active' };
        });
      const runtimeRows = await db.select().from(t.runtimes).where(and(eq(t.runtimes.repo, actor.repo), projectId ? eq(t.runtimes.project_id, projectId) : undefined));
      const pendingStats = await db.select({ session_id: t.deliveries.session_id, count: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${t.deliveries.created_at})::text` }).from(t.deliveries).innerJoin(t.coordinationEvents, eq(t.coordinationEvents.id, t.deliveries.event_id)).where(and(eq(t.deliveries.repo, actor.repo), isNull(t.deliveries.acked_at), projectId ? eq(t.coordinationEvents.project_id, projectId) : undefined)).groupBy(t.deliveries.session_id);
      const controls = await db.select({ delivery: t.deliveries, event: t.coordinationEvents }).from(t.deliveries).innerJoin(t.coordinationEvents, eq(t.coordinationEvents.id, t.deliveries.event_id)).leftJoin(t.goals, eq(t.goals.id, t.coordinationEvents.aggregate_id)).leftJoin(t.projects, eq(t.projects.id, t.coordinationEvents.aggregate_id)).where(and(eq(t.deliveries.repo, actor.repo), projectId ? eq(t.coordinationEvents.project_id, projectId) : undefined, sql`((${t.coordinationEvents.action}='goal.updated' AND ${t.coordinationEvents.entity_version}=${t.goals.version} AND ${t.goals.plan_state} IN ('paused','cancelled','archived')) OR (${t.coordinationEvents.action}='project.updated' AND ${t.coordinationEvents.entity_version}=${t.projects.version} AND ${t.projects.state}='archived'))`)).orderBy(desc(t.deliveries.created_at),t.deliveries.id).limit(201);
      const runtimeViews = runtimeRows.map(r => ({ ...r, unresponsive: ['waiting','running'].includes(r.state) && Date.parse(r.expires_at) <= this.clock().getTime(), source: 'adapter_report', pending_updates: pendingStats.find(u => u.session_id === r.session_id)?.count ?? 0 }));
      const stopControls = controls.slice(0,200).map(r => ({ session_id: r.delivery.session_id, aggregate_id: r.event.aggregate_id, version: r.event.entity_version, requested_at: r.event.created_at, observed_at: r.delivery.acked_at, outcome: r.delivery.outcome, source: 'adapter_report' }));
      const risks = work.flatMap(c => [
        ...c.blocked_reasons.map(code => ({ code, goal_id: c.goal_id, change_id: c.id, observed_at: c.updated_at, source: 'project_state' })),
        ...(c.claim_state === 'expired' ? [{ code: 'responsibility_expired', goal_id: c.goal_id, change_id: c.id, observed_at: c.updated_at, source: 'lease_record' }] : []),
        ...(runtimeViews.some(r => r.session_id === c.claim?.session_id && r.unresponsive) ? [{ code: 'executor_unresponsive', goal_id: c.goal_id, change_id: c.id, observed_at: runtimeViews.find(r => r.session_id === c.claim?.session_id)!.heartbeat_at, source: 'runtime_heartbeat' }] : []),
        ...(views.some(d => d.required_change_ids.includes(c.id) && ['deferred','needs_input'].includes(d.status)) ? [{ code: 'coordination_pending', goal_id: c.goal_id, change_id: c.id, observed_at: c.updated_at, source: 'decision_record' }] : []),
      ]);
      const riskGoals = goalViews.map(g => ({ ...g, risks: [...risks.filter(r => r.goal_id === g.id), ...stopControls.filter(s => s.aggregate_id === g.id && s.version === g.version && s.outcome !== 'stopped' && s.outcome !== 'superseded').map(s => ({ code: 'execution_stop_unknown', goal_id: g.id, change_id: null, observed_at: s.requested_at, source: 'unacked_plan_control' }))] }));
      const reliability = { risks, runtimes: runtimeViews, pending_updates: pendingStats.reduce((count,s) => count+s.count,0), oldest_unacked_at: pendingStats.flatMap(s => s.oldest ? [s.oldest] : []).sort()[0] ?? null, stop_controls: stopControls, stop_controls_truncated: controls.length>200 };
      return { reliability, projects, selected_project_id: projectId ?? null, milestones: milestones.filter(m => !projectId || m.project_id === projectId).map(m => {
          const items = riskGoals.filter(g => g.milestone_id === m.id);
          return { ...m, risks: items.flatMap(g => g.risks), goal_count: items.length, reported_completed_goals: items.filter(g => g.progress === 'reported_completed').length, delivery_state: 'not_independently_verified' };
        }), repo: actor.repo, actor: { member: actor.member, role: actor.role },
        goals: riskGoals, changes: work, sessions, decisions: views, events,
        available_work: work.filter(c => c.available_to_claim).sort((a,b) => goals.findIndex(g => g.id === a.goal_id) - goals.findIndex(g => g.id === b.goal_id)),
        summary: { goals: goals.length, active_changes: changes.filter(c => !['completed', 'abandoned'].includes(c.status)).length,
          pending_decisions: views.filter(d => openDecisionStatuses.includes(d.status)).length,
          negotiating_decisions: views.filter(d => d.status === 'negotiating').length,
          deferred_decisions: views.filter(d => d.status === 'deferred').length,
          needs_input_decisions: views.filter(d => d.status === 'needs_input').length,
          resolved_decisions: views.filter(d => ['agent_resolved', 'human_resolved'].includes(d.status)).length,
          completed_changes: changes.filter(c => c.status === 'completed').length },
        limits: { goals: 200, changes: 500, decisions: 200, events: 30 },
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async readFindings(actor: Actor, raw: unknown) {
    const query = z.discriminatedUnion('scope', [
      z.object({ scope: z.literal('repo') }).strict(),
      z.object({ scope: z.literal('change'), change_id: z.uuid() }).strict(),
    ]).parse(raw);
    return this.db.transaction(async db => {
      if (query.scope === 'change') await this.change(db, actor, query.change_id);
      const rows = await db.select({ finding: t.findings, change_title: t.changes.title,
        member: t.sessions.member, agent_type: t.sessions.agent_type }).from(t.findings)
        .innerJoin(t.changes, and(eq(t.findings.change_id, t.changes.id), eq(t.changes.repo, actor.repo)))
        .innerJoin(t.sessions, and(eq(t.findings.session_id, t.sessions.id), eq(t.sessions.repo, actor.repo)))
        .where(and(eq(t.findings.repo, actor.repo), query.scope === 'change' ? eq(t.findings.change_id, query.change_id) : undefined))
        .orderBy(desc(t.findings.created_at), desc(t.findings.id)).limit(101);
      return { findings: rows.slice(0, 100).map(({ finding, ...source }) => ({ ...finding, ...source })),
        scope: query.scope, change_id: query.scope === 'change' ? query.change_id : null,
        limit: 100, truncated: rows.length > 100 };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
