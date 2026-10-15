/**
 * Plan §4.1 / A6 / R3 / R7: the request context is resolved on the server only. Browser-supplied
 * workspaceId, userId or role never changes it (a mismatch is a 404), an unassigned employee
 * gets 404, a missing capability inside the tenant gets 403, ctx.db is tenant-scoped, and
 * adminContext commits its AuditEvent before any tenant data can be read through it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { CAPABILITIES } from '@/lib/domain/enums';
import { adminContext, buildUserContext, getJobContext, getWebhookContext, publicContext, type AppCtx } from '@/server/auth/context';
import { requireCapability, requireRole, requireWorkspace } from '@/server/auth/guards';
import { createSession, loadSession } from '@/server/auth/session';
import { csrfTokenFor } from '@/server/security/csrf';
import { recordAudit } from '@/server/services/audit/record';
import { withRoute } from '@/app/api/_lib/with-route';
import { POST as switchPOST } from '@/app/api/app/auth/active-workspace/route';
import { GET as sessionGET } from '@/app/api/app/auth/session/route';
import { createTestDb, type TestDb } from '../../support/db';
import { createTenantGraph, type TenantGraph } from '../db/fixtures';
import { makeRequest, NOW, seedIdentities, testConfig, uninstallRuntime, useRuntime, type Identity } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
let gamma: TenantGraph;
const clock = new FixedClock(NOW);
const config = testConfig('live');
const deps = () => ({ prisma: db, mode: 'live' as const, clock });

beforeAll(async () => {
  testDb = await createTestDb({ label: 'auth-context' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
  gamma = await createTenantGraph(db, 'gamma');
  await db.workspace.update({ where: { id: gamma.workspaceId }, data: { mode: 'LIVE' } });
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

async function sessionFor(userId: string, globalRole: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN', activeWorkspaceId: string | null = null) {
  const { token, session } = await createSession(db, { userId, globalRole, mode: 'LIVE', activeWorkspaceId, ipHash: 'x', userAgent: 'vitest', now: clock.now() });
  return { cookie: `__Host-aura_session=${token}`, csrf: csrfTokenFor(config.secrets.sessionSecret!, session.id), token };
}

async function ctxFor(userId: string, role: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN', opts: { active?: string | null; slug?: string } = {}): Promise<AppCtx> {
  const { token } = await sessionFor(userId, role, opts.active ?? null);
  const loaded = await loadSession(db, token, { now: clock.now(), mode: 'LIVE' });
  return buildUserContext(loaded!, deps(), { correlationId: 'req_test_context_0001', workspaceSlug: opts.slug });
}

// A probe route that reports the context it was given.
const probe = withRoute({ auth: 'session', body: z.object({ note: z.string() }) }, async ({ ctx, body }) => ({
  workspaceId: ctx.workspaceId,
  userId: ctx.actor?.userId ?? null,
  role: ctx.actor?.role ?? null,
  note: body.note,
}));
const wsProbe = withRoute({ auth: 'session', workspaceParam: 'ws' }, async ({ ctx }) => ({
  workspaceId: ctx.workspaceId,
  capabilities: [...ctx.capabilities].sort(),
  maxDiscountBps: ctx.maxDiscountBps,
}));
const manageProbe = withRoute({ auth: 'session', workspaceParam: 'ws', capability: 'integrations.manage' }, async ({ ctx }) => ({ ok: ctx.workspaceId }));
const params = (ws: string) => ({ params: Promise.resolve({ ws }) });

describe('browser-supplied identity is ignored', () => {
  it('uses the session workspace; a matching body workspaceId changes nothing', async () => {
    useRuntime(db, config, clock);
    const s = await sessionFor(ids.ownerId, 'USER', ids.workspaceAId);
    const res = await probe(makeRequest('/api/app/probe', { body: { note: 'hi', workspaceId: ids.workspaceAId }, cookie: s.cookie, csrf: s.csrf }), params(''));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: ids.workspaceAId, userId: ids.ownerId, role: 'USER', note: 'hi' });
  });

  it('a foreign workspaceId, userId or role in the body or query is a 404, not a switch', async () => {
    useRuntime(db, config, clock);
    const s = await sessionFor(ids.ownerId, 'USER', ids.workspaceAId);
    const attempts = [
      makeRequest('/api/app/probe', { body: { note: 'x', workspaceId: ids.workspaceBId }, cookie: s.cookie, csrf: s.csrf }),
      makeRequest('/api/app/probe', { body: { note: 'x', userId: ids.adminId }, cookie: s.cookie, csrf: s.csrf }),
      makeRequest('/api/app/probe', { body: { note: 'x', role: 'SUPER_ADMIN' }, cookie: s.cookie, csrf: s.csrf }),
      makeRequest(`/api/app/probe?workspaceId=${ids.workspaceBId}`, { body: { note: 'x' }, cookie: s.cookie, csrf: s.csrf }),
    ];
    for (const req of attempts) {
      const res = await probe(req, params(''));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    }
  });

  it('a stale activeWorkspaceId the user is not a member of falls back to their own membership', async () => {
    const ctx = await ctxFor(ids.ownerId, 'USER', { active: ids.workspaceBId });
    expect(ctx.workspaceId).toBe(ids.workspaceAId);
  });

  it('ctx.db is scoped: another tenant row is invisible by primary key', async () => {
    const ctx = await ctxFor(ids.ownerId, 'USER');
    expect(await ctx.db.lead.findUnique({ where: { id: gamma.leadId } })).toBeNull();
    expect(await ctx.db.quote.count()).toBe(0);
  });
});

describe('employees and capabilities', () => {
  it('an unassigned employee gets 404 for a workspace route', async () => {
    useRuntime(db, config, clock);
    const s = await sessionFor(ids.unassignedEmployeeId, 'EMPLOYEE');
    const res = await wsProbe(makeRequest('/dashboard/employee/alpha', { cookie: s.cookie }), params('alpha'));
    expect(res.status).toBe(404);
  });

  it('an assigned employee gets 404 for a workspace they are not assigned to, and 404 for an unknown slug', async () => {
    useRuntime(db, config, clock);
    const s = await sessionFor(ids.employeeId, 'EMPLOYEE');
    expect((await wsProbe(makeRequest('/x', { cookie: s.cookie }), params('beta'))).status).toBe(404);
    expect((await wsProbe(makeRequest('/x', { cookie: s.cookie }), params('no-such-ws'))).status).toBe(404);
  });

  it('an assigned employee gets exactly the granted capabilities and the lower discount cap', async () => {
    useRuntime(db, config, clock);
    const s = await sessionFor(ids.employeeId, 'EMPLOYEE');
    const res = await wsProbe(makeRequest('/x', { cookie: s.cookie }), params('alpha'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: ids.workspaceAId, capabilities: ['drafts.generate', 'leads.read'], maxDiscountBps: 500 });
  });

  it('a missing capability inside the tenant is 403; the owner holds every capability', async () => {
    useRuntime(db, config, clock);
    const emp = await sessionFor(ids.employeeId, 'EMPLOYEE');
    const denied = await manageProbe(makeRequest('/x', { cookie: emp.cookie }), params('alpha'));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe('FORBIDDEN');
    const member = await sessionFor(ids.memberId, 'USER');
    expect((await manageProbe(makeRequest('/x', { cookie: member.cookie }), params('alpha'))).status).toBe(403);
    const owner = await sessionFor(ids.ownerId, 'USER');
    expect((await manageProbe(makeRequest('/x', { cookie: owner.cookie }), params('alpha'))).status).toBe(200);
    const ownerCtx = await ctxFor(ids.ownerId, 'USER');
    expect([...ownerCtx.capabilities].sort()).toEqual([...CAPABILITIES].sort());
    expect(ownerCtx.maxDiscountBps).toBe(1500);
  });

  it('a deactivated assignment is a 404', async () => {
    await db.employeeAssignment.update({ where: { employeeUserId_workspaceId: { employeeUserId: ids.employeeId, workspaceId: ids.workspaceAId } }, data: { active: false } });
    try {
      useRuntime(db, config, clock);
      const s = await sessionFor(ids.employeeId, 'EMPLOYEE');
      expect((await wsProbe(makeRequest('/x', { cookie: s.cookie }), params('alpha'))).status).toBe(404);
    } finally {
      await db.employeeAssignment.update({ where: { employeeUserId_workspaceId: { employeeUserId: ids.employeeId, workspaceId: ids.workspaceAId } }, data: { active: true } });
    }
  });

  it('guards: role mismatch is 404, missing workspace is 404, missing capability is 403', async () => {
    const owner = await ctxFor(ids.ownerId, 'USER');
    expect(() => requireRole(owner, 'SUPER_ADMIN')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => requireCapability(owner, 'leads.read')).not.toThrow();
    const admin = await ctxFor(ids.adminId, 'SUPER_ADMIN');
    expect(admin.workspaceId).toBeNull();
    expect(() => requireWorkspace(admin)).toThrow(expect.objectContaining({ status: 404 }));
    const emp = await ctxFor(ids.employeeId, 'EMPLOYEE', { slug: 'alpha' });
    expect(() => requireCapability(emp, 'pipeline.manage')).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe('active workspace switch', () => {
  it('switches only to a workspace the actor belongs to; anything else is 404', async () => {
    useRuntime(db, config, clock);
    await db.membership.create({ data: { userId: ids.ownerId, workspaceId: ids.workspaceBId, role: 'MEMBER' } });
    try {
      const s = await sessionFor(ids.ownerId, 'USER', ids.workspaceAId);
      const sw = (slug: string) => switchPOST(makeRequest('/api/app/auth/active-workspace', { body: { workspaceSlug: slug }, cookie: s.cookie, csrf: s.csrf }), params(''));
      expect((await sw('gamma')).status).toBe(404);
      const ok = await sw('beta');
      expect(ok.status).toBe(200);
      const me = (await (await sessionGET(makeRequest('/api/app/auth/session', { cookie: s.cookie }), params(''))).json()) as {
        workspace: { id: string };
        capabilities: string[];
      };
      expect(me.workspace.id).toBe(ids.workspaceBId);
      expect(me.capabilities).not.toContain('integrations.manage');
      const emp = await sessionFor(ids.employeeId, 'EMPLOYEE');
      const empSwitch = await switchPOST(makeRequest('/api/app/auth/active-workspace', { body: { workspaceSlug: 'beta' }, cookie: emp.cookie, csrf: emp.csrf }), params(''));
      expect(empSwitch.status).toBe(404);
    } finally {
      await db.membership.delete({ where: { userId_workspaceId: { userId: ids.ownerId, workspaceId: ids.workspaceBId } } });
    }
  });
});

describe('adminContext', () => {
  it('writes and commits the AuditEvent before any tenant read', async () => {
    const ops: string[] = [];
    const spy = db.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            ops.push(`${model}.${operation}`);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { token } = await sessionFor(ids.adminId, 'SUPER_ADMIN');
    const loaded = await loadSession(db, token, { now: clock.now(), mode: 'LIVE' });
    const ctx = await buildUserContext(loaded!, { prisma: spy, mode: 'live', clock }, { correlationId: 'req_admin_context_01' });
    ops.length = 0;

    const elevated = await adminContext(ctx, gamma.workspaceId, 'Customer support ticket 42');
    const leads = await elevated.db.lead.findMany();

    expect(leads.map((l) => l.id)).toEqual([gamma.leadId]);
    const auditAt = ops.indexOf('AuditEvent.create');
    expect(auditAt).toBeGreaterThanOrEqual(0);
    expect(auditAt).toBeLessThan(ops.indexOf('Lead.findMany'));
    expect(elevated.workspaceId).toBe(gamma.workspaceId);
    expect(elevated.elevated?.reason).toBe('Customer support ticket 42');

    const audit = await db.auditEvent.findUniqueOrThrow({ where: { id: elevated.elevated!.auditEventId } });
    expect(audit).toMatchObject({
      workspaceId: gamma.workspaceId,
      actorUserId: ids.adminId,
      actorKind: 'SUPER_ADMIN',
      action: 'admin.elevate',
      targetType: 'Workspace',
      targetId: gamma.workspaceId,
      result: 'SUCCESS',
      crossWorkspace: true,
      reason: 'Customer support ticket 42',
      correlationId: 'req_admin_context_01',
    });
  });

  it('refuses non-admins and blank reasons without writing anything; unknown workspace is 404', async () => {
    const before = await db.auditEvent.count();
    const owner = await ctxFor(ids.ownerId, 'USER');
    await expect(adminContext(owner, gamma.workspaceId, 'curious')).rejects.toMatchObject({ status: 404 });
    const admin = await ctxFor(ids.adminId, 'SUPER_ADMIN');
    await expect(adminContext(admin, gamma.workspaceId, '   ')).rejects.toMatchObject({ status: 400 });
    await expect(adminContext(admin, 'no-such-workspace', 'support')).rejects.toMatchObject({ status: 404 });
    expect(await db.auditEvent.count()).toBe(before);
  });
});

describe('other contexts and the audit writer', () => {
  it('job, webhook and public contexts carry no actor; jobs and webhooks are scoped to their workspace', async () => {
    const job = getJobContext({ id: 'job_1', workspaceId: gamma.workspaceId, correlationId: 'req_job_00000001' }, deps());
    expect(job).toMatchObject({ kind: 'job', actor: null, workspaceId: gamma.workspaceId, causationId: 'job_1', mode: 'live' });
    expect(await job.db.lead.count()).toBe(1);
    const hook = getWebhookContext({ workspaceId: ids.workspaceAId }, deps(), 'req_hook_00000001');
    expect(hook).toMatchObject({ kind: 'webhook', actor: null, workspaceId: ids.workspaceAId });
    expect(hook.capabilities.size).toBe(0);
    const pub = publicContext(deps(), 'req_public_000001');
    expect(pub).toMatchObject({ kind: 'public', actor: null, workspaceId: null });
    await expect(pub.db.lead.count()).rejects.toMatchObject({ status: 404 });
  });

  it('records the audit row in the caller transaction with redacted summary and derived actor kind', async () => {
    const emp = await ctxFor(ids.employeeId, 'EMPLOYEE', { slug: 'alpha' });
    const event = await recordAudit(emp.db, emp, {
      action: 'lead.update',
      targetType: 'Lead',
      targetId: 'lead_x',
      summary: { fields: ['phoneE164', 'city'], phone: '+919812345678', note: 'call me at a@b.example' },
    });
    const row = await db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row).toMatchObject({ workspaceId: ids.workspaceAId, actorUserId: ids.employeeId, actorKind: 'EMPLOYEE', result: 'SUCCESS', crossWorkspace: false });
    expect(row.createdAt.toISOString()).toBe(NOW);
    const text = JSON.stringify(row.summary);
    expect(text).toContain('phoneE164');
    expect(text).not.toContain('9812345678');
    expect(text).not.toContain('a@b.example');

    // Rolled back together with the state change it describes.
    await expect(
      db.$transaction(async (tx) => {
        await recordAudit(tx, emp, { action: 'lead.update', targetType: 'Lead', targetId: 'lead_rollback' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.auditEvent.count({ where: { targetId: 'lead_rollback' } })).toBe(0);

    await expect(recordAudit(emp.db, emp, { action: 'x', targetType: 'Lead', targetId: 'y', workspaceId: ids.workspaceBId })).rejects.toMatchObject({ status: 404 });
  });
});
