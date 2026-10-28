// Adversarial review of ADR-127/128: `lead:erase` must hold against work already in flight. A
// Refresh that read the row before the erase must not write the listing back, and an email crawl
// that was already running must find nothing to fill in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { applyEmailOutcomes } from '@/server/services/lead-finder/emails';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { refreshFinderResults } from '@/server/services/lead-finder/refresh';
import { startFinderRun, getFinderRunView } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { withTx } from '@/server/db/tx';
import { DETAILS_PATH, placesAnswer, SEARCH_PATH } from './places-support';
import { createLiveHarness, DAY, drain, HOUR, INGEST, NOW, PEPPER, storePlacesKey, type LiveHarness } from './support';

let h: LiveHarness;
let storageDir: string;
beforeAll(async () => {
  h = await createLiveHarness('finder-erase-race');
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-erase-race-'));
  await storePlacesKey(h);
}, 120_000);
afterAll(async () => {
  await h?.destroy();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('erase against work in flight', () => {
  it('a Refresh that read the row before the erase does not write the listing back', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'));
    const ctx = await h.owner();
    const { run } = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'erase-race-1', keywords: ['dentist'], locations: ['Indore'], maxPerQuery: 20, extractEmails: true }), h.deps());
    await drain(h.worker);
    const royal = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, placeId: 'ChIJF1nderFixtureRoyalDental02' } });
    const imported = await importFinderResults(ctx, { runId: run.id, resultIds: [royal.id], requestKey: 'erase-race-import-1' }, INGEST);
    expect(imported.results[0]).toMatchObject({ outcome: 'ACCEPTED' });
    const leadId = imported.results[0]!.leadId!;

    // The 24-hour copy is purged; an email crawl is "in flight" (the row still reads PENDING).
    h.clock.set(new Date(new Date(NOW).getTime() + DAY + 2 * HOUR).toISOString());
    await drain(h.worker);
    await h.db.leadFinderResult.update({ where: { id: royal.id }, data: { emailStatus: 'PENDING' } });

    h.graph.reset();
    h.graph.on('GET', DETAILS_PATH, placesAnswer('response.place-details.json'));
    let erased = false;
    const deps = {
      ...h.deps(),
      seams: {
        http: async (url: string, init: Parameters<typeof h.graph.http>[1]) => {
          if (!erased) {
            erased = true;
            await eraseLead(h.db, h.clock, { workspaceId: h.wsId, leadId, reason: 'Erasure request during refresh', contactKeyPepper: PEPPER, storageDir, correlationId: 'erase-race' });
          }
          return h.graph.http(url, init);
        },
      },
    };
    const r = await refreshFinderResults(ctx, { runId: run.id, resultIds: [royal.id] }, deps);
    expect(erased).toBe(true);
    expect(r.refreshed).toBe(0);
    const after = await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: royal.id } });
    expect(after).toMatchObject({ name: null, phoneRaw: null, address: null, website: null, contentPurgedAt: null, importedLeadId: null });
    const view = await getFinderRunView(ctx, run.id, { noWebsite: false, hasPhone: false, notImported: false });
    expect(view.results.find((x) => x.id === royal.id)).toMatchObject({ erased: true, hasDetails: false });

    // The crawl that was already running finds nothing to fill in: the erase ended it.
    expect(after.emailStatus).not.toBe('PENDING');
    await withTx(h.db, async (tx) => {
      await applyEmailOutcomes(tx, { ...(ctx as object), workspaceId: h.wsId } as Parameters<typeof applyEmailOutcomes>[1], {
        runId: run.id,
        jobId: 'job-erase-race',
        simulated: false,
        outcomes: [{ resultId: royal.id, outcome: { status: 'FOUND', emails: [{ address: 'info@royal.example.in', sourceUrl: 'https://royal.example.in/', kind: 'ROLE' }], pagesRead: 1 } }],
      });
    });
    expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: royal.id } })).toMatchObject({ emailCount: 0, emailStatus: after.emailStatus });
  });
});
