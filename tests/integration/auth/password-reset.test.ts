/**
 * ADR-67 / plan §9 Auth: password reset. An administrator (or the operator through
 * `npm run admin:bootstrap -- --recover`) issues a single-use link; there is no self-service
 * "forgot password" mail because the platform has no email transport of its own. Tokens are stored
 * hashed, last one hour, supersede earlier unused tokens, and redeem exactly once. Redeeming sets
 * the password, clears the lockout, revokes every session and signs nobody in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { authenticate } from '@/server/auth/login';
import { verifyPassword } from '@/server/auth/password';
import { createPasswordReset, PASSWORD_RESET_TTL_MS } from '@/server/auth/password-reset';
import { createSession } from '@/server/auth/session';
import { hashToken } from '@/server/security/tokens';
import { POST as resetPOST } from '@/app/api/app/auth/reset/route';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, noParams, NOW, seedIdentities, testConfig, uninstallRuntime, useRuntime, type Identity } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
const t0 = new Date(NOW);
const NEW_PASSWORD = 'a fresh and long passphrase';

beforeAll(async () => {
  testDb = await createTestDb({ label: 'auth-password-reset' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

const redeem = (body: unknown) => resetPOST(makeRequest('/api/app/auth/reset', { body }), noParams);

async function issue(userId: string, now = t0) {
  return createPasswordReset(db, { userId, createdBy: ids.adminId, now });
}

describe('password reset tokens', () => {
  it('stores only the token hash and expires one hour after creation', async () => {
    const { token, reset } = await issue(ids.ownerId);
    expect(PASSWORD_RESET_TTL_MS).toBe(3_600_000);
    const row = await db.passwordReset.findUniqueOrThrow({ where: { id: reset.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime() - t0.getTime()).toBe(PASSWORD_RESET_TTL_MS);
    expect(row.usedAt).toBeNull();
  });

  it('a newer token supersedes every earlier unused token of the same user', async () => {
    useRuntime(db, testConfig('live'));
    const first = await issue(ids.memberId);
    const second = await issue(ids.memberId);
    expect((await redeem({ token: first.token, password: NEW_PASSWORD })).status).toBe(404);
    expect((await redeem({ token: second.token, password: NEW_PASSWORD })).status).toBe(200);
  });
});

describe('POST /api/app/auth/reset', () => {
  it('sets the password, clears the lockout, revokes all sessions, audits, and does not sign anyone in', async () => {
    useRuntime(db, testConfig('live'));
    await db.user.update({ where: { id: ids.employeeId }, data: { failedLoginCount: 5, lockedUntil: new Date(t0.getTime() + 600_000) } });
    const { session } = await createSession(db, { userId: ids.employeeId, globalRole: 'EMPLOYEE', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'test', now: t0 });
    const { token } = await issue(ids.employeeId);

    const res = await redeem({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ redirectTo: '/login' });

    const user = await db.user.findUniqueOrThrow({ where: { id: ids.employeeId } });
    expect(await verifyPassword(user.passwordHash!, NEW_PASSWORD)).toBe(true);
    expect(user).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
    const login = await authenticate(db, { email: 'employee@example.test', password: NEW_PASSWORD }, { now: t0, mode: 'LIVE' });
    expect(login.ok).toBe(true);

    const audit = await db.auditEvent.findFirst({ where: { action: 'password.reset', targetId: ids.employeeId } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('redeems exactly once', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await issue(ids.ownerId);
    expect((await redeem({ token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await redeem({ token, password: 'another long passphrase' })).status).toBe(404);
    const user = await db.user.findUniqueOrThrow({ where: { id: ids.ownerId } });
    expect(await verifyPassword(user.passwordHash!, NEW_PASSWORD)).toBe(true);
  });

  it('two concurrent redemptions cannot both win', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await issue(ids.unassignedEmployeeId);
    const results = await Promise.all([redeem({ token, password: NEW_PASSWORD }), redeem({ token, password: 'a second long passphrase' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  it('an expired, unknown, malformed or already-superseded token is one and the same 404', async () => {
    useRuntime(db, testConfig('live'));
    const expired = await issue(ids.memberId, new Date(t0.getTime() - PASSWORD_RESET_TTL_MS - 1));
    const statuses = await Promise.all([
      redeem({ token: expired.token, password: NEW_PASSWORD }),
      redeem({ token: 'A'.repeat(43), password: NEW_PASSWORD }),
      redeem({ token: 'short', password: NEW_PASSWORD }),
    ]);
    expect(statuses.map((r) => r.status)).toEqual([404, 404, 404]);
    const bodies = await Promise.all(statuses.map((r) => r.json()));
    expect(new Set(bodies.map((b) => (b as { code: string }).code)).size).toBe(1);
  });

  it('enforces the password policy and leaves the token usable', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await issue(ids.memberId);
    const weak = await redeem({ token, password: 'short' });
    expect(weak.status).toBe(400);
    expect((await redeem({ token, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('never resets a disabled user or a demo user in LIVE', async () => {
    useRuntime(db, testConfig('live'));
    const demo = await issue(ids.demoOwnerId);
    expect((await redeem({ token: demo.token, password: NEW_PASSWORD })).status).toBe(404);

    const disabled = await db.user.create({ data: { email: 'gone@example.test', name: 'Gone', globalRole: 'USER', status: 'DISABLED', passwordHash: 'x' } });
    const gone = await issue(disabled.id);
    expect((await redeem({ token: gone.token, password: NEW_PASSWORD })).status).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { id: disabled.id } })).status).toBe('DISABLED');
  });

  it('rejects a cross-origin POST and is rate limited per IP', async () => {
    useRuntime(db, testConfig('live'));
    const foreign = await resetPOST(makeRequest('/api/app/auth/reset', { body: { token: 'A'.repeat(43), password: NEW_PASSWORD }, origin: 'https://evil.example' }), noParams);
    expect(foreign.status).toBe(403);
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await redeem({ token: 'B'.repeat(43), password: NEW_PASSWORD });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
