/**
 * R33 (T29): platform-wide audit search for the super admin.
 *  - filters: actor (email or user id), action prefix, target type and id, workspace (slug or id),
 *    result, India calendar-day range (both ends inclusive) and correlation id, combinable;
 *  - keyset pagination, newest first, ties broken by id: no gaps, no repeats;
 *  - summaries and reasons are redacted again on read (never PII or secrets), and nothing can be
 *    exported beyond the redacted page;
 *  - GET /api/admin/audit is super admin only, refuses a browser-supplied `workspaceId` and unknown
 *    parameters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as auditGET } from '@/app/api/admin/audit/route';
import { searchAudit } from '@/server/services/admin/audit-search';
import { createLiveAdminHarness, liveCtx, liveSession, type LiveAdminHarness } from './live-support';
import { callRoute } from './support';

let h: LiveAdminHarness;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  h = await createLiveAdminHarness('admin-audit-search');
  const { db, ids } = h;
  const base = { result: 'SUCCESS' as const, summary: { fields: ['status'] }, crossWorkspace: false };
  await db.auditEvent.createMany({
    data: [
      { ...base, workspaceId: ids.workspaceAId, actorUserId: ids.ownerId, actorKind: 'USER', action: 'quote.approve', targetType: 'Quote', targetId: 'quote_1', correlationId: 'req_alpha_1', createdAt: at('2026-10-13T18:29:59.000Z') },
      { ...base, workspaceId: ids.workspaceAId, actorUserId: ids.ownerId, actorKind: 'USER', action: 'quote.send', targetType: 'Quote', targetId: 'quote_1', correlationId: 'req_alpha_1', createdAt: at('2026-10-13T18:30:00.000Z') },
      { ...base, workspaceId: ids.workspaceBId, actorUserId: ids.employeeId, actorKind: 'EMPLOYEE', action: 'lead.stage', targetType: 'Lead', targetId: 'lead_9', correlationId: 'req_beta_1', createdAt: at('2026-10-14T09:00:00.000Z') },
      { ...base, workspaceId: ids.workspaceBId, actorUserId: null, actorKind: 'WORKER', action: 'quote.expire', targetType: 'Quote', targetId: 'quote_2', correlationId: 'req_beta_2', result: 'FAILED', createdAt: at('2026-10-14T18:29:59.999Z') },
      { ...base, workspaceId: null, actorUserId: ids.adminId, actorKind: 'SUPER_ADMIN', action: 'system.outbound_pause', targetType: 'System', targetId: 'outbound', correlationId: 'req_admin_1', crossWorkspace: true, reason: 'Call me on +91 98765 43210 or ops@vendor.example', createdAt: at('2026-10-14T18:30:00.000Z') },
      {
        ...base,
        workspaceId: ids.workspaceAId,
        actorUserId: ids.memberId,
        actorKind: 'USER',
        action: 'lead.update',
        targetType: 'Lead',
        targetId: 'lead_1',
        correlationId: 'req_alpha_2',
        result: 'DENIED',
        summary: { fields: ['phoneE164'], phone: '+919876543210', note: 'mail asha@clinic.example', apiKey: 'sk-ant-abcdefghijklmnop' },
        createdAt: at('2026-10-15T03:00:00.000Z'),
      },
    ],
  });
  // 75 events in one burst for paging (several share a timestamp).
  await db.auditEvent.createMany({
    data: Array.from({ length: 75 }, (_, i) => ({
      ...base,
      workspaceId: ids.workspaceAId,
      actorUserId: ids.ownerId,
      actorKind: 'USER' as const,
      action: 'page.probe',
      targetType: 'Probe',
      targetId: `probe_${String(i).padStart(3, '0')}`,
      correlationId: 'req_paging',
      createdAt: new Date(at('2026-10-15T04:00:00.000Z').getTime() + Math.floor(i / 3) * 1000),
    })),
  });
}, 120_000);
afterAll(async () => h?.destroy());

const search = async (filter: Parameters<typeof searchAudit>[1]) => searchAudit(await liveCtx(h, h.ids.adminId), filter);
const ids = (rows: Array<{ targetId: string }>) => rows.map((r) => r.targetId);

describe('audit search filters', () => {
  it('by action prefix, target and result', async () => {
    expect(ids((await search({ action: 'quote.' })).rows)).toEqual(['quote_2', 'quote_1', 'quote_1']);
    expect((await search({ action: 'quote.send' })).rows.map((r) => r.action)).toEqual(['quote.send']);
    expect(ids((await search({ targetType: 'Lead' })).rows)).toEqual(['lead_1', 'lead_9']);
    expect(ids((await search({ targetType: 'Quote', targetId: 'quote_1' })).rows)).toEqual(['quote_1', 'quote_1']);
    expect(ids((await search({ result: 'FAILED' })).rows)).toEqual(['quote_2']);
    expect(ids((await search({ result: 'DENIED' })).rows)).toEqual(['lead_1']);
  });

  it('by actor email or id, workspace slug or id, and correlation id', async () => {
    const byEmail = await search({ actor: 'EMPLOYEE@example.test' });
    expect(ids(byEmail.rows)).toEqual(['lead_9']);
    expect(byEmail.rows[0]!.actor).toMatchObject({ id: h.ids.employeeId, name: 'employee', email: 'employee@example.test' });
    expect(ids((await search({ actor: h.ids.adminId })).rows)).toEqual(['outbound']);
    const unknown = await search({ actor: 'nobody@example.test' });
    expect(unknown.rows).toEqual([]);
    expect(unknown.unknownActor).toBe(true);

    expect(ids((await search({ workspace: 'beta' })).rows)).toEqual(['quote_2', 'lead_9']);
    expect(ids((await search({ workspace: h.ids.workspaceBId, action: 'lead.' })).rows)).toEqual(['lead_9']);
    expect((await search({ workspace: 'no-such-workspace' })).rows).toEqual([]);
    expect(ids((await search({ correlationId: 'req_alpha_1' })).rows)).toEqual(['quote_1', 'quote_1']);
  });

  it('by India calendar days, both ends inclusive', async () => {
    // 2026-10-14 IST is [2026-10-13T18:30Z, 2026-10-14T18:30Z).
    const day = await search({ from: '2026-10-14', to: '2026-10-14', action: 'quote.' });
    expect(day.rows.map((r) => r.action)).toEqual(['quote.expire', 'quote.send']);
    const lead = await search({ from: '2026-10-14', to: '2026-10-14', targetType: 'Lead' });
    expect(ids(lead.rows)).toEqual(['lead_9']);
    expect(ids((await search({ to: '2026-10-13', action: 'quote.' })).rows)).toEqual(['quote_1']);
    expect((await search({ from: '2026-10-15', targetType: 'System' })).rows.map((r) => r.action)).toEqual(['system.outbound_pause']);
  });
});

describe('audit search output', () => {
  it('redacts summaries and reasons again on read', async () => {
    const [lead] = (await search({ targetId: 'lead_1' })).rows;
    const text = JSON.stringify(lead);
    for (const leaked of ['9876543210', 'asha@clinic.example', 'sk-ant-abcdefghijklmnop']) expect(text).not.toContain(leaked);
    expect(lead!.summary).toMatchObject({ fields: ['phoneE164'] });
    const [pause] = (await search({ targetType: 'System' })).rows;
    expect(pause!.reason).not.toContain('98765');
    expect(pause!.reason).not.toContain('ops@vendor.example');
    expect(pause).toMatchObject({ crossWorkspace: true, workspace: null, actorKind: 'SUPER_ADMIN' });
  });

  it('pages newest first with a keyset cursor: no gaps, no repeats, ties broken by id', async () => {
    const seen: string[] = [];
    let before: string | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await search({ action: 'page.', before });
      sizes.push(page.rows.length);
      seen.push(...ids(page.rows));
      for (let i = 1; i < page.rows.length; i += 1) {
        const prev = page.rows[i - 1]!;
        const cur = page.rows[i]!;
        expect(prev.createdAt.getTime() > cur.createdAt.getTime() || (prev.createdAt.getTime() === cur.createdAt.getTime() && prev.id > cur.id)).toBe(true);
      }
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(sizes).toEqual([50, 25]);
    expect(seen).toHaveLength(75);
    expect(new Set(seen).size).toBe(75);
  });
});

describe('GET /api/admin/audit', () => {
  const get = (auth: Parameters<typeof callRoute>[2], query: string) => callRoute(auditGET, `/api/admin/audit${query}`, auth);

  it('is super admin only and answers the redacted page', async () => {
    const admin = await liveSession(h, h.ids.adminId);
    const res = await get(admin, '?action=quote.&workspace=alpha');
    expect(res.status).toBe(200);
    expect((res.body.rows as Array<{ targetId: string }>).map((r) => r.targetId)).toEqual(['quote_1', 'quote_1']);
    expect(res.body.nextCursor).toBeNull();
    expect((await get(null, '')).status).toBe(401);
    expect((await get(await liveSession(h, h.ids.ownerId), '')).status).toBe(404);
    expect((await get(await liveSession(h, h.ids.employeeId), '')).status).toBe(404);
  });

  it('refuses a browser-supplied workspaceId and unknown parameters', async () => {
    const admin = await liveSession(h, h.ids.adminId);
    expect((await get(admin, `?workspaceId=${h.ids.workspaceAId}`)).status).toBe(404);
    expect((await get(admin, '?format=csv')).status).toBe(400);
    expect((await get(admin, '?from=14-10-2026')).status).toBe(400);
  });
});
