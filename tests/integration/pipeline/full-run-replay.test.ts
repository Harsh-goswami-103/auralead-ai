// E9, O5, ADR-43 (T23): the whole pinned pipeline, INGESTION -> SCORE -> DRAFT -> APPROVAL ->
// DELIVERY, run by the real executor and stage handlers, under an ingestion replay (the same Sheets
// batch delivered twice) plus a worker that dies mid-pipeline (after a stage ran, before its settle)
// and is reclaimed after its lease expires:
// - exactly one quote draft (the AiDraft with its proposal) per lead;
// - POLICY_AUTO with an eligible lead: exactly one outbound effect, one SENT attempt with
//   sendIntent AUTOMATED created by the DELIVERY stage, and one DEMO transport call;
// - HUMAN: zero outbound and exactly one PENDING approval (the drafted first-touch message).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestBatch } from '@/server/services/leads/ingest';
import { POLICY_AUTO_INITIATOR } from '@/server/services/messaging/eligibility';
import { savePipelineConfig } from '@/server/services/pipeline/config';
import { setPauseHandler } from '@/server/testing/pause';
import { PIPELINE_V1 } from '../../../prisma/seed/fixtures/configs';
import {
  createPipelineHarness,
  DEPS,
  firstTouchTemplate,
  ingestSheetsLead,
  setAutoSend,
  stageRuns,
  webhookCtx,
  WS_A,
  WS_C,
  type PipelineHarness,
} from './support';

let h: PipelineHarness;

beforeAll(async () => {
  h = await createPipelineHarness('pipeline-full-run');
  await firstTouchTemplate(h.db, WS_A);
  await firstTouchTemplate(h.db, WS_C);
  // Workspace A: auto-send on and a POLICY_AUTO pipeline v2. Workspace C keeps HUMAN v1.
  await setAutoSend(h.db, WS_A, true);
  const owner = await h.owner();
  await savePipelineConfig(owner, { graph: PIPELINE_V1, approvalMode: 'POLICY_AUTO', expectedVersion: 1 });
}, 120_000);

afterAll(async () => {
  setPauseHandler('job.before-settle', null);
  await h?.destroy();
});

/** Kills the worker once, before the settle of the given stage's job (the stage ran; nothing committed). */
function crashOnceBeforeSettleOf(stage: string): { crashed: () => boolean } {
  let crashed = false;
  setPauseHandler('job.before-settle', async (info) => {
    if (crashed) return;
    const job = await h.db.job.findUniqueOrThrow({ where: { id: String(info.jobId) } });
    if (job.type === 'pipeline.advance' && (job.payload as { stage: string }).stage === stage) {
      crashed = true;
      throw new Error(`simulated worker death before the ${stage} settle`);
    }
  });
  return { crashed: () => crashed };
}

/** Runs a worker until it dies, then a fresh worker after the lease expired, until idle. */
async function runWithRestart(): Promise<void> {
  await expect(h.drain(h.worker())).rejects.toThrow(/simulated worker death/);
  setPauseHandler('job.before-settle', null);
  h.clock.advance(61_000);
  const fresh = h.worker();
  await h.drain(fresh); // reaper requeues the dead worker's job with backoff
  h.clock.advance(1_000);
  await h.drain(fresh);
}

describe('full pipeline under replay and worker restart (E9)', () => {
  it('POLICY_AUTO, eligible lead: one draft, one SENT automated attempt, one demo transport call', async () => {
    const { input, leadId, execution } = await ingestSheetsLead(h, 'auto', '+91 98555 30001');
    expect(execution.pipelineConfigVersionId).not.toBe(null);
    const pinned = await h.db.pipelineConfigVersion.findUniqueOrThrow({ where: { id: execution.pipelineConfigVersionId } });
    expect(pinned).toMatchObject({ version: 2, approvalMode: 'POLICY_AUTO' });

    // Replay the same ingestion batch before and after the worker dies at the DELIVERY settle.
    const crash = crashOnceBeforeSettleOf('DELIVERY');
    expect((await ingestBatch(webhookCtx(h), input, DEPS)).replayed).toBe(true);
    await runWithRestart();
    expect(crash.crashed()).toBe(true);
    expect((await ingestBatch(webhookCtx(h), input, DEPS)).replayed).toBe(true);
    await h.drain();

    expect(await h.db.lead.count({ where: { workspaceId: WS_A, displayName: 'Pipeline Lead auto' } })).toBe(1);
    expect(await h.db.aiDraft.count({ where: { leadId } })).toBe(1);

    const runs = await stageRuns(h.db, execution.id);
    expect(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.status]))).toEqual({
      INGESTION: 'DONE',
      SCORE: 'DONE',
      DRAFT: 'DONE',
      APPROVAL: 'DONE',
      DELIVERY: 'DONE',
    });
    expect(runs.APPROVAL!.outputRef).toMatchObject({ decision: 'POLICY_APPROVED', channel: 'WHATSAPP' });

    const messages = await h.db.message.findMany({ where: { workspaceId: WS_A, direction: 'OUT', conversation: { leadId } } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: 'SENT', sendIntent: 'AUTOMATED', initiatedBy: POLICY_AUTO_INITIATOR, kind: 'TEMPLATE', simulated: true });
    const attempts = await h.db.dispatchAttempt.findMany({ where: { messageId: messages[0]!.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'SENT', sendIntent: 'AUTOMATED', initiatedBy: POLICY_AUTO_INITIATOR, attemptNo: 1 });
    expect(runs.DELIVERY!.outputRef).toMatchObject({ messageId: messages[0]!.id, attemptId: attempts[0]!.id });

    expect(h.outbox('whatsapp')).toHaveLength(1);
    expect(h.outbox('email')).toHaveLength(0);
    expect(h.outboundFetches).toEqual([]);
    expect(await h.db.approval.count({ where: { workspaceId: WS_A, status: 'PENDING', message: { conversation: { leadId } } } })).toBe(0);
    expect(await h.db.job.count({ where: { workspaceId: WS_A, status: 'DEAD' } })).toBe(0);
  });

  it('HUMAN: zero outbound and exactly one pending approval, also across replay and restart', async () => {
    const outboxBefore = h.outbox('whatsapp').length;
    const { input, leadId, execution } = await ingestSheetsLead(h, 'human', '+91 98555 30002', WS_C);
    const pinned = await h.db.pipelineConfigVersion.findUniqueOrThrow({ where: { id: execution.pipelineConfigVersionId } });
    expect(pinned).toMatchObject({ version: 1, approvalMode: 'HUMAN' });

    crashOnceBeforeSettleOf('APPROVAL');
    await runWithRestart();
    expect((await ingestBatch(webhookCtx(h, WS_C), input, DEPS)).replayed).toBe(true);
    await h.drain();

    expect(await h.db.aiDraft.count({ where: { leadId } })).toBe(1);
    const runs = await stageRuns(h.db, execution.id);
    expect(runs.APPROVAL).toMatchObject({ status: 'DONE', outputRef: expect.objectContaining({ decision: 'HUMAN_REVIEW', channel: 'WHATSAPP' }) });
    expect(runs.DELIVERY).toMatchObject({ status: 'SKIPPED', reasonCode: 'AWAITING_HUMAN_APPROVAL' });

    const approvals = await h.db.approval.findMany({ where: { workspaceId: WS_C, message: { conversation: { leadId } } } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: 'OUTBOUND_MESSAGE', status: 'PENDING', decidedBy: null });
    const message = await h.db.message.findUniqueOrThrow({ where: { id: approvals[0]!.messageId! } });
    expect(message).toMatchObject({ status: 'DRAFT', direction: 'OUT', sendIntent: null, kind: 'TEMPLATE' });
    expect(runs.APPROVAL!.outputRef).toMatchObject({ approvalId: approvals[0]!.id, messageId: message.id });

    expect(await h.db.dispatchAttempt.count({ where: { workspaceId: WS_C } })).toBe(0);
    expect(h.outbox('whatsapp')).toHaveLength(outboxBefore);
  });
});
