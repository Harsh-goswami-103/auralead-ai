// ADR-124 (lead-gen F5): "Hand over to client". `handOverLead` runs in one transaction: the stage
// compare-and-set (to CONVERTED unless already later), every open conversation AI off with a human
// takeover under a modeVersion compare-and-set, the lead's PENDING message approvals withdrawn,
// its open pipeline execution stopped, the LeadHandoff row with the summary status, a PII-free
// `lead.handoff` audit and the `handoff.summary` job. A conflict anywhere writes nothing; a second
// handoff is 409 unless the same request is replayed. Afterwards the operator side is read-only
// (409 HANDED_OVER on the composer, the approval send and bulk) and the client carries on.
// The client acknowledges; the list and the command-center count follow.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppCtx } from '@/server/auth/context';
import type { ScopedDb } from '@/server/db/scoped';
import { dispatchReasonLabel, sendFromQueue } from '@/server/services/approvals/queue';
import { previewBulkAction } from '@/server/services/bulk/bulk';
import { acknowledgeHandoff, handOverLead, HANDOFF_SUMMARY_JOB, listClientHandoffs, loadLeadHandoff } from '@/server/services/leads/handoff';
import { leadFilterWhere } from '@/server/services/leads/list';
import { loadClientCommandCenter } from '@/server/services/metrics/command-center';
import { resumeConversationAi, setConversationAiMode } from '@/server/services/messaging/conversations';
import { createMessageDraft } from '@/server/services/messaging/dispatch';
import { getInboxThread, sendComposerMessage } from '@/server/services/messaging/inbox';
import { createQuote } from '@/server/services/quotes/versioning';
import { createLead, grantConsent } from '../dispatch/support';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';
import { SERVICE, userCtx } from '../quotes/support';
import { DEMO_AI, drain, EMPLOYEE_ID, handoffFootprint, handoffWorker, operatorWithHandoff, requestKey } from './support';

let h: InboundHarness;
let owner: AppCtx;
let employee: AppCtx;
const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };
const NOTE = 'Wants a five-page website before Diwali; call after 5 pm on +919812345678.';

beforeAll(async () => {
  h = await createInboundHarness('handoff-service');
  owner = await h.owner();
  employee = await operatorWithHandoff(h);
}, 120_000);
afterAll(async () => {
  await h?.destroy();
});

async function stageVersion(leadId: string) {
  return (await h.db.lead.findUniqueOrThrow({ where: { id: leadId } })).stageVersion;
}

/** A pinned pipeline execution of the lead: ingestion and score done, the draft step running. */
async function runningExecution(leadId: string) {
  const config = await h.db.pipelineConfigVersion.findFirstOrThrow({ where: { workspaceId: WS_A, active: true } });
  const execution = await h.db.pipelineExecution.create({ data: { workspaceId: WS_A, leadId, pipelineConfigVersionId: config.id, currentStage: 'DRAFT' } });
  for (const [stage, status] of [
    ['INGESTION', 'DONE'],
    ['SCORE', 'DONE'],
    ['DRAFT', 'RUNNING'],
  ] as const) {
    await h.db.pipelineStageRun.create({ data: { workspaceId: WS_A, executionId: execution.id, stage, status, startedAt: h.clock.now() } });
  }
  return execution;
}

/**
 * A WhatsApp send queued on the conversation that has not gone out (message PENDING, attempt and
 * dispatch job QUEUED, due in an hour), as the dispatch path leaves a deferred send.
 */
async function queuedSend(conversationId: string, opts: { initiatedBy: string; sendIntent: 'AUTOMATED' | 'MANUAL_SINGLE'; quoteVersionId?: string; tag: string }) {
  const now = h.clock.now();
  const message = await h.db.message.create({
    data: {
      workspaceId: WS_A,
      conversationId,
      channel: 'WHATSAPP',
      direction: 'OUT',
      kind: opts.quoteVersionId ? 'DOCUMENT' : 'TEXT',
      body: opts.quoteVersionId ? null : 'Following up on your enquiry.',
      quoteVersionId: opts.quoteVersionId ?? null,
      status: 'PENDING',
      statusRank: 0,
      simulated: true,
      sendIntent: opts.sendIntent,
      initiatedBy: opts.initiatedBy,
    },
  });
  const job = await h.db.job.create({
    data: {
      workspaceId: WS_A,
      type: 'dispatch.whatsapp',
      payload: { messageId: message.id },
      status: 'QUEUED',
      runAt: new Date(now.getTime() + 60 * 60_000),
      maxAttempts: 5,
      idempotencyKey: `handoff-queued:${opts.tag}`,
      correlationId: 'req_handoff_queued',
      createdAt: now,
      updatedAt: now,
    },
  });
  const attempt = await h.db.dispatchAttempt.create({
    data: {
      workspaceId: WS_A,
      messageId: message.id,
      quoteVersionId: opts.quoteVersionId ?? null,
      channel: 'WHATSAPP',
      attemptNo: 1,
      state: 'QUEUED',
      sendIntent: opts.sendIntent,
      initiatedBy: opts.initiatedBy,
      idempotencyKey: `handoff-queued-attempt:${opts.tag}`,
      jobId: job.id,
    },
  });
  return { messageId: message.id, attemptId: attempt.id, jobId: job.id };
}

/** A lead with a WhatsApp thread (DRAFT mode), an AUTO email thread and a pending message draft. */
async function workedLead(opening = 'Do you build websites for clinics?') {
  const { lead, conversation } = await leadWithConversation(h, opening);
  const email = await h.db.conversation.create({ data: { workspaceId: WS_A, leadId: lead.id, channel: 'EMAIL', contactKey: `email-key-${lead.id}`, aiMode: 'AUTO', modeVersion: 4 } });
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Here are our website packages.' }, DEPS);
  return { lead, whatsapp: conversation, email, draft };
}

describe('handOverLead', () => {
  it('converts the lead, takes over its conversations, withdraws its message drafts, stops its pipeline and records the handoff', async () => {
    const { lead, whatsapp, email, draft } = await workedLead();
    const execution = await runningExecution(lead.id);
    const before = await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const waBefore = await h.db.conversation.findUniqueOrThrow({ where: { id: whatsapp.id } });
    // The DRAFT thread's suggested reply (reply.auto) and the owner's draft are both waiting.
    const pendingBefore = await h.db.approval.count({ where: { status: 'PENDING', kind: 'OUTBOUND_MESSAGE', message: { conversation: { leadId: lead.id } } } });
    expect(pendingBefore).toBe(2);
    const key = requestKey();

    const result = await handOverLead(employee, { leadId: lead.id, note: NOTE, expectedStageVersion: before.stageVersion, requestKey: key }, DEMO_AI);

    expect(result).toMatchObject({ created: true, summaryStatus: 'PENDING', lead: { id: lead.id, salesStage: 'CONVERTED', stageVersion: before.stageVersion + 1, handedOverAt: h.clock.now().toISOString() } });
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ salesStage: 'CONVERTED', stageVersion: before.stageVersion + 1, handedOverAt: h.clock.now() });

    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: whatsapp.id } })).toMatchObject({ aiMode: 'OFF', humanTakeover: true, modeVersion: waBefore.modeVersion + 1 });
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ aiMode: 'OFF', humanTakeover: true, modeVersion: 5 });

    expect(await h.db.approval.findUniqueOrThrow({ where: { id: draft.approvalId } })).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'LEAD_HANDED_OVER', invalidatedAt: h.clock.now() });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: draft.messageId } })).toMatchObject({ status: 'NOT_SENT' });
    expect(await h.db.approval.count({ where: { status: 'PENDING', message: { conversation: { leadId: lead.id } } } })).toBe(0);

    const runs = await h.db.pipelineStageRun.findMany({ where: { executionId: execution.id }, orderBy: { stage: 'asc' } });
    expect(runs.find((r) => r.stage === 'DRAFT')).toMatchObject({ status: 'FAILED', reasonCode: 'HANDED_OVER', finishedAt: h.clock.now() });
    expect(runs.filter((r) => r.stage !== 'DRAFT').every((r) => r.status === 'DONE')).toBe(true);

    const row = await h.db.leadHandoff.findUniqueOrThrow({ where: { id: result.handoffId } });
    expect(row).toMatchObject({ workspaceId: WS_A, leadId: lead.id, fromUserId: EMPLOYEE_ID, note: NOTE, status: 'HANDED_OVER', summaryStatus: 'PENDING', summary: null, createdAt: h.clock.now() });

    const job = await h.db.job.findFirstOrThrow({ where: { type: HANDOFF_SUMMARY_JOB, workspaceId: WS_A, idempotencyKey: `handoff.summary:${result.handoffId}` } });
    expect(job).toMatchObject({ status: 'QUEUED', payload: { handoffId: result.handoffId }, maxAttempts: 3 });

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.handoff', targetId: lead.id } });
    expect(audit).toMatchObject({ actorUserId: EMPLOYEE_ID, actorKind: 'EMPLOYEE', targetType: 'Lead', workspaceId: WS_A });
    expect(audit.summary).toMatchObject({
      handoffId: result.handoffId,
      from: before.salesStage,
      to: 'CONVERTED',
      conversations: 2,
      invalidatedApprovals: pendingBefore,
      pipelineHalted: { executionId: execution.id, stage: 'DRAFT' },
      summaryStatus: 'PENDING',
      hasNote: true,
      requestKey: key,
    });
    // PII-free: neither the note nor the phone number in it reaches the audit trail.
    const audits = JSON.stringify(await h.db.auditEvent.findMany({ where: { OR: [{ targetId: lead.id }, { targetId: { in: [whatsapp.id, email.id] } }] } }));
    expect(audits).not.toContain('five-page');
    expect(audits).not.toContain('9812345678');
    expect(await h.db.auditEvent.count({ where: { action: 'conversation.handoff', targetId: { in: [whatsapp.id, email.id] } } })).toBe(2);
  });

  it('keeps a CONVERTED lead converted and skips a conversation that is already off and taken over', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Thanks, we accept the offer');
    await h.db.lead.update({ where: { id: lead.id }, data: { salesStage: 'CONVERTED', stageVersion: 7 } });
    await h.db.conversation.update({ where: { id: conversation.id }, data: { aiMode: 'OFF', humanTakeover: true, modeVersion: 3 } });
    const pendingBefore = await h.db.approval.count({ where: { status: 'PENDING', kind: 'OUTBOUND_MESSAGE', message: { conversation: { leadId: lead.id } } } });
    const result = await handOverLead(employee, { leadId: lead.id, expectedStageVersion: 7, requestKey: requestKey() }, DEMO_AI);
    expect(result.lead).toMatchObject({ salesStage: 'CONVERTED', stageVersion: 8 });
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ modeVersion: 3 });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.handoff', targetId: lead.id } });
    expect(audit.summary).toMatchObject({ from: 'CONVERTED', to: 'CONVERTED', conversations: 0, invalidatedApprovals: pendingBefore, pipelineHalted: null, hasNote: false });
  });

  it("cancels the operator's and the automation's queued sends that have not gone out; the client's own queued send and a quotation send stay", async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Please message me tomorrow morning');
    // Queued, not sent yet (a pause, quiet hours or a busy worker can hold a send for hours).
    const operatorSend = await sendComposerMessage(employee, { conversationId: conversation.id, requestKey: requestKey('composer'), kind: 'TEXT', body: 'We will send the designs tomorrow.' }, DEPS);
    const clientSend = await sendComposerMessage(owner, { conversationId: conversation.id, requestKey: requestKey('composer'), kind: 'TEXT', body: 'Hi, this is the clinic team.' }, DEPS);
    const automated = await queuedSend(conversation.id, { initiatedBy: 'system:pipeline.advance', sendIntent: 'AUTOMATED', tag: `auto-${lead.id}` });
    const { version } = await createQuote(owner, { leadId: lead.id, items: [{ serviceId: SERVICE.CONSULT, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Clinic website', timelineText: 'Two weeks' });
    const quoteSend = await queuedSend(conversation.id, { initiatedBy: EMPLOYEE_ID, sendIntent: 'MANUAL_SINGLE', quoteVersionId: version.id, tag: `quote-${lead.id}` });

    const result = await handOverLead(employee, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey() }, DEMO_AI);

    for (const send of [operatorSend, automated]) {
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: send.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'LEAD_HANDED_OVER' });
      expect(await h.db.job.findUniqueOrThrow({ where: { id: send.jobId } })).toMatchObject({ status: 'CANCELLED' });
      expect(await h.db.message.findUniqueOrThrow({ where: { id: send.messageId } })).toMatchObject({ status: 'NOT_SENT' });
    }
    for (const send of [clientSend, quoteSend]) {
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: send.attemptId } })).toMatchObject({ state: 'QUEUED' });
      expect(await h.db.job.findUniqueOrThrow({ where: { id: send.jobId } })).toMatchObject({ status: 'QUEUED' });
      expect(await h.db.message.findUniqueOrThrow({ where: { id: send.messageId } })).toMatchObject({ status: 'PENDING' });
    }
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.handoff', targetId: lead.id } });
    expect(audit.summary).toMatchObject({ handoffId: result.handoffId, cancelledSends: 2 });

    // Each cancelled send is traceable on its own, as the delivery checks trace theirs
    // (`dispatch.cancelled`, the reason only: no message text); the sends that stay have no such row.
    const all = [operatorSend, automated, clientSend, quoteSend];
    const cancelledRows = await h.db.auditEvent.findMany({ where: { action: 'dispatch.cancelled', targetType: 'DispatchAttempt', targetId: { in: all.map((s) => s.attemptId) } } });
    expect(cancelledRows.map((r) => r.targetId).sort()).toEqual([operatorSend.attemptId, automated.attemptId].sort());
    for (const row of cancelledRows) expect(row).toMatchObject({ workspaceId: WS_A, summary: { reasons: ['LEAD_HANDED_OVER'] } });

    // The person reading the thread (and the approval queue) gets words, not the code.
    expect(dispatchReasonLabel('LEAD_HANDED_OVER')).toBe('The lead was handed over to the client');
    const thread = await getInboxThread(owner, conversation.id, DEPS);
    expect(thread.messages.find((m) => m.id === operatorSend.messageId)?.note).toBe('Not sent: The lead was handed over to the client.');
    expect(thread.messages.find((m) => m.id === clientSend.messageId)?.note).toBeNull();
  });

  it('a stale stage version is 409 STAGE_VERSION_CONFLICT and writes nothing', async () => {
    const { lead, whatsapp } = await workedLead('Can you send prices?');
    await runningExecution(lead.id);
    await sendComposerMessage(employee, { conversationId: whatsapp.id, requestKey: requestKey('composer'), kind: 'TEXT', body: 'Our prices are on the way.' }, DEPS);
    const before = await handoffFootprint(h, lead.id);
    await expect(handOverLead(employee, { leadId: lead.id, note: NOTE, expectedStageVersion: before.lead.stageVersion + 1, requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({
      status: 409,
      code: 'STAGE_VERSION_CONFLICT',
    });
    expect(await handoffFootprint(h, lead.id)).toEqual(before);
  });

  it('a conversation compare-and-set lost to a concurrent change rolls the whole handoff back', async () => {
    const { lead, whatsapp } = await workedLead('Do you also do logos?');
    await runningExecution(lead.id);
    await sendComposerMessage(employee, { conversationId: whatsapp.id, requestKey: requestKey('composer'), kind: 'TEXT', body: 'Yes, logos too.' }, DEPS);
    const before = await handoffFootprint(h, lead.id);
    // Another person changes a conversation's mode between the handoff's read and its write: the
    // conversation compare-and-set matches no row. Everything written before it (the lead's stage
    // and handedOverAt) must roll back with it.
    const racing = { ...employee, db: losingConversationCas(employee.db) } as AppCtx;
    await expect(handOverLead(racing, { leadId: lead.id, expectedStageVersion: before.lead.stageVersion, requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({
      status: 409,
      code: 'MODE_VERSION_CONFLICT',
    });
    expect(await handoffFootprint(h, lead.id)).toEqual(before);
  });

  it('a second handoff is 409 ALREADY_HANDED_OVER; replaying the same request returns the first result', async () => {
    const { lead } = await leadWithConversation(h, 'Hello there');
    const key = requestKey();
    const first = await handOverLead(employee, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: key }, DEMO_AI);
    const replay = await handOverLead(employee, { leadId: lead.id, expectedStageVersion: 0, requestKey: key }, DEMO_AI);
    expect(replay).toEqual({ ...first, created: false });
    const footprint = await handoffFootprint(h, lead.id);
    await expect(handOverLead(employee, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_HANDED_OVER',
    });
    // The client owner holds leads.handoff too; it is 409 for everyone, and nothing changes.
    await expect(handOverLead(owner, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: key }, DEMO_AI)).rejects.toMatchObject({ status: 409, code: 'ALREADY_HANDED_OVER' });
    expect(await handoffFootprint(h, lead.id)).toEqual(footprint);
    expect(await h.db.leadHandoff.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('refuses a lost lead (422 LEAD_LOST), a merged lead (422 LEAD_MERGED), a foreign lead (404) and an operator without leads.handoff (403)', async () => {
    const lost = await createLead(h.db);
    await h.db.lead.update({ where: { id: lost.id }, data: { salesStage: 'LOST' } });
    await expect(handOverLead(employee, { leadId: lost.id, expectedStageVersion: 0, requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({ status: 422, code: 'LEAD_LOST' });

    const target = await createLead(h.db);
    const merged = await createLead(h.db);
    await h.db.lead.update({ where: { id: merged.id }, data: { mergedIntoLeadId: target.id } });
    await expect(handOverLead(employee, { leadId: merged.id, expectedStageVersion: 0, requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({ status: 422, code: 'LEAD_MERGED' });

    const foreign = await createLead(h.db, { workspaceId: (await h.db.workspace.findUniqueOrThrow({ where: { slug: 'ironpulse-fitness' } })).id });
    await expect(handOverLead(employee, { leadId: foreign.id, expectedStageVersion: 0, requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({ status: 404 });

    const narrow = await userCtx(h.db, h.clock, 'employee', 'kesari-crafts');
    const kesariLead = await createLead(h.db, { workspaceId: narrow.workspaceId! });
    await expect(handOverLead(narrow, { leadId: kesariLead.id, expectedStageVersion: 0, requestKey: requestKey() }, DEMO_AI)).rejects.toMatchObject({ status: 403 });
    for (const id of [lost.id, merged.id, foreign.id, kesariLead.id]) expect(await h.db.leadHandoff.count({ where: { leadId: id } })).toBe(0);
  });
});

describe('after the handoff', () => {
  it('the operator is refused on the composer, the approval send and bulk (409 HANDED_OVER); the client carries on', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Is the website mobile friendly?');
    await grantConsent(h.db, lead, 'EMAIL');
    const clientDraft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Yes, every page works on phones.' }, DEPS);
    // The handoff withdraws pending drafts; this one is created by the client afterwards.
    await handOverLead(employee, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey() }, DEMO_AI);
    expect(await h.db.approval.findUniqueOrThrow({ where: { id: clientDraft.approvalId } })).toMatchObject({ status: 'INVALIDATED' });
    const afterDraft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Our designer will call you today.' }, DEPS);

    const HANDED_OVER = { status: 409, code: 'HANDED_OVER' };
    await expect(sendComposerMessage(employee, { conversationId: conversation.id, requestKey: requestKey('composer'), kind: 'TEXT', body: 'Any update?' }, DEPS)).rejects.toMatchObject(HANDED_OVER);
    await expect(createMessageDraft(employee, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Checking in.' }, DEPS)).rejects.toMatchObject(HANDED_OVER);
    await expect(sendFromQueue(employee, afterDraft.approvalId, {}, DEPS)).rejects.toMatchObject(HANDED_OVER);
    // The handoff's AI off and takeover stand against the operator; only the client changes them.
    await expect(resumeConversationAi(employee, { conversationId: conversation.id })).rejects.toMatchObject(HANDED_OVER);
    await expect(setConversationAiMode(employee, { conversationId: conversation.id, aiMode: 'DRAFT' })).rejects.toMatchObject(HANDED_OVER);
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ aiMode: 'OFF', humanTakeover: true });
    const action = { action: 'SEND_EMAIL' as const, subject: 'Website packages', body: 'Fast websites for local businesses.' };
    const preview = await previewBulkAction(employee, { leadIds: [lead.id], ...action }, DEPS);
    expect(preview).toMatchObject({ eligible: 0, failed: 1 });
    expect(preview.rows[0]).toMatchObject({ outcome: 'FAILED', reasons: ['HANDED_OVER'] });

    // The client: composer, approval send and bulk all go through.
    expect((await sendComposerMessage(owner, { conversationId: conversation.id, requestKey: requestKey('composer'), kind: 'TEXT', body: 'Hi, this is Ananya from the clinic team.' }, DEPS)).created).toBe(true);
    expect((await sendFromQueue(owner, afterDraft.approvalId, {}, DEPS)).created).toBe(true);
    expect(await previewBulkAction(owner, { leadIds: [lead.id], ...action }, DEPS)).toMatchObject({ eligible: 1, failed: 0 });
  });

  it('the summary job runs for the handoff (DEMO local generator) and the client sees the summary', async () => {
    const { lead } = await leadWithConversation(h, 'How much does a clinic website cost and how long does it take?');
    const { handoffId } = await handOverLead(employee, { leadId: lead.id, note: 'Prefers WhatsApp.', expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey() }, DEMO_AI);
    await drain(handoffWorker(h));
    const row = await h.db.leadHandoff.findUniqueOrThrow({ where: { id: handoffId } });
    expect(row).toMatchObject({ summaryStatus: 'READY', summaryGeneratorLabel: 'local-deterministic' });
    const view = await loadLeadHandoff(owner, lead.id, DEMO_AI);
    expect(view.handoff).toMatchObject({ id: handoffId, status: 'HANDED_OVER', note: 'Prefers WhatsApp.', summaryStatus: 'READY', summaryGeneratorLabel: 'local-deterministic', fromUserName: 'Imran Qureshi' });
    expect(view.handoff?.summary?.asked).toMatch(/prices or a quotation/);
    expect(view.permissions).toEqual({ canHandOff: true, canAcknowledge: true });
    expect((await loadLeadHandoff(employee, lead.id, DEMO_AI)).permissions).toEqual({ canHandOff: true, canAcknowledge: false });
  });
});

describe('the client side', () => {
  it('lists open handoffs, counts them under "Needs you", filters the leads list, and acknowledges once', async () => {
    const { lead } = await leadWithConversation(h, 'Please share the design options');
    const { handoffId } = await handOverLead(employee, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey() }, DEMO_AI);
    const open = await listClientHandoffs(owner, { status: 'open' });
    expect(open.map((x) => x.id)).toContain(handoffId);
    expect(open.find((x) => x.id === handoffId)).toMatchObject({ lead: { id: lead.id, salesStage: 'CONVERTED' }, status: 'HANDED_OVER' });
    const openCount = await h.db.leadHandoff.count({ where: { workspaceId: WS_A, status: 'HANDED_OVER' } });
    const cc = await loadClientCommandCenter(owner);
    expect(cc.needsYou.ok && cc.needsYou.value.find((i) => i.id === 'handedOverLeads')).toMatchObject({ count: openCount, label: 'Handed over to you', href: '/dashboard/user/leads?handedOver=1' });

    const handedOver = await h.db.lead.findMany({ where: { AND: [{ workspaceId: WS_A }, leadFilterWhere({ handedOver: true })] }, select: { id: true } });
    expect(handedOver.map((l) => l.id)).toContain(lead.id);
    expect(await h.db.lead.count({ where: { AND: [{ workspaceId: WS_A }, leadFilterWhere({ handedOver: true })] } })).toBe(await h.db.lead.count({ where: { workspaceId: WS_A, handedOverAt: { not: null }, mergedIntoLeadId: null } }));

    expect(await acknowledgeHandoff(owner, { handoffId })).toEqual({ handoffId, status: 'ACKNOWLEDGED', changed: true });
    expect(await acknowledgeHandoff(owner, { handoffId })).toEqual({ handoffId, status: 'ACKNOWLEDGED', changed: false });
    expect(await h.db.leadHandoff.findUniqueOrThrow({ where: { id: handoffId } })).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: owner.actor!.userId, acknowledgedAt: h.clock.now() });
    expect(await h.db.auditEvent.count({ where: { action: 'lead.handoff.acknowledge', targetId: lead.id } })).toBe(1);
    expect((await listClientHandoffs(owner, { status: 'open' })).map((x) => x.id)).not.toContain(handoffId);
    expect((await listClientHandoffs(owner)).find((x) => x.id === handoffId)).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedByName: 'Ananya Sharma' });
    const after = await loadClientCommandCenter(owner);
    expect(after.needsYou.ok && after.needsYou.value.find((i) => i.id === 'handedOverLeads')?.count).toBe(openCount - 1);
  });

  it('acknowledging is for the client only: an operator is 404, and so is a handoff of another workspace', async () => {
    const { lead } = await leadWithConversation(h, 'Hi');
    const { handoffId } = await handOverLead(employee, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey() }, DEMO_AI);
    await expect(acknowledgeHandoff(employee, { handoffId })).rejects.toMatchObject({ status: 404 });
    await expect(listClientHandoffs(employee)).rejects.toMatchObject({ status: 404 });
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    await expect(acknowledgeHandoff(rohan, { handoffId })).rejects.toMatchObject({ status: 404 });
    expect(await h.db.leadHandoff.findUniqueOrThrow({ where: { id: handoffId } })).toMatchObject({ status: 'HANDED_OVER', acknowledgedAt: null });
  });
});

/** A scoped client whose transactions answer every conversation compare-and-set with "no row matched". */
function losingConversationCas(db: ScopedDb): ScopedDb {
  const wrapTx = (tx: object) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'conversation') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return new Proxy(value as object, {
          get(delegate, method) {
            if (method === 'updateMany') return async () => ({ count: 0 });
            const fn = Reflect.get(delegate, method) as unknown;
            return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(delegate) : fn;
          },
        });
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: (tx: object) => Promise<unknown>, options?: unknown) => (target.$transaction as (f: (tx: object) => Promise<unknown>, o?: unknown) => Promise<unknown>)((tx) => fn(wrapTx(tx)), options);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as ScopedDb;
}
