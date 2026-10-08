import { z } from 'zod';

const id = z.uuid();
const text = z.string().trim().min(1).max(2000);
const scope = z.array(z.string().trim().min(1).max(300).refine(p =>
  !p.startsWith('/') && !p.includes('..') && !/(^|\/)\.env($|\.)|\.pem$/i.test(p),
'Use repository-relative, non-sensitive paths')).max(100);
const mutation = { request_id: id };
export const statusSchema = z.enum(['probable', 'implementing', 'verifying', 'completed', 'abandoned']);
export const findingSchema = z.object({
  kind: z.enum(['observation', 'hypothesis', 'root_cause', 'constraint', 'test_result', 'failed_attempt', 'patch_summary']),
  content: text, confidence: z.number().min(0).max(1),
  detail: text.max(2000).optional(), conditions: text.optional(),
  evidence: z.array(z.object({ description: text, head_sha: z.string().regex(/^[0-9a-f]{40}$/i).optional(), command: text.optional(), result: z.enum(['passed', 'failed']).optional() }).strict()).max(10).default([]),
  refutes_id: id.optional(), supersedes_id: id.optional(),
});
export const verificationSchema = z.object({
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  command: text, result: z.enum(['passed', 'failed']),
  criteria: z.array(z.object({ index: z.number().int().min(0), passed: z.boolean(), evidence: text })).min(1).max(30),
  definition_version: z.number().int().positive().optional(), goal_definition_version: z.number().int().positive().optional(),
  isolated_decisions: z.array(z.object({ decision_id: id, mitigation: text, evidence: text }).strict()).max(100).optional(),
});
export const decisionEvidenceSchema = z.object({ goal_alignment: text, constraints_check: text, verification: text }).strict();
export const schemas = {
  preflight_register_goal: z.object({ ...mutation,
    title: text.max(200), objective: text, acceptance: z.array(text.max(500)).min(1).max(30),
    project_id: id.optional(), milestone_id: id.optional(), plan_state: z.enum(['backlog', 'ready']).optional(), priority: z.number().int().min(1).max(4).optional(),
    owner: text.max(100).optional(), due_date: z.iso.date().optional(), kind: z.enum(['requirement', 'bug']).default('requirement'),
  }).strict(),
  preflight_start_work: z.object({ ...mutation,
    goal_id: id, title: text.max(200), agent_type: text.max(80),
    session_id: id.optional(), existing_change_id: id.optional(),
    likely_scope: scope.default([]), branch: z.string().max(200).optional(),
    error_fingerprints: z.array(text.max(200)).max(20).default([]),
    mode: z.enum(['propose', 'claim']).optional(), task_acceptance: z.array(text.max(500)).min(1).max(30).optional(),
    goal_criteria_indices: z.array(z.number().int().min(0)).min(1).max(30).optional(), depends_on_change_ids: z.array(id).max(50).default([]),
  }).strict(),
  preflight_get_context: z.object({ change_id: id.optional(), session_id: id.optional(), goal_id: id.optional() }).strict().refine(d => Boolean(d.goal_id) !== Boolean(d.change_id) && (!d.change_id || Boolean(d.session_id)), 'Use goal_id or change_id with session_id'),
  preflight_report_progress: z.object({ ...mutation,
    change_id: id, session_id: id, expected_version: z.number().int().positive(),
    status: statusSchema, summary: text, likely_scope: scope.optional(),
    verification: verificationSchema.optional(), lease_id: id.optional(), lease_epoch: z.number().int().positive().optional(),
    feedback: z.object({ change_id: id, relation: z.enum(['same_work', 'related_but_distinct', 'not_related', 'intentional_parallel']) }).optional(),
    pr_url: z.url().refine(url => new URL(url).protocol === 'https:', 'Use an HTTPS PR URL').optional(),
  }).strict(),
  preflight_publish_findings: z.object({ ...mutation,
    change_id: id, session_id: id, findings: z.array(findingSchema).min(1).max(20),
  }).strict(),
  preflight_propose_decision: z.object({ ...mutation,
    change_id: id, session_id: id, question: text.max(500), context: text,
    category: z.enum(['public_api_behavior', 'database_schema', 'auth_security', 'product_behavior', 'architecture_boundary', 'unknown']),
    authority: z.enum(['within_goal', 'goal_boundary', 'missing_information']).default('within_goal'),
    urgency: z.enum(['blocking', 'normal', 'low']),
    options: z.array(z.object({ label: text.max(80), description: text,
      pros: z.array(text.max(500)).max(10).default([]), cons: z.array(text.max(500)).max(10).default([]),
    })).min(2).max(5).refine(opts => new Set(opts.map(o => o.label)).size === opts.length, 'Option labels must be unique'),
    recommendation: z.string().max(80).optional(), affected_change_ids: z.array(id).max(20).default([]),
  }).strict(),
  preflight_review_decision: z.object({ ...mutation,
    change_id: id, session_id: id, decision_id: id, expected_version: z.number().int().positive(),
    stance: z.enum(['accept', 'object']), option_id: id.optional(), rationale: text, evidence: decisionEvidenceSchema,
  }).strict().refine(data => data.stance !== 'accept' || data.option_id !== undefined, 'Accept requires an option ID'),
  preflight_get_project: z.object({ project_id: id.optional() }).strict(),
  preflight_manage_project: z.object({ ...mutation, operation: z.enum(['create','update']), project_id: id.optional(), expected_version: z.number().int().positive().optional(),
    title: text.max(200).optional(), description: z.string().trim().max(2000).optional(), state: z.enum(['active','archived']).optional(), planning_agents: z.array(text.max(100)).max(30).optional() }).strict(),
  preflight_manage_milestone: z.object({ ...mutation, operation: z.enum(['create','update']), project_id: id, milestone_id: id.optional(), expected_version: z.number().int().positive().optional(),
    title: text.max(200).optional(), due_date: z.iso.date().nullable().optional(), state: z.enum(['planned','archived']).optional() }).strict(),
  preflight_manage_goal: z.object({ ...mutation, goal_id: id, expected_version: z.number().int().positive(),
    title: text.max(200).optional(), objective: text.optional(), acceptance: z.array(text.max(500)).min(1).max(30).optional(),
    plan_state: z.enum(['backlog','ready','paused','cancelled','archived']).optional(), priority: z.number().int().min(1).max(4).optional(), rank: z.number().int().min(0).max(1000000).optional(),
    milestone_id: id.nullable().optional(), owner: text.max(100).nullable().optional(), due_date: z.iso.date().nullable().optional() }).strict(),
  preflight_manage_work: z.object({ ...mutation, change_id: id, expected_version: z.number().int().positive(),
    title: text.max(200).optional(), task_acceptance: z.array(text.max(500)).min(1).max(30).optional(), goal_criteria_indices: z.array(z.number().int().min(0)).min(1).max(30).optional(),
    depends_on_change_ids: z.array(id).max(50).optional(), session_id: id.optional(), lease_id: id.optional(), lease_epoch: z.number().int().positive().optional() }).strict(),
  preflight_manage_claim: z.object({ ...mutation, operation: z.enum(['claim','renew','release']), change_id: id, expected_version: z.number().int().positive().optional(),
    session_id: id.optional(), agent_type: text.max(80).default('coding-agent'), lease_id: id.optional(), lease_epoch: z.number().int().positive().optional() }).strict(),
  preflight_search_findings: z.object({ query: z.string().trim().min(1).max(200).optional(), project_id: id.optional(), goal_id: id.optional(), change_id: id.optional(), finding_id: id.optional(),
    kind: findingSchema.shape.kind.optional(), cursor: z.string().max(300).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  resolve_decision: z.object({ ...mutation, decision_id: id,
    expected_version: z.number().int().positive(), option_id: id, resolution: text,
  }).strict(),
};
export type Action = keyof typeof schemas;
export type Actor = { member: string; role: 'human' | 'agent'; repo: string };
export type Verification = z.infer<typeof verificationSchema> & { source: 'agent_report' };
export class DomainError extends Error {
  constructor(public code: string, message: string, public status: 400 | 401 | 403 | 404 | 409 | 413 | 503 = 400) {
    super(message);
  }
}

/** Secret filtering applies before persistence, including nested MCP/REST inputs. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/\b(?:password|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s,"'\n]+/gi, '[REDACTED CREDENTIAL]') as T;
  if (Array.isArray(value)) return value.map(v => redact(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
