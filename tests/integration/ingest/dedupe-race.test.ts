// R12 dedupe race: two batches carrying the same phone, ingested at the same moment through two
// separate Prisma clients (two SQLite connections, as the web and worker processes would be),
// produce exactly one lead. The other record is a DUPLICATE linked to that lead, and only one
// pipeline.advance job exists. LeadContactKey (workspaceId, kind, value) UNIQUE is the backstop.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { ingestBatch } from '@/server/services/leads/ingest';
import { createIngestHarness, ctxFor, DEPS, WS_A, type IngestHarness } from './support';

let h: IngestHarness;
let first: PrismaClient;
let second: PrismaClient;

beforeAll(async () => {
  h = await createIngestHarness('dedupe-race');
  first = h.db;
  second = h.testDb.client();
});
afterAll(async () => {
  await h.testDb.destroy();
});

describe('dedupe race', () => {
  for (const round of [1, 2, 3, 4, 5]) {
    it(`round ${round}: two concurrent batches with the same phone give one lead`, async () => {
      const phone = `+91 98111 0000${round}`;
      const e164 = `+9198111000${String(round).padStart(2, '0')}`;
      const [a, b] = await Promise.all([
        ingestBatch(
          ctxFor(first, h.clock),
          { source: 'GOOGLE_SHEETS', externalBatchId: `race-a-${round}`, records: [{ externalId: `sheet-row-${round}`, fields: { name: 'Race Dental', phone } }] },
          DEPS,
        ),
        ingestBatch(
          ctxFor(second, h.clock),
          { source: 'META_ADS', externalBatchId: `race-b-${round}`, records: [{ externalId: `leadgen-${round}`, fields: { name: 'Race Dental Clinic', phone } }] },
          DEPS,
        ),
      ]);

      const statuses = [a.records[0]!.status, b.records[0]!.status].sort();
      expect(statuses).toEqual(['ACCEPTED', 'DUPLICATE']);
      expect(a.records[0]!.leadId).toBe(b.records[0]!.leadId);

      const leads = await first.lead.findMany({ where: { workspaceId: WS_A, phoneE164: e164 } });
      expect(leads).toHaveLength(1);
      const keys = await first.leadContactKey.findMany({ where: { workspaceId: WS_A, kind: 'PHONE', value: e164 } });
      expect(keys).toHaveLength(1);
      const executions = await first.pipelineExecution.findMany({ where: { leadId: leads[0]!.id } });
      expect(executions).toHaveLength(1);
      const jobs = await first.job.findMany({ where: { workspaceId: WS_A, type: 'pipeline.advance' } });
      expect(jobs.filter((j) => (j.payload as { executionId: string }).executionId === executions[0]!.id)).toHaveLength(1);
      const sourceRecords = await first.leadSourceRecord.findMany({ where: { leadId: leads[0]!.id } });
      expect(sourceRecords.map((s) => s.status).sort()).toEqual(['ACCEPTED', 'DUPLICATE']);
    });
  }
});
