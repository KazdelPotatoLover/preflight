import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
export async function migrate(url: string, searchPath?: string) {
  const client = postgres(url, { max: 1, onnotice: () => {}, ...(searchPath ? { connection: { search_path: searchPath } } : {}) });
  try {
    await client.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(48291900)`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      const rows = await tx`SELECT version FROM schema_migrations`;
      const applied = new Set(rows.map(row => Number(row.version)));
      const files = readdirSync(resolve('migrations')).filter(file => /^\d+_.+\.sql$/.test(file))
        .map(file => ({ file, version: Number(file.split('_')[0]) })).sort((a, b) => a.version - b.version);
      if (new Set(files.map(file => file.version)).size !== files.length) throw new Error('Duplicate migration version');
      for (const { file, version } of files) if (!applied.has(version)) {
        await tx.unsafe(readFileSync(resolve('migrations', file), 'utf8'));
        await tx`INSERT INTO schema_migrations(version) VALUES (${version})`;
      }
    });
  } finally { await client.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await migrate(process.env.DATABASE_URL);
  console.log('Database migration complete.');
}
