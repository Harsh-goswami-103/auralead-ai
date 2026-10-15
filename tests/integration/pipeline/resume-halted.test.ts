// ADR-51, M2 handoff, progress.md (T23): before T23 a pipeline halted visibly at APPROVAL
// (PipelineStageRun PENDING, STAGE_HANDLER_MISSING) and its `pipeline.advance` job SUCCEEDED, so the
// same idempotency key can never run it again. `resumeHaltedStages` enqueues one new job per halted
// run whose stage now has a handler, under a resume key (so a second call adds nothing), and the
// executor then runs the stage and the rest of the pipeline.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@/lib/logger';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { buildJobRegistry } from '@/server/jobs/registry';
import { resumeHaltedStages } from '@/server/services/pipeline/config';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { createDraftStage } from '@/server/services/pipeline/stages/draft';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import type { StageHandler } from '@/server/services/pipeline/stages/types';
import { createWorker } from '../../../worker/worker';
import { KEY_RING } from '../ai/support';
import { createPipelineHarness, firstTouchTemplate, ingestSheetsLead, stageRuns, WS_A, type PipelineHarness } from './support';

let h: PipelineHarness;

beforeAll(async () => {
  h = await createPipelineHarness('pipeline-resume');
  await firstTouchTemplate(h.db, WS_A);
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

const passScore: StageHandler = { stage: 'SCORE', run: async () => ({ status: 'DONE', outputRef: { stub: 'SCORE' } }) };

describe('resuming stages halted before their handler existed', () => {
  it('re-runs a STAGE_HANDLER_MISSING APPROVAL once, under a new key, and finishes the pipeline', async () => {
    // The M2 registry: no APPROVAL or DELIVERY handler yet.
    const m2 = createWorker(
      {
        db: h.db,
        clock: h.clock,
        registry: buildJobRegistry([
          createPipelineAdvanceJob({ stages: new StageRegistry().register(ingestionStage).register(passScore).register(createDraftStage(() => ({ keyRing: KEY_RING }))), mode: () => 'demo' }),
        ]),
        logger: createLogger({ level: 'silent' }),
        mode: 'demo',
        version: 'test',
        random: () => 0,
      },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );
    const { execution } = await ingestSheetsLead(h, 'halted', '+91 98555 50001');
    await h.drain(m2);
    expect((await stageRuns(h.db, execution.id)).APPROVAL).toMatchObject({ status: 'PENDING', reasonCode: 'STAGE_HANDLER_MISSING' });

    // A stage that still has no handler is not resumed.
    expect(await resumeHaltedStages(h.db, h.clock, { stages: ['INGESTION', 'SCORE', 'DRAFT'], correlationId: 'req_resume_test_0000' })).toEqual({ resumed: 0, jobIds: [] });

    const first = await resumeHaltedStages(h.db, h.clock, { stages: ['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY'], correlationId: 'req_resume_test_0001' });
    expect(first.resumed).toBe(1);
    const again = await resumeHaltedStages(h.db, h.clock, { stages: ['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY'], correlationId: 'req_resume_test_0002' });
    expect(again).toEqual({ resumed: 0, jobIds: [] });
    const resumeJob = await h.db.job.findUniqueOrThrow({ where: { id: first.jobIds[0]! } });
    expect(resumeJob).toMatchObject({ type: 'pipeline.advance', workspaceId: WS_A, status: 'QUEUED', correlationId: 'req_resume_test_0001' });
    expect(resumeJob.payload).toEqual({ executionId: execution.id, stage: 'APPROVAL' });
    expect(resumeJob.idempotencyKey).not.toBe(`pipeline.advance:${execution.id}:APPROVAL`);

    // The T23 worker runs APPROVAL (HUMAN v1: a pending first-touch approval), then DELIVERY.
    await h.drain();
    const runs = await stageRuns(h.db, execution.id);
    expect(runs.APPROVAL).toMatchObject({ status: 'DONE', reasonCode: null, outputRef: expect.objectContaining({ decision: 'HUMAN_REVIEW' }) });
    expect(runs.DELIVERY).toMatchObject({ status: 'SKIPPED', reasonCode: 'AWAITING_HUMAN_APPROVAL' });
    expect(await h.db.approval.count({ where: { workspaceId: WS_A, status: 'PENDING', kind: 'OUTBOUND_MESSAGE' } })).toBe(1);
    expect(await resumeHaltedStages(h.db, h.clock, { stages: ['APPROVAL', 'DELIVERY'], correlationId: 'req_resume_test_0003' })).toEqual({ resumed: 0, jobIds: [] });
  });
});
