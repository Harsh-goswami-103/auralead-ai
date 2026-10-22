// T28 Employee assignment overview (06-design §11.2.2 "Employee overview: assigned workspaces with
// counts needing action, cross-workspace approval count, integration health summary per
// workspace"). Each workspace is read through its own tenant-scoped context; counts are real
// counts of stored rows (no invented numbers), and a workspace where the assignment lacks
// `leads.read` reports its approvals as not readable (null) instead of zero.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getWorkspaceOverview } from '@/server/services/shell/employee-overview';
import { seedId } from '../../../prisma/seed/ids';
import { userCtx } from '../quotes/support';
import { createIntegrationsHarness, employeeCtx, nehaCtx, NOW, WS_A, type IntegrationsHarness } from './support';

let h: IntegrationsHarness;

beforeAll(async () => {
  h = await createIntegrationsHarness('employee-overview');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

describe('workspace overview', () => {
  it('counts pending approvals, integration health and the active pipeline from stored rows', async () => {
    const ctx = await nehaCtx(h);
    const overview = await getWorkspaceOverview(ctx);
    const ironpulse = seedId('workspace', 'ironpulse-fitness');
    expect(overview.pendingApprovals).toBe(await h.db.approval.count({ where: { workspaceId: ironpulse, status: 'PENDING' } }));
    expect(overview.pendingApprovals).toBeGreaterThanOrEqual(1);
    expect(overview.integrations).toEqual({ total: 8, connected: 0, simulated: 0, attention: 0, notConfigured: 8 });
    expect(overview.pipeline).toEqual({ version: 1, approvalMode: 'HUMAN' });
  });

  it('counts simulated and attention integrations separately and new leads in the last 7 days', async () => {
    await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'GOOGLE_SHEETS', status: 'SIMULATED', config: {} } });
    await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'EMAIL_SMTP', status: 'ERROR', config: {} } });
    const now = new Date(NOW);
    for (const [name, daysAgo] of [
      ['Fresh lead', 1],
      ['Old lead', 9],
    ] as const) {
      await h.db.lead.create({
        data: { workspaceId: WS_A, displayName: name, nameNormalized: name.toLowerCase(), alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL', createdAt: new Date(now.getTime() - daysAgo * 86_400_000) },
      });
    }
    const overview = await getWorkspaceOverview(await employeeCtx(h));
    expect(overview.integrations).toEqual({ total: 8, connected: 0, simulated: 1, attention: 1, notConfigured: 6 });
    expect(overview.newLeads7d).toBe(await h.db.lead.count({ where: { workspaceId: WS_A, mergedIntoLeadId: null, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }));
    expect(overview.newLeads7d).toBeGreaterThanOrEqual(1);
  });

  it('without leads.read the lead and approval counts are not readable (null)', async () => {
    const pixel = await h.db.workspace.findUniqueOrThrow({ where: { slug: 'pixelchai-studio' } });
    await h.db.employeeAssignment.create({ data: { employeeUserId: seedId('user', 'arjun'), workspaceId: pixel.id, capabilities: ['integrations.manage'], createdBy: seedId('user', 'admin') } });
    const overview = await getWorkspaceOverview(await userCtx(h.db, h.clock, 'arjun', 'pixelchai-studio'));
    expect(overview.pendingApprovals).toBeNull();
    expect(overview.newLeads7d).toBeNull();
    expect(overview.integrations.total).toBe(8);
  });
});
