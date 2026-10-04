import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
export async function migrate(url: string) {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(48291900)`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      const rows = await tx`SELECT version FROM schema_migrations WHERE version = 1`;
      if (rows.length === 0) {
        await tx.unsafe(readFileSync(resolve('migrations/001_initial.sql'), 'utf8'));
        await tx`INSERT INTO schema_migrations(version) VALUES (1)`;
      }
    });
  } finally { await client.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await migrate(process.env.DATABASE_URL);
  console.log('Database migration complete.');
}
