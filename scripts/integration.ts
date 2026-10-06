import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import * as t from '../src/db/schema.js';
import { CollaborationService } from '../src/domain/service.js';
import type { Credential } from '../src/config.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests');
const testSchema = `preflight_test_${randomUUID().replaceAll('-', '')}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
await admin.unsafe(`CREATE SCHEMA "${testSchema}"`);
const connection = connectDatabase(process.env.DATABASE_URL, testSchema);
const legacyPending = randomUUID(), legacyResolved = randomUUID();
try {
  // A real 001-era schema with durable legacy decisions exercises the upgrade, never the running app schema.
  await connection.client.unsafe(readFileSync('migrations/001_initial.sql', 'utf8'));
  await connection.client`CREATE TABLE schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await connection.client`INSERT INTO schema_migrations(version) VALUES (1)`;
  for (const [id, status] of [[legacyPending, 'pending'], [legacyResolved, 'human_resolved']]) {
    await connection.client`INSERT INTO decisions(id,repo,question,context,category,urgency,status,options,raised_by)
      VALUES (${id!},'legacy/upgrade','Legacy question','Legacy context','product_behavior','blocking',${status!},'[]','legacy')`;
  }
  await migrate(process.env.DATABASE_URL, testSchema);
  await migrate(process.env.DATABASE_URL, testSchema);
  const upgraded = await connection.client`SELECT * FROM decisions WHERE id = ${legacyPending}`;
  assert.equal(upgraded[0]?.status, 'negotiating');
  assert.equal(upgraded[0]?.authority, 'within_goal');
  assert.equal(upgraded[0]?.review_round, 1);
  assert.equal(upgraded[0]?.review_epoch, 1);
  assert.equal((await connection.client`SELECT status FROM decisions WHERE id = ${legacyResolved}`)[0]?.status, 'human_resolved');
  assert.equal((await connection.client`SELECT * FROM schema_migrations`).length, 2);
  assert.equal((await connection.client`SELECT * FROM domain_events WHERE action = 'decision.coordination_migrated'`).length, 1);
  console.log('✓ Real legacy schema upgrades pending decisions once and preserves historical human resolutions');
} catch (error) {
  await connection.client.end();
  await admin.unsafe(`DROP SCHEMA "${testSchema}" CASCADE`);
  await admin.end();
  throw error;
}
const repo = `integration/${randomUUID()}`;
const secrets = Array.from({ length: 4 }, () => randomBytes(32).toString('hex'));
const credentials: Credential[] = ['alice', 'bob', 'lead', 'outsider'].map((member, i) => ({ member,
  role: i === 2 ? 'human' : 'agent', repo: i === 3 ? `${repo}-other` : repo,
  token_hash: createHash('sha256').update(secrets[i]!).digest('hex'), expires_at: new Date(Date.now() + 1000000).toISOString(),
}));
let currentCredentials = credentials;
const app = createApp({ service: new CollaborationService(connection.db), credentials: () => currentCredentials });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const clients = [new Client({ name: 'alice-client', version: '1.0' }), new Client({ name: 'bob-client', version: '1.0' })];
type Work = { session_id: string; change: t.Change; related_work: { change_id: string; relation: string; evidence: unknown[] }[] };
type Decision = typeof t.decisions.$inferSelect & { required_change_ids: string[]; missing_change_ids: string[];
  current_reviews: (typeof t.decisionReviews.$inferSelect)[]; review_history: (typeof t.decisionReviews.$inferSelect)[]; round_limit: number };
type FindingsView = { findings: (typeof t.findings.$inferSelect & { change_title: string; member: string; agent_type: string })[];
  scope: string; change_id: string | null; limit: number; truncated: boolean };
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  return (result.structuredContent as { data: T }).data;
}
async function errorCode(client: Client, name: string, args: Record<string, unknown>, code: string) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert(JSON.stringify(result.content).includes(code), JSON.stringify(result.content));
}
async function request(path: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
}
try {
  for (let i = 0; i < clients.length; i++) await clients[i]!.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${secrets[i]}` } } }));
  const alice = clients[0]!, bob = clients[1]!;
  const tools = await alice.listTools();
  assert.equal(tools.tools.length, 8);
  assert(!tools.tools.some(tool => tool.name.includes('resolve')));
  assert.equal((await request('/api/v1/findings?scope=repo', undefined)).status, 401);
  const emptyFindings = await request('/api/v1/findings?scope=repo', secrets[0]);
  assert.equal(emptyFindings.status, 200);
  assert.deepEqual((await emptyFindings.json() as { data: FindingsView }).data, { findings: [], scope: 'repo', change_id: null, limit: 100, truncated: false });
  for (const query of ['', '?scope=unknown', '?scope=change', '?scope=change&change_id=invalid', '?scope=repo&change_id=' + randomUUID(), '?scope=repo&repo=foreign', '?scope=repo&scope=change']) {
    assert.equal((await request('/api/v1/findings' + query, secrets[0])).status, 400, query);
  }
  console.log('✓ Two independent authenticated clients initialize and discover eight real MCP tools');
  const goalInput = { request_id: randomUUID(), title: 'Fix login timeout', objective: 'Keep login backward compatible', acceptance: ['Tests pass', 'Public API is unchanged'] };
  const goals = await Promise.all([call<{ goal: typeof t.goals.$inferSelect }>(alice, 'preflight_register_goal', goalInput), call<{ goal: typeof t.goals.$inferSelect }>(alice, 'preflight_register_goal', goalInput)]);
  assert.equal(goals[0]!.goal.id, goals[1]!.goal.id);
  const goal = goals[0]!.goal;
  await errorCode(alice, 'preflight_register_goal', { ...goalInput, title: 'Different goal' }, 'IDEMPOTENCY_CONFLICT');
  const a = await call<Work>(alice, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, title: 'Fix login timeout', agent_type: 'client-a', likely_scope: ['src/auth.ts'], error_fingerprints: ['dbpool-timeout'] });
  await call(alice, 'preflight_publish_findings', { request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, findings: [{ kind: 'root_cause', content: 'TimeoutError is fatal. api_key=do-not-store-this', confidence: 0.9 }] });
  const b = await call<Work>(bob, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, title: 'Investigate auth 500', agent_type: 'client-b', likely_scope: ['src/auth.ts'], error_fingerprints: ['dbpool-timeout'] });
  assert.notEqual(a.change.id, b.change.id);
  assert(b.related_work.some(r => r.change_id === a.change.id && r.relation === 'possible_duplicate' && r.evidence.length > 0));
  let context = await call<{ findings: { content: string }[]; pending_decisions: Decision[]; resolved_decisions: Decision[]; blocking: boolean; current_change: t.Change }>(bob, 'preflight_get_context', { change_id: b.change.id, session_id: b.session_id });
  assert(context.findings.some(f => f.content.includes('TimeoutError')));
  assert(!JSON.stringify(context).includes('do-not-store-this'));
  const scopedResponse = await request('/api/v1/findings?scope=change&change_id=' + a.change.id, secrets[1]);
  assert.equal(scopedResponse.status, 200);
  const scoped = (await scopedResponse.json() as { data: FindingsView }).data;
  assert.equal(scoped.scope, 'change');
  assert.equal(scoped.change_id, a.change.id);
  assert.equal(scoped.findings.length, 1);
  assert.equal(scoped.findings[0]?.session_id, a.session_id);
  assert.equal(scoped.findings[0]?.change_title, a.change.title);
  assert.equal(scoped.findings[0]?.member, 'alice');
  assert.equal(scoped.findings[0]?.agent_type, 'client-a');
  assert.equal(scoped.findings[0]?.confidence, 0.9);
  assert(!JSON.stringify(scoped).includes('do-not-store-this'));
  const foreignGoalResponse = await request('/api/v1/tools/preflight_register_goal', secrets[3], { request_id: randomUUID(), title: 'Foreign goal', objective: 'Isolate findings', acceptance: ['No leak'] });
  assert.equal(foreignGoalResponse.status, 200);
  const foreignGoal = (await foreignGoalResponse.json() as { data: { goal: typeof t.goals.$inferSelect } }).data.goal;
  const foreignWorkResponse = await request('/api/v1/tools/preflight_start_work', secrets[3], { request_id: randomUUID(), goal_id: foreignGoal.id, title: 'Foreign work', agent_type: 'outsider' });
  assert.equal(foreignWorkResponse.status, 200);
  const foreign = (await foreignWorkResponse.json() as { data: Work }).data;
  assert.equal((await request('/api/v1/tools/preflight_publish_findings', secrets[3], { request_id: randomUUID(), change_id: foreign.change.id, session_id: foreign.session_id, findings: [{ kind: 'observation', content: 'ForeignFindingMarker', confidence: 0.4 }] })).status, 200);
  assert.equal((await request('/api/v1/findings?scope=change&change_id=' + foreign.change.id, secrets[0])).status, 404);
  assert.equal((await request('/api/v1/findings?scope=change&change_id=' + a.change.id, secrets[3])).status, 404);
  const foreignView = (await (await request('/api/v1/findings?scope=repo', secrets[3])).json() as { data: FindingsView }).data;
  assert.equal(foreignView.findings.length, 1);
  assert.equal(foreignView.findings[0]?.content, 'ForeignFindingMarker');
  assert(!JSON.stringify((await (await request('/api/v1/findings?scope=repo', secrets[0])).json())).includes('ForeignFindingMarker'));
  console.log('✓ Explicit Findings scopes validate input, preserve confidence/source and isolate real foreign-repository findings');
  const discoveryGoal = await call<{ goal: typeof t.goals.$inferSelect }>(alice, 'preflight_register_goal', { request_id: randomUUID(), title: 'Shared goal discovery', objective: 'Find distinct work', acceptance: ['Findings visible'] });
  const source = await call<Work>(alice, 'preflight_start_work', { request_id: randomUUID(), goal_id: discoveryGoal.goal.id, title: 'backend database', agent_type: 'client-a', likely_scope: ['src/domain/service.ts'] });
  await call(alice, 'preflight_publish_findings', { request_id: randomUUID(), change_id: source.change.id, session_id: source.session_id, findings: [{ kind: 'observation', content: 'SameGoalDiscovery', confidence: 1 }] });
  const sibling = await call<Work>(bob, 'preflight_start_work', { request_id: randomUUID(), goal_id: discoveryGoal.goal.id, title: '页面呈现', agent_type: 'client-b', likely_scope: ['public/app.js'] });
  assert.notEqual(sibling.change.id, source.change.id);
  assert(sibling.related_work.some(r => r.change_id === source.change.id && JSON.stringify(r.evidence).includes('same_goal')));
  const siblingContext = await call<typeof context>(bob, 'preflight_get_context', { change_id: sibling.change.id, session_id: sibling.session_id });
  assert(siblingContext.findings.some(f => f.content.includes('SameGoalDiscovery')));
  await call(bob, 'preflight_report_progress', { request_id: randomUUID(), change_id: sibling.change.id, session_id: sibling.session_id, expected_version: 1, status: 'implementing', summary: 'Hide unrelated work', feedback: { change_id: source.change.id, relation: 'not_related' } });
  const filteredContext = await call<typeof context & { related_work: { change_id: string }[] }>(bob, 'preflight_get_context', { change_id: sibling.change.id, session_id: sibling.session_id });
  assert(!filteredContext.related_work.some(r => r.change_id === source.change.id));
  assert(!filteredContext.findings.some(f => f.content.includes('SameGoalDiscovery')));
  await call(bob, 'preflight_report_progress', { request_id: randomUUID(), change_id: sibling.change.id, session_id: sibling.session_id, expected_version: 2, status: 'abandoned', summary: 'Same-goal regression verified' });
  await call(alice, 'preflight_report_progress', { request_id: randomUUID(), change_id: source.change.id, session_id: source.session_id, expected_version: 1, status: 'abandoned', summary: 'Same-goal regression verified' });
  console.log('✓ Distinct same-goal work discovers shared findings without title/scope overlap and honors not_related feedback');
  console.log('✓ Planned goals, concurrent retry deduplication, distinct changes and cross-member findings reuse');
  await errorCode(bob, 'preflight_publish_findings', { request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, findings: [{ kind: 'observation', content: 'Attempt unauthorized write', confidence: 1 }] }, 'FORBIDDEN');
  const proposal = { question: 'Should the public login API change?', context: 'Both changes need the same error contract', category: 'public_api_behavior', urgency: 'blocking', recommendation: 'B', options: [{ label: 'A', description: 'Change the API', pros: [], cons: ['Migration'] }, { label: 'B', description: 'Keep the public API', pros: ['Compatible'], cons: [] }] };
  const proposed = await call<{ decision: Decision }>(alice, 'preflight_propose_decision', { ...proposal, request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, affected_change_ids: [b.change.id] });
  const attached = await call<{ decision: Decision; attached: boolean }>(bob, 'preflight_propose_decision', { ...proposal, request_id: randomUUID(), change_id: b.change.id, session_id: b.session_id });
  assert.equal(attached.decision.id, proposed.decision.id);
  assert(attached.attached);
  const joined = await call<Work & { blocking: boolean }>(bob, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, existing_change_id: a.change.id, title: 'Join shared investigation', agent_type: 'client-b' });
  assert.equal(joined.change.id, a.change.id);
  assert(joined.blocking, 'Joining work must preserve its pending decision blockers');
  const distinctContext = await call<{ decision: Decision; attached: boolean }>(alice, 'preflight_propose_decision', { ...proposal, urgency: 'normal', context: 'A different compatibility constraint', request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id });
  assert.notEqual(distinctContext.decision.id, proposed.decision.id);
  assert.equal(distinctContext.attached, false);
  const distinctOptions = await call<{ decision: Decision; attached: boolean }>(alice, 'preflight_propose_decision', { ...proposal, urgency: 'normal', options: [{ ...proposal.options[0], description: 'A materially different implementation' }, proposal.options[1]], request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id });
  assert.notEqual(distinctOptions.decision.id, proposed.decision.id);
  assert.equal(distinctOptions.attached, false);
  const exactAgain = await call<{ decision: Decision; attached: boolean }>(alice, 'preflight_propose_decision', { ...proposal, request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id });
  assert.equal(exactAgain.decision.id, proposed.decision.id);
  const mutate = async (work: Work, status: string, version: number, extra: Record<string, unknown> = {}) => call<{ change: t.Change }>(work === a ? alice : bob, 'preflight_report_progress', {
    request_id: randomUUID(), change_id: work.change.id, session_id: work.session_id, expected_version: version, status, summary: 'Progress updated', ...extra,
  });
  await mutate(a, 'implementing', 1);
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, expected_version: 1, status: 'verifying', summary: 'Stale update' }, 'STALE_VERSION');
  await mutate(a, 'verifying', 2);
  const verification = { head_sha: 'a'.repeat(40), command: 'npm test', result: 'passed', criteria: [{ index: 0, passed: true, evidence: 'Test suite passed' }, { index: 1, passed: true, evidence: 'Public interface diff reviewed' }] };
  const completeArgs = { change_id: a.change.id, session_id: a.session_id, expected_version: 3, status: 'completed', summary: 'Finished', verification };
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), ...completeArgs }, 'COORDINATION_PENDING');
  const resolution = { request_id: randomUUID(), expected_version: proposed.decision.version, option_id: proposed.decision.options[1]!.id, resolution: 'Use an internal result type; keep the external API unchanged' };
  assert.equal((await request(`/api/v1/decisions/${proposed.decision.id}/resolve`, secrets[1], resolution)).status, 403);
  const login = await request('/auth/login', undefined, { token: secrets[2] });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  assert(login.headers.get('set-cookie')!.includes('HttpOnly'));
  assert.equal((await request(`/api/v1/decisions/${proposed.decision.id}/resolve`, undefined, resolution, { Cookie: cookie })).status, 409);
  const evidence = { goal_alignment: 'Keep the explicit user goal', constraints_check: 'Repository and API boundaries checked', verification: 'Integration evidence inspected' };
  const reviewArgs = (work: Work, decision: Decision, stance: string, option = decision.options[1]!.id) => ({ request_id: randomUUID(), change_id: work.change.id, session_id: work.session_id,
    decision_id: decision.id, expected_version: decision.version, stance, option_id: option, rationale: 'Reviewed current goal and constraints', evidence });
  const review = async (client: Client, work: Work, decision: Decision, stance = 'accept', option = decision.options[1]!.id) =>
    (await call<{ decision: Decision }>(client, 'preflight_review_decision', reviewArgs(work, decision, stance, option))).decision;
  await errorCode(bob, 'preflight_review_decision', reviewArgs(a, proposed.decision, 'accept'), 'FORBIDDEN');
  await errorCode(alice, 'preflight_review_decision', reviewArgs(source, proposed.decision, 'accept'), 'FORBIDDEN');
  await errorCode(alice, 'preflight_review_decision', reviewArgs(a, proposed.decision, 'accept', randomUUID()), 'VALIDATION_ERROR');
  assert.equal((await request('/api/v1/tools/preflight_review_decision', secrets[2], reviewArgs(a, proposed.decision, 'accept'))).status, 403);
  assert.equal((await request('/api/v1/tools/preflight_review_decision', secrets[3], reviewArgs(foreign, proposed.decision, 'accept'))).status, 404);
  const firstVoteArgs = { ...reviewArgs(a, proposed.decision, 'accept'), rationale: 'Checked boundaries api_key=review-secret-value' };
  const firstVotes = await Promise.all([call<{ decision: Decision }>(alice, 'preflight_review_decision', firstVoteArgs), call<{ decision: Decision }>(alice, 'preflight_review_decision', firstVoteArgs)]);
  assert.deepEqual(firstVotes[0], firstVotes[1]);
  const firstVote = firstVotes[0]!.decision;
  assert.equal(firstVote.current_reviews.length, 1);
  assert(!JSON.stringify(firstVote).includes('review-secret-value'));
  assert.deepEqual(firstVote.missing_change_ids, [b.change.id]);
  await errorCode(alice, 'preflight_review_decision', { ...firstVoteArgs, rationale: 'Different content' }, 'IDEMPOTENCY_CONFLICT');
  await errorCode(bob, 'preflight_review_decision', reviewArgs(b, proposed.decision, 'accept'), 'STALE_VERSION');
  await errorCode(alice, 'preflight_review_decision', reviewArgs(a, firstVote, 'object'), 'REVIEW_ALREADY_RECORDED');
  const agreed = await review(bob, b, firstVote);
  assert.equal(agreed.status, 'agent_resolved');
  assert.equal(agreed.current_reviews.length, 2);
  assert.equal(agreed.current_reviews[0]?.evidence.goal_alignment, evidence.goal_alignment);
  assert.deepEqual(agreed.missing_change_ids, []);
  assert.equal(agreed.resolved_by, 'agent_consensus');
  await errorCode(alice, 'preflight_review_decision', reviewArgs(a, agreed, 'accept'), 'REVIEW_NOT_ALLOWED');
  context = await call(bob, 'preflight_get_context', { change_id: b.change.id, session_id: b.session_id });
  assert.equal(context.blocking, false);
  assert.equal(context.resolved_decisions[0]?.resolved_by, 'agent_consensus');
  const another = await call<{ decision: Decision }>(bob, 'preflight_propose_decision', { ...proposal, question: 'Choose the telemetry policy', request_id: randomUUID(), change_id: b.change.id, session_id: b.session_id });
  context = await call(bob, 'preflight_get_context', { change_id: b.change.id, session_id: b.session_id });
  assert(context.blocking);
  assert.equal((await review(bob, b, another.decision)).status, 'agent_resolved');
  console.log('✓ Two agents reach evidence-backed agreement without a human; impersonation, stale votes and duplicate replies rejected');

  const epochProposal = { ...proposal, urgency: 'normal', question: 'Expand review scope', request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, affected_change_ids: [b.change.id] };
  let epoch = (await call<{ decision: Decision }>(alice, 'preflight_propose_decision', epochProposal)).decision;
  epoch = await review(alice, a, epoch);
  const beforeEpoch = epoch;
  epoch = (await call<{ decision: Decision }>(alice, 'preflight_propose_decision', { ...epochProposal, request_id: randomUUID(), affected_change_ids: [b.change.id, source.change.id] })).decision;
  assert.equal(epoch.review_epoch, 2);
  assert.equal(epoch.review_round, 1);
  assert.equal(epoch.current_reviews.length, 0);
  assert.equal(epoch.review_history.length, 1);
  assert.equal(epoch.missing_change_ids.length, 3);
  await errorCode(bob, 'preflight_review_decision', reviewArgs(b, beforeEpoch, 'accept'), 'STALE_VERSION');
  const epochVersion = epoch.version;
  epoch = (await call<{ decision: Decision }>(alice, 'preflight_propose_decision', { ...epochProposal, request_id: randomUUID(), urgency: 'blocking', affected_change_ids: [b.change.id, source.change.id] })).decision;
  assert.equal(epoch.version, epochVersion + 1);
  assert.equal(epoch.review_epoch, 2);
  epoch = await review(alice, a, epoch);
  epoch = await review(bob, b, epoch);
  epoch = await review(alice, source, epoch);
  assert.equal(epoch.status, 'agent_resolved');
  console.log('✓ New affected changes invalidate earlier votes by epoch; escalation preserves the current electorate');

  const needsInput = (await call<{ decision: Decision }>(alice, 'preflight_propose_decision', { ...proposal, authority: 'goal_boundary', request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id })).decision;
  assert.equal(needsInput.status, 'needs_input');
  await errorCode(alice, 'preflight_review_decision', reviewArgs(a, needsInput, 'accept'), 'REVIEW_NOT_ALLOWED');
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), ...completeArgs }, 'GOAL_INPUT_REQUIRED');
  assert.equal((await request(`/api/v1/decisions/${needsInput.id}/resolve`, secrets[0], { ...resolution, expected_version: needsInput.version, option_id: needsInput.options[1]!.id })).status, 403);
  const inputResolution = { request_id: randomUUID(), expected_version: needsInput.version, option_id: needsInput.options[1]!.id, resolution: 'Test goal boundary clarified by the generated human identity' };
  assert.equal((await request(`/api/v1/decisions/${needsInput.id}/resolve`, undefined, inputResolution, { Cookie: cookie })).status, 200);
  assert.equal((await request(`/api/v1/decisions/${needsInput.id}/resolve`, undefined, inputResolution, { Cookie: cookie })).status, 200);
  assert.equal((await request(`/api/v1/decisions/${needsInput.id}/resolve`, secrets[2], { ...inputResolution, request_id: randomUUID(), option_id: needsInput.options[0]!.id })).status, 409);
  const missingInfo = (await call<{ decision: Decision }>(bob, 'preflight_propose_decision', { ...proposal, context: 'A different compatibility constraint', authority: 'missing_information', request_id: randomUUID(), change_id: b.change.id, session_id: b.session_id, affected_change_ids: [a.change.id] })).decision;
  assert.equal(missingInfo.status, 'needs_input');
  assert.notEqual(missingInfo.id, needsInput.id);
  assert.notEqual(missingInfo.id, distinctContext.decision.id, 'Authority must participate in exact proposal matching');
  await errorCode(bob, 'preflight_review_decision', reviewArgs(b, missingInfo, 'accept'), 'REVIEW_NOT_ALLOWED');
  assert.equal((await request(`/api/v1/decisions/${missingInfo.id}/resolve`, secrets[2], { request_id: randomUUID(), expected_version: missingInfo.version, option_id: missingInfo.options[1]!.id, resolution: 'Missing requirement supplied for this test only' })).status, 200);

  let dispute = (await call<{ decision: Decision }>(alice, 'preflight_propose_decision', { ...proposal, question: 'Disputed scope', request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, affected_change_ids: [b.change.id] })).decision;
  for (let round = 1; round <= 3; round++) {
    assert.equal(dispute.review_round, round);
    dispute = await review(alice, a, dispute, round === 2 ? 'object' : 'accept', dispute.options[0]!.id);
    assert.equal(dispute.status, 'negotiating', 'A disagreement waits for all changes to respond');
    dispute = await review(bob, b, dispute);
    assert.equal(dispute.status, round === 3 ? 'deferred' : 'negotiating');
  }
  assert.equal(dispute.review_history.length, 6);
  assert.equal(dispute.current_reviews.length, 2);
  assert.equal(dispute.round_limit, 3);
  await errorCode(alice, 'preflight_review_decision', reviewArgs(a, dispute, 'accept'), 'REVIEW_NOT_ALLOWED');
  assert.equal((await request(`/api/v1/decisions/${dispute.id}/resolve`, secrets[2], { ...resolution, expected_version: dispute.version, option_id: dispute.options[1]!.id })).status, 409);
  const disputedContext = await call<typeof context & { recommended_action: string }>(alice, 'preflight_get_context', { change_id: a.change.id, session_id: a.session_id });
  assert.equal(disputedContext.recommended_action, 'isolate_disputed_scope');
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), ...completeArgs }, 'ISOLATION_REQUIRED');
  const isolation = { decision_id: dispute.id, mitigation: 'Keep disputed behavior behind an explicit opt-in boundary', evidence: 'Unchanged default verified with integration tests' };
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), ...completeArgs, verification: { ...verification, isolated_decisions: [isolation, isolation] } }, 'INVALID_ISOLATION');
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), ...completeArgs, verification: { ...verification, isolated_decisions: [{ ...isolation, decision_id: randomUUID() }] } }, 'INVALID_ISOLATION');
  const remaining = (await call<{ decision: Decision }>(bob, 'preflight_propose_decision', { ...proposal, question: 'Independent remaining blocker', request_id: randomUUID(), change_id: b.change.id, session_id: b.session_id })).decision;
  await mutate(b, 'implementing', 1);
  await mutate(b, 'verifying', 2);
  await errorCode(bob, 'preflight_report_progress', { request_id: randomUUID(), change_id: b.change.id, session_id: b.session_id, expected_version: 3, status: 'completed', summary: 'Cannot ignore independent blockers', verification: { ...verification, isolated_decisions: [isolation] } }, 'COORDINATION_PENDING');
  await review(bob, b, remaining);
  console.log('✓ Three bounded disagreement rounds defer scope without human escalation; goal gaps and other blockers remain enforced');
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), ...completeArgs, verification: { ...verification, criteria: [verification.criteria[0]], isolated_decisions: [isolation] } }, 'VERIFICATION_REQUIRED');
  await mutate(a, 'completed', 3, { verification: { ...verification, isolated_decisions: [isolation] } });
  await mutate(b, 'completed', 3, { verification: { ...verification, isolated_decisions: [isolation] } });
  const board = await call<{ summary: { completed_changes: number }; goals: { id: string; progress: string }[]; events: { action: string }[] }>(bob, 'preflight_get_project');
  assert.equal(board.summary.completed_changes, 2);
  assert.equal(board.goals.find(g => g.id === goal.id)?.progress, 'reported_completed');
  assert.equal(board.events.filter(e => e.action === 'decision.scope_isolated').length, 2);
  const coordinationBoard = await call<{ changes: { id: string; waiting_for_coordination: boolean }[]; decisions: Decision[]; summary: { deferred_decisions: number; needs_input_decisions: number; resolved_decisions: number } }>(bob, 'preflight_get_project');
  assert.equal(coordinationBoard.changes.find(c => c.id === a.change.id)?.waiting_for_coordination, false);
  assert.equal(coordinationBoard.changes.find(c => c.id === b.change.id)?.waiting_for_coordination, false);
  assert.equal(coordinationBoard.decisions.find(d => d.id === dispute.id)?.status, 'deferred');
  assert.equal(coordinationBoard.summary.deferred_decisions, 1);
  assert.equal(coordinationBoard.summary.needs_input_decisions, 0);
  assert(coordinationBoard.summary.resolved_decisions >= 4);
  console.log('✓ Exact isolation evidence allows verified completion without claiming consensus or waiting on terminal work');
  const historical = (await (await request('/api/v1/findings?scope=repo', secrets[0])).json() as { data: FindingsView }).data;
  assert.deepEqual((await (await request('/api/v1/findings?scope=repo', undefined, undefined, { Cookie: cookie })).json() as { data: FindingsView }).data, historical);
  assert(historical.findings.some(f => f.change_id === a.change.id), 'Completed work findings remain readable');
  assert(historical.findings.some(f => f.change_id === source.change.id), 'Abandoned work findings remain readable');
  for (let batch = 0; batch < 4; batch++) await call(alice, 'preflight_publish_findings', { request_id: randomUUID(), change_id: source.change.id, session_id: source.session_id,
    findings: Array.from({ length: 20 }, (_, index) => ({ kind: 'test_result', content: `Bounded finding ${batch}-${index}`, confidence: 1 })) });
  await call(alice, 'preflight_publish_findings', { request_id: randomUUID(), change_id: source.change.id, session_id: source.session_id,
    findings: Array.from({ length: 19 }, (_, index) => ({ kind: 'test_result', content: `Limit boundary ${index}`, confidence: 1 })) });
  const exactLimit = (await (await request('/api/v1/findings?scope=change&change_id=' + source.change.id, secrets[0])).json() as { data: FindingsView }).data;
  assert.equal(exactLimit.findings.length, 100);
  assert.equal(exactLimit.truncated, false);
  await call(alice, 'preflight_publish_findings', { request_id: randomUUID(), change_id: source.change.id, session_id: source.session_id, findings: [{ kind: 'test_result', content: 'One beyond limit', confidence: 1 }] });
  const bounded = (await (await request('/api/v1/findings?scope=change&change_id=' + source.change.id, secrets[0])).json() as { data: FindingsView }).data;
  assert.equal(bounded.findings.length, 100);
  assert.equal(bounded.limit, 100);
  assert.equal(bounded.truncated, true);
  assert(bounded.findings.every(f => f.change_id === source.change.id && f.member === 'alice'));
  for (let i = 1; i < bounded.findings.length; i++) {
    const before = bounded.findings[i - 1]!, after = bounded.findings[i]!;
    assert(before.created_at > after.created_at || (before.created_at === after.created_at && before.id > after.id));
  }
  assert.deepEqual((await (await request('/api/v1/findings?scope=change&change_id=' + source.change.id, secrets[0])).json() as { data: FindingsView }).data, bounded);
  assert.equal((await request('/api/v1/findings?scope=repo', secrets[0], undefined, { Origin: 'https://malicious.example' })).status, 403);
  console.log('✓ Historical Findings retained, deterministic 100-row cap and truncation exposed');
  assert.equal((await request('/api/v1/atlas', undefined)).status, 401);
  assert.equal((await request('/auth/login', undefined, [])).status, 400);
  assert.equal((await request('/api/v1/tools/preflight_register_goal', secrets[0], [])).status, 400);
  assert.equal((await request('/api/v1/context?change_id=' + a.change.id + '&session_id=' + a.session_id, secrets[3])).status, 404);
  assert.equal((await request('/api/v1/atlas', secrets[0], undefined, { Origin: 'https://malicious.example' })).status, 403);
  assert.equal((await request('/auth/login', undefined, { token: secrets[0] })).status, 401);
  currentCredentials = credentials.filter(c => c.member !== 'lead');
  assert.equal((await request('/api/v1/atlas', undefined, undefined, { Cookie: cookie })).status, 401);
  console.log('✓ SHA-specific acceptance, shared project view, repository isolation, origin checks and token revocation');
  // New service instance against the same DB proves state does not live in MCP process/session memory.
  const persisted = await new CollaborationService(connection.db).project({ member: 'bob', role: 'agent', repo });
  assert.equal(persisted.summary.completed_changes, 2);
  assert.equal(persisted.decisions.find(d => d.id === dispute.id)?.review_history.length, 6);
  assert.equal(persisted.decisions.find(d => d.id === dispute.id)?.status, 'deferred');
  assert.equal(persisted.decisions.find(d => d.id === agreed.id)?.current_reviews.length, 2);
  const audit = await connection.client`SELECT action FROM domain_events WHERE repo = ${repo}`;
  for (const action of ['decision.reviewed', 'decision.agent_resolved', 'decision.round_advanced', 'decision.deferred', 'decision.scope_isolated', 'decision.review_scope_changed']) {
    assert(audit.some(event => event.action === action), `Missing audit ${action}`);
  }
  console.log('✓ Durable collaboration state survives service recreation');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await connection.db.transaction(async db => {
    const testRepos = [repo, `${repo}-other`];
    const decisionIds = (await db.select({ id: t.decisions.id }).from(t.decisions).where(inArray(t.decisions.repo, testRepos))).map(r => r.id);
    const changeIds = (await db.select({ id: t.changes.id }).from(t.changes).where(inArray(t.changes.repo, testRepos))).map(r => r.id);
    await db.delete(t.decisionReviews).where(inArray(t.decisionReviews.repo, testRepos));
    if (decisionIds.length) await db.delete(t.decisionImpacts).where(inArray(t.decisionImpacts.decision_id, decisionIds));
    if (changeIds.length) await db.delete(t.changeSessions).where(inArray(t.changeSessions.change_id, changeIds));
    await db.delete(t.findings).where(inArray(t.findings.repo, testRepos));
    await db.delete(t.feedback).where(inArray(t.feedback.repo, testRepos));
    await db.delete(t.decisions).where(inArray(t.decisions.repo, testRepos));
    await db.delete(t.changes).where(inArray(t.changes.repo, testRepos));
    await db.delete(t.sessions).where(inArray(t.sessions.repo, testRepos));
    await db.delete(t.goals).where(inArray(t.goals.repo, testRepos));
    await db.delete(t.events).where(inArray(t.events.repo, testRepos));
    await db.delete(t.mutations).where(inArray(t.mutations.repo, testRepos));
  });
  await connection.client.end();
  await admin.unsafe(`DROP SCHEMA "${testSchema}" CASCADE`);
  await admin.end();
}
