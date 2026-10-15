/**
 * R40, O1: outbound pauses are honored by the worker at preflight. The global DB flag
 * (SystemSetting.outboundPaused), the `outbound.lock` file and OUTBOUND_PAUSED=1 each defer every
 * dispatch (attempt stays QUEUED, job QUEUED later, attempt counter refunded, 0 calls); the workspace
 * automation pause defers automated sends only. Ingestion and the pipeline keep running.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getJobContext, getWebhookContext } from '@/server/auth/context';
import { withTx } from '@/server/db/tx';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { ingestBatch } from '@/server/services/leads/ingest';
import { approveAndSendMessage, createMessageDraft, PAUSE_RECHECK_MS, queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { createDispatchHarness, DEPS, eligibleLead, WS_A, type DispatchHarness } from '../dispatch/support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('pause-honored', () => [createPipelineAdvanceJob({ stages: new StageRegistry().register(ingestionStage), mode: () => 'demo' })]);
}, 120_000);
afterAll(async () => h?.destroy());

beforeEach(async () => {
  await h.db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: false } });
  await h.db.workspace.update({ where: { id: WS_A }, data: { automationPaused: false } });
  h.flags.envOutboundPaused = false;
  fs.rmSync(h.lockFile, { force: true });
});

async function manualEmail() {
  const lead = await eligibleLead(h.db);
  const owner = await h.owner();
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Hi', body: 'Hello.' }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

let n = 0;
async function automatedEmail() {
  n += 1;
  const lead = await eligibleLead(h.db);
  const ctx = getJobContext({ id: `job_pause_${n}`, workspaceId: WS_A, correlationId: `req_pause_${n}` }, { prisma: h.db, mode: 'demo', clock: h.clock });
  return withTx(ctx.db, (tx) => queueOutboundMessage(tx, ctx, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Auto', body: 'Auto text.', sendIntent: 'AUTOMATED', initiatedBy: 'system:reply.auto', dedupeKey: `pause-${n}` }, DEPS));
}

async function ingestOne(tag: string) {
  const ctx = getWebhookContext({ workspaceId: WS_A }, { prisma: h.db, mode: 'demo', clock: h.clock }, `req_pause_ingest_${tag}`);
  const res = await ingestBatch(ctx, { source: 'GMAPS_EXTENSION', externalBatchId: `pause-${tag}`, simulated: true, records: [{ externalId: `pause-place-${tag}`, fields: { name: `Paused Clinic ${tag}`, phone: `+91 98100 7${tag.padStart(4, '0')}`, city: 'Gurugram' } }] }, DEPS);
  return res;
}

async function expectDeferred(r: { attemptId: string; jobId: string }, reason: string) {
  const calls0 = h.email.calls.length;
  await h.drain();
  expect(h.email.calls.length).toBe(calls0);
  expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'QUEUED' });
  const job = await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } });
  expect(job).toMatchObject({ status: 'QUEUED', attempts: 0 });
  expect(job.lastErrorCode).toContain(reason);
  expect(job.runAt.getTime()).toBe(h.clock.now().getTime() + PAUSE_RECHECK_MS);
  const log = await h.db.jobAttempt.findMany({ where: { jobId: r.jobId } });
  expect(log.every((a) => a.outcome === 'DEFERRED')).toBe(true);
}

describe('outbound pauses at dispatch (R40, O1)', () => {
  it('global DB flag: dispatch deferred while ingestion and the pipeline run; unpause sends', async () => {
    await h.db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: true } });
    const r = await manualEmail();
    const ingested = await ingestOne('1');
    await expectDeferred(r, 'GLOBAL_PAUSED');
    const leadId = ingested.records[0]!.leadId!;
    const advance = await h.db.job.findMany({ where: { type: 'pipeline.advance', workspaceId: WS_A, correlationId: 'req_pause_ingest_1' } });
    expect(advance.length).toBeGreaterThan(0);
    expect(advance.every((j) => j.status === 'SUCCEEDED')).toBe(true);
    expect(await h.db.pipelineStageRun.count({ where: { execution: { leadId }, stage: 'INGESTION', status: 'DONE' } })).toBe(1);

    await h.db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: false } });
    h.clock.advance(PAUSE_RECHECK_MS);
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'SENT' });
  }, 60_000);

  it('a send that is ineligible for a non-pause reason is skipped with that reason first, not GLOBAL_PAUSED', async () => {
    await h.db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: true } });
    const r = await manualEmail();
    const message = await h.db.message.findUniqueOrThrow({ where: { id: r.messageId }, include: { conversation: true } });
    await h.db.consentRecord.updateMany({ where: { leadId: message.conversation.leadId, channel: 'EMAIL' }, data: { withdrawnAt: h.clock.now() } });
    await h.drain();
    const attempt = await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } });
    expect(attempt).toMatchObject({ state: 'SKIPPED', reasonCode: 'NO_EMAIL_BASIS' });
    expect(attempt.errorRedacted).toContain('GLOBAL_PAUSED');
    expect(h.email.calls.filter((c) => c.request.attemptId === r.attemptId)).toHaveLength(0);
  }, 60_000);

  it('outbound.lock in the data dir defers dispatch', async () => {
    fs.writeFileSync(h.lockFile, 'restore in progress');
    await expectDeferred(await manualEmail(), 'GLOBAL_PAUSED');
  }, 60_000);

  it('OUTBOUND_PAUSED=1 defers dispatch', async () => {
    h.flags.envOutboundPaused = true;
    await expectDeferred(await manualEmail(), 'GLOBAL_PAUSED');
  }, 60_000);

  it('workspace automation pause defers automated sends only; manual sends go out', async () => {
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { autoSendEnabled: true } });
    await h.db.workspace.update({ where: { id: WS_A }, data: { automationPaused: true } });
    const automated = await automatedEmail();
    const manual = await manualEmail();
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: manual.attemptId } })).toMatchObject({ state: 'SENT' });
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: automated.attemptId } })).toMatchObject({ state: 'QUEUED' });
    expect((await h.db.job.findUniqueOrThrow({ where: { id: automated.jobId } })).lastErrorCode).toContain('WORKSPACE_PAUSED');
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { autoSendEnabled: false } });
  }, 60_000);
});
