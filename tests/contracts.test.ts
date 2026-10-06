import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { authenticate } from '../src/config.js';
import { canonical, redact, schemas } from '../src/domain/contracts.js';
import { relatedWork } from '../src/domain/related.js';
import type { Change } from '../src/db/schema.js';
function change(id: string, title: string, scope: string[], fingerprints: string[] = []): Change {
  return { id, title, likely_scope: scope, error_fingerprints: fingerprints, repo: 'test/repo', goal_id: randomUUID(), created_by: 'alice',
    status: 'implementing', version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), summary: title,
    branch: null, verification: null, pr_url: null };
}
describe('collaboration boundaries', () => {
  it('discovers distinct same-goal work without shared titles or paths and excludes other repositories', () => {
    const current = change('a', 'backend database', ['src/domain/service.ts']);
    const sibling = { ...change('b', '页面呈现', ['public/app.js']), goal_id: current.goal_id };
    const results = relatedWork(current, [sibling, { ...sibling, id: 'foreign', repo: 'another/repo' }]);
    expect(results).toHaveLength(1);
    expect(results[0]?.change_id).toBe('b');
    expect(results[0]?.relation).toBe('related_to');
    expect(results[0]?.evidence).toContainEqual({ kind: 'same_goal', source: 'agent_explicit', value: current.goal_id });
    expect(results[0]?.blocking).toBe(false);
  });
  it('does not identify similar titles as the same work or lock an agent', () => {
    const result = relatedWork(change('a', 'improve login retry', []), [change('b', 'improve login logging', [])]);
    expect(result[0]?.relation).toBe('related_to');
    expect(result[0]?.blocking).toBe(false);
    expect(result[0]?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'title_token_overlap' })]));
  });
  it('provides a duplicate candidate, not identity, for matching declared evidence', () => {
    const results = relatedWork(change('a', '修复登录超时', ['auth.ts'], ['db-timeout']), [
      change('b', '调查登录超时', ['auth.ts'], ['db-timeout']),
      { ...change('c', '修复登录超时', ['auth.ts']), status: 'completed' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.relation).toBe('possible_duplicate');
    expect(results[0]?.evidence.some(e => e.kind === 'shared_declared_scope')).toBe(true);
  });
  it('redacts credentials recursively while retaining useful findings', () => {
    const input = { nested: ['DB timeout; api_key=secret-value', 'Bearer abc.def.xyz', 'ghp_' + 'A'.repeat(36), '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----'] };
    const output = JSON.stringify(redact(input));
    expect(output).toContain('DB timeout');
    for (const secret of ['secret-value', 'abc.def.xyz', 'A'.repeat(36), '\\nprivate']) expect(output).not.toContain(secret);
  });
  it('rejects unknown source-of-truth fields and unsafe scopes', () => {
    const input = { request_id: randomUUID(), goal_id: randomUUID(), title: 'Fix', agent_type: 'test' };
    expect(schemas.preflight_start_work.safeParse({ ...input, actual_scope: ['auth.ts'] }).success).toBe(false);
    for (const path of ['../secret', '/etc/passwd', '.env', 'src/.env.local', 'key.pem'])
      expect(schemas.preflight_start_work.safeParse({ ...input, likely_scope: [path] }).success).toBe(false);
  });
  it('uses stable canonical input hashing regardless of key order', () => {
    expect(canonical({ b: 1, a: { y: 2, x: 3 } })).toBe(canonical({ a: { x: 3, y: 2 }, b: 1 }));
    expect(canonical({ values: [1, 2] })).not.toBe(canonical({ values: [2, 1] }));
  });
  it('requires explicit accept options and all three review evidence summaries', () => {
    const input = { request_id: randomUUID(), change_id: randomUUID(), session_id: randomUUID(), decision_id: randomUUID(),
      expected_version: 1, stance: 'accept', option_id: randomUUID(), rationale: 'Reviewed against the goal',
      evidence: { goal_alignment: 'Matches goal', constraints_check: 'Checked boundaries', verification: 'Actual tests passed' } };
    expect(schemas.preflight_review_decision.safeParse(input).success).toBe(true);
    expect(schemas.preflight_review_decision.safeParse({ ...input, option_id: undefined }).success).toBe(false);
    expect(schemas.preflight_review_decision.safeParse({ ...input, stance: 'object', option_id: undefined }).success).toBe(true);
    for (const key of ['goal_alignment', 'constraints_check', 'verification']) {
      expect(schemas.preflight_review_decision.safeParse({ ...input, evidence: { ...input.evidence, [key]: '  ' } }).success).toBe(false);
    }
    expect(schemas.preflight_review_decision.safeParse({ ...input, vote_for_member: 'bob' }).success).toBe(false);
  });
  it('defaults engineering proposals to within-goal coordination and validates isolation evidence', () => {
    const proposal = { request_id: randomUUID(), change_id: randomUUID(), session_id: randomUUID(), question: 'Choose an approach', context: 'Within existing requirements',
      category: 'product_behavior', urgency: 'blocking', options: [{ label: 'A', description: 'First approach' }, { label: 'B', description: 'Second approach' }] };
    expect(schemas.preflight_propose_decision.parse(proposal).authority).toBe('within_goal');
    expect(schemas.preflight_propose_decision.safeParse({ ...proposal, authority: 'human_required' }).success).toBe(false);
    const progress = { request_id: randomUUID(), change_id: randomUUID(), session_id: randomUUID(), expected_version: 1, status: 'completed', summary: 'Finished',
      verification: { head_sha: 'a'.repeat(40), command: 'npm test', result: 'passed', criteria: [{ index: 0, passed: true, evidence: 'Actual evidence' }],
        isolated_decisions: [{ decision_id: randomUUID(), mitigation: 'Limit disputed scope', evidence: 'Boundary test passed' }] } };
    expect(schemas.preflight_report_progress.safeParse(progress).success).toBe(true);
    expect(schemas.preflight_report_progress.safeParse({ ...progress, verification: { ...progress.verification, isolated_decisions: [{ ...progress.verification.isolated_decisions[0], mitigation: '' }] } }).success).toBe(false);
  });
  it('rejects expired or mismatched tokens', () => {
    const token = 'private-test-token';
    const credential = { member: 'alice', role: 'agent' as const, repo: 'test/repo', token_hash: createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + 100000).toISOString() };
    expect(authenticate(token, [credential])?.member).toBe('alice');
    expect(authenticate('wrong', [credential])).toBeUndefined();
    expect(authenticate(token, [{ ...credential, expires_at: new Date(0).toISOString() }])).toBeUndefined();
  });
});
