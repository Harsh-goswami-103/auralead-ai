/**
 * ADR-68: first-administrator bootstrap for LIVE (`npm run admin:bootstrap`). A fresh LIVE database
 * has no users and the login page promises accounts "by invitation", so the operator needs one
 * trusted way in. With no active real SUPER_ADMIN it issues a single-use platform invite (the
 * person sets their own password in the browser; the CLI never handles a password). Once an
 * administrator exists it refuses, and `--recover` issues a one-hour password reset link for that
 * existing administrator (lost-password break-glass for someone with shell access).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { AdminBootstrapError, bootstrapAdmin } from '@/server/auth/bootstrap';
import { redeemInvite } from '@/server/auth/invites';
import { redeemPasswordReset } from '@/server/auth/password-reset';
import { verifyPassword } from '@/server/auth/password';
import { createTestDb, type TestDb } from '../../support/db';
import { NOW } from './support';

let testDb: TestDb;
let db: PrismaClient;
const clock = new FixedClock(NOW);
const deps = { mode: 'live' as const, clock, correlationId: 'bootstrap-test' };
const PASSWORD = 'first admin long passphrase';

beforeAll(async () => {
  testDb = await createTestDb({ label: 'admin-bootstrap' });
  db = testDb.client();
});
afterEach(async () => {
  await db.passwordReset.deleteMany();
  await db.invite.deleteMany();
  await db.session.deleteMany();
  await db.auditEvent.deleteMany();
  await db.user.deleteMany();
});
afterAll(async () => {
  await testDb?.destroy();
});

describe('bootstrapAdmin', () => {
  it('on an empty LIVE database issues a platform SUPER_ADMIN invite the person redeems themselves', async () => {
    const result = await bootstrapAdmin(db, { email: ' Founder@Example.Test ', recover: false }, deps);
    expect(result.kind).toBe('invite');
    expect(result.email).toBe('founder@example.test');
    expect(result.expiresAt.getTime() - clock.now().getTime()).toBe(72 * 3_600_000);

    const invite = await db.invite.findFirstOrThrow({ where: { email: 'founder@example.test' } });
    expect(invite).toMatchObject({ globalRole: 'SUPER_ADMIN', workspaceId: null, membershipRole: null, createdBy: 'system:operator' });
    expect(JSON.stringify(invite)).not.toContain(result.token);

    const { user } = await redeemInvite(db, { token: result.token, name: 'Founder', password: PASSWORD }, deps);
    expect(user).toMatchObject({ globalRole: 'SUPER_ADMIN', status: 'ACTIVE', isDemo: false });
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(stored.passwordHash!, PASSWORD)).toBe(true);
  });

  it('audits the issue without the token', async () => {
    const result = await bootstrapAdmin(db, { email: 'founder@example.test', recover: false }, deps);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.bootstrap' } });
    expect(audit.actorKind).toBe('SYSTEM');
    expect(JSON.stringify(audit)).not.toContain(result.token);
  });

  it('running it again before redemption retires the earlier invite', async () => {
    const first = await bootstrapAdmin(db, { email: 'founder@example.test', recover: false }, deps);
    const second = await bootstrapAdmin(db, { email: 'founder@example.test', recover: false }, deps);
    await expect(redeemInvite(db, { token: first.token, name: 'Founder', password: PASSWORD }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(redeemInvite(db, { token: second.token, name: 'Founder', password: PASSWORD }, deps)).resolves.toBeDefined();
  });

  it('a new bootstrap for another address also retires the earlier link, so only one first-admin link is ever live', async () => {
    const first = await bootstrapAdmin(db, { email: 'first@example.test', recover: false }, deps);
    const second = await bootstrapAdmin(db, { email: 'second@example.test', recover: false }, deps);
    await expect(redeemInvite(db, { token: first.token, name: 'First', password: PASSWORD }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(redeemInvite(db, { token: second.token, name: 'Second', password: PASSWORD }, deps)).resolves.toBeDefined();
  });

  it('an operator invite cannot be redeemed once an administrator exists (first redemption wins)', async () => {
    const invite = await bootstrapAdmin(db, { email: 'late@example.test', recover: false }, deps);
    await db.user.create({ data: { email: 'root@example.test', name: 'Root', globalRole: 'SUPER_ADMIN', passwordHash: 'x' } });
    await expect(redeemInvite(db, { token: invite.token, name: 'Late', password: PASSWORD }, deps)).rejects.toMatchObject({ status: 404 });
    expect(await db.user.count({ where: { email: 'late@example.test' } })).toBe(0);
  });

  it('refuses when an active real SUPER_ADMIN already exists, and says what to do instead', async () => {
    await db.user.create({ data: { email: 'root@example.test', name: 'Root', globalRole: 'SUPER_ADMIN', passwordHash: 'x' } });
    const err = await bootstrapAdmin(db, { email: 'second@example.test', recover: false }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminBootstrapError);
    expect((err as AdminBootstrapError).code).toBe('ADMIN_EXISTS');
    expect((err as Error).message).toMatch(/--recover/);
    expect(await db.invite.count()).toBe(0);
  });

  it('a demo SUPER_ADMIN or a disabled one does not count as an administrator', async () => {
    await db.user.create({ data: { email: 'demo-admin@example.test', name: 'Demo', globalRole: 'SUPER_ADMIN', isDemo: true, passwordHash: 'x' } });
    await db.user.create({ data: { email: 'old-admin@example.test', name: 'Old', globalRole: 'SUPER_ADMIN', status: 'DISABLED', passwordHash: 'x' } });
    const result = await bootstrapAdmin(db, { email: 'founder@example.test', recover: false }, deps);
    expect(result.kind).toBe('invite');
  });

  it('refuses an email that already belongs to a non-admin user', async () => {
    await db.user.create({ data: { email: 'owner@alpha.test', name: 'Owner', globalRole: 'USER', passwordHash: 'x' } });
    await expect(bootstrapAdmin(db, { email: 'owner@alpha.test', recover: false }, deps)).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
  });

  it('refuses to run in DEMO, whose identities are seeded', async () => {
    await expect(bootstrapAdmin(db, { email: 'founder@example.test', recover: false }, { ...deps, mode: 'demo' })).rejects.toMatchObject({ code: 'DEMO_MODE' });
  });

  it('rejects an invalid email', async () => {
    await expect(bootstrapAdmin(db, { email: 'not-an-email', recover: false }, deps)).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
  });
});

describe('bootstrapAdmin --recover', () => {
  it('issues a one-hour reset link for the existing administrator, who sets a new password and can log in', async () => {
    const admin = await db.user.create({ data: { email: 'root@example.test', name: 'Root', globalRole: 'SUPER_ADMIN', passwordHash: 'x', failedLoginCount: 5, lockedUntil: new Date(clock.now().getTime() + 600_000) } });
    const result = await bootstrapAdmin(db, { email: 'ROOT@example.test', recover: true }, deps);
    expect(result.kind).toBe('reset');
    expect(result.expiresAt.getTime() - clock.now().getTime()).toBe(3_600_000);
    await redeemPasswordReset(db, { token: result.token, password: PASSWORD }, deps);
    const stored = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword(stored.passwordHash!, PASSWORD)).toBe(true);
    expect(stored.lockedUntil).toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'password.reset_issue', targetId: admin.id } })).toBe(1);
  });

  it('only recovers an active real SUPER_ADMIN', async () => {
    await db.user.create({ data: { email: 'owner@alpha.test', name: 'Owner', globalRole: 'USER', passwordHash: 'x' } });
    await db.user.create({ data: { email: 'demo-admin@example.test', name: 'Demo', globalRole: 'SUPER_ADMIN', isDemo: true, passwordHash: 'x' } });
    await expect(bootstrapAdmin(db, { email: 'owner@alpha.test', recover: true }, deps)).rejects.toMatchObject({ code: 'NOT_AN_ADMIN' });
    await expect(bootstrapAdmin(db, { email: 'demo-admin@example.test', recover: true }, deps)).rejects.toMatchObject({ code: 'NOT_AN_ADMIN' });
    await expect(bootstrapAdmin(db, { email: 'nobody@example.test', recover: true }, deps)).rejects.toMatchObject({ code: 'NOT_AN_ADMIN' });
  });
});
