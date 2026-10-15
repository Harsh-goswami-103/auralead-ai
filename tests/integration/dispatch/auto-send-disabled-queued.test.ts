/**
 * E4 (ADR-45): send provenance is persisted and checked at dispatch. Automated attempts queued
 * while auto-send was on are SKIPPED `AUTO_SEND_DISABLED` once it is switched off (and, separately,
 * POLICY_AUTO-origin attempts once the lead's pinned pipeline is back on HUMAN): 0 sends. MANUAL_SINGLE
 * attempts in the same queue still send.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJobContext } from '@/server/auth/context';
import { withTx } from '@/server/db/tx';
import { POLICY_AUTO_INITIATOR } from '@/server/services/messaging/eligibility';
import { approveAndSendMessage, createMessageDraft, queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { createDispatchHarness, DEPS, eligibleLead, WS_A, type DispatchHarness } from './support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('auto-send-disabled');
}, 120_000);
afterAll(async () => h?.destroy());

let n = 0;
async function queueAutomated(leadId: string, initiatedBy: string) {
  n += 1;
  const ctx = getJobContext({ id: `job_auto_${n}`, workspaceId: WS_A, correlationId: `req_auto_${n}` }, { prisma: h.db, mode: 'demo', clock: h.clock });
  return withTx(ctx.db, (tx) =>
    queueOutboundMessage(tx, ctx, { leadId, channel: 'EMAIL', kind: 'EMAIL', subject: 'Following up', body: 'Checking in about your enquiry.', sendIntent: 'AUTOMATED', initiatedBy, dedupeKey: `auto-${n}` }, DEPS),
  );
}

async function queueManual(leadId: string) {
  const owner = await h.owner();
  const draft = await createMessageDraft(owner, { leadId, channel: 'EMAIL', kind: 'EMAIL', subject: 'Your visit', body: 'See you on Monday.' }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('auto-send disabled with automated work queued (E4)', () => {
  it('turning auto-send off skips queued AUTOMATED attempts; MANUAL_SINGLE still sends', async () => {
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { autoSendEnabled: true } });
    const leads = await Promise.all([eligibleLead(h.db), eligibleLead(h.db), eligibleLead(h.db)]);
    const automated = [await queueAutomated(leads[0]!.id, 'system:reply.auto'), await queueAutomated(leads[1]!.id, 'system:reply.auto')];
    const manual = await queueManual(leads[2]!.id);
    for (const a of automated) {
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).toMatchObject({ sendIntent: 'AUTOMATED', initiatedBy: 'system:reply.auto' });
      expect(await h.db.message.findUniqueOrThrow({ where: { id: a.messageId } })).toMatchObject({ sendIntent: 'AUTOMATED', initiatedBy: 'system:reply.auto' });
    }

    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { autoSendEnabled: false } });
    await h.drain();

    expect(h.email.calls.map((c) => c.request.attemptId)).toEqual([manual.attemptId]);
    for (const a of automated) {
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'AUTO_SEND_DISABLED' });
      expect((await h.db.message.findUniqueOrThrow({ where: { id: a.messageId } })).status).toBe('NOT_SENT');
    }
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: manual.attemptId } })).toMatchObject({ state: 'SENT' });
  }, 60_000);

  it('POLICY_AUTO-origin attempts are skipped once the pinned pipeline is back on HUMAN', async () => {
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { autoSendEnabled: true } });
    const pipeline = await h.db.pipelineConfigVersion.findFirstOrThrow({ where: { workspaceId: WS_A, active: true } });
    await h.db.pipelineConfigVersion.update({ where: { id: pipeline.id }, data: { approvalMode: 'POLICY_AUTO' } });
    const lead = await eligibleLead(h.db);
    await h.db.lead.update({ where: { id: lead.id }, data: { pipelineConfigVersionId: pipeline.id } });
    const other = await eligibleLead(h.db);
    await h.db.lead.update({ where: { id: other.id }, data: { pipelineConfigVersionId: pipeline.id } });

    const policy = await queueAutomated(lead.id, POLICY_AUTO_INITIATOR);
    const reply = await queueAutomated(other.id, 'system:reply.auto');
    await h.db.pipelineConfigVersion.update({ where: { id: pipeline.id }, data: { approvalMode: 'HUMAN' } });
    const calls0 = h.email.calls.length;
    await h.drain();

    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: policy.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'AUTO_SEND_DISABLED' });
    // Auto-send is still on: an automated reply that did not come from the POLICY_AUTO node is unaffected.
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: reply.attemptId } })).toMatchObject({ state: 'SENT' });
    expect(h.email.calls.slice(calls0).map((c) => c.request.attemptId)).toEqual([reply.attemptId]);
  }, 60_000);
});
