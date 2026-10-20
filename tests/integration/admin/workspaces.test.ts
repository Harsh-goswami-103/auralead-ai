/**
 * R33 (T29): a super admin creates a workspace in LIVE, and it is immediately usable.
 *  - one transaction creates the workspace in the process mode with the production defaults
 *    (settings, scoring v1, pipeline v1 with human approval) and nothing else: no services, prices,
 *    leads, quotes or sample data;
 *  - its first owner gets a single-use invite shown once as a link (or, for an address that already
 *    belongs to a client user, the owner membership directly);
 *  - end to end: the owner opens the link, chooses a name and password, is signed in, and the
 *    client panel pages render for the new workspace with its empty states;
 *  - slugs are validated, reserved names refused and duplicates answered 409 with nothing written;
 *  - the workspace list shows only this mode's workspaces with owners and access counts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as acceptPOST } from '@/app/api/app/auth/invite/accept/route';
import { POST as createPOST } from '@/app/api/admin/workspaces/route';
import { POST as invitePOST } from '@/app/api/admin/people/invites/route';
import { validatePipelineConfig } from '@/server/services/pipeline/validator';
import { parseScoringConfig } from '@/lib/schemas/scoring';
import { getRequestContext } from '@/server/auth/context';
import { loadUserHome } from '@/server/services/shell/panel-home';
import { getWorkspaceAdminView, listWorkspaces } from '@/server/services/admin/workspaces';
import { invokePage } from '../../support/routes';
import { cookieFrom, makeRequest, noParams, ORIGIN, testEnv } from '../auth/support';
import { createLiveAdminHarness, liveCtx, liveSession, REASON, refillLimits, sessionAlive, type LiveAdminHarness } from './live-support';
import { callRoute, type AdminAuth } from './support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));

let h: LiveAdminHarness;
let admin: AdminAuth;
const savedEnv = { ...process.env };

beforeAll(async () => {
  h = await createLiveAdminHarness('admin-workspaces');
  // Pages that read the process config (getConfig) see the same LIVE config as the runtime.
  Object.assign(process.env, testEnv('live'), { NEXT_PUBLIC_APP_MODE: 'live' });
}, 120_000);
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await h?.destroy();
});
beforeEach(async () => {
  refillLimits(h);
  admin = await liveSession(h, h.ids.adminId);
});

const create = (auth: AdminAuth | null, body: Record<string, unknown>) =>
  callRoute(createPOST, '/api/admin/workspaces', auth, { body: { name: 'Asha Physiotherapy', planLabel: 'Starter', reason: REASON, ...body } });

const tokenOf = (link: unknown) => {
  const m = new RegExp(`^${ORIGIN}/invite/([A-Za-z0-9_-]{43})$`).exec(String(link));
  expect(m, String(link)).not.toBeNull();
  return m![1]!;
};

async function tenantCounts(workspaceId: string) {
  const where = { workspaceId };
  return {
    services: await h.db.service.count({ where }),
    pricingVersions: await h.db.pricingVersion.count({ where }),
    leads: await h.db.lead.count({ where }),
    quotes: await h.db.quote.count({ where }),
    integrations: await h.db.integration.count({ where }),
    conversations: await h.db.conversation.count({ where }),
  };
}

describe('creating a workspace', () => {
  it('creates it in this mode with production defaults only, plus a single-use owner invite, in one audited step', async () => {
    const res = await create(admin, { slug: 'asha-physio', ownerEmail: 'Founder@AshaPhysio.example' });
    expect(res.status).toBe(200);
    const created = res.body.workspace as { id: string; slug: string; name: string };
    expect(created).toMatchObject({ slug: 'asha-physio', name: 'Asha Physiotherapy' });
    expect(res.body.owner).toMatchObject({ kind: 'invite', email: 'founder@ashaphysio.example' });

    const ws = await h.db.workspace.findUniqueOrThrow({ where: { id: created.id }, include: { settings: true } });
    expect(ws).toMatchObject({ mode: 'LIVE', planLabel: 'Starter', timezone: 'Asia/Kolkata', status: 'ACTIVE', automationPaused: false });
    expect(ws.settings).toMatchObject({ autoSendEnabled: false, taxMode: 'NONE', quoteValidityDays: 15, currencyDisplay: 'INR', updatedBy: h.ids.adminId });

    const scoring = await h.db.scoringConfigVersion.findMany({ where: { workspaceId: ws.id } });
    expect(scoring).toHaveLength(1);
    expect(scoring[0]).toMatchObject({ version: 1, active: true });
    expect(() => parseScoringConfig(scoring[0]!.weights)).not.toThrow();
    const pipeline = await h.db.pipelineConfigVersion.findMany({ where: { workspaceId: ws.id } });
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0]).toMatchObject({ version: 1, active: true, approvalMode: 'HUMAN' });
    expect(validatePipelineConfig({ graph: pipeline[0]!.graph, approvalMode: 'HUMAN' }, { autoSendEnabled: false }).ok).toBe(true);

    expect(await tenantCounts(ws.id)).toEqual({ services: 0, pricingVersions: 0, leads: 0, quotes: 0, integrations: 0, conversations: 0 });
    expect(await h.db.membership.count({ where: { workspaceId: ws.id } })).toBe(0);

    const token = tokenOf((res.body.owner as { link: string }).link);
    const invite = await h.db.invite.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(invite).toMatchObject({ email: 'founder@ashaphysio.example', globalRole: 'USER', membershipRole: 'OWNER', createdBy: h.ids.adminId, redeemedAt: null });
    expect(JSON.stringify(invite)).not.toContain(token);

    const audits = await h.db.auditEvent.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action).sort()).toEqual(['invite.create', 'workspace.create']);
    for (const a of audits) {
      expect(a).toMatchObject({ actorUserId: h.ids.adminId, actorKind: 'SUPER_ADMIN', crossWorkspace: true, reason: REASON, result: 'SUCCESS' });
      expect(JSON.stringify(a)).not.toContain('founder@');
      expect(JSON.stringify(a)).not.toContain(token);
    }
  });

  it('the invited owner signs in through the link and the client panel opens on the new workspace with its empty states', async () => {
    const res = await create(admin, { name: 'Kaveri Yoga Studio', slug: 'kaveri-yoga', planLabel: 'Growth', timezone: 'Asia/Kolkata', ownerEmail: 'meera@kaveri.example' });
    expect(res.status).toBe(200);
    const workspaceId = (res.body.workspace as { id: string }).id;
    const token = tokenOf((res.body.owner as { link: string }).link);

    const accepted = await acceptPOST(makeRequest('/api/app/auth/invite/accept', { body: { token, name: 'Meera Iyer', password: 'kaveri owner long passphrase' } }), noParams);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ redirectTo: '/dashboard/user' });
    const cookie = cookieFrom(accepted);
    expect(cookie).not.toBeNull();

    // The session the browser now holds resolves to the new workspace with every owner capability.
    const { ctx, session } = await getRequestContext(
      makeRequest('/dashboard/user', { cookie }),
      { prisma: h.db, mode: 'live', clock: h.clock, config: h.config },
      { correlationId: 'req_owner_first_visit' },
    );
    expect(session.user).toMatchObject({ email: 'meera@kaveri.example', name: 'Meera Iyer', globalRole: 'USER', isDemo: false });
    expect(ctx.workspaceId).toBe(workspaceId);
    expect(ctx.capabilities.has('pricing.override')).toBe(true);
    expect(ctx.capabilities.has('approvals.decide')).toBe(true);

    const home = await loadUserHome(ctx);
    expect(home.workspace).toMatchObject({ name: 'Kaveri Yoga Studio', slug: 'kaveri-yoga', planLabel: 'Growth', role: 'OWNER' });
    expect(home.members).toEqual([{ name: 'Meera Iyer', role: 'OWNER' }]);
    expect(home.services).toEqual([]);
    expect(home.pricing).toBeNull();
    expect(home.scoring).toMatchObject({ version: 1 });
    expect(home.pipeline).toMatchObject({ version: 1, approvalMode: 'HUMAN', stages: ['Ingestion', 'Score', 'Draft', 'Approval', 'Delivery'] });
    expect(home.settings).toMatchObject({ taxMode: 'NONE', autoSendEnabled: false });

    // The real panel pages (layout + page) render for the new owner.
    pageHeaders.current = new Headers({ cookie: cookie! });
    for (const file of ['src/app/dashboard/user/page.tsx', 'src/app/dashboard/user/pricing/page.tsx', 'src/app/dashboard/user/quotations/page.tsx', 'src/app/dashboard/user/inbox/page.tsx']) {
      expect((await invokePage(file, {})).status, file).toBe(200);
    }
  });

  it('an address that already belongs to a client user becomes the owner directly (sessions revoked, no invite)', async () => {
    const existing = await liveSession(h, h.ids.memberId);
    const res = await create(admin, { name: 'Alpha Smiles Annexe', slug: 'alpha-annexe', ownerEmail: 'member@alpha.test' });
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({ kind: 'membership', email: 'member@alpha.test' });
    expect(res.body.owner).not.toHaveProperty('link');
    const workspaceId = (res.body.workspace as { id: string }).id;
    expect(await h.db.membership.findFirst({ where: { userId: h.ids.memberId, workspaceId } })).toMatchObject({ role: 'OWNER' });
    expect(await h.db.invite.count({ where: { workspaceId } })).toBe(0);
    expect(await sessionAlive(h, existing.token)).toBe(false);
    expect(await h.db.auditEvent.count({ where: { workspaceId, action: 'membership.set', targetId: h.ids.memberId } })).toBe(1);
  });

  it('refuses an owner address held by staff, a demo user, or a disabled account, with nothing written', async () => {
    await h.db.user.create({ data: { email: 'left@alpha.test', name: 'Left', globalRole: 'USER', status: 'DISABLED' } });
    const before = await h.db.workspace.count();
    for (const ownerEmail of ['employee@example.test', 'admin@example.test', 'demo-owner@alpha.test', 'left@alpha.test']) {
      const res = await create(admin, { slug: `refused-${before}`, ownerEmail });
      expect(res.status, ownerEmail).toBe(409);
      expect(res.body.code).toBe('EMAIL_IN_USE');
    }
    expect(await h.db.workspace.count()).toBe(before);
  });

  it('validates the slug and time zone, refuses reserved and duplicate slugs, and writes nothing on failure', async () => {
    const before = { workspaces: await h.db.workspace.count(), invites: await h.db.invite.count(), audits: await h.db.auditEvent.count() };
    expect((await create(admin, { slug: 'Not A Slug', ownerEmail: 'x1@example.test' })).status).toBe(400);
    const reserved = await create(admin, { slug: 'approvals', ownerEmail: 'x2@example.test' });
    expect(reserved.status).toBe(422);
    expect(reserved.body.code).toBe('SLUG_RESERVED');
    const tz = await create(admin, { slug: 'tz-check', timezone: 'Mars/Olympus', ownerEmail: 'x3@example.test' });
    expect(tz.status).toBe(422);
    expect(tz.body.code).toBe('TIMEZONE_INVALID');
    const dup = await create(admin, { slug: 'alpha', ownerEmail: 'x4@example.test' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SLUG_TAKEN');
    expect({ workspaces: await h.db.workspace.count(), invites: await h.db.invite.count(), audits: await h.db.auditEvent.count() }).toEqual(before);
  });

  it('is super admin only with a fresh sign-in', async () => {
    expect((await create(null, { slug: 'nope-1', ownerEmail: 'n1@example.test' })).status).toBe(401);
    expect((await create(await liveSession(h, h.ids.ownerId), { slug: 'nope-2', ownerEmail: 'n2@example.test' })).status).toBe(404);
    const stale = await liveSession(h, h.ids.adminId, { createdAt: new Date(h.clock.now().getTime() - 30 * 60_000) });
    const res = await create(stale, { slug: 'nope-3', ownerEmail: 'n3@example.test' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
    expect(await h.db.workspace.count({ where: { slug: { startsWith: 'nope-' } } })).toBe(0);
  });
});

describe('workspace read models', () => {
  it('lists only this mode with owners, member and assignment counts, and pending invites', async () => {
    await h.db.workspace.create({ data: { slug: 'a-demo-tenant', name: 'Demo Tenant', mode: 'DEMO', planLabel: 'Solo' } });
    const ctx = await liveCtx(h, h.ids.adminId);
    const rows = await listWorkspaces(ctx);
    expect(rows.map((r) => r.slug)).not.toContain('a-demo-tenant');
    const alpha = rows.find((r) => r.slug === 'alpha')!;
    expect(alpha.owners.map((o) => o.email)).toEqual(['owner@alpha.test']);
    expect(alpha).toMatchObject({ memberCount: 1, activeAssignments: 1 });
    const asha = rows.find((r) => r.slug === 'asha-physio')!;
    expect(asha).toMatchObject({ owners: [], pendingInvites: 1 });

    const view = await getWorkspaceAdminView(ctx, asha.id);
    expect(view.invites).toEqual([expect.objectContaining({ email: 'founder@ashaphysio.example', membershipRole: 'OWNER' })]);
    expect(JSON.stringify(view)).not.toMatch(/tokenHash/);
    const demo = await h.db.workspace.findUniqueOrThrow({ where: { slug: 'a-demo-tenant' } });
    await expect(getWorkspaceAdminView(ctx, demo.id)).rejects.toMatchObject({ status: 404 });
  });

  it('a member invited into the new workspace through People joins it', async () => {
    const ws = await h.db.workspace.findUniqueOrThrow({ where: { slug: 'kaveri-yoga' } });
    const res = await callRoute(invitePOST, '/api/admin/people/invites', admin, { body: { email: 'front.desk@kaveri.example', globalRole: 'USER', targetWorkspaceId: ws.id, membershipRole: 'MEMBER', reason: REASON } });
    expect(res.status).toBe(200);
    const token = tokenOf(res.body.link);
    const accepted = await acceptPOST(makeRequest('/api/app/auth/invite/accept', { body: { token, name: 'Front Desk', password: 'front desk long passphrase' } }), noParams);
    expect(accepted.status).toBe(200);
    const ctx = await liveCtx(h, (await h.db.user.findUniqueOrThrow({ where: { email: 'front.desk@kaveri.example' } })).id);
    expect(ctx.workspaceId).toBe(ws.id);
    expect(ctx.capabilities.has('pricing.override')).toBe(false);
  });
});
