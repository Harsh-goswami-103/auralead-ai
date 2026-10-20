/**
 * R33 / R46 (T29): people management in LIVE.
 *  - invites (client users into a workspace, employees, administrators) are single use, stored
 *    hashed, shown once as a link, audited without the email or the token, superseded by a newer
 *    invite to the same address, revocable, refused for an address that already has an account;
 *  - every role, status, membership or assignment change revokes all of that user's sessions and
 *    is audited (crossWorkspace, with the typed reason);
 *  - guards: an administrator cannot demote or disable themselves or the last active
 *    administrator (422), cannot remove a workspace's last owner (422), cannot change the role of
 *    someone who still holds workspace access (422), and never touches a demo user in LIVE (404);
 *  - a password reset link (ADR-67) needs a fresh sign-in, is shown once and works end to end with
 *    the existing reset route;
 *  - the plan label change is audited;
 *  - every route is super admin only (others 404, anonymous 401), CSRF-checked, and needs a sign-in
 *    within 15 minutes; invites and reset links are rate limited per administrator.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as acceptPOST } from '@/app/api/app/auth/invite/accept/route';
import { POST as resetPOST } from '@/app/api/app/auth/reset/route';
import { POST as assignmentPOST } from '@/app/api/admin/people/[userId]/assignments/route';
import { POST as membershipPOST } from '@/app/api/admin/people/[userId]/memberships/route';
import { POST as resetLinkPOST } from '@/app/api/admin/people/[userId]/reset-link/route';
import { POST as rolePOST } from '@/app/api/admin/people/[userId]/role/route';
import { POST as statusPOST } from '@/app/api/admin/people/[userId]/status/route';
import { POST as revokePOST } from '@/app/api/admin/people/invites/[inviteId]/revoke/route';
import { POST as invitePOST } from '@/app/api/admin/people/invites/route';
import { POST as planLabelPOST } from '@/app/api/admin/workspaces/[workspaceId]/plan-label/route';
import { authenticate } from '@/server/auth/login';
import { hashPassword } from '@/server/auth/password';
import { hashToken } from '@/server/security/tokens';
import { changeUserRole, changeUserStatus, getPerson, listPeople, listPendingInvites } from '@/server/services/admin/people';
import { makeRequest, noParams, ORIGIN, PASSWORD } from '../auth/support';
import { createLiveAdminHarness, liveCtx, liveSession, REASON, refillLimits, sessionAlive, type LiveAdminHarness } from './live-support';
import { callRoute, type AdminAuth } from './support';

let h: LiveAdminHarness;
let admin: AdminAuth;

beforeAll(async () => {
  h = await createLiveAdminHarness('admin-people');
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(async () => {
  refillLimits(h);
  admin = await liveSession(h, h.ids.adminId);
});

const invite = (auth: AdminAuth | null, body: Record<string, unknown>) => callRoute(invitePOST, '/api/admin/people/invites', auth, { body: { reason: REASON, ...body } });
const onUser = (handler: typeof rolePOST, action: string) => (auth: AdminAuth | null, userId: string, body: Record<string, unknown>) =>
  callRoute(handler, `/api/admin/people/${userId}/${action}`, auth, { body: { reason: REASON, ...body }, params: { userId } });
const setRole = onUser(rolePOST, 'role');
const setStatus = onUser(statusPOST, 'status');
const setMembership = onUser(membershipPOST, 'memberships');
const setAssignment = onUser(assignmentPOST, 'assignments');
const resetLink = onUser(resetLinkPOST, 'reset-link');

const tokenOf = (link: unknown, kind: 'invite' | 'reset') => {
  const m = new RegExp(`^${ORIGIN}/${kind}/([A-Za-z0-9_-]{43})$`).exec(String(link));
  expect(m, String(link)).not.toBeNull();
  return m![1]!;
};
const accept = (token: string, name = 'New Person', password = 'a brand new long passphrase') =>
  acceptPOST(makeRequest('/api/app/auth/invite/accept', { body: { token, name, password } }), noParams);

async function newUser(email: string, globalRole: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN') {
  return h.db.user.create({ data: { email, name: email.split('@')[0]!, globalRole, passwordHash: await hashPassword(PASSWORD) } });
}

async function auditsFor(targetId: string, action: string) {
  return h.db.auditEvent.findMany({ where: { targetId, action }, orderBy: { createdAt: 'asc' } });
}

describe('access rules for the people routes', () => {
  it('super admin only (owner and employee 404, anonymous 401), CSRF-checked, fresh sign-in required', async () => {
    const body = { email: 'gate@example.test', globalRole: 'EMPLOYEE' };
    expect((await invite(null, body)).status).toBe(401);
    expect((await invite(await liveSession(h, h.ids.ownerId), body)).status).toBe(404);
    expect((await invite(await liveSession(h, h.ids.employeeId), body)).status).toBe(404);
    expect((await invite({ ...admin, csrf: 'forged' }, body)).status).toBe(403);

    const stale = await liveSession(h, h.ids.adminId, { createdAt: new Date(h.clock.now().getTime() - 20 * 60_000) });
    const refused = await invite(stale, body);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('REAUTH_REQUIRED');
    expect(await h.db.invite.count({ where: { email: 'gate@example.test' } })).toBe(0);

    const reauthed = await liveSession(h, h.ids.adminId, { createdAt: new Date(h.clock.now().getTime() - 20 * 60_000), reauthAt: new Date(h.clock.now().getTime() - 60_000) });
    expect((await invite(reauthed, body)).status).toBe(200);
    expect((await invite(admin, { ...body, reason: 'no' })).status).toBe(400);
  });

  it('refuses browser-supplied identity keys in the body', async () => {
    const res = await invite(admin, { email: 'x@example.test', globalRole: 'EMPLOYEE', workspaceId: h.ids.workspaceBId });
    expect(res.status).toBe(404);
  });
});

describe('invites', () => {
  it('are single use, stored hashed, shown once as a link and audited without the email or token', async () => {
    const res = await invite(admin, { email: 'New.Employee@Example.test', globalRole: 'EMPLOYEE' });
    expect(res.status).toBe(200);
    const token = tokenOf(res.body.link, 'invite');
    const inviteId = (res.body.invite as { id: string }).id;
    const row = await h.db.invite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(row).toMatchObject({ email: 'new.employee@example.test', globalRole: 'EMPLOYEE', workspaceId: null, membershipRole: null, createdBy: h.ids.adminId, redeemedAt: null });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const [audit] = await auditsFor(inviteId, 'invite.create');
    expect(audit).toMatchObject({ actorUserId: h.ids.adminId, actorKind: 'SUPER_ADMIN', crossWorkspace: true, reason: REASON, result: 'SUCCESS' });
    expect(JSON.stringify(audit)).not.toContain('new.employee');
    expect(JSON.stringify(audit)).not.toContain(token);

    expect((await accept(token, 'Nisha Rao')).status).toBe(200);
    const user = await h.db.user.findUniqueOrThrow({ where: { email: 'new.employee@example.test' } });
    expect(user).toMatchObject({ globalRole: 'EMPLOYEE', status: 'ACTIVE', isDemo: false, name: 'Nisha Rao' });
    expect((await accept(token, 'Someone Else', 'another long passphrase')).status).toBe(404);
  });

  it('a client invite needs a workspace of this mode and grants that membership', async () => {
    expect((await invite(admin, { email: 'client@example.test', globalRole: 'USER' })).status).toBe(422);
    expect((await invite(admin, { email: 'client@example.test', globalRole: 'USER', targetWorkspaceId: 'nosuchworkspace0000000000', membershipRole: 'MEMBER' })).status).toBe(404);
    expect((await invite(admin, { email: 'staff@example.test', globalRole: 'EMPLOYEE', targetWorkspaceId: h.ids.workspaceBId, membershipRole: 'MEMBER' })).status).toBe(422);

    const res = await invite(admin, { email: 'client@example.test', globalRole: 'USER', targetWorkspaceId: h.ids.workspaceBId, membershipRole: 'MEMBER' });
    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({ globalRole: 'USER', membershipRole: 'MEMBER', workspace: { id: h.ids.workspaceBId, slug: 'beta' } });
    const pending = await listPendingInvites(await liveCtx(h, h.ids.adminId), {});
    expect(pending.map((p) => p.email)).toContain('client@example.test');

    expect((await accept(tokenOf(res.body.link, 'invite'), 'Chitra')).status).toBe(200);
    const user = await h.db.user.findUniqueOrThrow({ where: { email: 'client@example.test' }, include: { memberships: true } });
    expect(user.memberships.map((m) => [m.workspaceId, m.role])).toEqual([[h.ids.workspaceBId, 'MEMBER']]);
    const audit = await h.db.auditEvent.findFirst({ where: { action: 'invite.create', targetId: (res.body.invite as { id: string }).id } });
    expect(audit?.workspaceId).toBe(h.ids.workspaceBId);
  });

  it('a newer invite to the same address supersedes the pending one; revoke ends a pending invite', async () => {
    const first = await invite(admin, { email: 'twice@example.test', globalRole: 'SUPER_ADMIN' });
    const second = await invite(admin, { email: 'twice@example.test', globalRole: 'SUPER_ADMIN' });
    expect(second.body.supersededInvites).toBe(1);
    expect((await accept(tokenOf(first.body.link, 'invite'))).status).toBe(404);

    const secondId = (second.body.invite as { id: string }).id;
    const revoked = await callRoute(revokePOST, `/api/admin/people/invites/${secondId}/revoke`, admin, { body: { reason: REASON }, params: { inviteId: secondId } });
    expect(revoked.status).toBe(200);
    expect((await accept(tokenOf(second.body.link, 'invite'))).status).toBe(404);
    expect(await auditsFor(secondId, 'invite.revoke')).toHaveLength(1);
    const again = await callRoute(revokePOST, `/api/admin/people/invites/${secondId}/revoke`, admin, { body: { reason: REASON }, params: { inviteId: secondId } });
    expect(again.status).toBe(404);
    expect(await h.db.user.count({ where: { email: 'twice@example.test' } })).toBe(0);
  });

  it('refuses an address that already has an account, demo or not', async () => {
    const taken = await invite(admin, { email: 'owner@alpha.test', globalRole: 'EMPLOYEE' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('EMAIL_IN_USE');
    expect((await invite(admin, { email: 'demo-owner@alpha.test', globalRole: 'EMPLOYEE' })).status).toBe(409);
  });

  it('is rate limited per administrator (plan §9: invite/reset 10/h)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await invite(admin, { email: `burst${i}@example.test`, globalRole: 'EMPLOYEE' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('role and status changes', () => {
  it('a role change revokes every session of that user and is audited', async () => {
    const target = await newUser('promote@example.test', 'EMPLOYEE');
    const a = await liveSession(h, target.id);
    const b = await liveSession(h, target.id);
    const res = await setRole(admin, target.id, { globalRole: 'SUPER_ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, globalRole: 'SUPER_ADMIN', revokedSessions: 2 });
    expect(await sessionAlive(h, a.token)).toBe(false);
    expect(await sessionAlive(h, b.token)).toBe(false);
    expect((await h.db.user.findUniqueOrThrow({ where: { id: target.id } })).globalRole).toBe('SUPER_ADMIN');

    const [audit] = await auditsFor(target.id, 'user.role_change');
    expect(audit).toMatchObject({ actorUserId: h.ids.adminId, targetType: 'User', crossWorkspace: true, reason: REASON, workspaceId: null });
    expect(audit!.summary).toMatchObject({ from: 'EMPLOYEE', to: 'SUPER_ADMIN', revokedSessions: 2 });

    const same = await setRole(admin, target.id, { globalRole: 'SUPER_ADMIN' });
    expect(same.body).toMatchObject({ changed: false });
    expect(await auditsFor(target.id, 'user.role_change')).toHaveLength(1);
  });

  it('refuses a role change while the person still holds workspace access', async () => {
    const live = await liveSession(h, h.ids.employeeId);
    const res = await setRole(admin, h.ids.employeeId, { globalRole: 'USER' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ROLE_HAS_ACCESS');
    expect(await sessionAlive(h, live.token)).toBe(true);
    const member = await setRole(admin, h.ids.memberId, { globalRole: 'EMPLOYEE' });
    expect(member.status).toBe(422);
  });

  it('disable revokes sessions and blocks sign-in; enable restores; both audited', async () => {
    const target = await newUser('pause.me@example.test', 'EMPLOYEE');
    const live = await liveSession(h, target.id);
    const off = await setStatus(admin, target.id, { status: 'DISABLED' });
    expect(off.status).toBe(200);
    expect(await sessionAlive(h, live.token)).toBe(false);
    const login = await authenticate(h.db, { email: 'pause.me@example.test', password: PASSWORD }, { now: h.clock.now(), mode: 'LIVE' });
    expect(login.ok).toBe(false);

    expect((await setStatus(admin, target.id, { status: 'ACTIVE' })).status).toBe(200);
    expect((await authenticate(h.db, { email: 'pause.me@example.test', password: PASSWORD }, { now: h.clock.now(), mode: 'LIVE' })).ok).toBe(true);
    const audits = await auditsFor(target.id, 'user.status_change');
    expect(audits.map((a) => (a.summary as { to: string }).to)).toEqual(['DISABLED', 'ACTIVE']);
  });

  it('an administrator cannot demote or disable themselves', async () => {
    for (const res of [await setRole(admin, h.ids.adminId, { globalRole: 'USER' }), await setStatus(admin, h.ids.adminId, { status: 'DISABLED' })]) {
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SELF_CHANGE');
    }
    expect(await h.db.user.findUniqueOrThrow({ where: { id: h.ids.adminId } })).toMatchObject({ globalRole: 'SUPER_ADMIN', status: 'ACTIVE' });
  });

  it('never removes the last active administrator, even when two administrators act at once', async () => {
    // Only the seeded administrator is active before this test.
    await h.db.user.updateMany({ where: { globalRole: 'SUPER_ADMIN', id: { not: h.ids.adminId } }, data: { status: 'DISABLED' } });
    const other = await newUser('second.admin@example.test', 'SUPER_ADMIN');
    const mine = await liveCtx(h, h.ids.adminId);
    const theirs = await liveCtx(h, other.id);
    // Both requests were authorized while both were administrators; the first wins.
    await changeUserRole(mine, { userId: other.id, globalRole: 'EMPLOYEE', reason: REASON });
    await expect(changeUserRole(theirs, { userId: h.ids.adminId, globalRole: 'USER', reason: REASON })).rejects.toMatchObject({ status: 422, code: 'LAST_ADMIN' });
    await expect(changeUserStatus(theirs, { userId: h.ids.adminId, status: 'DISABLED', reason: REASON })).rejects.toMatchObject({ status: 422, code: 'LAST_ADMIN' });
    expect(await h.db.user.count({ where: { globalRole: 'SUPER_ADMIN', status: 'ACTIVE', isDemo: false } })).toBe(1);
  });

  it('never touches a demo user in LIVE and does not list one', async () => {
    const id = h.ids.demoOwnerId;
    expect((await setRole(admin, id, { globalRole: 'EMPLOYEE' })).status).toBe(404);
    expect((await setStatus(admin, id, { status: 'DISABLED' })).status).toBe(404);
    expect((await setMembership(admin, id, { targetWorkspaceId: h.ids.workspaceBId, membershipRole: 'MEMBER' })).status).toBe(404);
    expect((await resetLink(admin, id, {})).status).toBe(404);
    const ctx = await liveCtx(h, h.ids.adminId);
    await expect(getPerson(ctx, id)).rejects.toMatchObject({ status: 404 });
    const listed = await listPeople(ctx, {});
    expect(listed.rows.map((r) => r.id)).not.toContain(id);
    expect(await h.db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ globalRole: 'USER', status: 'ACTIVE' });
  });
});

describe('memberships and assignments', () => {
  it('a membership change revokes sessions, is audited on the workspace and opens that workspace', async () => {
    const keeper = await newUser('beta.owner@example.test', 'USER');
    expect((await setMembership(admin, keeper.id, { targetWorkspaceId: h.ids.workspaceBId, membershipRole: 'OWNER' })).status).toBe(200);
    const user = await newUser('join.beta@example.test', 'USER');
    const live = await liveSession(h, user.id);
    const res = await setMembership(admin, user.id, { targetWorkspaceId: h.ids.workspaceBId, membershipRole: 'OWNER' });
    expect(res.status).toBe(200);
    expect(await sessionAlive(h, live.token)).toBe(false);
    const ctx = await liveCtx(h, user.id, 'beta');
    expect(ctx.workspaceId).toBe(h.ids.workspaceBId);
    expect(ctx.capabilities.has('pricing.override')).toBe(true);
    const [audit] = await h.db.auditEvent.findMany({ where: { action: 'membership.set', targetId: user.id } });
    expect(audit!.summary).toMatchObject({ from: null, to: 'OWNER' });
    expect(audit).toMatchObject({ workspaceId: h.ids.workspaceBId, crossWorkspace: true, reason: REASON });

    const demoted = await setMembership(admin, user.id, { targetWorkspaceId: h.ids.workspaceBId, membershipRole: 'MEMBER' });
    expect(demoted.status).toBe(200);
    expect((await liveCtx(h, user.id, 'beta')).capabilities.has('pricing.override')).toBe(false);
    expect((await setMembership(admin, user.id, { targetWorkspaceId: h.ids.workspaceBId, membershipRole: null })).status).toBe(200);
    await expect(liveCtx(h, user.id, 'beta')).rejects.toMatchObject({ status: 404 });
  });

  it("never removes or demotes a workspace's last active owner", async () => {
    // Alpha has one real owner; its demo owner cannot sign in to LIVE and does not count.
    for (const membershipRole of ['MEMBER', null] as const) {
      const res = await setMembership(admin, h.ids.ownerId, { targetWorkspaceId: h.ids.workspaceAId, membershipRole });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('LAST_OWNER');
    }
    expect(await h.db.membership.findFirst({ where: { userId: h.ids.ownerId, workspaceId: h.ids.workspaceAId } })).toMatchObject({ role: 'OWNER' });
    const employee = await setMembership(admin, h.ids.employeeId, { targetWorkspaceId: h.ids.workspaceAId, membershipRole: 'MEMBER' });
    expect(employee.status).toBe(422);
    expect(employee.body.code).toBe('NOT_A_CLIENT_USER');
  });

  it('an assignment grants exactly the chosen capabilities and cap, revokes sessions, and deactivates', async () => {
    const live = await liveSession(h, h.ids.unassignedEmployeeId);
    const res = await setAssignment(admin, h.ids.unassignedEmployeeId, { targetWorkspaceId: h.ids.workspaceBId, capabilities: ['quotes.edit', 'leads.read', 'leads.read'], maxDiscountBps: 750, active: true });
    expect(res.status).toBe(200);
    expect(res.body.assignment).toMatchObject({ capabilities: ['leads.read', 'quotes.edit'], maxDiscountBps: 750, active: true });
    expect(await sessionAlive(h, live.token)).toBe(false);
    const ctx = await liveCtx(h, h.ids.unassignedEmployeeId, 'beta');
    expect([...ctx.capabilities].sort()).toEqual(['leads.read', 'quotes.edit']);
    expect(ctx.maxDiscountBps).toBe(750);
    const [audit] = await h.db.auditEvent.findMany({ where: { action: 'assignment.set', targetId: h.ids.unassignedEmployeeId } });
    expect(audit).toMatchObject({ workspaceId: h.ids.workspaceBId, crossWorkspace: true, reason: REASON });
    expect(audit!.summary).toMatchObject({ capabilities: ['leads.read', 'quotes.edit'], maxDiscountBps: 750, active: true });

    expect((await setAssignment(admin, h.ids.unassignedEmployeeId, { targetWorkspaceId: h.ids.workspaceBId, capabilities: ['leads.read'], maxDiscountBps: null, active: false })).status).toBe(200);
    await expect(liveCtx(h, h.ids.unassignedEmployeeId, 'beta')).rejects.toMatchObject({ status: 404 });
  });

  it('assigns employees only, with known capabilities, to a workspace of this mode', async () => {
    const owner = await setAssignment(admin, h.ids.ownerId, { targetWorkspaceId: h.ids.workspaceBId, capabilities: ['leads.read'], maxDiscountBps: null, active: true });
    expect(owner.status).toBe(422);
    expect(owner.body.code).toBe('NOT_AN_EMPLOYEE');
    expect((await setAssignment(admin, h.ids.employeeId, { targetWorkspaceId: h.ids.workspaceBId, capabilities: ['root.everything'], maxDiscountBps: null, active: true })).status).toBe(400);
    expect((await setAssignment(admin, h.ids.employeeId, { targetWorkspaceId: h.ids.workspaceBId, capabilities: [], maxDiscountBps: null, active: true })).status).toBe(422);
    expect((await setAssignment(admin, h.ids.employeeId, { targetWorkspaceId: 'nosuchworkspace0000000000', capabilities: ['leads.read'], maxDiscountBps: null, active: true })).status).toBe(404);
  });
});

describe('password reset links', () => {
  it('need a fresh sign-in, are shown once, and work end to end with the reset route', async () => {
    const target = await newUser('forgot@example.test', 'USER');
    const live = await liveSession(h, target.id);
    const stale = await liveSession(h, h.ids.adminId, { createdAt: new Date(h.clock.now().getTime() - 16 * 60_000) });
    expect((await resetLink(stale, target.id, {})).status).toBe(401);
    expect(await h.db.passwordReset.count({ where: { userId: target.id } })).toBe(0);

    const res = await resetLink(admin, target.id, {});
    expect(res.status).toBe(200);
    const token = tokenOf(res.body.link, 'reset');
    const [audit] = await auditsFor(target.id, 'password.reset_issue');
    expect(audit).toMatchObject({ actorUserId: h.ids.adminId, reason: REASON, crossWorkspace: true });
    expect(JSON.stringify(audit)).not.toContain(token);

    const redeem = (password: string) => resetPOST(makeRequest('/api/app/auth/reset', { body: { token, password } }), noParams);
    expect((await redeem('the new long passphrase')).status).toBe(200);
    expect(await sessionAlive(h, live.token)).toBe(false);
    expect((await authenticate(h.db, { email: 'forgot@example.test', password: 'the new long passphrase' }, { now: h.clock.now(), mode: 'LIVE' })).ok).toBe(true);
    expect((await redeem('yet another long passphrase')).status).toBe(404);
  });

  it('are refused for a disabled user', async () => {
    const target = await newUser('gone.user@example.test', 'USER');
    await setStatus(admin, target.id, { status: 'DISABLED' });
    expect((await resetLink(admin, target.id, {})).status).toBe(404);
  });
});

describe('plan labels', () => {
  it('a plan label change is audited with the old and new label; the same label is a no-op', async () => {
    const path = `/api/admin/workspaces/${h.ids.workspaceBId}/plan-label`;
    const res = await callRoute(planLabelPOST, path, admin, { body: { planLabel: 'Growth', reason: REASON }, params: { workspaceId: h.ids.workspaceBId } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, planLabel: 'Growth' });
    expect((await h.db.workspace.findUniqueOrThrow({ where: { id: h.ids.workspaceBId } })).planLabel).toBe('Growth');
    const audits = await auditsFor(h.ids.workspaceBId, 'workspace.plan_label');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: h.ids.workspaceBId, actorUserId: h.ids.adminId, crossWorkspace: true, reason: REASON });
    expect(audits[0]!.summary).toMatchObject({ fields: ['planLabel'], from: 'Starter', to: 'Growth' });

    const same = await callRoute(planLabelPOST, path, admin, { body: { planLabel: 'Growth', reason: REASON }, params: { workspaceId: h.ids.workspaceBId } });
    expect(same.body).toMatchObject({ changed: false });
    expect(await auditsFor(h.ids.workspaceBId, 'workspace.plan_label')).toHaveLength(1);
    expect((await callRoute(planLabelPOST, path, await liveSession(h, h.ids.ownerId), { body: { planLabel: 'Pro', reason: REASON }, params: { workspaceId: h.ids.workspaceBId } })).status).toBe(404);
  });
});

describe('people read model', () => {
  it('lists role, status, last sign-in, memberships and assignments; filters by role and text', async () => {
    const ctx = await liveCtx(h, h.ids.adminId);
    const all = await listPeople(ctx, {});
    const owner = all.rows.find((r) => r.id === h.ids.ownerId)!;
    expect(owner).toMatchObject({ email: 'owner@alpha.test', globalRole: 'USER', status: 'ACTIVE' });
    expect(owner.memberships).toEqual([expect.objectContaining({ workspace: expect.objectContaining({ slug: 'alpha' }), membershipRole: 'OWNER' })]);
    const employee = all.rows.find((r) => r.id === h.ids.employeeId)!;
    expect(employee.assignments).toEqual([expect.objectContaining({ workspace: expect.objectContaining({ slug: 'alpha' }), capabilityCount: 2, active: true })]);

    const employees = await listPeople(ctx, { globalRole: 'EMPLOYEE' });
    expect(employees.rows.every((r) => r.globalRole === 'EMPLOYEE')).toBe(true);
    const search = await listPeople(ctx, { q: 'ALPHA.test' });
    expect(search.rows.map((r) => r.email).sort()).toEqual(['member@alpha.test', 'owner@alpha.test']);

    const detail = await getPerson(ctx, h.ids.employeeId);
    expect(detail.assignments[0]).toMatchObject({ capabilities: ['leads.read', 'drafts.generate'], maxDiscountBps: 500 });
    expect(JSON.stringify(detail)).not.toMatch(/passwordHash|tokenHash/);
  });

  it('pages through people with a keyset cursor without gaps or repeats', async () => {
    for (let i = 0; i < 7; i += 1) await newUser(`page${i}@example.test`, 'EMPLOYEE');
    const ctx = await liveCtx(h, h.ids.adminId);
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await listPeople(ctx, { before, limit: 3 });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    const total = await h.db.user.count({ where: { isDemo: false } });
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});
