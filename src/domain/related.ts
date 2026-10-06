import type { Change } from '../db/schema.js';
export function titleTokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const words: string[] = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i + 1 < segment.length; i++) words.push(segment.slice(i, i + 2));
  }
  return new Set(words);
}
export function relatedWork(current: Change, candidates: Change[]) {
  return candidates.filter(c => c.repo === current.repo && c.id !== current.id && !['completed', 'abandoned'].includes(c.status)).map(other => {
    const sameGoal = current.goal_id === other.goal_id;
    const sharedFiles = current.likely_scope.filter(p => other.likely_scope.includes(p));
    const fingerprints = current.error_fingerprints.filter(p => other.error_fingerprints.includes(p));
    const a = titleTokens(current.title), b = titleTokens(other.title);
    const intersection = [...a].filter(t => b.has(t)).length;
    const similarity = intersection / (new Set([...a, ...b]).size || 1);
    const evidence = [
      ...(sameGoal ? [{ kind: 'same_goal', source: 'agent_explicit', value: current.goal_id }] : []),
      ...sharedFiles.map(value => ({ kind: 'shared_declared_scope', source: 'agent_explicit', value })),
      ...fingerprints.map(value => ({ kind: 'same_error_fingerprint', source: 'agent_explicit', value })),
      ...(similarity >= 0.25 ? [{ kind: 'title_token_overlap', source: 'rules', value: similarity.toFixed(2) }] : []),
    ];
    const score = Math.min(0.95, similarity * 0.35 + (sameGoal ? 0.2 : 0) + (sharedFiles.length ? 0.35 : 0) + (fingerprints.length ? 0.5 : 0));
    return { change_id: other.id, title: other.title, member: other.created_by,
      relation: fingerprints.length && sharedFiles.length ? 'possible_duplicate' : 'related_to',
      confidence: Number(score.toFixed(2)), evidence,
      declared_scope_overlap: sharedFiles, blocking: false,
    };
  }).filter(r => r.evidence.length > 0).sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}
