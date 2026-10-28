// Adversarial review of ADR-128: a retried import request (same request key) replays instead of
// failing with BATCH_CONTENT_MISMATCH, also when some of its results were rejected or sent to
// review (they stay unlinked, so the retry's set of results to ingest is smaller than the first).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob } from '@/server/jobs/handlers/lead-finder-search';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { createDemoHarness, drain, INGEST, workerFor, type DemoHarness } from './support';

describe('finder import replay', () => {
  let h: DemoHarness;
  beforeAll(async () => {
    h = await createDemoHarness('finder-import-replay');
  }, 120_000);
  afterAll(async () => h?.testDb.destroy());

  it('answers a retry of the same request with the same outcomes, rejected results included', async () => {
    const ctx = await h.operator();
    const w = workerFor(h.db, h.clock, 'demo', [createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }), createLeadFinderPurgeJob({ mode: () => 'demo' })]);
    const { run } = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'import-replay-run', keywords: ['gym'], locations: ['Bhopal'], maxPerQuery: 20 }), { keyRing: null });
    await drain(w);
    const [good, bare] = await h.db.leadFinderResult.findMany({ where: { runId: run.id, hasPhone: true }, take: 2, orderBy: { createdAt: 'asc' } });
    // No phone and no email: the one result ingestion rejects (NO_VALID_CONTACT).
    await h.db.leadFinderResult.update({ where: { id: bare!.id }, data: { phoneRaw: null, hasPhone: false, website: null, websiteListed: false, emails: [], emailCount: 0 } });

    const input = { runId: run.id, resultIds: [good!.id, bare!.id], requestKey: 'import-replay-key-1' };
    const first = await importFinderResults(ctx, input, INGEST);
    expect(first.results.map((r) => r.outcome)).toEqual(['ACCEPTED', 'REJECTED']);

    const again = await importFinderResults(ctx, input, INGEST);
    expect(again.results.map((r) => [r.outcome, r.reasonCode])).toEqual([
      ['ALREADY_IMPORTED', null],
      ['REJECTED', first.results[1]!.reasonCode],
    ]);
    expect(again.results[0]!.leadId).toBe(first.results[0]!.leadId);
    expect(await h.db.lead.count({ where: { placeId: good!.placeId } })).toBe(1);
  });
});
