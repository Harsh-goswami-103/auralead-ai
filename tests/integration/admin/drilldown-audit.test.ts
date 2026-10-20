/**
 * R33 (T29): the super admin's workspace drilldown.
 *  - it goes through `adminContext`: the `admin.elevate` AuditEvent (reason, crossWorkspace, the
 *    workspace) is written and committed before any tenant row is read;
 *  - it needs a typed reason and a sign-in within 15 minutes; a refused request writes no audit
 *    row and reads nothing;
 *  - it is super admin only: a workspace owner or an employee gets 404 (plan §4.1, A6: a panel the
 *    actor cannot use does not exist for them; ADR-86), anonymous 401;
 *  - it is read-only and aggregate: counts, configuration and redacted activity, never a lead's
 *    name, phone or message;
 *  - a workspace of the other mode, or one that does not exist, is 404 with nothing recorded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { POST as drilldownPOST } from '@/app/api/admin/workspaces/[workspaceId]/drilldown/route';
import { buildUserContext } from '@/server/auth/context';
import { loadSession } from '@/server/auth/session';
import { REQUIRED_TENANT_MODELS } from '@/server/db/scoped';
import { openWorkspaceDrilldown } from '@/server/services/admin/workspaces';
import { createTenantGraph, type TenantGraph } from '../db/fixtures';
import { createLiveAdminHarness, liveSession, REASON, refillLimits, type LiveAdminHarness } from './live-support';
import { callRoute, type AdminAuth } from './support';

let h: LiveAdminHarness;
let gamma: TenantGraph;
let admin: AdminAuth;

beforeAll(async () => {
  h = await createLiveAdminHarness('admin-drilldown');
  gamma = await createTenantGraph(h.db, 'gamma');
  await h.db.workspace.update({ where: { id: gamma.workspaceId }, data: { mode: 'LIVE' } });
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(async () => {
  refillLimits(h);
  admin = await liveSession(h, h.ids.adminId);
});

const open = (auth: AdminAuth | null, workspaceId: string, body: Record<string, unknown> = { reason: REASON }) =>
  callRoute(drilldownPOST, `/api/admin/workspaces/${workspaceId}/drilldown`, auth, { body, params: { workspaceId } });

const elevations = (workspaceId: string) => h.db.auditEvent.count({ where: { action: 'admin.elevate', targetId: workspaceId } });

describe('workspace drilldown', () => {
  it('commits the admin.elevate AuditEvent before any tenant row is read', async () => {
    const ops: string[] = [];
    const spy = h.db.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            ops.push(`${model}.${operation}`);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { token } = await liveSession(h, h.ids.adminId);
    const loaded = (await loadSession(h.db, token, { now: h.clock.now(), mode: 'LIVE' }))!;
    const ctx = await buildUserContext(loaded, { prisma: spy, mode: 'live', clock: h.clock }, { correlationId: 'req_drilldown_order' });
    ops.length = 0;

    const view = await openWorkspaceDrilldown(ctx, { workspaceId: gamma.workspaceId, reason: 'Support ticket 4411: quote totals look wrong' });

    const auditAt = ops.indexOf('AuditEvent.create');
    expect(auditAt).toBeGreaterThanOrEqual(0);
    const before = ops.slice(0, auditAt);
    expect(before.every((op) => /^(Workspace|User|Session)\./.test(op)), before.join(', ')).toBe(true);
    const tenantReads = ops.slice(auditAt + 1).filter((op) => (REQUIRED_TENANT_MODELS as readonly string[]).some((m) => op.startsWith(`${m}.`)));
    expect(tenantReads.length).toBeGreaterThan(0);

    const audit = await h.db.auditEvent.findUniqueOrThrow({ where: { id: view.audit.eventId } });
    expect(audit).toMatchObject({
      action: 'admin.elevate',
      targetType: 'Workspace',
      targetId: gamma.workspaceId,
      workspaceId: gamma.workspaceId,
      actorUserId: h.ids.adminId,
      actorKind: 'SUPER_ADMIN',
      crossWorkspace: true,
      reason: 'Support ticket 4411: quote totals look wrong',
      correlationId: 'req_drilldown_order',
    });
    expect(view.audit.reason).toBe('Support ticket 4411: quote totals look wrong');
  });

  it('answers aggregates and configuration only: no lead names, phones or message text', async () => {
    const res = await open(admin, gamma.workspaceId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspace: { id: gamma.workspaceId, slug: 'gamma', mode: 'LIVE' },
      leads: { total: 1 },
      quotes: { total: 1 },
      configuration: { pricingVersion: 1, services: 1, pricedServices: 1 },
      audit: { reason: REASON },
    });
    const text = JSON.stringify(res.body);
    for (const secret of ['Lead gamma', '9800000001', 'ck-gamma', 'Hello']) expect(text).not.toContain(secret);
    const recent = res.body.recentActivity as Array<{ action: string }>;
    expect(recent.map((r) => r.action)).toContain('admin.elevate');
  });

  it('records every opening separately', async () => {
    const before = await elevations(gamma.workspaceId);
    expect((await open(admin, gamma.workspaceId)).status).toBe(200);
    expect((await open(admin, gamma.workspaceId)).status).toBe(200);
    expect(await elevations(gamma.workspaceId)).toBe(before + 2);
  });

  it('is super admin only: owner and employees 404, anonymous 401, and nothing is recorded', async () => {
    const before = await elevations(gamma.workspaceId);
    expect((await open(null, gamma.workspaceId)).status).toBe(401);
    expect((await open(await liveSession(h, h.ids.ownerId), gamma.workspaceId)).status).toBe(404);
    expect((await open(await liveSession(h, h.ids.employeeId), gamma.workspaceId)).status).toBe(404);
    expect((await open(await liveSession(h, h.ids.unassignedEmployeeId), gamma.workspaceId)).status).toBe(404);
    expect(await elevations(gamma.workspaceId)).toBe(before);
  });

  it('needs a fresh sign-in and a reason; a refusal records and reads nothing', async () => {
    const before = await elevations(gamma.workspaceId);
    const stale = await liveSession(h, h.ids.adminId, { createdAt: new Date(h.clock.now().getTime() - 20 * 60_000) });
    const refused = await open(stale, gamma.workspaceId);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('REAUTH_REQUIRED');
    expect((await open(admin, gamma.workspaceId, {})).status).toBe(400);
    expect((await open(admin, gamma.workspaceId, { reason: 'x' })).status).toBe(400);
    expect(await elevations(gamma.workspaceId)).toBe(before);
  });

  it('a workspace of the other mode or an unknown id is 404 with nothing recorded', async () => {
    const demo = await h.db.workspace.create({ data: { slug: 'demo-only', name: 'Demo Only', mode: 'DEMO', planLabel: 'Solo' } });
    expect((await open(admin, demo.id)).status).toBe(404);
    expect((await open(admin, 'nosuchworkspace0000000000')).status).toBe(404);
    expect(await elevations(demo.id)).toBe(0);
    expect(await h.db.auditEvent.count({ where: { action: 'admin.elevate', targetId: 'nosuchworkspace0000000000' } })).toBe(0);
  });
});
