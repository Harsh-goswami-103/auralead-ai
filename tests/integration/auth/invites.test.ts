/**
 * ADR-11 / plan §9: invite onboarding. Invite tokens are stored hashed, expire after 72 hours and
 * redeem exactly once; redemption creates or activates the user, grants the membership, and
 * signs the user in with a fresh session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createInvite, INVITE_TTL_MS } from '@/server/auth/invites';
import { verifyPassword } from '@/server/auth/password';
import { hashToken } from '@/server/security/tokens';
import { POST as acceptPOST } from '@/app/api/app/auth/invite/accept/route';
import { GET as sessionGET } from '@/app/api/app/auth/session/route';
import { createTestDb, type TestDb } from '../../support/db';
import { cookieFrom, makeRequest, noParams, NOW, PASSWORD, seedIdentities, testConfig, uninstallRuntime, useRuntime, type Identity } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
const t0 = new Date(NOW);

beforeAll(async () => {
  testDb = await createTestDb({ label: 'auth-invites' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

const accept = (body: unknown) => acceptPOST(makeRequest('/api/app/auth/invite/accept', { body }), noParams);

describe('invites', () => {
  it('stores only the token hash and expires 72 hours after creation', async () => {
    const { token, invite } = await createInvite(db, { email: 'New.Person@Alpha.test', globalRole: 'USER', workspaceId: ids.workspaceAId, membershipRole: 'MEMBER', createdBy: ids.adminId, now: t0 });
    expect(INVITE_TTL_MS).toBe(72 * 3600_000);
    const row = await db.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.email).toBe('new.person@alpha.test');
    expect(row.expiresAt.getTime() - t0.getTime()).toBe(INVITE_TTL_MS);
  });

  it('redeems once: creates an active user with the membership and signs them in', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await createInvite(db, { email: 'joiner@alpha.test', globalRole: 'USER', workspaceId: ids.workspaceAId, membershipRole: 'MEMBER', createdBy: ids.adminId, now: t0 });
    const res = await accept({ token, name: 'Joiner', password: 'a brand new passphrase' });
    expect(res.status).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { email: 'joiner@alpha.test' } });
    expect(user).toMatchObject({ status: 'ACTIVE', globalRole: 'USER', isDemo: false, name: 'Joiner' });
    expect(await verifyPassword(user.passwordHash!, 'a brand new passphrase')).toBe(true);
    expect(await db.membership.count({ where: { userId: user.id, workspaceId: ids.workspaceAId, role: 'MEMBER' } })).toBe(1);
    const me = await sessionGET(makeRequest('/api/app/auth/session', { cookie: cookieFrom(res) }), noParams);
    expect(((await me.json()) as { workspace: { id: string } }).workspace.id).toBe(ids.workspaceAId);

    const again = await accept({ token, name: 'Joiner', password: 'a brand new passphrase' });
    expect(again.status).toBe(404);
    const audit = await db.auditEvent.findFirst({ where: { action: 'invite.redeem', actorUserId: user.id } });
    expect(audit?.workspaceId).toBe(ids.workspaceAId);
  });

  it('an expired or unknown token is the same 404', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await createInvite(db, { email: 'late@alpha.test', globalRole: 'USER', workspaceId: ids.workspaceAId, membershipRole: 'MEMBER', createdBy: ids.adminId, now: new Date(t0.getTime() - INVITE_TTL_MS - 1) });
    const expired = await accept({ token, name: 'Late', password: 'a brand new passphrase' });
    const unknown = await accept({ token: 'A'.repeat(43), name: 'Late', password: 'a brand new passphrase' });
    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await db.user.count({ where: { email: 'late@alpha.test' } })).toBe(0);
  });

  it('an existing user must prove their password; joining a workspace revokes old sessions', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await createInvite(db, { email: 'member@alpha.test', globalRole: 'USER', workspaceId: ids.workspaceBId, membershipRole: 'MEMBER', createdBy: ids.adminId, now: t0 });
    const wrong = await accept({ token, name: 'Member', password: 'not my password at all' });
    expect(wrong.status).toBe(401);
    expect(await db.membership.count({ where: { userId: ids.memberId, workspaceId: ids.workspaceBId } })).toBe(0);
    const right = await accept({ token, name: 'Member', password: PASSWORD });
    expect(right.status).toBe(200);
    expect(await db.membership.count({ where: { userId: ids.memberId, workspaceId: ids.workspaceBId } })).toBe(1);
    const user = await db.user.findUniqueOrThrow({ where: { id: ids.memberId } });
    expect(user.globalRole).toBe('USER');
  });

  it('rejects a weak password with 400 and leaves the invite usable', async () => {
    useRuntime(db, testConfig('live'));
    const { token } = await createInvite(db, { email: 'weak@alpha.test', globalRole: 'EMPLOYEE', createdBy: ids.adminId, now: t0 });
    expect((await accept({ token, name: 'Weak', password: 'short' })).status).toBe(400);
    expect((await accept({ token, name: 'Weak', password: 'long enough passphrase' })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { email: 'weak@alpha.test' } })).globalRole).toBe('EMPLOYEE');
  });
});
