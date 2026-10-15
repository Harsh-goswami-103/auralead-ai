/**
 * ADR-26 / plan §4 / A32: withRoute() is the one pipeline for route handlers: size cap, auth,
 * rate limit, CSRF (Origin + signed token) on cookie mutations, Zod, context, then one error
 * mapping that never leaks internals and always carries the correlation id.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createSession } from '@/server/auth/session';
import { DbBusyError } from '@/server/db/tx';
import { TenantScopeError } from '@/server/db/scoped';
import { csrfTokenFor } from '@/server/security/csrf';
import { withRoute } from '@/app/api/_lib/with-route';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, NOW, ORIGIN, seedIdentities, testConfig, uninstallRuntime, useRuntime, type Identity } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
const config = testConfig('live');
const clock = new FixedClock(NOW);
const p = { params: Promise.resolve({}) };

beforeAll(async () => {
  testDb = await createTestDb({ label: 'with-route' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

async function owner(role: 'USER' | 'SUPER_ADMIN' = 'USER') {
  const userId = role === 'USER' ? ids.ownerId : ids.adminId;
  const { token, session } = await createSession(db, { userId, globalRole: role, mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'v', now: clock.now() });
  return { cookie: `__Host-aura_session=${token}`, csrf: csrfTokenFor(config.secrets.sessionSecret!, session.id) };
}

const echo = withRoute({ auth: 'session', body: z.object({ n: z.number().int() }) }, async ({ body }) => ({ n: body.n }));

describe('CSRF on cookie mutations', () => {
  it('passes with Origin = APP_ORIGIN and the signed token', async () => {
    useRuntime(db, config, clock);
    const s = await owner();
    const res = await echo(makeRequest('/api/app/echo', { body: { n: 1 }, cookie: s.cookie, csrf: s.csrf }), p);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 1 });
  });

  it('403 for a cross-origin POST with a valid cookie and token', async () => {
    useRuntime(db, config, clock);
    const s = await owner();
    const res = await echo(makeRequest('/api/app/echo', { body: { n: 1 }, cookie: s.cookie, csrf: s.csrf, origin: 'https://evil.example' }), p);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_FAILED');
  });

  it('403 for a missing Origin, a missing token, or a token minted for another session', async () => {
    useRuntime(db, config, clock);
    const s = await owner();
    const other = await owner();
    for (const req of [
      makeRequest('/api/app/echo', { body: { n: 1 }, cookie: s.cookie, csrf: s.csrf, origin: null }),
      makeRequest('/api/app/echo', { body: { n: 1 }, cookie: s.cookie }),
      makeRequest('/api/app/echo', { body: { n: 1 }, cookie: s.cookie, csrf: other.csrf }),
    ]) {
      expect((await echo(req, p)).status).toBe(403);
    }
  });

  it('GET needs no CSRF token', async () => {
    useRuntime(db, config, clock);
    const s = await owner();
    const get = withRoute({ auth: 'session' }, async ({ ctx }) => ({ user: ctx.actor?.userId }));
    expect((await get(makeRequest('/api/app/me', { cookie: s.cookie }), p)).status).toBe(200);
  });
});

describe('pipeline order and error mapping', () => {
  it('401 without a session, before reading the body schema', async () => {
    useRuntime(db, config, clock);
    const res = await echo(makeRequest('/api/app/echo', { body: { n: 'not a number' } }), p);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('413 for a body over the cap, before auth', async () => {
    useRuntime(db, config, clock);
    const small = withRoute({ auth: 'session', maxBodyBytes: 16, body: z.object({}) }, async () => ({ ok: true }));
    const res = await small(makeRequest('/api/app/x', { rawBody: JSON.stringify({ padding: 'x'.repeat(100) }) }), p);
    expect(res.status).toBe(413);
  });

  it('400 for invalid JSON and for a Zod failure, with field paths but no values', async () => {
    useRuntime(db, config, clock);
    const s = await owner();
    const bad = await echo(makeRequest('/api/app/echo', { rawBody: '{nope', cookie: s.cookie, csrf: s.csrf }), p);
    expect(bad.status).toBe(400);
    const zod = await echo(makeRequest('/api/app/echo', { body: { n: 'secret-ish value' }, cookie: s.cookie, csrf: s.csrf }), p);
    expect(zod.status).toBe(400);
    const body = (await zod.json()) as { code: string; details: { issues: Array<{ path: string }> } };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.issues[0]!.path).toBe('n');
    expect(JSON.stringify(body)).not.toContain('secret-ish value');
  });

  it('echoes a well-formed x-request-id and uses it as the error reference', async () => {
    useRuntime(db, config, clock);
    const res = await echo(makeRequest('/api/app/echo', { body: { n: 1 }, headers: { 'x-request-id': 'req_client_supplied_1' } }), p);
    expect(res.headers.get('x-request-id')).toBe('req_client_supplied_1');
    expect(((await res.json()) as { reference: string }).reference).toBe('req_client_supplied_1');
    const bad = await echo(makeRequest('/api/app/echo', { body: { n: 1 }, headers: { 'x-request-id': 'bad id <script>' } }), p);
    expect(bad.headers.get('x-request-id')).toMatch(/^req_[A-Za-z0-9_-]{22}$/);
  });

  it('maps unknown errors to a generic 500 without the message, and DB-layer errors to their statuses', async () => {
    useRuntime(db, config, clock);
    const s = await owner();
    const throwing = (err: unknown) => withRoute({ auth: 'session' }, async () => {
      throw err;
    });
    const boom = await throwing(new Error('database path C:\\secret\\app.db exploded'))(makeRequest('/x', { cookie: s.cookie }), p);
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('exploded');
    expect((await throwing(new DbBusyError(3, new Error('busy')))(makeRequest('/x', { cookie: s.cookie }), p)).status).toBe(503);
    expect((await throwing(new TenantScopeError('FOREIGN_REFERENCE', 'x', ['leadId']))(makeRequest('/x', { cookie: s.cookie }), p)).status).toBe(404);
  });

  it('every response is no-store', async () => {
    useRuntime(db, config, clock);
    const res = await echo(makeRequest('/api/app/echo', { body: { n: 1 } }), p);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('route options', () => {
  it('roles: a USER on a SUPER_ADMIN route gets 404', async () => {
    useRuntime(db, config, clock);
    const adminOnly = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'] }, async () => ({ ok: true }));
    expect((await adminOnly(makeRequest('/x', { cookie: (await owner()).cookie }), p)).status).toBe(404);
    expect((await adminOnly(makeRequest('/x', { cookie: (await owner('SUPER_ADMIN')).cookie }), p)).status).toBe(200);
  });

  it('reauth: requires a password re-entry within 15 minutes', async () => {
    useRuntime(db, config, clock);
    const guarded = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], reauth: true }, async () => ({ ok: true }));
    const res = await guarded(makeRequest('/x', { cookie: (await owner('SUPER_ADMIN')).cookie }), p);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('REAUTH_REQUIRED');
  });

  it('demoOnly: 404 in LIVE before anything else', async () => {
    useRuntime(db, config, clock);
    const demo = withRoute({ auth: 'none', demoOnly: true }, async () => ({ ok: true }));
    expect((await demo(makeRequest('/api/demo/x', { origin: ORIGIN }), p)).status).toBe(404);
    uninstallRuntime();
    useRuntime(db, testConfig('demo'), clock);
    expect((await demo(makeRequest('/api/demo/x', { origin: ORIGIN }), p)).status).toBe(200);
  });

  it('rate limit: per-key buckets with Retry-After', async () => {
    useRuntime(db, testConfig('live', { TRUSTED_PROXY_HOPS: '1' }), clock);
    const limited = withRoute(
      { auth: 'none', rateLimit: [{ policy: 'aiDraft', key: ({ ip }) => `ip:${ip}` }] },
      async () => ({ ok: true }),
    );
    const hit = (ip: string) => limited(makeRequest('/x', { headers: { 'x-forwarded-for': ip } }), p);
    for (let i = 0; i < 30; i += 1) expect((await hit('10.9.0.1')).status).toBe(200);
    const denied = await hit('10.9.0.1');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('2');
    expect((await hit('10.9.0.2')).status).toBe(200);
  });
});
