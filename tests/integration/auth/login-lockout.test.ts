/**
 * C6 / ADR-12: login lockout is the one persisted counter. Five failures lock the account for
 * 15 minutes; the lock survives a fresh Prisma client (a process restart), a locked account
 * rejects even the right password with the same generic error, and success resets the counter.
 * The in-process rate limiter (5/min per IP and per email) is a separate, non-persisted layer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { authenticate, LOGIN_LOCKOUT } from '@/server/auth/login';
import { hashPassword } from '@/server/auth/password';
import { POST as loginPOST } from '@/app/api/app/auth/login/route';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, noParams, NOW, PASSWORD, testConfig, uninstallRuntime, useRuntime } from './support';

let testDb: TestDb;
const t0 = new Date(NOW);

beforeAll(async () => {
  testDb = await createTestDb({ label: 'auth-lockout' });
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

async function makeUser(db: PrismaClient, email: string) {
  return db.user.create({ data: { email, name: 'L', globalRole: 'USER', passwordHash: await hashPassword(PASSWORD) } });
}

describe('persisted lockout', () => {
  it('locks after 5 failures, and the lock survives a fresh client', async () => {
    expect(LOGIN_LOCKOUT).toEqual({ threshold: 5, durationMs: 15 * 60_000 });
    const first = testDb.client();
    const user = await makeUser(first, 'lock@alpha.test');
    for (let i = 0; i < 5; i += 1) {
      const r = await authenticate(first, { email: 'LOCK@alpha.test', password: 'wrong password!' }, { now: new Date(t0.getTime() + i), mode: 'LIVE' });
      expect(r.ok).toBe(false);
    }
    await first.$disconnect();

    // A brand-new client, as after a restart: the state comes from the DB, not memory.
    const second = testDb.client();
    const row = await second.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(5);
    expect(row.lockedUntil?.toISOString()).toBe(new Date(t0.getTime() + 4 + LOGIN_LOCKOUT.durationMs).toISOString());

    const during = await authenticate(second, { email: 'lock@alpha.test', password: PASSWORD }, { now: new Date(t0.getTime() + 60_000), mode: 'LIVE' });
    expect(during).toEqual({ ok: false });
    const unchanged = await second.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(unchanged.lockedUntil?.toISOString()).toBe(row.lockedUntil?.toISOString());

    const after = await authenticate(second, { email: 'lock@alpha.test', password: PASSWORD }, { now: new Date(row.lockedUntil!.getTime() + 1), mode: 'LIVE' });
    expect(after.ok).toBe(true);
    const reset = await second.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reset.failedLoginCount).toBe(0);
    expect(reset.lockedUntil).toBeNull();
    expect(reset.lastLoginAt?.toISOString()).toBe(new Date(row.lockedUntil!.getTime() + 1).toISOString());
  });

  it('after a lock expires, counting starts again from one', async () => {
    const db = testDb.client();
    const user = await makeUser(db, 'relock@alpha.test');
    for (let i = 0; i < 5; i += 1) await authenticate(db, { email: 'relock@alpha.test', password: 'bad bad bad bad' }, { now: t0, mode: 'LIVE' });
    const later = new Date(t0.getTime() + LOGIN_LOCKOUT.durationMs + 1);
    await authenticate(db, { email: 'relock@alpha.test', password: 'bad bad bad bad' }, { now: later, mode: 'LIVE' });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });

  it('a locked account answers with the same generic 401 as a wrong password', async () => {
    const db = testDb.client();
    await makeUser(db, 'route-lock@alpha.test');
    // Each attempt from a different client IP so the in-process limiter is not what stops us.
    const clock = new FixedClock(NOW);
    useRuntime(db, testConfig('live', { TRUSTED_PROXY_HOPS: '1' }), clock);
    const attempt = async (password: string, ip: string) =>
      loginPOST(makeRequest('/api/app/auth/login', { body: { email: 'route-lock@alpha.test', password }, headers: { 'x-forwarded-for': ip } }), noParams);
    const wrong = await attempt('wrong wrong wrong', '10.0.0.1');
    for (let i = 2; i <= 5; i += 1) {
      clock.advance(61_000);
      await attempt('wrong wrong wrong', `10.0.0.${i}`);
    }
    clock.advance(61_000);
    const locked = await attempt(PASSWORD, '10.0.0.9');
    expect(locked.status).toBe(401);
    const a = (await wrong.json()) as { code: string; message: string };
    const b = (await locked.json()) as { code: string; message: string };
    expect({ code: b.code, message: b.message }).toEqual({ code: a.code, message: a.message });
  });
});

describe('in-process rate limit', () => {
  it('the sixth login attempt for one email within a minute gets 429 with Retry-After', async () => {
    const db = testDb.client();
    await makeUser(db, 'burst@alpha.test');
    useRuntime(db, testConfig('live', { TRUSTED_PROXY_HOPS: '1' }));
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await loginPOST(
        makeRequest('/api/app/auth/login', { body: { email: 'burst@alpha.test', password: 'wrong wrong wrong' }, headers: { 'x-forwarded-for': `10.1.0.${i}` } }),
        noParams,
      );
      statuses.push(last.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
    // The rate-limited attempt never reached the password check, so it did not count.
    const row = await db.user.findUniqueOrThrow({ where: { email: 'burst@alpha.test' } });
    expect(row.failedLoginCount).toBe(5);
  });

  it('limits per IP across different emails', async () => {
    const db = testDb.client();
    useRuntime(db, testConfig('live', { TRUSTED_PROXY_HOPS: '1' }));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await loginPOST(
        makeRequest('/api/app/auth/login', { body: { email: `spray${i}@alpha.test`, password: 'wrong wrong wrong' }, headers: { 'x-forwarded-for': '10.2.0.1' } }),
        noParams,
      );
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
  });
});
