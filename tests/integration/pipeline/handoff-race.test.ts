// Adversarial review of ADR-43/ADR-124: a stage job that decided to run on its snapshot must not
// revive a stage a hand-over just stopped. The hand-over records the stop as a FAILED stage run
// (reason HANDED_OVER); the executor's fenced start must leave a finished stage run alone, run no
// handler and enqueue nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createLogger } from '@/lib/logger';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { buildJobRegistry } from '@/server/jobs/registry';
import { ingestBatch } from '@/server/services/leads/ingest';
import { StageRegistry } from '@/server/services/pipeline/stages';
import type { StageHandler } from '@/server/services/pipeline/stages/types';
import { createWorker } from '../../../worker/worker';
import { createIngestHarness, ctxFor, DEPS, WS_A, type IngestHarness } from '../ingest/support';

let h: IngestHarness;
let db: PrismaClient;
let handlerRuns = 0;

const stub = (stage: 'INGESTION' | 'SCORE'): StageHandler => ({
  stage,
  async run() {
    handlerRuns += 1;
    return { status: 'DONE', outputRef: { stub: stage } };
  },
});

beforeAll(async () => {
  h = await createIngestHarness('pipeline-handoff-race');
  db = h.db;
});
afterAll(async () => h.testDb.destroy());

describe('stage start vs a hand-over', () => {
  it('leaves a stage the hand-over stopped FAILED, runs no handler and enqueues no next stage', async () => {
    const stages = new StageRegistry().register(stub('INGESTION')).register(stub('SCORE'));
    const real = createPipelineAdvanceJob({ stages, mode: () => 'demo' });
    let raced = false;
    // The hand-over commits after the job read its snapshot and before its fenced stage start.
    const racing = {
      ...real,
      handler: (job: Parameters<typeof real.handler>[0]) =>
        real.handler({
          ...job,
          fencedTx: async (fn) => {
            if (!raced) {
              raced = true;
              const payload = job.job.payload as { executionId: string; stage: 'INGESTION' };
              await db.pipelineStageRun.create({ data: { workspaceId: WS_A, executionId: payload.executionId, stage: payload.stage, status: 'FAILED', reasonCode: 'HANDED_OVER', startedAt: h.clock.now(), finishedAt: h.clock.now() } });
            }
            return job.fencedTx(fn);
          },
        } as typeof job),
    };
    const worker = createWorker(
      { db, clock: h.clock, registry: buildJobRegistry([racing]), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );
    const result = await ingestBatch(ctxFor(db, h.clock), { source: 'GOOGLE_SHEETS', externalBatchId: 'handoff-race', records: [{ externalId: 'row-race', fields: { name: 'Race Lead', phone: '+91 98555 00077' } }] }, DEPS);
    const execution = await db.pipelineExecution.findUniqueOrThrow({ where: { leadId: result.records[0]!.leadId! } });
    while ((await worker.tick()) === 'ran') {
      /* drain */
    }
    expect(raced).toBe(true);
    expect(handlerRuns).toBe(0);
    const runs = await db.pipelineStageRun.findMany({ where: { executionId: execution.id } });
    expect(runs.map((r) => [r.stage, r.status, r.reasonCode])).toEqual([['INGESTION', 'FAILED', 'HANDED_OVER']]);
    const jobs = (await db.job.findMany({ where: { workspaceId: WS_A, type: 'pipeline.advance' } })).filter((j) => (j.payload as { executionId: string }).executionId === execution.id);
    expect(jobs.map((j) => (j.payload as { stage: string }).stage)).toEqual(['INGESTION']);
  });
});
