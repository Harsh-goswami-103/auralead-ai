// E9, ADR-43, T14: the DRAFT stage registered in the pipeline executor.
// - An ingested DEMO lead runs INGESTION -> SCORE -> DRAFT; DRAFT stores exactly one AiDraft for
//   the execution (local-deterministic in DEMO, zero provider calls) and records its id in the
//   stage run's outputRef.
// - Replaying the DRAFT stage (a fresh pipeline.advance job) and re-running the stage handler
//   never creates a second draft for the execution.
// - In LIVE, a retryable provider failure retries the stage job; the last attempt stores a
//   NEEDS_REVIEW draft and the pipeline moves on to review (no local fallback).
// SCORE is a pass-through stub here so the test does not depend on T12's scoring stage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { idempotencyKey } from '@/lib/ids';
import { createLogger } from '@/lib/logger';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { enqueueJob } from '@/server/jobs/queue';
import { buildJobRegistry } from '@/server/jobs/registry';
import { ingestBatch } from '@/server/services/leads/ingest';
import { StageRegistry, STAGE_HANDLERS } from '@/server/services/pipeline/stages';
import { createDraftStage } from '@/server/services/pipeline/stages/draft';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import type { StageHandler } from '@/server/services/pipeline/stages/types';
import { createWorker, type Worker } from '../../../worker/worker';
import { createMockTransport, fixture } from '../contract/support';
import { ANTHROPIC_KEY, KEY_RING, makeLive, WS_A } from '../ai/support';
import { createIngestHarness, ctxFor, DEPS, type IngestHarness } from '../ingest/support';

let h: IngestHarness;
let db: PrismaClient;
let t: ReturnType<typeof createMockTransport>;
let mode: 'demo' | 'live' = 'demo';

const passScore: StageHandler = { stage: 'SCORE', run: async () => ({ status: 'DONE', outputRef: { stub: 'SCORE' } }) };

function worker(): Worker {
  const stages = new StageRegistry().register(ingestionStage).register(passScore).register(createDraftStage(() => ({ keyRing: KEY_RING, transport: { fetch: t.fetch, timeoutMs: 2_000 } })));
  const registry = buildJobRegistry([createPipelineAdvanceJob({ stages, mode: () => mode })]);
  return createWorker(
    { db, clock: h.clock, registry, logger: createLogger({ level: 'silent' }), mode, version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

async function drain(w: Worker): Promise<number> {
  let ran = 0;
  while ((await w.tick()) === 'ran') ran += 1;
  return ran;
}

async function ingest(tag: string, fields: Record<string, unknown>) {
  const result = await ingestBatch(ctxFor(db, h.clock), { source: 'GOOGLE_SHEETS', externalBatchId: `draft-${tag}`, records: [{ externalId: `row-${tag}`, fields: fields as never }] }, DEPS);
  const leadId = result.records[0]!.leadId!;
  return db.pipelineExecution.findUniqueOrThrow({ where: { leadId } });
}

async function draftJob(executionId: string) {
  const jobs = await db.job.findMany({ where: { type: 'pipeline.advance', workspaceId: WS_A } });
  const job = jobs.find((j) => { const p = j.payload as { executionId: string; stage: string }; return p.executionId === executionId && p.stage === 'DRAFT'; });
  if (!job) throw new Error('no DRAFT job');
  return job;
}

beforeAll(async () => {
  h = await createIngestHarness('pipeline-draft-stage');
  db = h.db;
  t = createMockTransport('https://api.anthropic.com');
});
afterAll(async () => {
  await t.close();
  await h.testDb.destroy();
});

describe('DRAFT stage', () => {
  it('is registered in the production stage list', () => {
    expect(STAGE_HANDLERS.map((s) => s.stage)).toContain('DRAFT');
  });

  it('DEMO: one local draft per execution, id in outputRef, zero provider calls', async () => {
    const execution = await ingest('demo', { name: 'Kavya Whitening Enquiry', phone: '+91 98555 10001', category: 'Teeth whitening', city: 'Gurugram' });
    await drain(worker());

    const run = await db.pipelineStageRun.findUniqueOrThrow({ where: { executionId_stage: { executionId: execution.id, stage: 'DRAFT' } } });
    expect(run.status).toBe('DONE');
    const drafts = await db.aiDraft.findMany({ where: { executionId: execution.id } });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft).toMatchObject({ trigger: 'PIPELINE', generatorLabel: 'local-deterministic', status: 'READY', leadId: execution.leadId, requestedBy: 'system:pipeline.advance' });
    expect(run.outputRef).toEqual({ draftId: draft.id, status: 'READY', generatorLabel: 'local-deterministic' });
    const job = await draftJob(execution.id);
    expect(draft.correlationId).toBe(job.correlationId);
    expect(t.captured).toHaveLength(0);
  });

  it('a replayed DRAFT stage creates no second draft', async () => {
    const execution = await ingest('replay', { name: 'Replay Dental Lead', phone: '+91 98555 10002', category: 'Dentist' });
    await drain(worker());
    await enqueueJob(db, h.clock, {
      type: 'pipeline.advance',
      payload: { executionId: execution.id, stage: 'DRAFT' },
      workspaceId: WS_A,
      idempotencyKey: idempotencyKey('test-replay-draft', execution.id),
      correlationId: 'req_draft_replay_0001',
    });
    expect(await drain(worker())).toBe(1);
    expect(await db.aiDraft.count({ where: { executionId: execution.id } })).toBe(1);
  });

  it('re-running the stage handler for an execution that already has a draft reuses it', async () => {
    const execution = await ingest('rerun', { name: 'Rerun Dental Lead', phone: '+91 98555 10003' });
    await drain(worker());
    const existing = await db.aiDraft.findFirstOrThrow({ where: { executionId: execution.id } });
    // Reset the stage run as a crash between commit and bookkeeping never could, then run again.
    await db.pipelineStageRun.update({ where: { executionId_stage: { executionId: execution.id, stage: 'DRAFT' } }, data: { status: 'RUNNING' } });
    await enqueueJob(db, h.clock, {
      type: 'pipeline.advance',
      payload: { executionId: execution.id, stage: 'DRAFT' },
      workspaceId: WS_A,
      idempotencyKey: idempotencyKey('test-rerun-draft', execution.id),
      correlationId: 'req_draft_rerun_0001',
    });
    await drain(worker());
    expect(await db.aiDraft.count({ where: { executionId: execution.id } })).toBe(1);
    const run = await db.pipelineStageRun.findUniqueOrThrow({ where: { executionId_stage: { executionId: execution.id, stage: 'DRAFT' } } });
    expect(run.outputRef).toMatchObject({ draftId: existing.id });
  });

  it('LIVE: a retryable failure retries; the last attempt stores NEEDS_REVIEW and the pipeline continues', async () => {
    mode = 'live';
    try {
      await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: 'claude-sonnet-5-5' });
      const execution = await ingest('live', { name: 'Live Whitening Lead', phone: '+91 98555 10004', category: 'Teeth whitening' });
      for (let i = 0; i < 5; i++) t.reply('/v1/messages', 503, fixture('anthropic', 'error-529'));
      const w = worker();
      for (let i = 0; i < 6; i++) {
        await drain(w);
        h.clock.advance(1_000);
      }
      const drafts = await db.aiDraft.findMany({ where: { executionId: execution.id } });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'anthropic', errorCode: 'PROVIDER_UNAVAILABLE', followUpText: null });
      const run = await db.pipelineStageRun.findUniqueOrThrow({ where: { executionId_stage: { executionId: execution.id, stage: 'DRAFT' } } });
      expect(run.status).toBe('DONE');
      const job = await draftJob(execution.id);
      expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 5, maxAttempts: 5 });
      expect(t.captured).toHaveLength(5);
    } finally {
      mode = 'demo';
      await db.workspace.update({ where: { id: WS_A }, data: { mode: 'DEMO' } });
    }
  });
});
