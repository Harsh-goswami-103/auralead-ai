// ADR-124 (Foundation-B1): once a lead is handed over to the client (`Lead.handedOverAt`), the
// operator side is read-only. `assertNotHandedOver` refuses EMPLOYEE actors with 409 HANDED_OVER
// on every send path and on conversation mode changes; the client (a USER owner) carries on, and
// automated system sends are not touched by it. It is not an eligibility reason: the bulk
// pre-flight reports it as a row failure, and the eligibility reason list does not change.
// - Composer send (`sendComposerMessage` -> `queueOutboundMessage`).
// - Approval send (`sendFromQueue` -> `approveAndSendMessage` / `approveAndSendQuote`) and drafts
//   (`createMessageDraft`).
// - Bulk (`previewBulkAction`, `requestBulkRun` and the `bulk.run` job, where the requester is
//   the EMPLOYEE named in `initiatedBy`).
// - Conversation AI mode, takeover and resume.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lead } from '@/generated/prisma/client';
import { ConflictError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { withTx } from '@/server/db/tx';
import { createBulkRunJob } from '@/server/jobs/handlers/bulk-run';
import { buildJobRegistry } from '@/server/jobs/registry';
import { sendFromQueue } from '@/server/services/approvals/queue';
import { getBulkRun, previewBulkAction, requestBulkRun } from '@/server/services/bulk/bulk';
import { assertNotHandedOver, HandedOverError } from '@/server/services/leads/handoff-guard';
import { resumeConversationAi, setConversationAiMode, takeOverConversation } from '@/server/services/messaging/conversations';
import { approveAndSendQuote, createMessageDraft, queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { REASON_LABELS } from '@/server/services/messaging/eligibility';
import { sendComposerMessage } from '@/server/services/messaging/inbox';
import { seedId } from '../../../prisma/seed/ids';
import { createWorker, type Worker } from '../../../worker/worker';
import { createLead, grantConsent, quoteWithPdf } from '../dispatch/support';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';
import { userCtx } from '../quotes/support';

let h: InboundHarness;
let owner: AppCtx;
let employee: AppCtx;
let bulkWorker: Worker;
const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };
const EMPLOYEE_ID = seedId('user', 'employee');
const HANDED_OVER = { status: 409, code: 'HANDED_OVER' };

beforeAll(async () => {
  h = await createInboundHarness('handoff-guard');
  owner = await h.owner();
  employee = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
  bulkWorker = createWorker(
    { db: h.db, clock: h.clock, registry: buildJobRegistry([...h.defs, createBulkRunJob({ deps: () => ({ contactKeyPepper: PEPPER }), mode: () => 'demo' })]), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}, 120_000);
afterAll(async () => {
  await h?.destroy();
});

async function handOver(lead: Pick<Lead, 'id'>) {
  await h.db.lead.update({ where: { id: lead.id }, data: { handedOverAt: h.clock.now() } });
}

async function drainAll() {
  while ((await bulkWorker.tick()) === 'ran');
}

async function outboundCount(leadId: string) {
  return h.db.message.count({ where: { workspaceId: WS_A, direction: 'OUT', status: { not: 'DRAFT' }, conversation: { leadId } } });
}

let keySeq = 0;
const requestKey = () => `guard-key-${String((keySeq += 1)).padStart(4, '0')}`;

describe('assertNotHandedOver', () => {
  it('is a 409 HANDED_OVER conflict for EMPLOYEE actors only, and not an eligibility reason', async () => {
    expect(employee.actor?.role).toBe('EMPLOYEE');
    expect(owner.actor?.role).toBe('USER');
    const lead = await createLead(h.db);
    // Not handed over: nobody is refused.
    await withTx(employee.db, (tx) => assertNotHandedOver(tx, employee, lead.id));
    await handOver(lead);
    const error = await withTx(employee.db, (tx) => assertNotHandedOver(tx, employee, lead.id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandedOverError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ ...HANDED_OVER, safeDetails: { leadId: lead.id } });
    await withTx(owner.db, (tx) => assertNotHandedOver(tx, owner, lead.id));
    expect(Object.keys(REASON_LABELS)).not.toContain('HANDED_OVER');
  });
});

describe('send paths', () => {
  it('composer send: the operator is refused and nothing is queued; the client sends', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Do you build online shops?');
    // Before the handoff the operator may answer.
    const before = await sendComposerMessage(employee, { conversationId: conversation.id, requestKey: requestKey(), kind: 'TEXT', body: 'Yes, we do.' }, DEPS);
    expect(before.created).toBe(true);
    await handOver(lead);
    const sent = await outboundCount(lead.id);
    await expect(sendComposerMessage(employee, { conversationId: conversation.id, requestKey: requestKey(), kind: 'TEXT', body: 'Any update?' }, DEPS)).rejects.toMatchObject(HANDED_OVER);
    expect(await outboundCount(lead.id)).toBe(sent);
    const client = await sendComposerMessage(owner, { conversationId: conversation.id, requestKey: requestKey(), kind: 'TEXT', body: 'Hi, this is Ananya from the studio.' }, DEPS);
    expect(client.created).toBe(true);
    expect(await outboundCount(lead.id)).toBe(sent + 1);
  });

  it('approval send and drafts: the operator is refused; the client approves and sends', async () => {
    const { lead } = await leadWithConversation(h, 'Please send details');
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Here are our packages.' }, DEPS);
    await handOver(lead);

    await expect(sendFromQueue(employee, draft.approvalId, {}, DEPS)).rejects.toMatchObject(HANDED_OVER);
    expect(await h.db.approval.findUniqueOrThrow({ where: { id: draft.approvalId } })).toMatchObject({ status: 'PENDING' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: draft.messageId } })).toMatchObject({ status: 'DRAFT' });
    await expect(createMessageDraft(employee, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Following up.' }, DEPS)).rejects.toMatchObject(HANDED_OVER);

    const sent = await sendFromQueue(owner, draft.approvalId, {}, DEPS);
    expect(sent.created).toBe(true);
    expect(await h.db.dispatchAttempt.count({ where: { messageId: draft.messageId } })).toBe(1);
  });

  it('quote send: the operator is refused before anything is approved', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'EMAIL');
    const quote = await quoteWithPdf(h, lead.id);
    await handOver(lead);
    await expect(approveAndSendQuote(employee, { quoteId: quote.quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS)).rejects.toMatchObject(HANDED_OVER);
    expect(await h.db.quote.findUniqueOrThrow({ where: { id: quote.quote.id } })).toMatchObject({ status: 'DRAFT' });
    expect(await outboundCount(lead.id)).toBe(0);
  });

  it('bulk: a handed-over lead is a failed row for an operator (pre-flight and job), and eligible for the client', async () => {
    const handed = await createLead(h.db);
    const open = await createLead(h.db);
    for (const lead of [handed, open]) await grantConsent(h.db, lead, 'EMAIL');
    await handOver(handed);
    const action = { action: 'SEND_EMAIL' as const, subject: 'New website packages', body: 'We build fast websites for local businesses.' };
    const leadIds = [handed.id, open.id];

    const preview = await previewBulkAction(employee, { leadIds, ...action }, DEPS);
    expect(preview).toMatchObject({ selected: 2, eligible: 1, skipped: 0, failed: 1 });
    expect(preview.rows.find((r) => r.leadId === handed.id)).toMatchObject({ outcome: 'FAILED', reasons: ['HANDED_OVER'] });
    expect(preview.byReason).toEqual([{ code: 'HANDED_OVER', label: 'Handed over to the client', count: 1 }]);
    expect(await previewBulkAction(owner, { leadIds, ...action }, DEPS)).toMatchObject({ eligible: 2, failed: 0 });

    const run = await requestBulkRun(employee, { requestKey: requestKey(), leadIds, ...action }, DEPS);
    expect(run.preflight).toEqual({ eligible: 1, skipped: 0, failed: 1 });
    // The lead is handed over between the confirmation and the job: the job checks again.
    const late = await createLead(h.db);
    await grantConsent(h.db, late, 'EMAIL');
    const lateRun = await requestBulkRun(employee, { requestKey: requestKey(), leadIds: [late.id], ...action }, DEPS);
    expect(lateRun.preflight).toEqual({ eligible: 1, skipped: 0, failed: 0 });
    await handOver(late);
    await drainAll();

    const done = await getBulkRun(owner, run.id);
    expect(done).toMatchObject({ status: 'COMPLETED', queued: 1, failed: 1 });
    expect(done.rows.find((r) => r.leadId === handed.id)).toMatchObject({ outcome: 'FAILED', messageId: null, reasons: [{ code: 'HANDED_OVER', label: 'Handed over to the client' }] });
    expect(done.rows.find((r) => r.leadId === open.id)).toMatchObject({ outcome: 'QUEUED' });
    expect(await getBulkRun(owner, lateRun.id)).toMatchObject({ status: 'COMPLETED', queued: 0, failed: 1 });
    expect(await outboundCount(handed.id)).toBe(0);
    expect(await outboundCount(late.id)).toBe(0);

    // The client's own bulk send reaches the handed-over lead.
    const clientRun = await requestBulkRun(owner, { requestKey: requestKey(), leadIds: [handed.id], ...action }, DEPS);
    await drainAll();
    expect(await getBulkRun(owner, clientRun.id)).toMatchObject({ status: 'COMPLETED', queued: 1, failed: 0 });
  });

  it('queueOutboundMessage in a job: refused when an EMPLOYEE initiated the send, not for system sends', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'EMAIL');
    await handOver(lead);
    const job = getJobContext({ id: 'job_guard_test', workspaceId: WS_A, correlationId: 'req_guard_job_0001' }, { prisma: h.db, mode: 'demo', clock: h.clock });
    const queue = (initiatedBy: string, dedupeKey: string) =>
      withTx(job.db, (tx) => queueOutboundMessage(tx, job, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Hello', body: 'Hello there.', sendIntent: 'BULK', initiatedBy, dedupeKey }, DEPS));
    await expect(queue(EMPLOYEE_ID, 'guard-job-employee')).rejects.toMatchObject(HANDED_OVER);
    expect((await queue('system:pipeline.advance', 'guard-job-system')).created).toBe(true);
    expect((await queue(owner.actor!.userId, 'guard-job-owner')).created).toBe(true);
  });
});

describe('conversation mode changes', () => {
  it('the operator cannot change the AI mode, take over or resume; the client can', async () => {
    const { lead, conversation } = await leadWithConversation(h, 'Hello');
    await handOver(lead);
    const { modeVersion } = await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } });

    await expect(setConversationAiMode(employee, { conversationId: conversation.id, aiMode: 'OFF' })).rejects.toMatchObject(HANDED_OVER);
    await expect(takeOverConversation(employee, { conversationId: conversation.id })).rejects.toMatchObject(HANDED_OVER);
    await expect(resumeConversationAi(employee, { conversationId: conversation.id })).rejects.toMatchObject(HANDED_OVER);
    expect((await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).modeVersion).toBe(modeVersion);

    expect(await takeOverConversation(owner, { conversationId: conversation.id })).toMatchObject({ changed: true, humanTakeover: true });
    expect(await resumeConversationAi(owner, { conversationId: conversation.id })).toMatchObject({ changed: true, humanTakeover: false });
    expect(await setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'OFF' })).toMatchObject({ changed: true, aiMode: 'OFF' });
  });

  it('an operator still changes the mode of a lead that was not handed over', async () => {
    const { conversation } = await leadWithConversation(h, 'Hello again');
    expect(await takeOverConversation(employee, { conversationId: conversation.id })).toMatchObject({ changed: true, humanTakeover: true });
  });
});
