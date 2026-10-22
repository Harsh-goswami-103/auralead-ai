// T28 Sheets setup, Meta console and Extension hub read models (PRD "Employee": Sheets/Form setup
// with config, mapping, sync status and simulation; Meta console with metrics, spend, leads, CPL
// and its lead events; Extension hub with scoped keys, batch status, per-row errors, example payload
// and simulation). They show the configuration state the live adapters (T34-T36) fill and the
// DEMO simulations (the same `simulateSource` service as POST /api/demo/simulate/[source], so a
// simulated delivery appears here exactly like a live one). Every read needs `leads.read`; the
// simulation gate is DEMO + `leads.write`; token secrets never leave the service.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '@/lib/errors';
import { extensionBatchSchema } from '@/lib/schemas/webhooks';
import { getExtensionHub, getMetaConsole, getSheetsSetup } from '@/server/services/integrations/source-pages';
import { simulateSource } from '@/server/services/webhooks/simulate';
import { seedId } from '../../../prisma/seed/ids';
import { userCtx } from '../quotes/support';
import { createIntegrationsHarness, employeeCtx, KEY_RING, liveOwnerCtx, nehaCtx, NOW, WS_A, WS_KESARI_SLUG, type IntegrationsHarness } from './support';

let h: IntegrationsHarness;
const SIM_DEPS = { keyRing: KEY_RING };

beforeAll(async () => {
  h = await createIntegrationsHarness('integration-source-pages');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

describe('Sheets setup', () => {
  it('before anything: Not configured, no mapping, no events, simulation allowed in DEMO', async () => {
    const view = await getSheetsSetup(await employeeCtx(h));
    expect(view.integration.status).toBe('NOT_CONFIGURED');
    expect(view.mapping).toBeNull();
    expect(view.events).toEqual([]);
    expect(view.simulation).toEqual({ allowed: true });
    expect(view.canManage).toBe(true);
  });

  it('a simulated push shows the simulated integration, the consent mapping and the queued event', async () => {
    const ctx = await employeeCtx(h);
    await simulateSource(ctx, { source: 'sheets', count: 2 }, SIM_DEPS);
    const view = await getSheetsSetup(ctx);
    expect(view.integration).toMatchObject({ status: 'SIMULATED', stored: true });
    expect(view.sheetId).toBe('demo-sheet-smile-avenue-dental');
    expect(view.mapping).toMatchObject({ version: 1, active: true });
    expect(view.mapping!.fields).toContainEqual({ field: 'phone', column: 'Phone number' });
    expect(view.mapping!.consent).toMatchObject({ column: 'WhatsApp updates', truthyValues: ['Yes'], channel: 'WHATSAPP', purpose: 'MARKETING' });
    expect(view.mapping!.consent!.noticeTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]).toMatchObject({ status: 'RECEIVED', simulated: true, counts: null });
  });

  it('lists per-row failures with plain reasons', async () => {
    await h.db.leadSourceRecord.create({
      data: { workspaceId: WS_A, source: 'GOOGLE_SHEETS', externalId: 'sheet-row-bad-1', status: 'REJECTED', reasonCode: 'NO_VALID_CONTACT', rawPayloadRedacted: {}, attribution: {}, receivedAt: new Date(NOW) },
    });
    const view = await getSheetsSetup(await employeeCtx(h));
    expect(view.rowIssues[0]).toMatchObject({ externalId: 'sheet-row-bad-1', status: 'REJECTED', reasonCode: 'NO_VALID_CONTACT' });
  });

  it('gates the simulation: permission without leads.write, mode in LIVE', async () => {
    expect((await getSheetsSetup(await nehaCtx(h))).simulation).toMatchObject({ allowed: false, category: 'permission' });
    expect((await getSheetsSetup(await nehaCtx(h))).canManage).toBe(false);
    const live = await getSheetsSetup(await liveOwnerCtx(h));
    expect(live.simulation).toMatchObject({ allowed: false, category: 'mode' });
    expect(live.integration).toMatchObject({ status: 'NOT_CONFIGURED', simulated: false });
  });
});

describe('Meta console', () => {
  it('a simulated lead shows the simulated integration, the form mapping and the event', async () => {
    const ctx = await employeeCtx(h);
    await simulateSource(ctx, { source: 'meta', count: 1 }, SIM_DEPS);
    const view = await getMetaConsole(ctx);
    expect(view.integration.status).toBe('SIMULATED');
    expect(view.forms).toHaveLength(1);
    expect(view.forms[0]!.consent).toMatchObject({ channel: 'WHATSAPP' });
    expect(view.events).toHaveLength(1);
    expect(view.campaigns).toEqual([]);
    expect(view.canControlCampaigns).toBe(true);
  });

  it('shows campaigns in the ad account currency with the snapshot window and As of time', async () => {
    const campaign = await h.db.campaign.create({ data: { workspaceId: WS_A, providerCampaignId: 'cmp-1', name: 'Diwali whitening', currency: 'INR', configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE', simulated: true } });
    await h.db.campaignMetricSnapshot.create({
      data: { workspaceId: WS_A, campaignId: campaign.id, dateStart: new Date('2026-10-09T00:00:00Z'), dateStop: new Date('2026-10-15T00:00:00Z'), spendMinor: 1234500n, leads: 41, cplMinor: 30110n, attributionSetting: '7d_click', asOf: new Date(NOW) },
    });
    const view = await getMetaConsole(await employeeCtx(h));
    expect(view.campaigns).toEqual([
      expect.objectContaining({
        name: 'Diwali whitening',
        currency: 'INR',
        configuredStatus: 'ACTIVE',
        effectiveStatus: 'ACTIVE',
        simulated: true,
        latest: { spendMinor: '1234500', leads: 41, cplMinor: '30110', dateStart: new Date('2026-10-09T00:00:00Z'), dateStop: new Date('2026-10-15T00:00:00Z'), attributionSetting: '7d_click', asOf: new Date(NOW) },
      }),
    ]);
  });

  it('campaign control is a separate capability', async () => {
    const view = await getMetaConsole(await employeeCtx(h, WS_KESARI_SLUG));
    expect(view.canControlCampaigns).toBe(false);
  });
});

describe('Extension hub', () => {
  it('lists tokens by prefix and state, never their hash', async () => {
    await h.db.extensionToken.create({ data: { workspaceId: WS_A, name: 'Front desk laptop', prefix: 'alx_k1front', secretHash: 'f'.repeat(64), scopes: ['ingest:gmaps'], allowedExtensionId: 'abcdefghijklmnopabcdefghijklmnop', createdBy: seedId('user', 'employee'), createdAt: new Date(NOW) } });
    await h.db.extensionToken.create({ data: { workspaceId: WS_A, name: 'Old key', prefix: 'alx_k0old', secretHash: 'e'.repeat(64), scopes: ['ingest:gmaps'], createdBy: seedId('user', 'employee'), createdAt: new Date(NOW), revokedAt: new Date(NOW) } });
    const view = await getExtensionHub(await employeeCtx(h));
    expect(view.tokens.map((t) => [t.prefix, t.state])).toEqual([
      ['alx_k1front', 'ACTIVE'],
      ['alx_k0old', 'REVOKED'],
    ]);
    expect(JSON.stringify(view)).not.toContain('f'.repeat(64));
    expect(view.canManage).toBe(true);
  });

  it('lists batches with counts and the example payload validates against the batch schema', async () => {
    const ctx = await employeeCtx(h);
    await h.db.importBatch.create({
      data: { workspaceId: WS_A, source: 'GMAPS_EXTENSION', externalBatchId: 'batch-48', bodyHash: 'a'.repeat(64), status: 'PARTIAL', counts: { received: 48, accepted: 45, duplicate: 2, review: 0, rejected: 1 }, simulated: true, createdAt: new Date(NOW) },
    });
    const view = await getExtensionHub(ctx);
    expect(view.batches[0]).toMatchObject({ externalBatchId: 'batch-48', status: 'PARTIAL', simulated: true, counts: { received: 48, accepted: 45, duplicate: 2, review: 0, rejected: 1 } });
    expect(extensionBatchSchema.safeParse(view.examplePayload).success).toBe(true);
    expect(view.simulation).toEqual({ allowed: true });
  });

  it('every source page needs leads.read (403)', async () => {
    const pixel = await h.db.workspace.findUniqueOrThrow({ where: { slug: 'pixelchai-studio' } });
    await h.db.employeeAssignment.create({ data: { employeeUserId: seedId('user', 'arjun'), workspaceId: pixel.id, capabilities: ['sheets.manage'], createdBy: seedId('user', 'admin') } });
    const ctx = await userCtx(h.db, h.clock, 'arjun', 'pixelchai-studio');
    for (const read of [getSheetsSetup, getMetaConsole, getExtensionHub]) await expect(read(ctx)).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
