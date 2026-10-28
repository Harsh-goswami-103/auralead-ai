// Adversarial review of ADR-118 (d): Google Places content must not outlive its expiry, and the
// 30-day sweep must not take the phone from a lead the business is already talking to.
// - The source record kept for an imported Places listing holds the place ID and field names only.
// - The sweep rescored what it blanked, so no "Rated 4.5 of 5" / "N reviews" text survives it.
// - A handed-over lead, a lead with a quote and a lead whose customer wrote in keep their phone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob } from '@/server/jobs/handlers/lead-finder-search';
import { createLeadsPlacesExpireJob } from '@/server/jobs/handlers/leads-places-expire';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { loadActiveScoringConfig } from '@/server/services/scoring/config';
import { scoreData, scoreInputOf } from '@/server/services/scoring/record';
import { scoreLead } from '@/server/services/scoring/score';
import { seedId } from '../../../prisma/seed/ids';
import { createDemoHarness, DAY, drain, INGEST, NOW, workerFor, WS_A, type DemoHarness } from './support';

describe('Places retention', () => {
  let h: DemoHarness;
  beforeAll(async () => {
    h = await createDemoHarness('finder-places-retention');
  }, 120_000);
  afterAll(async () => h?.testDb.destroy());

  it('keeps no Places content in the source record, rescored reasons, and spares leads in a relationship', async () => {
    const ctx = await h.operator();
    const w = workerFor(h.db, h.clock, 'demo', [
      createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }),
      createLeadFinderPurgeJob({ mode: () => 'demo' }),
      createLeadsPlacesExpireJob({ mode: () => 'demo' }),
    ]);
    const { run } = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'places-retention-1', keywords: ['gym'], locations: ['Bhopal'], maxPerQuery: 20 }), { keyRing: null });
    await drain(w);
    const picks = await h.db.leadFinderResult.findMany({ where: { runId: run.id, hasPhone: true }, take: 5, orderBy: { createdAt: 'asc' } });
    expect(picks.length).toBeGreaterThanOrEqual(5);
    const imported = await importFinderResults(ctx, { runId: run.id, resultIds: picks.map((p) => p.id), requestKey: 'places-retention-import-1' }, INGEST);
    const [handedId, quotedId, wroteId, plainId, rescoreId] = imported.results.map((r) => r.leadId!);

    // 1. The kept source records name no Places content.
    const records = await h.db.leadSourceRecord.findMany({ where: { workspaceId: WS_A, source: 'GOOGLE_PLACES', leadId: { in: imported.results.map((r) => r.leadId!) } } });
    expect(records).toHaveLength(5);
    const raw = JSON.stringify(records.map((r) => r.rawPayloadRedacted));
    for (const p of picks) {
      for (const value of [p.name, p.website, p.city, p.category, p.pincode, p.address].filter((v): v is string => typeof v === 'string' && v !== '')) expect(raw).not.toContain(value);
    }
    for (const r of records) expect(r.rawPayloadRedacted).not.toHaveProperty('fields');
    for (const r of records) expect(JSON.parse(JSON.stringify(r.rawPayloadRedacted))).toMatchObject({ providerId: expect.any(String) });

    // 2. Relationships: a hand-over, a quote and an inbound conversation are exempt from the sweep.
    await h.db.lead.update({ where: { id: handedId! }, data: { handedOverAt: new Date(NOW) } });
    const user = seedId('user', 'owner');
    await h.db.quote.create({ data: { workspaceId: WS_A, leadId: quotedId!, number: 'Q-9901', createdBy: user } });
    await h.db.conversation.create({ data: { workspaceId: WS_A, leadId: wroteId!, channel: 'WHATSAPP', contactKey: 'ck-retention', lastInboundProviderAt: new Date(NOW) } });
    // An outbound-only conversation (a bulk template send) is not a relationship.
    await h.db.conversation.create({ data: { workspaceId: WS_A, leadId: plainId!, channel: 'WHATSAPP', contactKey: 'ck-retention-2' } });

    // 3. The persisted score of an expiring lead quotes the rating and review count.
    const scoring = (await loadActiveScoringConfig(h.db, WS_A))!;
    const before = await h.db.lead.findUniqueOrThrow({ where: { id: rescoreId! } });
    await h.db.lead.update({ where: { id: rescoreId! }, data: { rating: 45, reviewCount: 128 } });
    await h.db.lead.update({ where: { id: rescoreId! }, data: scoreData(scoreLead(scoreInputOf({ ...before, rating: 45, reviewCount: 128 }), scoring)) });
    expect(JSON.stringify((await h.db.lead.findUniqueOrThrow({ where: { id: rescoreId! } })).scoreReasons)).toContain('Rated 4.5 of 5');

    h.clock.set(new Date(new Date(NOW).getTime() + 31 * DAY).toISOString());
    await drain(w);

    for (const id of [handedId, quotedId, wroteId]) expect((await h.db.lead.findUniqueOrThrow({ where: { id: id! } })).phoneE164).not.toBeNull();
    expect(await h.db.leadContactKey.count({ where: { leadId: { in: [handedId!, quotedId!, wroteId!] }, kind: 'PHONE' } })).toBe(3);
    expect((await h.db.lead.findUniqueOrThrow({ where: { id: plainId! } })).phoneE164).toBeNull();
    const expired = await h.db.lead.findUniqueOrThrow({ where: { id: rescoreId! } });
    expect(expired).toMatchObject({ phoneE164: null, rating: null, reviewCount: null });
    expect(JSON.stringify(expired.scoreReasons)).not.toMatch(/Rated|reviews/);
    expect(JSON.stringify(expired.unknownInputs)).toContain('rating');
    h.clock.set(NOW);
  });
});
