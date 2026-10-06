import { pgTable, uuid, text, integer, jsonb, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Verification, decisionEvidenceSchema } from '../domain/contracts.js';
import type { z } from 'zod';
const identity = () => ({ id: uuid('id').primaryKey(), repo: text('repo').notNull(), created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow() });
export const goals = pgTable('goals', {
  ...identity(), title: text('title').notNull(), objective: text('objective').notNull(),
  acceptance: jsonb('acceptance').$type<string[]>().notNull(), created_by: text('created_by').notNull(),
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
}, t => [index('changes_repo_idx').on(t.repo, t.updated_at)]);
export const changeSessions = pgTable('change_sessions', {
  change_id: uuid('change_id').notNull().references(() => changes.id), session_id: uuid('session_id').notNull().references(() => sessions.id),
}, t => [primaryKey({ columns: [t.change_id, t.session_id] })]);
export const findings = pgTable('findings', {
  ...identity(), change_id: uuid('change_id').notNull().references(() => changes.id),
  session_id: uuid('session_id').notNull().references(() => sessions.id),
  kind: text('kind').notNull(), content: text('content').notNull(), confidence: jsonb('confidence').$type<number>().notNull(),
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
