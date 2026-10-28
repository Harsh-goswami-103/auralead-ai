/**
 * "Import as leads" (ADR-118, slice F1): the selected results of a finder run become leads through
 * the one ingestion path (`ingestBatch`, source GOOGLE_PLACES), so dedupe, merge review, scoring and
 * pipeline pinning are the same as every other source. Needs `leads.write`.
 *
 * - Each result is a record with the place ID as provider id (PROVIDER key `GOOGLE_PLACES:<placeId>`:
 *   the same place imported again from another run is a DUPLICATE of the first lead), the listing's
 *   own statement about a website (`websiteListed`, NOT_LISTED when it has none, ADR-119), and the
 *   run's keyword and location as attribution. The best website-sourced email (a role address
 *   first) goes with it; Places itself gives no email.
 * - Records go in chunks of 100; the batch id carries the request key and a hash of the chunk's
 *   result ids (not its position: the set of unlinked results shrinks as a request proceeds), so a
 *   retried request never imports twice and never conflicts with its own earlier chunks. A record
 *   an earlier chunk already sent to review or rejected keeps that outcome. Accepted and duplicate records link the result to their
 *   lead (`importedLeadId`, `importedAt`); a record sent to merge review or rejected stays
 *   unlinked. Results already imported, or whose 24-hour details expired, are skipped.
 * - Places leads carry no WhatsApp consent (ADR-15): ingestion records none for this source, so
 *   they stay NO_WHATSAPP_OPT_IN until the business writes in or an opt-in is recorded.
 * - Imported leads keep their Places-sourced fields until `placesContentExpiresAt` (30 days,
 *   ADR-118 (d)); the `leads.placesExpire` sweep is armed for that day.
 */
import { createHash } from 'node:crypto';
import type { LeadFinderResult } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { ingestBatch, PLACES_CONTENT_TTL_MS, type IngestDeps } from '@/server/services/leads/ingest';
import type { IngestRecord } from '@/lib/schemas/ingest';
import { enqueuePlacesExpire } from './jobs';
import { finderEmails, hasDetails, loadFinderRun } from './runs';

const CHUNK = 100;
const EMAIL_KIND_ORDER = { ROLE: 0, PERSONAL: 1, FREEMAIL: 2 } as const;

export type FinderImportOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REVIEW' | 'REJECTED' | 'ALREADY_IMPORTED' | 'DETAILS_EXPIRED';

export type FinderImportResult = {
  runId: string;
  requested: number;
  counts: { accepted: number; duplicate: number; review: number; rejected: number; alreadyImported: number; detailsExpired: number };
  results: Array<{ resultId: string; outcome: FinderImportOutcome; leadId: string | null; reasonCode: string | null }>;
};

function bestEmail(value: unknown): string | null {
  const emails = finderEmails(value).sort((a, b) => EMAIL_KIND_ORDER[a.kind] - EMAIL_KIND_ORDER[b.kind]);
  return emails[0]?.address ?? null;
}

export function finderIngestRecord(row: LeadFinderResult): IngestRecord {
  return {
    externalId: `${row.runId}:${row.placeId}`,
    providerId: row.placeId,
    fields: {
      name: row.name,
      phone: row.phoneRaw,
      email: bestEmail(row.emails),
      website: row.website,
      address: row.address,
      city: row.city,
      category: row.category,
      rating: row.ratingX10 === null ? null : row.ratingX10 / 10,
      reviewCount: row.reviewCount,
      pincode: row.pincode,
      websiteListed: row.websiteListed,
      placeId: row.placeId,
    },
    attribution: { finderRunId: row.runId, keyword: row.keyword.slice(0, 500), location: row.location.slice(0, 500) },
  };
}

export async function importFinderResults(ctx: AppCtx, input: { runId: string; resultIds: readonly string[]; requestKey: string }, deps: IngestDeps): Promise<FinderImportResult> {
  requireCapability(ctx, 'leads.write');
  const workspaceId = requireWorkspace(ctx);
  const run = await loadFinderRun(ctx, input.runId);
  const ids = [...new Set(input.resultIds)];
  const rows = await ctx.db.leadFinderResult.findMany({ where: { runId: run.id, id: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (rows.length !== ids.length) throw new NotFoundError({ message: 'a selected finder result is not in this run' });
  const now = ctx.clock.now();

  const outcomes = new Map<string, { outcome: FinderImportOutcome; leadId: string | null; reasonCode: string | null }>();
  const toIngest: LeadFinderResult[] = [];
  for (const row of rows) {
    if (row.importedLeadId !== null) outcomes.set(row.id, { outcome: 'ALREADY_IMPORTED', leadId: row.importedLeadId, reasonCode: null });
    else if (!hasDetails(row, now) || row.name === null) outcomes.set(row.id, { outcome: 'DETAILS_EXPIRED', leadId: null, reasonCode: 'DETAILS_EXPIRED' });
    else toIngest.push(row);
  }

  for (let i = 0; i < toIngest.length; i += CHUNK) {
    const chunk = toIngest.slice(i, i + CHUNK);
    const chunkHash = createHash('sha256').update(chunk.map((row) => row.id).join(',')).digest('hex').slice(0, 16);
    const batch = await ingestBatch(ctx, { source: 'GOOGLE_PLACES', externalBatchId: `finder:${run.id}:${input.requestKey}:${chunkHash}`, simulated: run.simulated, records: chunk.map(finderIngestRecord) }, deps);
    const linked: Array<{ resultId: string; leadId: string }> = [];
    for (const [k, row] of chunk.entries()) {
      let rec: { status: string; leadId: string | null; reasonCode: string | null } = batch.records[k]!;
      const earlier = batch.records[k]!;
      if (earlier.reasonCode === 'ALREADY_RECEIVED' && earlier.sourceRecordId) {
        // An earlier chunk of this request (or an earlier request) already decided this record: keep its outcome.
        const stored = await ctx.db.leadSourceRecord.findFirst({ where: { id: earlier.sourceRecordId }, select: { status: true, leadId: true, reasonCode: true } });
        if (stored) rec = stored;
      }
      const leadId = (rec.status === 'ACCEPTED' || rec.status === 'DUPLICATE') && rec.leadId ? rec.leadId : null;
      outcomes.set(row.id, { outcome: rec.status === 'ACCEPTED' || rec.status === 'DUPLICATE' || rec.status === 'REVIEW' ? rec.status : 'REJECTED', leadId, reasonCode: rec.reasonCode });
      if (leadId) linked.push({ resultId: row.id, leadId });
    }
    if (linked.length > 0) {
      await withTx(ctx.db, async (tx) => {
        for (const l of linked) await tx.leadFinderResult.updateMany({ where: { id: l.resultId, importedLeadId: null }, data: { importedLeadId: l.leadId, importedAt: now } });
      });
    }
  }

  const results = rows.map((r) => ({ resultId: r.id, ...outcomes.get(r.id)! }));
  const count = (o: FinderImportOutcome) => results.filter((r) => r.outcome === o).length;
  const counts = { accepted: count('ACCEPTED'), duplicate: count('DUPLICATE'), review: count('REVIEW'), rejected: count('REJECTED'), alreadyImported: count('ALREADY_IMPORTED'), detailsExpired: count('DETAILS_EXPIRED') };

  await withTx(ctx.db, async (tx) => {
    await recordAudit(tx, ctx, { action: 'finder.import', targetType: 'LeadFinderRun', targetId: run.id, workspaceId, simulated: run.simulated, summary: { requested: rows.length, ...counts } });
    if (counts.accepted > 0) {
      await enqueuePlacesExpire(tx as unknown as JobStore, ctx.clock, { workspaceId, expiresAt: new Date(now.getTime() + PLACES_CONTENT_TTL_MS), correlationId: ctx.correlationId });
    }
  });
  return { runId: run.id, requested: rows.length, counts, results };
}
