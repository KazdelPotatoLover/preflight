import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

if (existsSync('.env') || existsSync('.preflight/auth.json')) {
  console.error('Existing configuration found. Keep it or move it aside before initializing.');
  process.exit(1);
}
const secret = () => randomBytes(32).toString('hex');
const password = secret();
const repo = process.argv[2] ?? 'KazdelPotatoLover/preflight';
const clients = [
  { member: 'kazdelpotatolover', role: 'human', token: secret() },
  { member: 'alice', role: 'agent', token: secret() },
  { member: 'bob', role: 'agent', token: secret() },
];
mkdirSync('.preflight', { recursive: true, mode: 0o700 });
writeFileSync('.preflight/auth.json', JSON.stringify(clients.map(({ token, ...actor }) => ({
  ...actor, repo, token_hash: createHash('sha256').update(token).digest('hex'),
  expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
})), null, 2), { mode: 0o600 });
writeFileSync('.preflight/client-tokens.json', JSON.stringify({ repo, clients }, null, 2), { mode: 0o600 });
writeFileSync('.env', `DATABASE_URL=postgres://preflight:${password}@127.0.0.1:55432/preflight\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_PORT=55432\nPREFLIGHT_PORT=3000\nPREFLIGHT_HOST=127.0.0.1\nPREFLIGHT_AUTH_FILE=.preflight/auth.json\nPREFLIGHT_ALLOWED_HOSTS=127.0.0.1,localhost\n`, { mode: 0o600 });
console.log('Created .env and .preflight/auth.json. Client tokens are in .preflight/client-tokens.json.');
console.log('Next: docker compose up -d --wait, npm run db:migrate, npm run dev.');
