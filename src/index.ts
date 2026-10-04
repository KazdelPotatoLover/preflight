import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadCredentials } from './config.js';
import { connectDatabase } from './db/client.js';
import { CollaborationService } from './domain/service.js';
if (!process.env.DATABASE_URL || !process.env.PREFLIGHT_AUTH_FILE) throw new Error('Run npm run setup and configure .env first');
const authFile = process.env.PREFLIGHT_AUTH_FILE;
loadCredentials(authFile);
const connection = connectDatabase(process.env.DATABASE_URL);
const port = Number(process.env.PREFLIGHT_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PREFLIGHT_PORT');
const hostname = process.env.PREFLIGHT_HOST ?? '127.0.0.1';
const app = createApp({ service: new CollaborationService(connection.db), credentials: () => loadCredentials(authFile),
  allowedHosts: (process.env.PREFLIGHT_ALLOWED_HOSTS ?? '127.0.0.1,localhost').split(',').map(h => h.trim()),
  secureCookies: process.env.PREFLIGHT_SECURE_COOKIES === 'true',
});
const server = serve({ fetch: app.fetch, port, hostname }, () => console.log(`Preflight board: http://${hostname}:${port} · MCP: /mcp`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 10000).unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await connection.client.end({ timeout: 5 });
  clearTimeout(timer);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
