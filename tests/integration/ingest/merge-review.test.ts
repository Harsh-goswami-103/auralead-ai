// R12 dedupe to review: a record whose email matches lead A and whose phone matches lead B is
// never auto-merged. It becomes a REVIEW source record with an OPEN MergeReview naming both
// candidates, and neither A nor B (nor their contact keys) is written. No pipeline starts for it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { ingestBatch } from '@/server/services/leads/ingest';
import { createIngestHarness, ctxFor, DEPS, WS_A, type IngestHarness } from './support';

let h: IngestHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createIngestHarness('merge-review');
  db = h.db;
});
afterAll(async () => {
  await h.testDb.destroy();
});

describe('merge review', () => {
  it('email matches A and phone matches B: MergeReview, no write to A or B', async () => {
    const seeded = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'GOOGLE_SHEETS',
        externalBatchId: 'seed-run',
        records: [
          { externalId: 'row-a', fields: { name: 'Alpha Orthodontics', email: 'hello@alpha-ortho.in' } },
          { externalId: 'row-b', fields: { name: 'Beta Dental Care', phone: '+91 98222 00002' } },
        ],
      },
      DEPS,
    );
    const [leadA, leadB] = seeded.records.map((r) => r.leadId!);
    const snapshot = async () => ({
      leads: await db.lead.findMany({ where: { id: { in: [leadA!, leadB!] } }, orderBy: { id: 'asc' } }),
      keys: await db.leadContactKey.findMany({ where: { leadId: { in: [leadA!, leadB!] } }, orderBy: { id: 'asc' } }),
      consents: await db.consentRecord.count({ where: { leadId: { in: [leadA!, leadB!] } } }),
    });
    const before = await snapshot();
    const jobsBefore = await db.job.count();
    h.clock.advance(60_000);

    const ctx = ctxFor(db, h.clock);
    const result = await ingestBatch(
      ctx,
      {
        source: 'GOOGLE_SHEETS',
        externalBatchId: 'conflict-run',
        records: [{ externalId: 'row-c', fields: { name: 'Alpha Beta Dental', email: 'HELLO@alpha-ortho.in', phone: '098222 00002' } }],
      },
      DEPS,
    );

    expect(result.records[0]).toMatchObject({ status: 'REVIEW', reasonCode: 'MULTIPLE_MATCHES', leadId: null });
    expect(result.counts).toEqual({ received: 1, accepted: 0, duplicate: 0, review: 1, rejected: 0 });
    expect(result.status).toBe('COMPLETED');

    const review = await db.mergeReview.findFirstOrThrow({ where: { workspaceId: WS_A, sourceRecordId: result.records[0]!.sourceRecordId! } });
    expect(review.status).toBe('OPEN');
    expect([...(review.candidateLeadIds as string[])].sort()).toEqual([leadA, leadB].sort());
    expect(result.records[0]!.mergeReviewId).toBe(review.id);

    const sourceRecord = await db.leadSourceRecord.findUniqueOrThrow({ where: { id: result.records[0]!.sourceRecordId! } });
    expect(sourceRecord).toMatchObject({ status: 'REVIEW', leadId: null, reasonCode: 'MULTIPLE_MATCHES' });

    expect(await snapshot()).toEqual(before);
    expect(await db.job.count()).toBe(jobsBefore);
    expect(await db.lead.count({ where: { displayName: 'Alpha Beta Dental' } })).toBe(0);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { correlationId: ctx.correlationId, action: 'lead.merge_review.open' } });
    expect(audit).toMatchObject({ targetType: 'MergeReview', targetId: review.id });
  });
});
