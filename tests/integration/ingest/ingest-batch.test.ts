// R12, E9: `ingestBatch` turns source records into leads with per-record results. Each accepted
// lead gets its LeadSourceRecord, contact keys, an audit event, a PipelineExecution and exactly
// one `pipeline.advance` job in the same transaction; ingestion never enqueues score, enrich or
// draft jobs directly. The batch is idempotent on (workspace, source, externalBatchId): a replay
// returns the stored results without writing, and the same id with different content is a 409.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { IdempotencyConflictError } from '@/lib/errors';
import { ingestBatch } from '@/server/services/leads/ingest';
import { createIngestHarness, ctxFor, DEPS, WS_A, WS_B, type IngestHarness } from './support';

let h: IngestHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createIngestHarness('ingest-batch');
  db = h.db;
});
afterAll(async () => {
  await h.testDb.destroy();
});

const THREE = [
  { externalId: 'place-1', providerId: 'ChIJ-smile-1', fields: { name: 'Bright Smile Dental', phone: '+91 98100 00001', city: 'Gurugram', category: 'Dentist', rating: 4.7, reviewCount: 120 } },
  { externalId: 'place-2', providerId: 'ChIJ-smile-2', fields: { name: 'Pearl Dental Studio', phone: '98100 00002', website: 'pearldental.in', city: 'Gurugram' } },
  { externalId: 'place-3', fields: { name: 'Gurgaon Kids Dentistry', email: 'Front.Desk@KidsDentistry.in', city: 'Gurugram' } },
];

describe('ingestBatch', () => {
  it('3 records give 3 leads, source records, batch counts, audit and one pipeline.advance job per lead', async () => {
    const ctx = ctxFor(db, h.clock);
    const result = await ingestBatch(ctx, { source: 'GMAPS_EXTENSION', externalBatchId: 'batch-3', simulated: true, records: THREE }, DEPS);

    expect(result.replayed).toBe(false);
    expect(result.status).toBe('COMPLETED');
    expect(result.counts).toEqual({ received: 3, accepted: 3, duplicate: 0, review: 0, rejected: 0 });
    expect(result.records.map((r) => [r.externalId, r.status])).toEqual([
      ['place-1', 'ACCEPTED'],
      ['place-2', 'ACCEPTED'],
      ['place-3', 'ACCEPTED'],
    ]);

    const leadIds = result.records.map((r) => r.leadId!);
    expect(new Set(leadIds).size).toBe(3);
    const leads = await db.lead.findMany({ where: { id: { in: leadIds } }, orderBy: { displayName: 'asc' } });
    expect(leads.map((l) => [l.displayName, l.workspaceId, l.firstSource, l.simulated, l.salesStage])).toEqual([
      ['Bright Smile Dental', WS_A, 'GMAPS_EXTENSION', true, 'NEW'],
      ['Gurgaon Kids Dentistry', WS_A, 'GMAPS_EXTENSION', true, 'NEW'],
      ['Pearl Dental Studio', WS_A, 'GMAPS_EXTENSION', true, 'NEW'],
    ]);
    expect(leads.find((l) => l.displayName === 'Gurgaon Kids Dentistry')!.emailNormalized).toBe('front.desk@kidsdentistry.in');

    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch).toMatchObject({ workspaceId: WS_A, source: 'GMAPS_EXTENSION', externalBatchId: 'batch-3', status: 'COMPLETED', simulated: true });
    expect(batch.counts).toEqual({ received: 3, accepted: 3, duplicate: 0, review: 0, rejected: 0 });
    expect(batch.completedAt?.toISOString()).toBe(h.clock.now().toISOString());

    const sourceRecords = await db.leadSourceRecord.findMany({ where: { importBatchId: batch.id } });
    expect(sourceRecords).toHaveLength(3);
    expect(sourceRecords.every((s) => s.status === 'ACCEPTED' && s.workspaceId === WS_A && leadIds.includes(s.leadId!))).toBe(true);
    // Raw payloads are stored redacted: no phone or email literal survives.
    const raw = JSON.stringify(sourceRecords.map((s) => s.rawPayloadRedacted));
    expect(raw).not.toContain('98100');
    expect(raw).not.toContain('kidsdentistry');

    const keys = await db.leadContactKey.findMany({ where: { leadId: { in: leadIds } } });
    expect(keys.map((k) => `${k.kind} ${k.value}`).sort()).toEqual(
      [
        'PHONE +919810000001',
        'PHONE +919810000002',
        'PROVIDER GMAPS_EXTENSION:ChIJ-smile-1',
        'PROVIDER GMAPS_EXTENSION:ChIJ-smile-2',
        'EMAIL front.desk@kidsdentistry.in',
      ].sort(),
    );

    const executions = await db.pipelineExecution.findMany({ where: { leadId: { in: leadIds } } });
    expect(executions).toHaveLength(3);
    expect(executions.every((e) => e.currentStage === 'INGESTION')).toBe(true);

    const jobs = await db.job.findMany({ where: { workspaceId: WS_A } });
    expect(jobs.map((j) => j.type)).toEqual(['pipeline.advance', 'pipeline.advance', 'pipeline.advance']);
    expect(jobs.map((j) => (j.payload as { executionId: string }).executionId).sort()).toEqual(executions.map((e) => e.id).sort());
    expect(jobs.every((j) => (j.payload as { stage: string }).stage === 'INGESTION' && j.status === 'QUEUED' && j.correlationId === ctx.correlationId)).toBe(true);

    const audits = await db.auditEvent.findMany({ where: { workspaceId: WS_A, correlationId: ctx.correlationId }, orderBy: { createdAt: 'asc' } });
    expect(audits.filter((a) => a.action === 'lead.ingest').map((a) => a.targetId).sort()).toEqual([...leadIds].sort());
    const batchAudit = audits.filter((a) => a.action === 'import.batch.ingest');
    expect(batchAudit).toHaveLength(1);
    expect(batchAudit[0]).toMatchObject({ targetType: 'ImportBatch', targetId: batch.id, actorKind: 'WEBHOOK', simulated: true });
    expect(batchAudit[0]!.summary).toMatchObject({ accepted: 3, received: 3 });
    expect(JSON.stringify(audits.map((a) => a.summary))).not.toContain('98100');
  });

  it('a replayed batch returns the stored results and writes nothing', async () => {
    const before = { leads: await db.lead.count(), jobs: await db.job.count(), audits: await db.auditEvent.count(), records: await db.leadSourceRecord.count() };
    const again = await ingestBatch(ctxFor(db, h.clock), { source: 'GMAPS_EXTENSION', externalBatchId: 'batch-3', simulated: true, records: THREE }, DEPS);
    expect(again.replayed).toBe(true);
    expect(again.counts).toEqual({ received: 3, accepted: 3, duplicate: 0, review: 0, rejected: 0 });
    expect(again.records.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    const after = { leads: await db.lead.count(), jobs: await db.job.count(), audits: await db.auditEvent.count(), records: await db.leadSourceRecord.count() };
    expect(after).toEqual(before);
  });

  it('the same batch id with different content is a 409 BATCH_CONTENT_MISMATCH', async () => {
    const changed = THREE.map((r, i) => (i === 0 ? { ...r, fields: { ...r.fields, name: 'Bright Smile Dental Care' } } : r));
    const err = await ingestBatch(ctxFor(db, h.clock), { source: 'GMAPS_EXTENSION', externalBatchId: 'batch-3', simulated: true, records: changed }, DEPS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyConflictError);
    expect(err).toMatchObject({ status: 409, code: 'BATCH_CONTENT_MISMATCH' });
  });

  it('a record seen in an earlier batch, or matching an existing contact, is a duplicate with no new job', async () => {
    const jobsBefore = await db.job.count();
    const result = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'GMAPS_EXTENSION',
        externalBatchId: 'batch-dup',
        records: [
          THREE[0]!,
          { externalId: 'place-9', fields: { name: 'Pearl Dental (2nd listing)', phone: '+919810000002' } },
        ],
      },
      DEPS,
    );
    expect(result.records.map((r) => [r.status, r.reasonCode])).toEqual([
      ['DUPLICATE', 'ALREADY_RECEIVED'],
      ['DUPLICATE', 'CONTACT_MATCH'],
    ]);
    expect(result.counts).toEqual({ received: 2, accepted: 0, duplicate: 2, review: 0, rejected: 0 });
    const pearl = await db.lead.findFirstOrThrow({ where: { displayName: 'Pearl Dental Studio' } });
    expect(result.records[1]!.leadId).toBe(pearl.id);
    expect(pearl.displayName).toBe('Pearl Dental Studio');
    expect(await db.job.count()).toBe(jobsBefore);
  });

  it('per-row failures are reported without failing the batch', async () => {
    const result = await ingestBatch(
      ctxFor(db, h.clock),
      {
        source: 'GOOGLE_SHEETS',
        externalBatchId: 'sheet-run-1',
        records: [
          { externalId: 'row-2', fields: { name: 'Cyber Hub Dental', phone: '9810000003' } },
          { externalId: 'row-3', fields: { name: '', phone: '9810000004' } },
          { externalId: 'row-4', fields: { name: 'No Contact Dental', phone: '123' } },
          { externalId: 'row-2', fields: { name: 'Cyber Hub Dental', phone: '9810000003' } },
        ],
      },
      DEPS,
    );
    expect(result.status).toBe('PARTIAL');
    expect(result.records.map((r) => [r.externalId, r.status, r.reasonCode])).toEqual([
      ['row-2', 'ACCEPTED', null],
      ['row-3', 'REJECTED', 'MISSING_NAME'],
      ['row-4', 'REJECTED', 'NO_VALID_CONTACT'],
      ['row-2', 'REJECTED', 'DUPLICATE_IN_BATCH'],
    ]);
    expect(result.counts).toEqual({ received: 4, accepted: 1, duplicate: 0, review: 0, rejected: 3 });
    const rejected = await db.leadSourceRecord.findMany({ where: { importBatchId: result.batchId, status: 'REJECTED' } });
    expect(rejected.map((r) => r.reasonCode).sort()).toEqual(['MISSING_NAME', 'NO_VALID_CONTACT']);
    expect(rejected.every((r) => r.leadId === null)).toBe(true);
  });

  it('a batch whose every record is rejected is FAILED', async () => {
    const result = await ingestBatch(
      ctxFor(db, h.clock),
      { source: 'MANUAL', externalBatchId: 'manual-bad', records: [{ externalId: 'm-1', fields: { name: 'Nobody' } }] },
      DEPS,
    );
    expect(result.status).toBe('FAILED');
    expect(await db.importBatch.findUniqueOrThrow({ where: { id: result.batchId } })).toMatchObject({ status: 'FAILED' });
  });

  it('the same phone in another workspace is a different lead (contact keys are per workspace)', async () => {
    const result = await ingestBatch(
      ctxFor(db, h.clock, WS_B),
      { source: 'GMAPS_EXTENSION', externalBatchId: 'batch-3', records: [{ externalId: 'place-1', fields: { name: 'Bright Smile Dental', phone: '+91 98100 00001' } }] },
      DEPS,
    );
    expect(result.records[0]).toMatchObject({ status: 'ACCEPTED' });
    const lead = await db.lead.findUniqueOrThrow({ where: { id: result.records[0]!.leadId! } });
    expect(lead.workspaceId).toBe(WS_B);
  });

  it('rejects malformed input with a validation error before any write', async () => {
    const before = await db.importBatch.count();
    await expect(
      ingestBatch(ctxFor(db, h.clock), { source: 'NOT_A_SOURCE', externalBatchId: 'x', records: [] } as never, DEPS),
    ).rejects.toThrow();
    expect(await db.importBatch.count()).toBe(before);
  });
});
