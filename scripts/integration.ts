import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq, inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import * as t from '../src/db/schema.js';
import { CollaborationService } from '../src/domain/service.js';
import type { Credential } from '../src/config.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests');
await migrate(process.env.DATABASE_URL);
const connection = connectDatabase(process.env.DATABASE_URL);
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
type Decision = typeof t.decisions.$inferSelect;
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
  assert.equal(tools.tools.length, 7);
  assert(!tools.tools.some(tool => tool.name.includes('resolve')));
  console.log('✓ Two independent authenticated clients initialize and discover seven real MCP tools');
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
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, expected_version: 3, status: 'completed', summary: 'Finished', verification }, 'DECISION_PENDING');
  const resolution = { request_id: randomUUID(), expected_version: proposed.decision.version, option_id: proposed.decision.options[1]!.id, resolution: 'Use an internal result type; keep the external API unchanged' };
  assert.equal((await request(`/api/v1/decisions/${proposed.decision.id}/resolve`, secrets[1], resolution)).status, 403);
  const login = await request('/auth/login', undefined, { token: secrets[2] });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  assert(login.headers.get('set-cookie')!.includes('HttpOnly'));
  const resolved = await request(`/api/v1/decisions/${proposed.decision.id}/resolve`, undefined, resolution, { Cookie: cookie });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.equal((await request(`/api/v1/decisions/${proposed.decision.id}/resolve`, undefined, resolution, { Cookie: cookie })).status, 200);
  assert.equal((await request(`/api/v1/decisions/${proposed.decision.id}/resolve`, secrets[2], { ...resolution, request_id: randomUUID(), option_id: proposed.decision.options[0]!.id })).status, 409);
  context = await call(bob, 'preflight_get_context', { change_id: b.change.id, session_id: b.session_id });
  assert.equal(context.blocking, false);
  assert.equal(context.resolved_decisions[0]?.resolved_by, 'lead');
  const another = await call<{ decision: Decision }>(bob, 'preflight_propose_decision', { ...proposal, question: 'Choose the telemetry policy', request_id: randomUUID(), change_id: b.change.id, session_id: b.session_id });
  context = await call(bob, 'preflight_get_context', { change_id: b.change.id, session_id: b.session_id });
  assert(context.blocking);
  assert.equal((await request(`/api/v1/decisions/${another.decision.id}/resolve`, secrets[2], { request_id: randomUUID(), expected_version: 1, option_id: another.decision.options[1]!.id, resolution: 'Use the compatible option' })).status, 200);
  console.log('✓ Shared blocking decision, human-only resolution, retry safety and preserved independent blockers');
  await errorCode(alice, 'preflight_report_progress', { request_id: randomUUID(), change_id: a.change.id, session_id: a.session_id, expected_version: 3, status: 'completed', summary: 'Finished' }, 'VERIFICATION_REQUIRED');
  await mutate(a, 'completed', 3, { verification });
  await mutate(b, 'implementing', 1);
  await mutate(b, 'verifying', 2);
  await mutate(b, 'completed', 3, { verification });
  const board = await call<{ summary: { completed_changes: number }; goals: { id: string; progress: string }[]; events: { action: string }[] }>(bob, 'preflight_get_project');
  assert.equal(board.summary.completed_changes, 2);
  assert.equal(board.goals.find(g => g.id === goal.id)?.progress, 'reported_completed');
  assert.equal(board.events.filter(e => e.action === 'decision.resolved').length, 2);
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
  console.log('✓ Durable collaboration state survives service recreation');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await connection.db.transaction(async db => {
    const decisionIds = (await db.select({ id: t.decisions.id }).from(t.decisions).where(eq(t.decisions.repo, repo))).map(r => r.id);
    const changeIds = (await db.select({ id: t.changes.id }).from(t.changes).where(eq(t.changes.repo, repo))).map(r => r.id);
    if (decisionIds.length) await db.delete(t.decisionImpacts).where(inArray(t.decisionImpacts.decision_id, decisionIds));
    if (changeIds.length) await db.delete(t.changeSessions).where(inArray(t.changeSessions.change_id, changeIds));
    await db.delete(t.findings).where(eq(t.findings.repo, repo));
    await db.delete(t.feedback).where(eq(t.feedback.repo, repo));
    await db.delete(t.decisions).where(eq(t.decisions.repo, repo));
    await db.delete(t.changes).where(eq(t.changes.repo, repo));
    await db.delete(t.sessions).where(eq(t.sessions.repo, repo));
    await db.delete(t.goals).where(eq(t.goals.repo, repo));
    await db.delete(t.events).where(eq(t.events.repo, repo));
    await db.delete(t.mutations).where(eq(t.mutations.repo, repo));
  });
  await connection.client.end();
}
