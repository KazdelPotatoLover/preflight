import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { chromium, type Browser } from 'playwright';
import { eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/client.js';
import * as t from '../src/db/schema.js';
import { CollaborationService } from '../src/domain/service.js';
import type { Credential } from '../src/config.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const connection = connectDatabase(process.env.DATABASE_URL);
const repo = `browser/${randomUUID()}`;
const token = randomBytes(32).toString('hex');
const actor = { member: 'browser-agent', role: 'agent' as const, repo };
const peerActor = { member: 'browser-peer', role: 'agent' as const, repo };
type ReviewDecision = { id: string; version: number; status: string; options: { id: string; label: string }[] };
const reviewAction = 'preflight_review_decision' as Parameters<CollaborationService['execute']>[1];
const credentials: Credential[] = [{ member: 'team-lead', role: 'human', repo,
  token_hash: createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + 600000).toISOString() }];
const service = new CollaborationService(connection.db);
const server = serve({ fetch: createApp({ service, credentials: () => credentials }).fetch, port: 0, hostname: '127.0.0.1' });
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PREFLIGHT_CHROMIUM_PATH });
  const { goal } = await service.execute(actor, 'preflight_register_goal', { request_id: randomUUID(), title: '修复登录超时', objective: '保持公共接口兼容', acceptance: ['相关测试通过'] }) as { goal: typeof t.goals.$inferSelect };
  const unsafeAgentType = '<svg onload=alert(1)> browser-test';
  const work = await service.execute(actor, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, title: '调查登录异常', agent_type: unsafeAgentType, likely_scope: ['src/auth.ts'] }) as { change: t.Change; session_id: string };
  const unsafeFinding = '<img src=x onerror=alert(1)>\n保留换行与发现内容';
  await service.execute(actor, 'preflight_publish_findings', { request_id: randomUUID(), change_id: work.change.id, session_id: work.session_id,
    findings: [{ kind: 'hypothesis', content: unsafeFinding, confidence: 0.42 }] });
  const peer = await service.execute(peerActor, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, title: '验证兼容边界', agent_type: 'browser-test' }) as { change: t.Change; session_id: string };
  const { decision } = await service.execute(actor, 'preflight_propose_decision', { request_id: randomUUID(), change_id: work.change.id, session_id: work.session_id, question: '是否调整公共错误格式？', context: '需要团队共同确认兼容边界', category: 'public_api_behavior', urgency: 'blocking', options: [{ label: 'A', description: '修改错误格式' }, { label: 'B', description: '保持兼容' }], recommendation: 'B', affected_change_ids: [peer.change.id] }) as { decision: ReviewDecision };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('#login-panel').waitFor({ state: 'visible' });
  await page.locator('#token').fill(token);
  await page.getByRole('button', { name: '连接团队' }).click();
  await page.locator('#board').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.work .badge').allTextContents(), ['协商中', '协商中']);
  assert.equal(await page.locator('#decisions form, #decisions input, #decisions button').count(), 0);
  await page.locator('#findings-change').selectOption(work.change.id);
  await page.locator('#findings[data-state=ready]').waitFor();
  assert.equal(await page.locator('.finding-content').textContent(), unsafeFinding);
  assert.match(await page.locator('.finding-head').innerText(), /置信度 42%/);
  assert.match(await page.locator('.finding-source').innerText(), /调查登录异常/);
  assert((await page.locator('.finding-source').innerText()).includes(`browser-agent · ${unsafeAgentType}`));
  assert((await page.locator('.finding-source dd').allTextContents()).includes(work.change.id));
  assert((await page.locator('.finding-source dd').allTextContents()).includes(work.session_id));
  assert.equal(await page.locator('.finding img, .finding script, .finding svg').count(), 0);
  const unsafeEvidence = '<svg onload=alert(1)> 协商验证证据';
  async function review(by: typeof actor, participating: { change: t.Change; session_id: string }, decisionId: string, stance: 'accept' | 'object', optionId?: string) {
    const snapshot = await service.project(by);
    const current = snapshot.decisions.find(d => d.id === decisionId);
    assert(current);
    return service.execute(by, reviewAction, { request_id: randomUUID(), change_id: participating.change.id, session_id: participating.session_id,
      decision_id: decisionId, expected_version: current.version, stance, ...(optionId ? { option_id: optionId } : {}), rationale: unsafeEvidence,
      evidence: { goal_alignment: '保持目标兼容', constraints_check: '<img src=x onerror=alert(1)> 核查边界', verification: unsafeEvidence } });
  }
  const chosen = decision.options.find(o => o.label === 'B');
  assert(chosen);
  await review(actor, work, decision.id, 'accept', chosen.id);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const coordination = page.locator(`[data-decision="${decision.id}"]`);
  await page.getByText('已答复：browser-agent（同意）', { exact: true }).waitFor();
  assert.match(await coordination.innerText(), /待答复：验证兼容边界/);
  await coordination.locator('summary').first().click();
  assert((await coordination.innerText()).includes(unsafeEvidence));
  assert.equal(await coordination.locator('img, svg, script').count(), 0);
  await review(peerActor, peer, decision.id, 'accept', chosen.id);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator(`[data-decision="${decision.id}"][data-status=agent_resolved]`).waitFor();
  assert.match(await coordination.innerText(), /Agent 已达成一致：B/);
  assert((await service.context(actor, work.change.id, work.session_id)).blocking === false);
  const { decision: disagreement } = await service.execute(actor, 'preflight_propose_decision', { request_id: randomUUID(), change_id: work.change.id, session_id: work.session_id,
    question: '普通实现分歧', context: '三轮后隔离推进，不回到人工待办', category: 'architecture_boundary', urgency: 'normal',
    options: [{ label: 'A', description: '实现 A' }, { label: 'B', description: '实现 B' }], affected_change_ids: [peer.change.id] }) as { decision: ReviewDecision };
  for (let round = 1; round <= 3; round++) {
    await review(actor, work, disagreement.id, 'object');
    await review(peerActor, peer, disagreement.id, 'object');
  }
  const { decision: gap } = await service.execute(actor, 'preflight_propose_decision', { request_id: randomUUID(), change_id: work.change.id, session_id: work.session_id,
    question: '缺少目标边界', context: '需要补充允许变更的目标范围', category: 'product_behavior', urgency: 'normal', authority: 'missing_information',
    options: [{ label: 'A', description: '补充范围 A' }, { label: 'B', description: '补充范围 B' }] }) as { decision: ReviewDecision };
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator(`[data-decision="${disagreement.id}"][data-status=deferred]`).waitFor();
  assert.match(await page.locator(`[data-decision="${disagreement.id}"]`).innerText(), /建议隔离受影响工作/);
  await page.locator(`#input-gaps [data-decision="${gap.id}"][data-status=needs_input]`).waitFor();
  assert.equal(await page.locator('#decisions [data-status=needs_input]').count(), 0);
  assert.equal(await page.locator('#decisions form, #input-gaps form').count(), 0);
  const second = await service.execute(actor, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, title: '另一项工作', agent_type: 'browser-test' }) as { change: t.Change; session_id: string };
  await service.execute(actor, 'preflight_publish_findings', { request_id: randomUUID(), change_id: second.change.id, session_id: second.session_id,
    findings: [{ kind: 'observation', content: '另一项工作的独立发现', confidence: 1 }] });
  const emptyWork = await service.execute(actor, 'preflight_start_work', { request_id: randomUUID(), goal_id: goal.id, title: '尚无发现的工作', agent_type: 'browser-test' }) as { change: t.Change; session_id: string };
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator(`#findings-change option[value="${emptyWork.change.id}"]`).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#findings-change').inputValue(), work.change.id, 'Refresh must preserve the selected Change');
  await page.locator('#findings[data-state=ready]').waitFor();
  assert.equal(await page.locator('.finding').count(), 1);
  await page.locator('#findings-change').selectOption('all');
  await page.locator('#findings[data-state=ready]').waitFor();
  assert.equal(await page.locator('.finding').count(), 2);
  await page.locator('#findings-change').selectOption(second.change.id);
  await page.locator('#findings[data-state=ready]').waitFor();
  assert.equal(await page.locator('.finding-content').textContent(), '另一项工作的独立发现');
  await page.locator('#findings-change').selectOption(emptyWork.change.id);
  await page.locator('#findings[data-state=ready]').waitFor();
  assert.equal(await page.locator('.finding').count(), 0);
  assert.match(await page.locator('#findings').innerText(), /这项工作尚未共享发现/);
  await page.locator('#findings-change').selectOption('all');
  await page.locator('#findings[data-state=ready]').waitFor();
  await page.getByRole('button', { name: '＋ 登记目标' }).click();
  await page.locator('#goal-title').fill('<img src=x onerror=alert(1)> 新的计划目标');
  await page.locator('#goal-objective').fill('可以在没有 Agent 工作时保留计划');
  await page.locator('#goal-acceptance').fill('满足验收标准');
  await page.getByRole('button', { name: '保存目标' }).click();
  await page.locator('#goal-dialog').waitFor({ state: 'hidden' });
  await page.getByText('<img src=x onerror=alert(1)> 新的计划目标', { exact: true }).waitFor();
  assert.equal(await page.locator('#goals img').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await mkdir('.preflight/screenshots', { recursive: true });
  await page.screenshot({ path: '.preflight/screenshots/board-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile board overflows horizontally');
  await page.screenshot({ path: '.preflight/screenshots/board-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.locator('#login-panel').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log('✓ Real Chromium: human observation, two-Agent consensus, deferred isolation, goal gaps, Findings scopes/source/confidence/empty state/refresh, XSS escaping, private session, mobile layout and logout');
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await connection.db.transaction(async db => {
    const decisionIds = (await db.select({ id: t.decisions.id }).from(t.decisions).where(eq(t.decisions.repo, repo))).map(r => r.id);
    const changeIds = (await db.select({ id: t.changes.id }).from(t.changes).where(eq(t.changes.repo, repo))).map(r => r.id);
    await db.execute(sql`DELETE FROM decision_reviews WHERE repo = ${repo}`);
    if (decisionIds.length) await db.delete(t.decisionImpacts).where(inArray(t.decisionImpacts.decision_id, decisionIds));
    if (changeIds.length) await db.delete(t.changeSessions).where(inArray(t.changeSessions.change_id, changeIds));
    for (const table of [t.findings, t.feedback, t.decisions, t.changes, t.sessions, t.goals, t.events, t.mutations]) await db.delete(table).where(eq(table.repo, repo));
  });
  await connection.client.end();
}
