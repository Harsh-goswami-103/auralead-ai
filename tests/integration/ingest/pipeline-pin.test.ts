// O5: a lead pins the workspace's active PipelineConfigVersion at ingestion, on both the Lead and
// its PipelineExecution. Activating a new version later affects only leads ingested afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { withTx } from '@/server/db/tx';
import { ingestBatch } from '@/server/services/leads/ingest';
import { seedId } from '../../../prisma/seed/ids';
import { PIPELINE_V1 } from '../../../prisma/seed/fixtures/configs';
import { createIngestHarness, ctxFor, DEPS, WS_A, type IngestHarness } from './support';

let h: IngestHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createIngestHarness('pipeline-pin');
  db = h.db;
});
afterAll(async () => {
  await h.testDb.destroy();
});

async function ingestOne(externalId: string, phone: string): Promise<string> {
  const r = await ingestBatch(ctxFor(db, h.clock), { source: 'META_ADS', externalBatchId: `pin-${externalId}`, records: [{ externalId, fields: { name: `Lead ${externalId}`, phone } }] }, DEPS);
  return r.records[0]!.leadId!;
}

describe('pipeline version pin (O5)', () => {
  it('lead and execution pin the active PipelineConfigVersion; a later version affects new leads only', async () => {
    const v1 = seedId('pipeline-version', 'smile-avenue-dental:1');
    const before = await ingestOne('lg-1', '+91 98333 00001');
    const leadBefore = await db.lead.findUniqueOrThrow({ where: { id: before } });
    expect(leadBefore.pipelineConfigVersionId).toBe(v1);
    const execBefore = await db.pipelineExecution.findUniqueOrThrow({ where: { leadId: before } });
    expect(execBefore.pipelineConfigVersionId).toBe(v1);

    const v2 = await withTx(db, async (tx) => {
      await tx.pipelineConfigVersion.update({ where: { id: v1 }, data: { active: false } });
      return tx.pipelineConfigVersion.create({
        data: { workspaceId: WS_A, version: 2, graph: PIPELINE_V1, approvalMode: 'HUMAN', active: true, createdBy: seedId('user', 'owner') },
      });
    });

    const after = await ingestOne('lg-2', '+91 98333 00002');
    expect((await db.lead.findUniqueOrThrow({ where: { id: after } })).pipelineConfigVersionId).toBe(v2.id);
    expect((await db.pipelineExecution.findUniqueOrThrow({ where: { leadId: after } })).pipelineConfigVersionId).toBe(v2.id);

    // The earlier lead keeps v1.
    expect((await db.lead.findUniqueOrThrow({ where: { id: before } })).pipelineConfigVersionId).toBe(v1);
    expect((await db.pipelineExecution.findUniqueOrThrow({ where: { leadId: before } })).pipelineConfigVersionId).toBe(v1);
  });

  it('a workspace without an active pipeline still ingests the lead, with no execution and no job', async () => {
    await db.pipelineConfigVersion.updateMany({ where: { workspaceId: WS_A }, data: { active: false } });
    const jobsBefore = await db.job.count();
    const leadId = await ingestOne('lg-3', '+91 98333 00003');
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.pipelineConfigVersionId).toBeNull();
    expect(await db.pipelineExecution.count({ where: { leadId } })).toBe(0);
    expect(await db.job.count()).toBe(jobsBefore);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'lead.ingest', targetId: leadId } });
    expect(audit.summary).toMatchObject({ pipeline: 'NO_ACTIVE_PIPELINE' });
  });
});
