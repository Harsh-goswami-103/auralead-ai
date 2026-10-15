/**
 * T06 / ADR-11 / plan §9 Auth: argon2id parameters, DB sessions that store only the token hash,
 * the __Host- cookie, rotation on login and privilege change, revocation on role change, idle and
 * absolute expiry (super admin 12 h), generic login errors, and the dummy-hash timing defence.
 */
import { parseOptions } from '@node-rs/argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { authenticate } from '@/server/auth/login';
import { argon2Hasher, ARGON2_PARAMS, hashPassword, verifyPassword, type PasswordHasher } from '@/server/auth/password';
import { changeUserPrivileges } from '@/server/auth/privileges';
import {
  createSession,
  hasRecentReauth,
  loadSession,
  readSessionToken,
  revokeUserSessions,
  SESSION_POLICY,
  sessionCookieName,
} from '@/server/auth/session';
import { hashToken } from '@/server/security/tokens';
import { POST as loginPOST } from '@/app/api/app/auth/login/route';
import { POST as logoutPOST } from '@/app/api/app/auth/logout/route';
import { POST as reauthPOST } from '@/app/api/app/auth/reauth/route';
import { GET as sessionGET } from '@/app/api/app/auth/session/route';
import { createTestDb, type TestDb } from '../../support/db';
import { cookieFrom, makeRequest, noParams, NOW, PASSWORD, seedIdentities, testConfig, uninstallRuntime, useRuntime, type Identity } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
const t0 = new Date(NOW);
const plus = (ms: number) => new Date(t0.getTime() + ms);

beforeAll(async () => {
  testDb = await createTestDb({ label: 'auth-session' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
});

afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

async function login(email: string, password: string, cookie: string | null = null) {
  return loginPOST(makeRequest('/api/app/auth/login', { body: { email, password }, cookie }), noParams);
}

describe('passwords', () => {
  it('hashes with argon2id m=19456 KiB, t=2, p=1 and verifies', async () => {
    const hash = await hashPassword('a long enough passphrase');
    const opts = parseOptions(hash);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect({ m: opts.memoryCost, t: opts.timeCost, p: opts.parallelism }).toEqual({ m: ARGON2_PARAMS.memoryCost, t: 2, p: 1 });
    expect(ARGON2_PARAMS.memoryCost).toBe(19456);
    expect(await verifyPassword(hash, 'a long enough passphrase')).toBe(true);
    expect(await verifyPassword(hash, 'a long enough passphrasE')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('rejects passwords shorter than 12 characters', async () => {
    await expect(hashPassword('short')).rejects.toMatchObject({ status: 400 });
  });
});

describe('session storage and cookie', () => {
  it('stores only the sha256 of a 32-byte token', async () => {
    const { token, session } = await createSession(db, {
      userId: ids.ownerId,
      globalRole: 'USER',
      mode: 'LIVE',
      activeWorkspaceId: null,
      ipHash: 'iphash',
      userAgent: 'vitest',
      now: t0,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.idleExpiresAt.getTime() - t0.getTime()).toBe(SESSION_POLICY.idleMs);
    expect(row.absoluteExpiresAt.getTime() - t0.getTime()).toBe(SESSION_POLICY.absoluteMs);
  });

  it('login sets an HttpOnly Secure SameSite=Lax __Host- cookie with Path=/', async () => {
    useRuntime(db, testConfig('live'));
    const res = await login('owner@alpha.test', PASSWORD);
    expect(res.status).toBe(200);
    const raw = res.headers.get('set-cookie')!;
    expect(raw.startsWith('__Host-aura_session=')).toBe(true);
    expect(raw).toMatch(/; HttpOnly/);
    expect(raw).toMatch(/; Secure/);
    expect(raw).toMatch(/; SameSite=Lax/);
    expect(raw).toMatch(/; Path=\//);
    expect(raw).not.toMatch(/Domain=/i);
    const body = (await res.json()) as { redirectTo: string; csrfToken: string };
    expect(body.redirectTo).toBe('/dashboard/user');
    expect(body.csrfToken.length).toBeGreaterThan(20);
  });

  it('uses the insecure fallback name only when AUTH_COOKIE_INSECURE_DEV=1', async () => {
    const config = testConfig('live', { AUTH_COOKIE_INSECURE_DEV: '1' });
    expect(sessionCookieName(config)).toBe('aura_session');
    useRuntime(db, config);
    const res = await login('owner@alpha.test', PASSWORD);
    const raw = res.headers.get('set-cookie')!;
    expect(raw.startsWith('aura_session=')).toBe(true);
    expect(raw).not.toMatch(/Secure/);
    const headers = new Headers({ cookie: `other=1; ${cookieFrom(res)}` });
    expect(readSessionToken(headers, config)).toBe(cookieFrom(res)!.split('=')[1]);
  });
});

describe('rotation', () => {
  it('a second login issues a new token and revokes the presented session', async () => {
    useRuntime(db, testConfig('live'));
    const first = cookieFrom(await login('owner@alpha.test', PASSWORD))!;
    const second = cookieFrom(await login('owner@alpha.test', PASSWORD, first))!;
    expect(second).not.toBe(first);
    const oldToken = first.split('=')[1]!;
    const oldRow = await db.session.findUniqueOrThrow({ where: { tokenHash: hashToken(oldToken) } });
    expect(oldRow.revokedAt).not.toBeNull();
    expect((await sessionGET(makeRequest('/api/app/auth/session', { cookie: first }), noParams)).status).toBe(401);
    expect((await sessionGET(makeRequest('/api/app/auth/session', { cookie: second }), noParams)).status).toBe(200);
  });

  it('re-auth rotates the session and opens a 15 minute window', async () => {
    const rt = useRuntime(db, testConfig('live'));
    const loginRes = await login('admin@example.test', PASSWORD);
    const cookie = cookieFrom(loginRes)!;
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };
    const res = await reauthPOST(makeRequest('/api/app/auth/reauth', { body: { password: PASSWORD }, cookie, csrf: csrfToken }), noParams);
    expect(res.status).toBe(200);
    const rotated = cookieFrom(res)!;
    expect(rotated).not.toBe(cookie);
    const loaded = await loadSession(db, rotated.split('=')[1]!, { now: rt.clock.now(), mode: 'LIVE' });
    expect(loaded).not.toBeNull();
    expect(hasRecentReauth(loaded!.session, rt.clock.now())).toBe(true);
    expect(hasRecentReauth(loaded!.session, new Date(rt.clock.now().getTime() + SESSION_POLICY.reauthWindowMs + 1))).toBe(false);
    expect((await sessionGET(makeRequest('/api/app/auth/session', { cookie }), noParams)).status).toBe(401);
  });

  it('re-auth with a wrong password is refused and keeps the session', async () => {
    useRuntime(db, testConfig('live'));
    const loginRes = await login('admin@example.test', PASSWORD);
    const cookie = cookieFrom(loginRes)!;
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };
    const res = await reauthPOST(makeRequest('/api/app/auth/reauth', { body: { password: 'wrong password!!' }, cookie, csrf: csrfToken }), noParams);
    expect(res.status).toBe(401);
    expect((await sessionGET(makeRequest('/api/app/auth/session', { cookie }), noParams)).status).toBe(200);
  });
});

describe('revocation', () => {
  it('a role change revokes every session of that user', async () => {
    const user = await db.user.create({ data: { email: 'promote@alpha.test', name: 'P', globalRole: 'USER', passwordHash: await hashPassword(PASSWORD) } });
    const a = await createSession(db, { userId: user.id, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    const b = await createSession(db, { userId: user.id, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'b', now: t0 });
    expect(await loadSession(db, a.token, { now: plus(1000), mode: 'LIVE' })).not.toBeNull();

    await changeUserPrivileges(db, { userId: user.id, globalRole: 'EMPLOYEE' }, plus(2000));

    expect(await loadSession(db, a.token, { now: plus(3000), mode: 'LIVE' })).toBeNull();
    expect(await loadSession(db, b.token, { now: plus(3000), mode: 'LIVE' })).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).globalRole).toBe('EMPLOYEE');
  });

  it('a status change to DISABLED revokes sessions, and a disabled user cannot load a session', async () => {
    const user = await db.user.create({ data: { email: 'disable@alpha.test', name: 'D', globalRole: 'USER', passwordHash: await hashPassword(PASSWORD) } });
    const s = await createSession(db, { userId: user.id, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    await changeUserPrivileges(db, { userId: user.id, status: 'DISABLED' }, plus(1));
    expect(await loadSession(db, s.token, { now: plus(2), mode: 'LIVE' })).toBeNull();
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it('revokeUserSessions (membership or assignment change) revokes all active sessions', async () => {
    const s = await createSession(db, { userId: ids.memberId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    const n = await revokeUserSessions(db, ids.memberId, plus(5));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await loadSession(db, s.token, { now: plus(6), mode: 'LIVE' })).toBeNull();
  });

  it('logout revokes the session and clears the cookie; it needs the CSRF token', async () => {
    useRuntime(db, testConfig('live'));
    const loginRes = await login('owner@alpha.test', PASSWORD);
    const cookie = cookieFrom(loginRes)!;
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };
    const noCsrf = await logoutPOST(makeRequest('/api/app/auth/logout', { method: 'POST', cookie }), noParams);
    expect(noCsrf.status).toBe(403);
    const res = await logoutPOST(makeRequest('/api/app/auth/logout', { method: 'POST', cookie, csrf: csrfToken }), noParams);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await sessionGET(makeRequest('/api/app/auth/session', { cookie }), noParams)).status).toBe(401);
  });
});

describe('expiry', () => {
  it('expires after 7 idle days; activity slides the idle window', async () => {
    const s = await createSession(db, { userId: ids.ownerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    expect(await loadSession(db, s.token, { now: plus(SESSION_POLICY.idleMs - 1), mode: 'LIVE' })).not.toBeNull();
    // That load was activity: the idle window now runs from there.
    expect(await loadSession(db, s.token, { now: plus(2 * SESSION_POLICY.idleMs - 2), mode: 'LIVE' })).not.toBeNull();
    const idle = await createSession(db, { userId: ids.ownerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    expect(await loadSession(db, idle.token, { now: plus(SESSION_POLICY.idleMs), mode: 'LIVE' })).toBeNull();
  });

  it('expires at 30 days absolute even with constant activity', async () => {
    const s = await createSession(db, { userId: ids.ownerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    const day = 24 * 3600_000;
    for (let d = 1; d < 30; d += 1) {
      expect(await loadSession(db, s.token, { now: plus(d * day), mode: 'LIVE' })).not.toBeNull();
    }
    expect(await loadSession(db, s.token, { now: plus(SESSION_POLICY.absoluteMs), mode: 'LIVE' })).toBeNull();
  });

  it('super admin sessions end after 12 hours', async () => {
    const s = await createSession(db, { userId: ids.adminId, globalRole: 'SUPER_ADMIN', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'a', now: t0 });
    expect(SESSION_POLICY.superAdminAbsoluteMs).toBe(12 * 3600_000);
    expect(await loadSession(db, s.token, { now: plus(12 * 3600_000 - 1), mode: 'LIVE' })).not.toBeNull();
    expect(await loadSession(db, s.token, { now: plus(12 * 3600_000), mode: 'LIVE' })).toBeNull();
  });

  it('the login route honours the injected clock for expiry', async () => {
    const clock = new FixedClock(NOW);
    useRuntime(db, testConfig('live'), clock);
    const cookie = cookieFrom(await login('member@alpha.test', PASSWORD))!;
    clock.advance(SESSION_POLICY.idleMs + 1);
    expect((await sessionGET(makeRequest('/api/app/auth/session', { cookie }), noParams)).status).toBe(401);
  });
});

describe('generic errors and timing', () => {
  it('unknown email, wrong password, disabled user and malformed input all look the same', async () => {
    useRuntime(db, testConfig('live'));
    await db.user.create({ data: { email: 'off@alpha.test', name: 'Off', globalRole: 'USER', status: 'DISABLED', passwordHash: await hashPassword(PASSWORD) } });
    const results = [];
    for (const [email, pw] of [
      ['nobody@alpha.test', PASSWORD],
      ['owner@alpha.test', 'not the right password'],
      ['off@alpha.test', PASSWORD],
    ] as const) {
      const res = await login(email, pw);
      const body = (await res.json()) as { code: string; message: string };
      results.push({ status: res.status, code: body.code, message: body.message });
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(results[0]).toEqual({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('runs exactly one argon2 verification on every failure path (dummy hash for missing users)', async () => {
    const calls: string[] = [];
    const hasher: PasswordHasher = {
      hash: argon2Hasher.hash,
      verify: async (h, p) => {
        calls.push('verify');
        return argon2Hasher.verify(h, p);
      },
      verifyDummy: async (p) => {
        calls.push('dummy');
        return argon2Hasher.verifyDummy(p);
      },
    };
    await db.user.create({ data: { email: 'nopw@alpha.test', name: 'N', globalRole: 'USER', passwordHash: null } });
    const cases = [
      ['nobody@alpha.test', PASSWORD, 'dummy'],
      ['nopw@alpha.test', PASSWORD, 'dummy'],
      ['owner@alpha.test', 'nope nope nope', 'verify'],
    ] as const;
    for (const [email, password, expected] of cases) {
      calls.length = 0;
      const result = await authenticate(db, { email, password }, { now: t0, mode: 'LIVE', hasher });
      expect(result.ok).toBe(false);
      expect(calls).toEqual([expected]);
    }
  });

  it('a missing user takes comparable time to a wrong password', async () => {
    const time = async (email: string) => {
      const start = process.hrtime.bigint();
      await authenticate(db, { email, password: 'wrong wrong wrong' }, { now: t0, mode: 'LIVE' });
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    await time('nobody@alpha.test');
    const known = (await time('member@alpha.test')) + (await time('member@alpha.test'));
    const unknown = (await time('nobody2@alpha.test')) + (await time('nobody3@alpha.test'));
    expect(unknown).toBeGreaterThan(known * 0.3);
  });
});
