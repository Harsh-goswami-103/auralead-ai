// E9, ADR-43: the single pipeline orchestrator. Ingestion enqueues one `pipeline.advance` job; the
// executor runs the stages of the lead's pinned PipelineConfigVersion one at a time through the
// stage-handler registry, records each in PipelineStageRun (UNIQUE executionId + stage) and
// enqueues the next stage in the same fenced settle transaction. Stage handlers here are stubs
// whose committed effect is an audit row, so "runs once" is measured as committed effects.
// - A full run executes INGESTION, SCORE and DRAFT exactly once and halts visibly at the first
//   stage with no registered handler (APPROVAL until T23).
// - Replaying jobs (extra pipeline.advance jobs for finished stages, re-ingesting the batch) adds
//   no stage run, no effect and no job.
// - A worker that dies mid-stage (after the handler ran, before settle) is reclaimed after its
//   lease expires; the stage handler runs again but its effect commits once.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { ProviderUnavailableError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { createLogger } from '@/lib/logger';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { enqueueJob } from '@/server/jobs/queue';
import { buildJobRegistry } from '@/server/jobs/registry';
import { recordAudit } from '@/server/services/audit/record';
import { ingestBatch } from '@/server/services/leads/ingest';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import type { StageHandler, StageOutcome } from '@/server/services/pipeline/stages/types';
import { setPauseHandler } from '@/server/testing/pause';
import { createWorker, type Worker } from '../../../worker/worker';
import { createIngestHarness, ctxFor, DEPS, WS_A, type IngestHarness } from '../ingest/support';

let h: IngestHarness;
let db: PrismaClient;

const invocations = new Map<string, number>();
const behaviour: { failScoreOnceWith?: Error; scoreOutcome?: StageOutcome } = {};

function stub(stage: 'SCORE' | 'DRAFT'): StageHandler {
  return {
    stage,
    async run({ ctx, execution, stage: s }) {
      const key = `${execution.id}:${s}`;
      invocations.set(key, (invocations.get(key) ?? 0) + 1);
      if (s === 'SCORE' && behaviour.failScoreOnceWith) {
        const err = behaviour.failScoreOnceWith;
        behaviour.failScoreOnceWith = undefined;
        throw err;
      }
      if (s === 'SCORE' && behaviour.scoreOutcome) return behaviour.scoreOutcome;
      return {
        status: 'DONE',
        outputRef: { stub: s },
        finalTx: async (tx) => {
          await recordAudit(tx, ctx, { action: 'test.stage.effect', targetType: 'PipelineExecution', targetId: execution.id, summary: { stage: s } });
        },
      };
    },
  };
}

const stages = new StageRegistry().register(ingestionStage).register(stub('SCORE')).register(stub('DRAFT'));
const registry = buildJobRegistry([createPipelineAdvanceJob({ stages, mode: () => 'demo' })]);
let worker: Worker;

beforeAll(async () => {
  h = await createIngestHarness('pipeline-executor');
  db = h.db;
  worker = createWorker(
    { db, clock: h.clock, registry, logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
});
afterEach(() => {
  setPauseHandler('job.before-settle', null);
  behaviour.failScoreOnceWith = undefined;
  behaviour.scoreOutcome = undefined;
});
afterAll(async () => {
  await h.testDb.destroy();
});

async function drain(): Promise<number> {
  let ran = 0;
  while ((await worker.tick()) === 'ran') ran += 1;
  return ran;
}

async function ingestLead(tag: string, phone: string) {
  const input = { source: 'GOOGLE_SHEETS' as const, externalBatchId: `exec-${tag}`, records: [{ externalId: `row-${tag}`, fields: { name: `Executor ${tag}`, phone } }] };
  const result = await ingestBatch(ctxFor(db, h.clock), input, DEPS);
  const leadId = result.records[0]!.leadId!;
  const execution = await db.pipelineExecution.findUniqueOrThrow({ where: { leadId } });
  return { input, leadId, execution };
}

async function stageRuns(executionId: string) {
  const runs = await db.pipelineStageRun.findMany({ where: { executionId }, orderBy: { startedAt: 'asc' } });
  return Object.fromEntries(runs.map((r) => [r.stage, { status: r.status, reasonCode: r.reasonCode, outputRef: r.outputRef }]));
}

async function effects(executionId: string) {
  const rows = await db.auditEvent.findMany({ where: { action: 'test.stage.effect', targetId: executionId } });
  return rows.map((r) => (r.summary as { stage: string }).stage).sort();
}

describe('pipeline executor (E9)', () => {
  it('runs each registered stage once and halts visibly at the first stage without a handler', async () => {
    const { execution, leadId } = await ingestLead('full', '+91 98555 00001');
    await drain();

    expect(await stageRuns(execution.id)).toEqual({
      INGESTION: { status: 'DONE', reasonCode: null, outputRef: expect.objectContaining({ leadId, firstSource: 'GOOGLE_SHEETS', pipelineVersion: 1 }) },
      SCORE: { status: 'DONE', reasonCode: null, outputRef: { stub: 'SCORE' } },
      DRAFT: { status: 'DONE', reasonCode: null, outputRef: { stub: 'DRAFT' } },
      APPROVAL: { status: 'PENDING', reasonCode: 'STAGE_HANDLER_MISSING', outputRef: null },
    });
    expect(await effects(execution.id)).toEqual(['DRAFT', 'SCORE']);
    expect(invocations.get(`${execution.id}:SCORE`)).toBe(1);
    expect(invocations.get(`${execution.id}:DRAFT`)).toBe(1);
    expect((await db.pipelineExecution.findUniqueOrThrow({ where: { id: execution.id } })).currentStage).toBe('APPROVAL');

    const jobs = await db.job.findMany({ where: { workspaceId: WS_A, type: 'pipeline.advance' } });
    const mine = jobs.filter((j) => (j.payload as { executionId: string }).executionId === execution.id);
    expect(mine.map((j) => (j.payload as { stage: string }).stage).sort()).toEqual(['APPROVAL', 'DRAFT', 'INGESTION', 'SCORE']);
    expect(mine.every((j) => j.status === 'SUCCEEDED')).toBe(true);
    // One correlation chain from the ingestion request through every stage job.
    expect(new Set(mine.map((j) => j.correlationId)).size).toBe(1);

    const halted = await db.auditEvent.findFirstOrThrow({ where: { action: 'pipeline.stage.waiting', targetId: execution.id } });
    expect(halted.summary).toMatchObject({ stage: 'APPROVAL', reasonCode: 'STAGE_HANDLER_MISSING' });
  });

  it('replayed pipeline.advance jobs and a re-ingested batch run nothing twice', async () => {
    const { execution, input } = await ingestLead('replay', '+91 98555 00002');
    await drain();
    const runsBefore = await db.pipelineStageRun.count({ where: { executionId: execution.id } });
    const jobsBefore = await db.job.count();

    // Re-ingest the same batch: replayed, no new job.
    const again = await ingestBatch(ctxFor(db, h.clock), input, DEPS);
    expect(again.replayed).toBe(true);
    expect(await db.job.count()).toBe(jobsBefore);

    // Operator-style replays of finished stages under fresh idempotency keys.
    for (const stage of ['INGESTION', 'SCORE', 'DRAFT'] as const) {
      await enqueueJob(db, h.clock, {
        type: 'pipeline.advance',
        payload: { executionId: execution.id, stage },
        workspaceId: WS_A,
        idempotencyKey: idempotencyKey('test-replay', execution.id, stage),
        correlationId: 'req_replay_test_0001',
      });
    }
    expect(await drain()).toBe(3);

    expect(await db.pipelineStageRun.count({ where: { executionId: execution.id } })).toBe(runsBefore);
    expect(await effects(execution.id)).toEqual(['DRAFT', 'SCORE']);
    expect(invocations.get(`${execution.id}:SCORE`)).toBe(1);
    expect(invocations.get(`${execution.id}:DRAFT`)).toBe(1);
    // The replays only re-assert already-enqueued next stages (idempotent keys): no new jobs beyond the 3 replays.
    expect(await db.job.count()).toBe(jobsBefore + 3);
    const replays = await db.job.findMany({ where: { correlationId: 'req_replay_test_0001' } });
    expect(replays.every((j) => j.status === 'SUCCEEDED')).toBe(true);
  });

  it('a worker that dies after the stage ran but before settle: the stage reruns and its effect commits once', async () => {
    const { execution } = await ingestLead('crash', '+91 98555 00003');
    let crashed = false;
    setPauseHandler('job.before-settle', async (info) => {
      const job = await db.job.findUniqueOrThrow({ where: { id: String(info.jobId) } });
      if (!crashed && (job.payload as { stage: string }).stage === 'SCORE') {
        crashed = true;
        throw new Error('simulated process death before settle');
      }
    });

    await expect(drain()).rejects.toThrow('simulated process death before settle');
    expect(crashed).toBe(true);
    const stuck = await db.job.findFirstOrThrow({ where: { status: 'RUNNING' } });
    expect((stuck.payload as { stage: string }).stage).toBe('SCORE');
    expect(await stageRuns(execution.id)).toMatchObject({ INGESTION: { status: 'DONE' }, SCORE: { status: 'RUNNING' } });
    expect(await effects(execution.id)).toEqual([]);

    // The lease expires; the reaper requeues; after the backoff the job is reclaimed and completes.
    h.clock.advance(61_000);
    expect(await worker.tick()).toBe('idle');
    h.clock.advance(1_000);
    await drain();

    expect(invocations.get(`${execution.id}:SCORE`)).toBe(2);
    expect(await effects(execution.id)).toEqual(['DRAFT', 'SCORE']);
    expect(await stageRuns(execution.id)).toMatchObject({ SCORE: { status: 'DONE' }, DRAFT: { status: 'DONE' }, APPROVAL: { status: 'PENDING' } });
    const scoreJob = await db.job.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(scoreJob).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
  });

  it('a retryable stage error is retried; the effect still commits once', async () => {
    const { execution } = await ingestLead('retry', '+91 98555 00004');
    behaviour.failScoreOnceWith = new ProviderUnavailableError({ message: 'temporarily unavailable' });
    await drain();
    expect(await effects(execution.id)).toEqual([]);
    h.clock.advance(1_000);
    await drain();
    expect(invocations.get(`${execution.id}:SCORE`)).toBe(2);
    expect(await effects(execution.id)).toEqual(['DRAFT', 'SCORE']);
    expect(await stageRuns(execution.id)).toMatchObject({ SCORE: { status: 'DONE' } });
  });

  it('a FAILED stage stops the pipeline: no next stage job', async () => {
    const { execution } = await ingestLead('failed', '+91 98555 00005');
    behaviour.scoreOutcome = { status: 'FAILED', reasonCode: 'SCORE_INPUT_INVALID' };
    await drain();
    expect(await stageRuns(execution.id)).toEqual({
      INGESTION: expect.objectContaining({ status: 'DONE' }),
      SCORE: { status: 'FAILED', reasonCode: 'SCORE_INPUT_INVALID', outputRef: null },
    });
    const jobs = await db.job.findMany({ where: { type: 'pipeline.advance' } });
    expect(jobs.filter((j) => (j.payload as { executionId: string }).executionId === execution.id).map((j) => (j.payload as { stage: string }).stage).sort()).toEqual(['INGESTION', 'SCORE']);
    expect((await db.pipelineExecution.findUniqueOrThrow({ where: { id: execution.id } })).currentStage).toBe('SCORE');
    expect(await db.auditEvent.count({ where: { action: 'pipeline.stage.failed', targetId: execution.id } })).toBe(1);
  });

  it('a non-retryable stage error marks the stage FAILED and the job DEAD', async () => {
    const { execution } = await ingestLead('fatal', '+91 98555 00006');
    behaviour.failScoreOnceWith = new Error('bug in stage');
    await drain();
    expect(await stageRuns(execution.id)).toMatchObject({ SCORE: { status: 'FAILED', reasonCode: 'STAGE_ERROR' } });
    const job = (await db.job.findMany({ where: { type: 'pipeline.advance', status: 'DEAD' } })).find((j) => (j.payload as { executionId: string }).executionId === execution.id);
    expect(job).toMatchObject({ deadReason: 'STAGE_ERROR' });
  });

  it('a payload for a missing execution or an unknown stage goes DEAD without writes', async () => {
    const { job } = await enqueueJob(db, h.clock, {
      type: 'pipeline.advance',
      payload: { executionId: 'does-not-exist', stage: 'SCORE' },
      workspaceId: WS_A,
      idempotencyKey: 'test-missing-exec',
      correlationId: 'req_missing_exec_0001',
    });
    const { job: bad } = await enqueueJob(db, h.clock, {
      type: 'pipeline.advance',
      payload: { executionId: 'x', stage: 'TELEPORT' },
      workspaceId: WS_A,
      idempotencyKey: 'test-bad-stage',
      correlationId: 'req_bad_stage_0001',
    });
    await drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'DEAD', deadReason: 'EXECUTION_NOT_FOUND' });
    expect(await db.job.findUniqueOrThrow({ where: { id: bad.id } })).toMatchObject({ status: 'DEAD', deadReason: 'INVALID_PAYLOAD' });
  });
});
