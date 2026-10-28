// ADR-118 (b), (d), adversarial review: the lead profile's `places` block, which feeds the Google
// Maps attribution and the "Confirm details" gate on the operator's and the client's lead pages.
// - LIVE: the attributions Google returned with the place (while the finder still holds them; the
//   24-hour purge removes them), and canConfirm for a person who may write leads.
// - canConfirm is false without leads.write and for a lead merged into another; a lead that did not
//   come from Places has no block.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { loadLeadProfile } from '@/server/services/leads/profile';
import { createLead } from '../dispatch/support';
import { placesAnswer, SEARCH_PATH } from './places-support';
import { createDemoHarness, createLiveHarness, DAY, drain, HOUR, INGEST, NOW, PEPPER, storePlacesKey, WS_A, WS_B, type DemoHarness, type LiveHarness } from './support';

const deps = { contactKeyPepper: PEPPER };

describe('LIVE', () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await createLiveHarness('finder-profile-live');
    await storePlacesKey(h);
  }, 120_000);
  afterAll(async () => h?.destroy());

  it('carries the partner attributions while the finder holds them, none after the purge; canConfirm false once merged', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'));
    const ctx = await h.owner();
    const { run } = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'profile-live-1', keywords: ['dentist'], locations: ['Indore'], maxPerQuery: 20 }), h.deps());
    await drain(h.worker);
    const rows = await h.db.leadFinderResult.findMany({ where: { runId: run.id, placeId: { in: ['ChIJF1nderFixtureRoyalDental02', 'ChIJF1nderFixtureSmileDental01'] } } });
    const royal = rows.find((r) => r.placeId === 'ChIJF1nderFixtureRoyalDental02')!;
    const smile = rows.find((r) => r.placeId === 'ChIJF1nderFixtureSmileDental01')!;
    const imported = await importFinderResults(ctx, { runId: run.id, resultIds: [royal.id, smile.id], requestKey: 'profile-live-import' }, INGEST);
    const royalLead = imported.results.find((r) => r.resultId === royal.id)!.leadId!;
    const smileLead = imported.results.find((r) => r.resultId === smile.id)!.leadId!;

    const live = await loadLeadProfile(ctx, royalLead, deps);
    expect(live.lead.simulated).toBe(false);
    expect(live.places).toMatchObject({ canConfirm: true, confirmedAt: null, attributions: [{ provider: 'Fixture Listings Partner', providerUri: 'https://partner.example.com/' }] });
    expect(live.places!.expiresAt).not.toBeNull();

    h.clock.set(new Date(new Date(NOW).getTime() + DAY + 2 * HOUR).toISOString());
    await drain(h.worker);
    expect((await loadLeadProfile(ctx, royalLead, deps)).places!.attributions).toEqual([]);

    await h.db.lead.update({ where: { id: royalLead }, data: { mergedIntoLeadId: smileLead } });
    expect((await loadLeadProfile(ctx, royalLead, deps)).places!.canConfirm).toBe(false);
    h.clock.set(NOW);
  });
});

describe('DEMO', () => {
  let h: DemoHarness;
  beforeAll(async () => {
    h = await createDemoHarness('finder-profile-demo');
  }, 120_000);
  afterAll(async () => h?.testDb.destroy());

  it('shows no Google attributions for a simulated Places lead, gates canConfirm on leads.write, and has no block for other leads', async () => {
    const operator = await h.operator();
    const plain = await createLead(h.db, { workspaceId: WS_A });
    expect((await loadLeadProfile(operator, plain.id, deps)).places).toBeNull();

    // A lead of workspace B that came from Places, read by a person who holds leads.read only.
    const lead = await createLead(h.db, { workspaceId: WS_B });
    await h.db.lead.update({ where: { id: lead.id }, data: { placeId: 'ChIJprofiledemo00001', simulated: true } });
    const reader = await h.reader();
    expect((await loadLeadProfile(reader, lead.id, deps)).places).toMatchObject({ canConfirm: false, attributions: [] });
  });
});
