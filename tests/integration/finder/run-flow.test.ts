// ADR-118 (slice F1), DEMO: a Lead Finder run from start to import, against the simulated
// directory, with the production `leadFinder.search` and `leadFinder.purge` handlers.
// - Starting needs `finder.run` (checked on the console target), is idempotent per request key,
//   rate limited only for new runs, capped at two queued or running runs, and audited with counts
//   only. It enqueues one `leadFinder.search` (kind fetch, priority 10, serial key run:<id>).
// - The worker walks every keyword x location cell page by page (one provider call per job),
//   stores each place once per run as a 24-hour working copy, counts progress and ends SUCCEEDED.
//   DEMO makes zero outbound attempts.
// - The results filter on real columns; import goes through ingestBatch (GOOGLE_PLACES, place ID,
//   NOT_LISTED for "no website", 30-day Places expiry), links the results, and the imported leads
//   are not WhatsApp-eligible (NO_WHATSAPP_OPT_IN).
// - The purge nulls the content after 24 hours and keeps the place ID, keyword, location, flags and
//   the link to the lead; Refresh brings the details back; cancel stops a run.
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readTable } from '@/lib/spreadsheet';
import { demoPlacesTotal } from '@/lib/demo/places';
import { IdempotencyConflictError, NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { buildFinderExport, FINDER_EXPORT_DEMO_HEADER } from '@/server/services/lead-finder/export';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { refreshFinderResults } from '@/server/services/lead-finder/refresh';
import { cancelFinderRun, FINDER_ACTIVE_RUN_CAP, getFinderRunView, listFinderRuns, startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { ensureWhatsApp } from '../consent/support';
import { createDemoHarness, DAY, drain, HOUR, INGEST, NOW, WS_A, type DemoHarness } from './support';

let h: DemoHarness;

beforeAll(async () => {
  h = await createDemoHarness('finder-run-flow');
}, 120_000);
afterAll(async () => {
  await h?.testDb.destroy();
});

const NONE = { noWebsite: false, hasPhone: false, notImported: false };
let keySeq = 0;
const key = () => `finder-flow-${String((keySeq += 1)).padStart(4, '0')}`;

function body(over: Partial<{ keywords: string[]; locations: string[]; maxPerQuery: 20 | 40 | 60 }> = {}) {
  return StartFinderRunBody.parse({ requestKey: key(), keywords: ['Dental clinic'], locations: ['Indore'], maxPerQuery: 20, ...over });
}

async function finishActiveRuns() {
  await h.db.leadFinderRun.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED' } });
  await h.db.job.updateMany({ where: { type: 'leadFinder.search', status: 'QUEUED' }, data: { status: 'CANCELLED' } });
}

describe('starting a run', () => {
  it('needs finder.run on the target workspace', async () => {
    await expect(startFinderRun(await h.reader(), body(), { keyRing: null })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('stores the run, enqueues its first search job and audits counts only; a replay returns it without the rate limit', async () => {
    const ctx = await h.operator();
    const rateLimit = vi.fn();
    const input = body({ keywords: ['Dental clinic', 'restaurants'], locations: ['Indore', 'Bhopal'] });
    const first = await startFinderRun(ctx, input, { keyRing: null, rateLimit });
    expect(first.created).toBe(true);
    expect(first.run).toMatchObject({ status: 'QUEUED', cellsTotal: 4, cellsDone: 0, simulated: true, keywords: ['Dental clinic', 'restaurants'], locations: ['Indore', 'Bhopal'], requestedByViewer: true });
    expect(rateLimit).toHaveBeenCalledTimes(1);

    const jobs = await h.db.job.findMany({ where: { type: 'leadFinder.search', workspaceId: WS_A, payload: { equals: { runId: first.run.id, cell: 0, page: 0 } } } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'QUEUED', priority: 10, serialKey: `run:${first.run.id}`, maxAttempts: 8 });

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'finder.run.start', targetId: first.run.id } });
    expect(audit.simulated).toBe(true);
    expect(audit.summary).toMatchObject({ keywords: 2, locations: 2, cells: 4, maxPerQuery: 20, extractEmails: false, blacklist: 0 });
    expect(JSON.stringify(audit.summary)).not.toMatch(/dental|restaurant|indore|bhopal/i);

    const again = await startFinderRun(ctx, input, { keyRing: null, rateLimit });
    expect(again).toMatchObject({ created: false, run: { id: first.run.id } });
    expect(rateLimit).toHaveBeenCalledTimes(1);
    // The same request key from another person is a conflict, never their run.
    await expect(startFinderRun(await h.owner(), input, { keyRing: null })).rejects.toBeInstanceOf(IdempotencyConflictError);
    // The same key with a different search is a conflict too, never the first run handed back under it.
    await expect(startFinderRun(ctx, { ...input, keywords: ['gym'] }, { keyRing: null })).rejects.toMatchObject({ status: 409 });
    await expect(startFinderRun(ctx, { ...input, maxPerQuery: 60 }, { keyRing: null })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    await finishActiveRuns();
  });

  it(`holds at most ${FINDER_ACTIVE_RUN_CAP} queued or running runs per workspace`, async () => {
    const ctx = await h.operator();
    for (let i = 0; i < FINDER_ACTIVE_RUN_CAP; i += 1) await startFinderRun(ctx, body(), { keyRing: null });
    await expect(startFinderRun(ctx, body(), { keyRing: null })).rejects.toMatchObject({ status: 409, code: 'FINDER_RUN_LIMIT' });
    await finishActiveRuns();
  });
});

describe('the search jobs (DEMO)', () => {
  it('walk every cell page by page, store each place once as a 24-hour copy, end SUCCEEDED, and contact nothing', async () => {
    resetOutboundAttempts();
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, body({ keywords: ['Dental clinic', 'gym'], locations: ['Indore'], maxPerQuery: 40 }), { keyRing: null });
    const ran = await drain(h.worker);
    const expected = Math.min(40, demoPlacesTotal({ keyword: 'Dental clinic', location: 'Indore' })) + Math.min(40, demoPlacesTotal({ keyword: 'gym', location: 'Indore' }));
    expect(ran).toBe(4); // two pages per cell, one call per job

    const after = await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: 'SUCCEEDED', cellsDone: 2, resultsFound: expected, errorCode: null });
    expect(after.startedAt).not.toBeNull();
    expect(after.finishedAt).not.toBeNull();
    const rows = await h.db.leadFinderResult.findMany({ where: { runId: run.id } });
    expect(rows).toHaveLength(expected);
    expect(new Set(rows.map((r) => r.placeId)).size).toBe(expected);
    for (const r of rows) {
      expect(r).toMatchObject({ simulated: true, emailStatus: 'NOT_REQUESTED', importedLeadId: null, contentPurgedAt: null });
      expect(r.contentExpiresAt!.getTime() - new Date(NOW).getTime()).toBe(DAY);
      expect(r.hasPhone).toBe(r.phoneRaw !== null);
      expect(r.websiteListed).toBe(r.website !== null);
    }
    expect(rows.filter((r) => r.keyword === 'gym').every((r) => r.category === 'Gym' && r.city === 'Indore')).toBe(true);
    expect(outboundAttempts()).toEqual([]);
    const finish = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'finder.run.finish', targetId: run.id } });
    expect(finish.summary).toMatchObject({ status: 'SUCCEEDED', results: expected, cells: 2 });
    // The purge of the working copy is armed for the end of the expiry hour.
    const purge = await h.db.job.findFirstOrThrow({ where: { type: 'leadFinder.purge', status: 'QUEUED', payload: { equals: { runId: run.id } } } });
    expect(purge.runAt.getTime()).toBe(Math.ceil((new Date(NOW).getTime() + DAY + 1) / HOUR) * HOUR);
  });

  it('a late job of a cancelled run writes nothing', async () => {
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, body({ keywords: ['bakery'] }), { keyRing: null });
    const cancelled = await cancelFinderRun(ctx, run.id);
    expect(cancelled).toMatchObject({ cancelled: true, run: { status: 'CANCELLED' } });
    expect(await h.db.job.findFirstOrThrow({ where: { type: 'leadFinder.search', payload: { equals: { runId: run.id, cell: 0, page: 0 } } } })).toMatchObject({ status: 'CANCELLED' });
    // Even if its job ran anyway, the run stays cancelled and gets no rows.
    await h.db.job.updateMany({ where: { type: 'leadFinder.search', payload: { equals: { runId: run.id, cell: 0, page: 0 } } }, data: { status: 'QUEUED' } });
    await drain(h.worker);
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'CANCELLED', resultsFound: 0 });
    expect(await h.db.leadFinderResult.count({ where: { runId: run.id } })).toBe(0);
    expect(await cancelFinderRun(ctx, run.id)).toMatchObject({ cancelled: false });
    expect(await h.db.auditEvent.count({ where: { action: 'finder.run.cancel', targetId: run.id } })).toBe(1);
  });
});

describe('results, import and expiry', () => {
  let runId: string;
  beforeAll(async () => {
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, body({ keywords: ['salon'], locations: ['Bhopal'], maxPerQuery: 60 }), { keyRing: null });
    runId = run.id;
    await drain(h.worker);
  });

  it('filter on the real columns with counts, 50 a page', async () => {
    const ctx = await h.operator();
    const all = await getFinderRunView(ctx, runId, NONE);
    const total = demoPlacesTotal({ keyword: 'salon', location: 'Bhopal' });
    expect(all.counts.all).toBe(total);
    expect(all.total).toBe(total);
    expect(all.results).toHaveLength(Math.min(50, total));
    expect(all.pageCount).toBe(Math.ceil(total / 50));
    expect(all.attributions).toEqual([]);
    const noSite = await getFinderRunView(ctx, runId, { ...NONE, noWebsite: true });
    expect(noSite.total).toBe(all.counts.noWebsite);
    expect(noSite.results.every((r) => !r.websiteListed && r.website === null && r.mapsHref === null)).toBe(true);
    const phone = await getFinderRunView(ctx, runId, { ...NONE, hasPhone: true });
    expect(phone.results.every((r) => r.hasPhone && r.phone !== null)).toBe(true);
    const both = await getFinderRunView(ctx, runId, { noWebsite: true, hasPhone: true, notImported: true });
    expect(both.results.every((r) => !r.websiteListed && r.hasPhone && r.importedLeadId === null)).toBe(true);
    // Another workspace never sees this run.
    await expect(getFinderRunView(await h.reader(), runId, NONE)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('import goes through ingestion as GOOGLE_PLACES leads, links the results, and the leads have no WhatsApp opt-in', async () => {
    const ctx = await h.operator();
    const view = await getFinderRunView(ctx, runId, { ...NONE, noWebsite: true, hasPhone: true });
    const picked = view.results.slice(0, 3);
    const result = await importFinderResults(ctx, { runId, resultIds: picked.map((r) => r.id), requestKey: 'finder-import-0001' }, INGEST);
    expect(result.counts).toEqual({ accepted: 3, duplicate: 0, review: 0, rejected: 0, alreadyImported: 0, detailsExpired: 0 });

    for (const r of picked) {
      const row = await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.importedLeadId).not.toBeNull();
      expect(row.importedAt!.toISOString()).toBe(NOW);
      const lead = await h.db.lead.findUniqueOrThrow({ where: { id: row.importedLeadId! } });
      expect(lead).toMatchObject({ firstSource: 'GOOGLE_PLACES', placeId: r.placeId, displayName: r.name, websiteStatus: 'NOT_LISTED', pincode: r.pincode, city: 'Bhopal', simulated: true });
      expect(lead.placesContentExpiresAt!.getTime() - new Date(NOW).getTime()).toBe(30 * DAY);
      const key = await h.db.leadContactKey.findFirst({ where: { leadId: lead.id, kind: 'PROVIDER' } });
      expect(key?.value).toBe(`GOOGLE_PLACES:${r.placeId}`);
      const source = await h.db.leadSourceRecord.findFirstOrThrow({ where: { leadId: lead.id } });
      expect(source.attribution).toEqual({ finderRunId: runId, keyword: 'salon', location: 'Bhopal' });
      expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);
    }

    // Places leads have no WhatsApp opt-in (ADR-15): skipped NO_WHATSAPP_OPT_IN for every send intent.
    const wa = await ensureWhatsApp(h.db, WS_A, 'SIMULATED');
    const leadId = (await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: picked[0]!.id } })).importedLeadId!;
    for (const sendIntent of ['BULK', 'AUTOMATED', 'MANUAL_SINGLE'] as const) {
      const elig = await checkDispatchEligibility(ctx.db, ctx, { leadId, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent, templateId: wa.approved.id }, { contactKeyPepper: INGEST.contactKeyPepper });
      expect(elig.eligible).toBe(false);
      expect(elig.reasons).toContain('NO_WHATSAPP_OPT_IN');
    }

    // Selecting them again: already imported. The import is audited with counts and arms the 30-day sweep.
    const again = await importFinderResults(ctx, { runId, resultIds: picked.map((r) => r.id), requestKey: 'finder-import-0002' }, INGEST);
    expect(again.counts.alreadyImported).toBe(3);
    const audits = await h.db.auditEvent.findMany({ where: { action: 'finder.import', targetId: runId }, orderBy: { createdAt: 'asc' } });
    expect(audits[0]!.summary).toMatchObject({ requested: 3, accepted: 3 });
    expect(await h.db.job.count({ where: { type: 'leads.placesExpire', workspaceId: WS_A, status: 'QUEUED' } })).toBe(1);
    // The filter "Not imported" now leaves them out.
    const notImported = await getFinderRunView(ctx, runId, { ...NONE, notImported: true });
    expect(notImported.results.some((r) => picked.some((p) => p.id === r.id))).toBe(false);
    // A result that is not in this run is 404.
    await expect(importFinderResults(ctx, { runId, resultIds: ['finderresultmatrixprobe00'], requestKey: 'finder-import-0003' }, INGEST)).rejects.toBeInstanceOf(NotFoundError);
    // Importing needs leads.write.
    await expect(importFinderResults(await h.reader(), { runId, resultIds: [picked[0]!.id], requestKey: 'finder-import-0004' }, INGEST)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('the same place found by another run becomes a duplicate of the first lead', async () => {
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, body({ keywords: ['salon'], locations: ['Bhopal'], maxPerQuery: 20 }), { keyRing: null });
    await drain(h.worker);
    const imported = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId, importedLeadId: { not: null } } });
    const twin = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, placeId: imported.placeId } });
    const result = await importFinderResults(ctx, { runId: run.id, resultIds: [twin.id], requestKey: 'finder-import-0005' }, INGEST);
    expect(result.results[0]).toMatchObject({ outcome: 'DUPLICATE', leadId: imported.importedLeadId });
    expect((await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: twin.id } })).importedLeadId).toBe(imported.importedLeadId);
  });

  it('the Excel file holds the full simulated columns, for the requester only', async () => {
    const ctx = await h.operator();
    const file = await buildFinderExport(ctx, runId);
    expect(file.limited).toBe(false);
    expect(file.fileName).toMatch(/^finder-smile-avenue-dental-\d{8}-\d{4}\.xlsx$/);
    const table = readTable(file.bytes, file.fileName);
    expect(table.rows[0]).toEqual([...FINDER_EXPORT_DEMO_HEADER]);
    expect(table.rows).toHaveLength(1 + demoPlacesTotal({ keyword: 'salon', location: 'Bhopal' }));
    const importedRow = table.rows.find((r) => r[15] === 'Yes')!;
    expect(importedRow[0]).toBe('Yes');
    expect(importedRow[17]).toBe('New');
    expect(await h.db.auditEvent.count({ where: { action: 'finder.export', targetId: runId } })).toBe(1);
    // Someone else in the workspace (the owner holds leads.export) cannot download the operator's run.
    await expect(buildFinderExport(await h.owner(), runId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('after 24 hours the purge nulls the Places content and keeps the place ID, terms, flags and lead link', async () => {
    const ctx = await h.operator();
    const before = await h.db.leadFinderResult.findMany({ where: { runId }, orderBy: { id: 'asc' } });
    h.clock.set(new Date(new Date(NOW).getTime() + DAY + 2 * HOUR).toISOString());
    await drain(h.worker);
    const after = await h.db.leadFinderResult.findMany({ where: { runId }, orderBy: { id: 'asc' } });
    for (let i = 0; i < after.length; i += 1) {
      const a = after[i]!;
      const b = before[i]!;
      expect(a).toMatchObject({ name: null, category: null, phoneRaw: null, website: null, ratingX10: null, reviewCount: null, address: null, city: null, state: null, pincode: null, attributions: null });
      expect(a).toMatchObject({ placeId: b.placeId, keyword: b.keyword, location: b.location, websiteListed: b.websiteListed, hasPhone: b.hasPhone, importedLeadId: b.importedLeadId });
      expect(a.contentPurgedAt).not.toBeNull();
    }
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'finder.results.purge', targetId: runId } });
    expect(audit.summary).toMatchObject({ purged: after.length });
    const view = await getFinderRunView(ctx, runId, NONE);
    expect(view.results.every((r) => !r.hasDetails && r.name === null && r.phone === null)).toBe(true);

    // Refresh brings two listings back as a new 24-hour copy (DEMO rebuilds them; nothing is contacted).
    resetOutboundAttempts();
    const ids = view.results.slice(0, 2).map((r) => r.id);
    const refreshed = await refreshFinderResults(ctx, { runId, resultIds: ids }, { keyRing: null });
    expect(refreshed).toMatchObject({ requested: 2, refreshed: 2, failed: 0, notExpired: 0 });
    const rows = await h.db.leadFinderResult.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.name !== null && r.contentPurgedAt === null && r.contentExpiresAt!.getTime() === h.clock.now().getTime() + DAY)).toBe(true);
    expect(outboundAttempts()).toEqual([]);
    // Importing an expired result is refused per row, never with stale data.
    const expired = view.results.find((r) => r.importedLeadId === null && !ids.includes(r.id))!;
    const imp = await importFinderResults(ctx, { runId, resultIds: [expired.id], requestKey: 'finder-import-0006' }, INGEST);
    expect(imp.results[0]).toMatchObject({ outcome: 'DETAILS_EXPIRED', leadId: null });
    h.clock.set(NOW);
  });

  it('an erased place keeps only its place ID and terms, survives the purge unstamped and is never refreshed', async () => {
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, body({ keywords: ['boutique'], locations: ['Indore'] }), { keyRing: null });
    await drain(h.worker);
    const pick = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, hasPhone: true }, orderBy: { createdAt: 'asc' } });
    const leadId = (await importFinderResults(ctx, { runId: run.id, resultIds: [pick.id], requestKey: 'finder-import-erase' }, INGEST)).results[0]!.leadId!;
    const erased = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId, reason: 'DPDP request REF-1', contactKeyPepper: INGEST.contactKeyPepper, storageDir: os.tmpdir(), correlationId: 'req_finder_erase' });
    expect(erased.finderResultsBlanked).toBe(1);
    const view = await getFinderRunView(ctx, run.id, NONE);
    expect(view.results.find((r) => r.id === pick.id)).toMatchObject({ erased: true, hasDetails: false, name: null, importedLeadId: null, placeId: pick.placeId, keyword: 'boutique' });

    h.clock.set(new Date(new Date(NOW).getTime() + DAY + 2 * HOUR).toISOString());
    await drain(h.worker);
    const row = await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: pick.id } });
    expect(row.contentPurgedAt).toBeNull();
    const other = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, id: { not: pick.id } } });
    expect(other.contentPurgedAt).not.toBeNull();
    resetOutboundAttempts();
    const refreshed = await refreshFinderResults(ctx, { runId: run.id, resultIds: [pick.id, other.id] }, { keyRing: null });
    expect(refreshed).toMatchObject({ refreshed: 1, erased: 1 });
    expect((await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: pick.id } })).name).toBeNull();
    h.clock.set(NOW);
  });

  it('a place erased after its 24-hour purge is recognised as erased too and never refreshed', async () => {
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, body({ keywords: ['travel agency'], locations: ['Jabalpur'] }), { keyRing: null });
    await drain(h.worker);
    const pick = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: run.id, hasPhone: true }, orderBy: { createdAt: 'asc' } });
    const leadId = (await importFinderResults(ctx, { runId: run.id, resultIds: [pick.id], requestKey: 'finder-import-erase-late' }, INGEST)).results[0]!.leadId!;

    // The 24-hour purge comes first: the row is stamped purged, so it looks merely "expired" ...
    h.clock.set(new Date(new Date(NOW).getTime() + DAY + 2 * HOUR).toISOString());
    await drain(h.worker);
    expect((await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: pick.id } })).contentPurgedAt).not.toBeNull();

    // ... until the person's erasure: then it must read as erased, and Refresh must not bring the listing back.
    const erased = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId, reason: 'DPDP request REF-2', contactKeyPepper: INGEST.contactKeyPepper, storageDir: os.tmpdir(), correlationId: 'req_finder_erase_late' });
    expect(erased.finderResultsBlanked).toBe(1);
    const view = await getFinderRunView(ctx, run.id, NONE);
    expect(view.results.find((r) => r.id === pick.id)).toMatchObject({ erased: true, hasDetails: false, name: null, importedLeadId: null, placeId: pick.placeId });
    resetOutboundAttempts();
    const refreshed = await refreshFinderResults(ctx, { runId: run.id, resultIds: [pick.id] }, { keyRing: null });
    expect(refreshed).toMatchObject({ requested: 1, refreshed: 0, erased: 1 });
    expect(outboundAttempts()).toEqual([]);
    expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: pick.id } })).toMatchObject({ name: null, phoneRaw: null, address: null });
    h.clock.set(NOW);
  });

  it('reports how many websites are still being checked for emails, in the list and in the run view', async () => {
    const ctx = await h.operator();
    const { run } = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: key(), keywords: ['hotel'], locations: ['Gwalior'], maxPerQuery: 20, extractEmails: true }), { keyRing: null });
    // The search ends first; the email checks of the last page are separate jobs that finish later
    // (this harness runs no email job, so every website of the run is still waiting).
    await drain(h.worker);
    const waiting = await h.db.leadFinderResult.count({ where: { runId: run.id, emailStatus: 'PENDING' } });
    expect(waiting).toBeGreaterThan(0);
    expect((await listFinderRuns(ctx)).find((r) => r.id === run.id)).toMatchObject({ status: 'SUCCEEDED', emailsPending: waiting });
    expect((await getFinderRunView(ctx, run.id, NONE)).run).toMatchObject({ emailsPending: waiting });
    // Once the checks are written, nothing is pending; a run that never asked for emails reports none.
    await h.db.leadFinderResult.updateMany({ where: { runId: run.id, emailStatus: 'PENDING' }, data: { emailStatus: 'NONE_FOUND' } });
    expect((await listFinderRuns(ctx)).find((r) => r.id === run.id)).toMatchObject({ emailsPending: 0 });
    const plain = await startFinderRun(ctx, body({ keywords: ['hotel'], locations: ['Jabalpur'] }), { keyRing: null });
    await drain(h.worker);
    await h.db.leadFinderResult.updateMany({ where: { runId: plain.run.id }, data: { emailStatus: 'PENDING' } });
    expect((await listFinderRuns(ctx)).find((r) => r.id === plain.run.id)).toMatchObject({ emailsPending: 0 });
  });

  it('lists the recent runs newest first', async () => {
    const runs = await listFinderRuns(await h.operator());
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.map((r) => r.createdAt)).toEqual([...runs.map((r) => r.createdAt)].sort().reverse());
  });
});
