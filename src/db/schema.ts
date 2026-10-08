import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Verification, decisionEvidenceSchema } from '../domain/contracts.js';
import type { z } from 'zod';
const identity = () => ({ id: uuid('id').primaryKey(), repo: text('repo').notNull(), created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow() });
export const projects = pgTable('projects', {
  ...identity(), title: text('title').notNull(), description: text('description').notNull().default(''),
  state: text('state').notNull().default('active'), planning_agents: jsonb('planning_agents').$type<string[]>().notNull().default([]),
  is_default: boolean('is_default').notNull().default(false), version: integer('version').notNull().default(1),
});
export const milestones = pgTable('milestones', {
  ...identity(), project_id: uuid('project_id').notNull().references(() => projects.id), title: text('title').notNull(),
  due_date: text('due_date'), state: text('state').notNull().default('planned'), version: integer('version').notNull().default(1),
});
export const goals = pgTable('goals', {
  ...identity(), title: text('title').notNull(), objective: text('objective').notNull(),
  acceptance: jsonb('acceptance').$type<string[]>().notNull(), created_by: text('created_by').notNull(),
  project_id: uuid('project_id').notNull().references(() => projects.id), milestone_id: uuid('milestone_id').references(() => milestones.id),
  plan_state: text('plan_state').notNull().default('ready'), priority: integer('priority').notNull().default(2), rank: integer('rank').notNull().default(0),
  due_date: text('due_date'), owner: text('owner'), kind: text('kind').notNull().default('requirement'),
  version: integer('version').notNull().default(1), definition_version: integer('definition_version').notNull().default(1),
});
export const sessions = pgTable('sessions', {
  ...identity(), member: text('member').notNull(), agent_type: text('agent_type').notNull(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
export const changes = pgTable('changes', {
  ...identity(), goal_id: uuid('goal_id').notNull().references(() => goals.id), title: text('title').notNull(),
  status: text('status').notNull(), created_by: text('created_by').notNull(), version: integer('version').notNull().default(1),
  likely_scope: jsonb('likely_scope').$type<string[]>().notNull(),
  error_fingerprints: jsonb('error_fingerprints').$type<string[]>().notNull(), branch: text('branch'),
  summary: text('summary').notNull(), verification: jsonb('verification').$type<Verification>(), pr_url: text('pr_url'),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lifecycle: text('lifecycle').notNull().default('legacy'), task_acceptance: jsonb('task_acceptance').$type<string[]>().notNull().default([]),
  goal_criteria_indices: jsonb('goal_criteria_indices').$type<number[]>().notNull().default([]),
  definition_version: integer('definition_version').notNull().default(1), goal_definition_version: integer('goal_definition_version').notNull().default(1),
  claim_epoch: integer('claim_epoch').notNull().default(0),
}, t => [index('changes_repo_idx').on(t.repo, t.updated_at)]);
export const dependencies = pgTable('change_dependencies', {
  change_id: uuid('change_id').notNull().references(() => changes.id), depends_on_id: uuid('depends_on_id').notNull().references(() => changes.id),
}, t => [primaryKey({ columns: [t.change_id, t.depends_on_id] })]);
export const claims = pgTable('work_claims', {
  ...identity(), change_id: uuid('change_id').notNull().references(() => changes.id), session_id: uuid('session_id').notNull().references(() => sessions.id),
  member: text('member').notNull(), epoch: integer('epoch').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(), released_at: timestamp('released_at', { withTimezone: true, mode: 'string' }),
});
export const changeSessions = pgTable('change_sessions', {
  change_id: uuid('change_id').notNull().references(() => changes.id), session_id: uuid('session_id').notNull().references(() => sessions.id),
}, t => [primaryKey({ columns: [t.change_id, t.session_id] })]);
export const findings = pgTable('findings', {
  ...identity(), change_id: uuid('change_id').notNull().references(() => changes.id),
  session_id: uuid('session_id').notNull().references(() => sessions.id),
  kind: text('kind').notNull(), content: text('content').notNull(), confidence: jsonb('confidence').$type<number>().notNull(),
  detail: text('detail'), conditions: text('conditions'), evidence: jsonb('evidence').$type<{ description: string; head_sha?: string; command?: string; result?: string }[]>().notNull().default([]),
  refutes_id: uuid('refutes_id'), supersedes_id: uuid('supersedes_id'),
}, t => [index('findings_change_idx').on(t.change_id)]);
export type DecisionOption = { id: string; label: string; description: string; pros: string[]; cons: string[] };
export const decisions = pgTable('decisions', {
  ...identity(), question: text('question').notNull(), context: text('context').notNull(), category: text('category').notNull(),
  urgency: text('urgency').notNull(), status: text('status').notNull().default('negotiating'),
  authority: text('authority').notNull().default('within_goal'), review_round: integer('review_round').notNull().default(1),
  review_epoch: integer('review_epoch').notNull().default(1),
  options: jsonb('options').$type<DecisionOption[]>().notNull(), recommendation: text('recommendation'),
  raised_by: text('raised_by').notNull(), option_id: uuid('option_id'), resolution: text('resolution'), resolved_by: text('resolved_by'),
  resolved_at: timestamp('resolved_at', { withTimezone: true, mode: 'string' }), version: integer('version').notNull().default(1),
});
export const decisionReviews = pgTable('decision_reviews', {
  ...identity(), decision_id: uuid('decision_id').notNull().references(() => decisions.id),
  review_epoch: integer('review_epoch').notNull(), review_round: integer('review_round').notNull(),
  change_id: uuid('change_id').notNull().references(() => changes.id), session_id: uuid('session_id').notNull().references(() => sessions.id),
  member: text('member').notNull(), stance: text('stance').notNull(), option_id: uuid('option_id'),
  rationale: text('rationale').notNull(), evidence: jsonb('evidence').$type<z.infer<typeof decisionEvidenceSchema>>().notNull(),
}, t => [uniqueIndex('decision_reviews_round_change_idx').on(t.decision_id, t.review_epoch, t.review_round, t.change_id)]);
export const decisionImpacts = pgTable('decision_impacts', {
  decision_id: uuid('decision_id').notNull().references(() => decisions.id), change_id: uuid('change_id').notNull().references(() => changes.id),
}, t => [primaryKey({ columns: [t.decision_id, t.change_id] })]);
export const feedback = pgTable('relation_feedback', {
  ...identity(), from_change_id: uuid('from_change_id').notNull().references(() => changes.id),
  to_change_id: uuid('to_change_id').notNull().references(() => changes.id), member: text('member').notNull(), relation: text('relation').notNull(),
});
export const events = pgTable('domain_events', {
  ...identity(), action: text('action').notNull(), actor: text('actor').notNull(), aggregate_id: uuid('aggregate_id'), data: jsonb('data').$type<Record<string, unknown>>().notNull(),
});
export const mutations = pgTable('mutation_requests', {
  id: uuid('id').primaryKey(), repo: text('repo').notNull(), actor: text('actor').notNull(), action: text('action').notNull(),
  request_id: uuid('request_id').notNull(), request_hash: text('request_hash').notNull(), response: jsonb('response').notNull(),
}, t => [uniqueIndex('mutations_key_idx').on(t.repo, t.actor, t.action, t.request_id)]);
export type Change = typeof changes.$inferSelect;
