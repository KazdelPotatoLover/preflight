import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { authenticate, type Credential } from './config.js';
import { DomainError, schemas, type Actor, type Action } from './domain/contracts.js';
import type { CollaborationService } from './domain/service.js';
import { handleMcp } from './mcp/server.js';
export type AppOptions = { service: CollaborationService; credentials: () => Credential[]; allowedHosts?: string[]; secureCookies?: boolean };
type AppEnvironment = { Variables: { actor: Actor; requestId: string } };
export function createApp(options: AppOptions) {
  const app = new Hono<AppEnvironment>();
  const loginSessions = new Map<string, { token: string; expires: number }>();
  const cookieName = 'preflight_session';
  const allowedHosts = options.allowedHosts ?? ['localhost', '127.0.0.1'];
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    c.header('Cache-Control', 'no-store');
    const url = new URL(c.req.url);
    if (!allowedHosts.includes(url.hostname)) throw new DomainError('FORBIDDEN', 'Host is not allowed', 403);
    const origin = c.req.header('origin');
    if (origin && origin !== url.origin) throw new DomainError('FORBIDDEN', 'Cross-origin requests are not allowed', 403);
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Maximum body size is 256 KiB' } }, 413) }));
  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json({ error: { code: error.code, message: error.message }, meta: { request_id: c.get('requestId') } }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Input does not match the contract' }, meta: { request_id: c.get('requestId') } }, 400);
    console.error(JSON.stringify({ level: 'error', request_id: c.get('requestId'), error_type: error.name }));
    return c.json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Service unavailable; retry later' }, meta: { request_id: c.get('requestId') } }, 503);
  });
  app.get('/health', c => c.json({ status: 'ok', version: '0.1.0' }));
  app.get('/', c => c.html(readFileSync(resolve('public/index.html'), 'utf8')));
  app.get('/app.js', c => { c.header('Content-Type', 'application/javascript'); return c.body(readFileSync(resolve('public/app.js'), 'utf8')); });
  app.get('/style.css', c => { c.header('Content-Type', 'text/css'); return c.body(readFileSync(resolve('public/style.css'), 'utf8')); });
  app.post('/auth/login', async c => {
    const { token } = z.object({ token: z.string().max(1024) }).strict().parse(await c.req.json());
    const actor = typeof token === 'string' ? authenticate(token, options.credentials()) : undefined;
    if (!actor || actor.role !== 'human') throw new DomainError('UNAUTHORIZED', 'Use an unexpired human board token', 401);
    for (const [key, session] of loginSessions) if (session.expires <= Date.now()) loginSessions.delete(key);
    if (loginSessions.size >= 500) throw new DomainError('UPSTREAM_UNAVAILABLE', 'Too many board sessions', 503);
    const key = randomBytes(32).toString('hex');
    loginSessions.set(key, { token: token as string, expires: Date.now() + 8 * 3600000 });
    setCookie(c, cookieName, key, { httpOnly: true, sameSite: 'Strict', secure: options.secureCookies ?? false, path: '/', maxAge: 8 * 3600 });
    return c.json({ data: actor });
  });
  app.post('/auth/logout', c => {
    const cookie = getCookie(c, cookieName);
    if (cookie) loginSessions.delete(cookie);
    deleteCookie(c, cookieName, { path: '/' });
    return c.json({ data: { logged_out: true } });
  });
  const authenticateRequest: MiddlewareHandler<AppEnvironment> = async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    const cookie = getCookie(c, cookieName);
    const session = cookie ? loginSessions.get(cookie) : undefined;
    const token = bearer ?? (session && session.expires > Date.now() ? session.token : '');
    const actor = authenticate(token, options.credentials());
    if (!actor) throw new DomainError('UNAUTHORIZED', 'Missing, expired or revoked credential', 401);
    c.set('actor', actor);
    await next();
  };
  app.use('/api/*', authenticateRequest);
  app.use('/mcp', authenticateRequest);
  app.get('/api/v1/atlas', async c => c.json({ data: await options.service.project(c.get('actor')), meta: { request_id: c.get('requestId') } }));
  app.get('/api/v1/context', async c => c.json({ data: await options.service.execute(c.get('actor'), 'preflight_get_context', c.req.query()), meta: { request_id: c.get('requestId') } }));
  app.post('/api/v1/tools/:action', async c => {
    const action = c.req.param('action');
    if (!Object.hasOwn(schemas, action) || action === 'resolve_decision') throw new DomainError('NOT_FOUND', 'Tool not found', 404);
    const body = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const key = c.req.header('Idempotency-Key');
    if (key && body.request_id && key !== body.request_id) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Header and body request IDs disagree', 409);
    const input = key ? { ...body, request_id: key } : body;
    const data = await options.service.execute(c.get('actor'), action as Action, input);
    return c.json({ data, meta: { request_id: c.get('requestId') } });
  });
  app.post('/api/v1/decisions/:id/resolve', async c => {
    const body = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const key = c.req.header('Idempotency-Key');
    if (key && body.request_id && key !== body.request_id) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Header and body request IDs disagree', 409);
    const data = await options.service.execute(c.get('actor'), 'resolve_decision', { ...body, request_id: key ?? body.request_id, decision_id: c.req.param('id') });
    return c.json({ data, meta: { request_id: c.get('requestId') } });
  });
  app.post('/mcp', async c => handleMcp(c.req.raw, c.get('actor'), options.service));
  app.on(['GET', 'DELETE'], '/mcp', c => { c.header('Allow', 'POST'); return c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Stateless MCP supports POST only' } }, 405); });
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route was not found' } }, 404));
  return app;
}
