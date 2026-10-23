// ADR-118 (slice F1), LIVE: the Lead Finder against the scripted Places stand-in (documented-shape
// fixtures, `verified: false`), with the workspace's encrypted GOOGLE_PLACES key.
// - Without a usable key a search is refused (422 PLACES_NOT_CONFIGURED); LIVE never falls back to
//   the simulated directory.
// - A run sends one Text Search per job with the key and the field mask, follows nextPageToken up to
//   maxPerQuery, stores Google's attributions, and builds Maps links from place IDs.
// - Throttling is retried with Retry-After; a refused API or a rejected key stops the run (FAILED,
//   or PARTIAL with what it found); a key that no longer decrypts is recorded on the integration.
// - The Excel file holds only the columns that may leave the product (no names, phones, addresses).
// - Refresh is one Place Details call per expired result; the connection test asks for IDs only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readTable } from '@/lib/spreadsheet';
import { buildFinderExport, FINDER_EXPORT_LIVE_HEADER } from '@/server/services/lead-finder/export';
import { refreshFinderResults } from '@/server/services/lead-finder/refresh';
import { getFinderRunView, startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { PLACES_SEARCH_FIELD_MASK } from '@/server/adapters/places/port';
import { DETAILS_PATH, networkError, PLACES_KEY, placesAnswer, SEARCH_PATH } from './places-support';
import { createLiveHarness, DAY, drain, HOUR, KEY_RING, NOW, storePlacesKey, type LiveHarness } from './support';

let h: LiveHarness;
let seq = 0;
const body = (over: Partial<{ keywords: string[]; locations: string[]; maxPerQuery: 20 | 40 | 60 }> = {}) =>
  StartFinderRunBody.parse({ requestKey: `finder-live-${String((seq += 1)).padStart(4, '0')}`, keywords: ['dental clinic'], locations: ['Indore'], maxPerQuery: 20, ...over });

beforeAll(async () => {
  h = await createLiveHarness('finder-live');
}, 120_000);
afterAll(async () => {
  await h?.destroy();
});
beforeEach(async () => {
  h.graph.reset();
  h.clock.set(NOW);
  await h.db.leadFinderRun.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED' } });
  await h.db.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
});

describe('LIVE without a usable key', () => {
  it('refuses to start a search and never uses the simulated directory', async () => {
    await expect(startFinderRun(await h.owner(), body(), h.deps())).rejects.toMatchObject({ status: 422, code: 'PLACES_NOT_CONFIGURED' });
    await storePlacesKey(h, { status: 'REVOKED' });
    await expect(startFinderRun(await h.owner(), body(), h.deps())).rejects.toMatchObject({ status: 422, code: 'PLACES_NOT_CONFIGURED' });
    expect(await h.db.leadFinderRun.count()).toBe(0);
    expect(h.graph.requests).toEqual([]);
  });
});

describe('LIVE runs', () => {
  beforeEach(async () => {
    await storePlacesKey(h, { status: 'CONFIGURED_UNVERIFIED' });
  });

  it('page through Text Search with the key and mask, keep attributions and build Maps links', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'), placesAnswer('response.search-last-page.json'), placesAnswer('response.search-empty.json'));
    const { run } = await startFinderRun(await h.owner(), body({ locations: ['Indore', 'Ujjain'], maxPerQuery: 40 }), h.deps());
    expect(run.simulated).toBe(false);
    await drain(h.worker);
    expect(h.graph.unexpected).toEqual([]);
    expect(h.graph.requests.map((r) => r.body)).toEqual([
      { textQuery: 'dental clinic in Indore', pageSize: 20, languageCode: 'en', regionCode: 'IN' },
      { textQuery: 'dental clinic in Indore', pageSize: 20, pageToken: 'AeCrKXsFixtureNextPageToken_page2', languageCode: 'en', regionCode: 'IN' },
      { textQuery: 'dental clinic in Ujjain', pageSize: 20, languageCode: 'en', regionCode: 'IN' },
    ]);
    for (const req of h.graph.requests) {
      expect(req.headers['x-goog-api-key']).toBe(PLACES_KEY);
      expect(req.headers['x-goog-fieldmask']).toBe(PLACES_SEARCH_FIELD_MASK);
    }
    const after = await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'SUCCEEDED', cellsDone: 2, resultsFound: 4, simulated: false });

    const view = await getFinderRunView(await h.owner(), run.id, { noWebsite: false, hasPhone: false, notImported: false });
    expect(view.results.map((r) => r.placeId)).toEqual(['ChIJF1nderFixtureSmileDental01', 'ChIJF1nderFixtureRoyalDental02', 'ChIJF1nderFixtureTooth3', 'ChIJF1nderFixtureLastPage04']);
    expect(view.results[1]).toMatchObject({ websiteListed: false, simulated: false, attributions: [{ provider: 'Fixture Listings Partner', providerUri: 'https://partner.example.com/' }] });
    expect(view.results[0]!.mapsHref).toBe('https://www.google.com/maps/search/?api=1&query=dental+clinic+Indore&query_place_id=ChIJF1nderFixtureSmileDental01');
    expect(view.results[0]!.websiteHref).toBe('https://smile-dental.example.in/');
    expect(view.attributions).toEqual([{ provider: 'Fixture Listings Partner', providerUri: 'https://partner.example.com/' }]);

    // The Excel file: only place ID, Maps link, keyword, location, the workspace's own columns and website emails.
    const file = await buildFinderExport(await h.owner(), run.id);
    expect(file.limited).toBe(true);
    const table = readTable(file.bytes, file.fileName);
    expect(table.rows[0]).toEqual([...FINDER_EXPORT_LIVE_HEADER]);
    expect(table.rows[1]!.slice(0, 5)).toEqual(['ChIJF1nderFixtureSmileDental01', view.results[0]!.mapsHref, 'dental clinic', 'Indore', 'No']);
    const text = JSON.stringify(table.rows);
    for (const content of ['Fixture Smile Dental Care', '98260', 'Vijay Nagar', 'smile-dental.example.in', '452010', 'Dental Clinic', '4.6']) expect(text).not.toContain(content);
  });

  it('retries throttling after Retry-After, then continues', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('error.429-resource-exhausted.json', { 'retry-after': '30' }), placesAnswer('response.search-last-page.json'));
    const { run } = await startFinderRun(await h.owner(), body(), h.deps());
    await drain(h.worker);
    const job = await h.db.job.findFirstOrThrow({ where: { type: 'leadFinder.search', payload: { equals: { runId: run.id, cell: 0, page: 0 } } } });
    expect(job).toMatchObject({ status: 'QUEUED', attempts: 1, lastErrorCode: 'PLACES_RATE_LIMITED' });
    expect(job.runAt.getTime() - h.clock.now().getTime()).toBeGreaterThanOrEqual(30_000);
    h.clock.set(new Date(h.clock.now().getTime() + 60_000).toISOString());
    await drain(h.worker);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', resultsFound: 1 });
  });

  it('a refused API stops the run FAILED with its code; a rejected key after results ends it PARTIAL', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('error.403-permission-denied.json'));
    const failed = await startFinderRun(await h.owner(), body({ locations: ['Indore', 'Bhopal'] }), h.deps());
    await drain(h.worker);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: failed.run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'PLACES_PERMISSION', resultsFound: 0, cellsDone: 0 });
    expect(h.graph.requests).toHaveLength(1);

    h.graph.reset();
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-last-page.json'), placesAnswer('error.400-api-key-invalid.json'));
    const partial = await startFinderRun(await h.owner(), body({ locations: ['Indore', 'Bhopal', 'Ujjain'] }), h.deps());
    await drain(h.worker);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: partial.run.id } })).toMatchObject({ status: 'PARTIAL', errorCode: 'PLACES_AUTH', resultsFound: 1, cellsDone: 1 });
    expect(h.graph.requests).toHaveLength(2);
    const finish = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'finder.run.finish', targetId: partial.run.id } });
    expect(finish.summary).toMatchObject({ status: 'PARTIAL', errorCode: 'PLACES_AUTH' });
  });

  it('a bad request skips the cell and the run continues; exhausted retries do the same', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('error.400-invalid-argument.json'), placesAnswer('response.search-last-page.json'));
    const { run } = await startFinderRun(await h.owner(), body({ locations: ['Indore', 'Bhopal'] }), h.deps());
    await drain(h.worker);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'PARTIAL', errorCode: 'PLACES_INVALID_ARGUMENT', resultsFound: 1, cellsDone: 2 });

    h.graph.reset();
    const answers = Array.from({ length: 8 }, () => ({ throw: networkError('ECONNRESET') }));
    h.graph.on('POST', SEARCH_PATH, ...answers);
    const down = await startFinderRun(await h.owner(), body(), h.deps());
    for (let i = 0; i < 10; i += 1) {
      await drain(h.worker);
      h.clock.set(new Date(h.clock.now().getTime() + 10 * 60_000).toISOString());
    }
    expect(h.graph.requests).toHaveLength(8);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: down.run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'PLACES_UNREACHABLE', resultsFound: 0, cellsDone: 1 });
  });

  it('a key that no longer decrypts fails the run and is recorded on the integration', async () => {
    const { run } = await startFinderRun(await h.owner(), body(), h.deps());
    // Swap the stored envelope for one bound to another integration (AAD mismatch) after the start.
    const other = (await import('@/server/security/secrets')).encryptSecret(KEY_RING, PLACES_KEY, 'other|integration|apiKey');
    await storePlacesKey(h, { envelope: other });
    await drain(h.worker);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'PLACES_CREDENTIAL_UNREADABLE' });
    expect(await h.db.integration.findFirstOrThrow({ where: { workspaceId: h.wsId, kind: 'GOOGLE_PLACES' } })).toMatchObject({ status: 'ERROR', lastErrorCode: 'CREDENTIAL_UNREADABLE' });
    expect(h.graph.requests).toEqual([]);
  });

  it('Refresh calls Place Details per expired result with the same mask', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'));
    const { run } = await startFinderRun(await h.owner(), body(), h.deps());
    await drain(h.worker);
    h.clock.set(new Date(new Date(NOW).getTime() + DAY + 2 * HOUR).toISOString());
    await drain(h.worker);
    const royal = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, placeId: 'ChIJF1nderFixtureRoyalDental02' } });
    expect(royal.name).toBeNull();
    h.graph.reset();
    h.graph.on('GET', DETAILS_PATH, placesAnswer('response.place-details.json'));
    const r = await refreshFinderResults(await h.owner(), { runId: run.id, resultIds: [royal.id] }, h.deps());
    expect(r).toMatchObject({ refreshed: 1, failed: 0 });
    expect(h.graph.requests[0]!.path).toBe('/v1/places/ChIJF1nderFixtureRoyalDental02');
    expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: royal.id } })).toMatchObject({ name: 'Fixture Royal Dental Clinic', ratingX10: 42, reviewCount: 41, contentPurgedAt: null });
  });

  it('a listing that carries no content at all (only an ID) is not stored, and is not a refresh either: it would read as an erased place', async () => {
    h.graph.on('POST', SEARCH_PATH, { status: 200, body: { places: [{ id: 'ChIJBareIdOnlyNoContent01' }, { id: 'ChIJHasNameOnlyListing02', displayName: { text: 'Name Only Dental' } }] } });
    const { run } = await startFinderRun(await h.owner(), body(), h.deps());
    await drain(h.worker);
    const rows = await h.db.leadFinderResult.findMany({ where: { runId: run.id } });
    expect(rows.map((r) => r.placeId)).toEqual(['ChIJHasNameOnlyListing02']);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', resultsFound: 1 });

    // Refresh: an answer without any content leaves the expired copy as it was and counts as failed.
    h.clock.set(new Date(rows[0]!.contentExpiresAt!.getTime() + 60_000).toISOString());
    h.graph.reset();
    h.graph.on('GET', DETAILS_PATH, { status: 200, body: { id: 'ChIJHasNameOnlyListing02' } });
    const r = await refreshFinderResults(await h.owner(), { runId: run.id, resultIds: [rows[0]!.id] }, h.deps());
    expect(r).toMatchObject({ refreshed: 0, failed: 1 });
    const view = await getFinderRunView(await h.owner(), run.id, { noWebsite: false, hasPhone: false, notImported: false });
    expect(view.results[0]).toMatchObject({ erased: false, hasDetails: false });
  });

  it('Refresh replaces a copy that expired but was not purged yet completely: attributions Google no longer sends do not linger', async () => {
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'));
    const { run } = await startFinderRun(await h.owner(), body(), h.deps());
    await drain(h.worker);
    const royal = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, placeId: 'ChIJF1nderFixtureRoyalDental02' } });
    expect(royal.attributions).not.toBeNull();
    // Past its 24 hours; the purge job (end of that hour) has not run, so the old content is still stored.
    h.clock.set(new Date(royal.contentExpiresAt!.getTime() + 60_000).toISOString());
    h.graph.reset();
    h.graph.on('GET', DETAILS_PATH, { status: 200, body: { id: 'ChIJF1nderFixtureRoyalDental02', displayName: { text: 'Fixture Royal Dental Clinic' }, nationalPhoneNumber: '0731 400 2002' } });
    const r = await refreshFinderResults(await h.owner(), { runId: run.id, resultIds: [royal.id] }, h.deps());
    expect(r).toMatchObject({ refreshed: 1, failed: 0 });
    const after = await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: royal.id } });
    expect(after).toMatchObject({ name: 'Fixture Royal Dental Clinic', ratingX10: null, reviewCount: null, attributions: null, contentPurgedAt: null });
  });

  it('the connection test asks Google for place IDs only and verifies the integration', async () => {
    h.graph.on('POST', SEARCH_PATH, { status: 200, body: { places: [{ id: 'ChIJF1nderFixtureSmileDental01' }] } }, placesAnswer('error.400-api-key-invalid.json'));
    const testers = liveAdapters({ keyRing: KEY_RING, graphVersion: null, places: { http: h.graph.http } }).testers;
    const ok = await testIntegrationConnection(await h.owner(), { kind: 'GOOGLE_PLACES' }, { testers });
    expect(ok).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED' });
    expect(h.graph.requests[0]!.headers['x-goog-fieldmask']).toBe('places.id');
    const bad = await testIntegrationConnection(await h.owner(), { kind: 'GOOGLE_PLACES' }, { testers });
    expect(bad).toMatchObject({ status: 'ERROR', errorCode: 'PROVIDER_AUTH' });
    expect(JSON.stringify(bad)).not.toContain(PLACES_KEY);
  });
});
