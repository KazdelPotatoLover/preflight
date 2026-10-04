import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Actor } from './domain/contracts.js';
export const credentialSchema = z.object({
  member: z.string().min(1).max(100), role: z.enum(['human', 'agent']), repo: z.string().min(1).max(200),
  token_hash: z.string().regex(/^[a-f0-9]{64}$/), expires_at: z.iso.datetime(),
});
export type Credential = z.infer<typeof credentialSchema>;
export function loadCredentials(path: string): Credential[] {
  return z.array(credentialSchema).min(1).parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function authenticate(token: string, credentials: Credential[]): Actor | undefined {
  if (!token || token.length > 1024) return undefined;
  const hash = createHash('sha256').update(token).digest();
  const match = credentials.find(c => Date.parse(c.expires_at) > Date.now() && timingSafeEqual(hash, Buffer.from(c.token_hash, 'hex')));
  return match ? { member: match.member, repo: match.repo, role: match.role } : undefined;
}
