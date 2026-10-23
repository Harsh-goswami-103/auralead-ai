// Cross-slice (integrator): HANDED_OVER, ADR-124, across the slices that each own a piece of it.
// F5 hands the lead over; F3's composer, drafts, conversation routes and `reply.auto`, F4's
// per-lead template values and the bulk run, and the foundation's dispatch and approval services
// each carry the guard. This file hands a lead over through `handOverLead` (not by setting the
// column) and then drives every send path through the routes the panels call:
//  - an EMPLOYEE (the operator) is refused on the composer (text, template, email), draft saving,
//    the approval send (message and quotation), a bulk run row, and conversation mode, takeover and
//    resume: 409 HANDED_OVER, and nothing is queued, drafted into the outbox or sent;
//  - the client OWNER goes through the same routes (a send, a draft, an approval, a quotation, a
//    bulk row, mode changes);
//  - `reply.auto` sends nothing for a handed-over lead, whether the job was queued before the
//    handoff, the client switched the thread back to AUTO, or the customer writes first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as approvalSendRoute } from '@/app/api/app/approvals/[approvalId]/send/route';
import { POST as bulkPreflightRoute } from '@/app/api/app/bulk/preflight/route';
import { POST as bulkRunsRoute } from '@/app/api/app/bulk/runs/route';
import { POST as modeRoute } from '@/app/api/app/conversations/[conversationId]/mode/route';
import { POST as resumeRoute } from '@/app/api/app/conversations/[conversationId]/resume/route';
import { POST as takeoverRoute } from '@/app/api/app/conversations/[conversationId]/takeover/route';
import { POST as draftsRoute } from '@/app/api/app/messages/drafts/route';
import { POST as messagesRoute } from '@/app/api/app/messages/route';
import type { AppCtx } from '@/server/auth/context';
import { createBulkRunJob } from '@/server/jobs/handlers/bulk-run';
import { createHandoffSummaryJob } from '@/server/jobs/handlers/handoff-summary';
import { handOverLead } from '@/server/services/leads/handoff';
import { resumeConversationAi, setConversationAiMode, setWorkspaceAutoSend } from '@/server/services/messaging/conversations';
import { createMessageDraft } from '@/server/services/messaging/dispatch';
import { createLead, grantConsent, quoteWithPdf } from '../dispatch/support';
import { customerSays, inboundMessage, leadWithConversation, repliesTo } from '../messaging/conversation-support';
import { createInboundHarness, inbound, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';
import { DEMO_AI, EMPLOYEE_ID, operatorWithHandoff, requestKey } from '../handoff/support';
import { approvedMarketingTemplate, callRoute, outboundFootprint, type RouteHandler } from './support';

const WS_A_SLUG = 'smile-avenue-dental';
const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };
const HANDED_OVER = { status: 409, body: { code: 'HANDED_OVER' } };

let h: InboundHarness;
let owner: AppCtx;
let operator: AppCtx;
let templateId: string;

beforeAll(async () => {
  h = await createInboundHarness('lg-handed-over', {
    extraDefs: () => [createBulkRunJob({ deps: () => ({ contactKeyPepper: PEPPER }), mode: () => 'demo' }), createHandoffSummaryJob({ mode: () => 'demo', deps: () => DEMO_AI })],
  });
  owner = await h.owner();
  operator = await operatorWithHandoff(h);
  templateId = (await approvedMarketingTemplate(h.db, WS_A)).id;
}, 120_000);
afterAll(async () => {
  await h?.destroy();
});

const stageVersion = async (leadId: string) => (await h.db.lead.findUniqueOrThrow({ where: { id: leadId } })).stageVersion;
const asOperator = (route: RouteHandler, url: string, body: Record<string, unknown>, params: Record<string, string> = {}) => callRoute(h, route, url, 'employee', { workspaceSlug: WS_A_SLUG, ...body }, params);
const asClient = (route: RouteHandler, url: string, body: Record<string, unknown>, params: Record<string, string> = {}) => callRoute(h, route, url, 'owner', body, params);

let keySeq = 0;
const key = (tag: string) => `lg-${tag}-${String((keySeq += 1)).padStart(5, '0')}`;

/** A lead with an open WhatsApp thread, an email thread, opt-ins on both channels and a rendered quotation. */
async function workedLead(opening: string) {
  const { lead, conversation } = await leadWithConversation(h, opening);
  await grantConsent(h.db, lead, 'WHATSAPP');
  await grantConsent(h.db, lead, 'EMAIL');
  const email = await h.db.conversation.create({ data: { workspaceId: WS_A, leadId: lead.id, channel: 'EMAIL', contactKey: `email-${lead.id}`, aiMode: 'OFF' } });
  const quote = await quoteWithPdf(h, lead.id);
  return { lead, whatsapp: conversation, email, quote };
}

describe('after a real handoff, every send path', () => {
  it('refuses the operator with 409 HANDED_OVER and writes nothing; the client owner goes through the same routes', async () => {
    const { lead, whatsapp, email, quote } = await workedLead('Do you build online shops?');
    // A draft the client left before the handoff is withdrawn by it; one written afterwards is the client's to send.
    const early = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Yes, we build online shops.' }, DEPS);
    const handoff = await handOverLead(operator, { leadId: lead.id, note: 'Wants an online shop.', expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey('lg') }, DEMO_AI);
    expect(await h.db.approval.findUniqueOrThrow({ where: { id: early.approvalId } })).toMatchObject({ status: 'INVALIDATED', invalidationReason: 'LEAD_HANDED_OVER' });
    const late = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Our designer will call you today.' }, DEPS);
    const quoteApproval = await h.db.approval.findFirstOrThrow({ where: { kind: 'QUOTE_VERSION', quoteId: quote.quote.id } });
    await h.drain();

    const before = await outboundFootprint(h.db, lead.id);
    const transportCalls = h.wa.calls.length + h.email.calls.length;
    const quoteRows = await h.db.quote.findUniqueOrThrow({ where: { id: quote.quote.id } });

    // ---- the operator -----------------------------------------------------------------------
    const text = { conversationId: whatsapp.id, kind: 'TEXT', body: 'Any update on the shop?' };
    expect(await asOperator(messagesRoute as RouteHandler, '/api/app/messages', { ...text, requestKey: key('op') })).toMatchObject(HANDED_OVER);
    expect(await asOperator(messagesRoute as RouteHandler, '/api/app/messages', { conversationId: whatsapp.id, kind: 'TEMPLATE', templateId, variables: {}, requestKey: key('op') })).toMatchObject(HANDED_OVER);
    expect(await asOperator(messagesRoute as RouteHandler, '/api/app/messages', { conversationId: email.id, kind: 'EMAIL', subject: 'Your online shop', body: 'Here is the plan.', requestKey: key('op') })).toMatchObject(HANDED_OVER);
    expect(await asOperator(draftsRoute as RouteHandler, '/api/app/messages/drafts', text)).toMatchObject(HANDED_OVER);
    expect(await asOperator(approvalSendRoute as RouteHandler, `/api/app/approvals/${late.approvalId}/send`, {}, { approvalId: late.approvalId })).toMatchObject(HANDED_OVER);
    expect(await asOperator(approvalSendRoute as RouteHandler, `/api/app/approvals/${quoteApproval.id}/send`, { expectedVersion: 1, channel: 'EMAIL' }, { approvalId: quoteApproval.id })).toMatchObject(HANDED_OVER);
    // The handoff's AI off and takeover stand against the operator, whatever the request asks.
    const modeParams = { conversationId: whatsapp.id };
    expect(await asOperator(modeRoute as RouteHandler, `/api/app/conversations/${whatsapp.id}/mode`, { aiMode: 'AUTO' }, modeParams)).toMatchObject(HANDED_OVER);
    expect(await asOperator(takeoverRoute as RouteHandler, `/api/app/conversations/${whatsapp.id}/takeover`, {}, modeParams)).toMatchObject(HANDED_OVER);
    expect(await asOperator(resumeRoute as RouteHandler, `/api/app/conversations/${whatsapp.id}/resume`, {}, modeParams)).toMatchObject(HANDED_OVER);
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: whatsapp.id } })).toMatchObject({ aiMode: 'OFF', humanTakeover: true });

    // Bulk is a row failure, not a refused request: the pre-flight and the run both report it.
    const bulk = { action: 'SEND_EMAIL', subject: 'Website packages', body: 'Fast websites for local businesses.', leadIds: [lead.id] };
    const preflight = await asOperator(bulkPreflightRoute as RouteHandler, '/api/app/bulk/preflight', bulk);
    expect(preflight).toMatchObject({ status: 200, body: { eligible: 0, failed: 1, rows: [{ leadId: lead.id, outcome: 'FAILED', reasons: ['HANDED_OVER'] }] } });
    const operatorRun = await asOperator(bulkRunsRoute as RouteHandler, '/api/app/bulk/runs', { ...bulk, requestKey: key('bulk') });
    expect(operatorRun.status).toBe(200);
    await h.drain();
    const finished = await h.db.bulkRun.findUniqueOrThrow({ where: { id: String((operatorRun.body.run as { id: string }).id) } });
    expect(finished).toMatchObject({ status: 'COMPLETED', queuedCount: 0, failedCount: 1 });

    // Nothing was queued, drafted into the outbox or handed to a transport.
    expect(await outboundFootprint(h.db, lead.id)).toEqual(before);
    expect(h.wa.calls.length + h.email.calls.length).toBe(transportCalls);
    expect(await h.db.approval.findUniqueOrThrow({ where: { id: late.approvalId } })).toMatchObject({ status: 'PENDING' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: late.messageId } })).toMatchObject({ status: 'DRAFT' });
    expect(await h.db.quote.findUniqueOrThrow({ where: { id: quote.quote.id } })).toMatchObject({ status: quoteRows.status, currentVersionNo: quoteRows.currentVersionNo });
    expect(await h.db.auditEvent.count({ where: { action: 'message.send', actorUserId: EMPLOYEE_ID, targetId: { in: before.outMessages.map((m) => m.split(':')[0]!) } } })).toBe(0);

    // ---- the client -------------------------------------------------------------------------
    const sent = await asClient(messagesRoute as RouteHandler, '/api/app/messages', { ...text, body: 'Hi, this is Ananya from the studio.', requestKey: key('client') });
    expect(sent).toMatchObject({ status: 200, body: { created: true } });
    expect(await asClient(messagesRoute as RouteHandler, '/api/app/messages', { conversationId: whatsapp.id, kind: 'TEMPLATE', templateId, variables: {}, requestKey: key('client') })).toMatchObject({ status: 200, body: { created: true } });
    expect(await asClient(messagesRoute as RouteHandler, '/api/app/messages', { conversationId: email.id, kind: 'EMAIL', subject: 'Your online shop', body: 'Here is the plan.', requestKey: key('client') })).toMatchObject({ status: 200, body: { created: true } });
    expect(await asClient(draftsRoute as RouteHandler, '/api/app/messages/drafts', text)).toMatchObject({ status: 200 });
    expect(await asClient(approvalSendRoute as RouteHandler, `/api/app/approvals/${late.approvalId}/send`, {}, { approvalId: late.approvalId })).toMatchObject({ status: 200, body: { created: true } });
    expect(await asClient(approvalSendRoute as RouteHandler, `/api/app/approvals/${quoteApproval.id}/send`, { expectedVersion: 1, channel: 'EMAIL' }, { approvalId: quoteApproval.id })).toMatchObject({ status: 200, body: { created: true } });
    expect(await asClient(bulkPreflightRoute as RouteHandler, '/api/app/bulk/preflight', bulk)).toMatchObject({ status: 200, body: { eligible: 1, failed: 0 } });
    const clientRun = await asClient(bulkRunsRoute as RouteHandler, '/api/app/bulk/runs', { ...bulk, requestKey: key('bulk') });
    expect(clientRun.status).toBe(200);
    expect(await asClient(takeoverRoute as RouteHandler, `/api/app/conversations/${whatsapp.id}/takeover`, {}, modeParams)).toMatchObject({ status: 200 });
    expect(await asClient(modeRoute as RouteHandler, `/api/app/conversations/${whatsapp.id}/mode`, { aiMode: 'OFF' }, modeParams)).toMatchObject({ status: 200 });
    await h.drain();
    expect(await h.db.bulkRun.findUniqueOrThrow({ where: { id: String((clientRun.body.run as { id: string }).id) } })).toMatchObject({ status: 'COMPLETED', queuedCount: 1, failedCount: 0 });
    expect((await outboundFootprint(h.db, lead.id)).sendable).toBeGreaterThanOrEqual(before.sendable + 5);
    // The client's sends are attributed to the client, never to the operator.
    const clientActors = await h.db.dispatchAttempt.findMany({ where: { message: { conversation: { leadId: lead.id } } }, select: { initiatedBy: true } });
    expect(clientActors.some((a) => a.initiatedBy === EMPLOYEE_ID)).toBe(false);
    expect(handoff.created).toBe(true);
  });
});

describe('reply.auto for a handed-over lead', () => {
  async function autoLead(opening: string) {
    await setWorkspaceAutoSend(owner, { enabled: true });
    const { lead, conversation } = await leadWithConversation(h, opening);
    await setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'AUTO' });
    return { lead, conversation };
  }

  it('answers a service question in AUTO before the handoff (control)', async () => {
    const { lead } = await autoLead('Hello');
    const wamid = await customerSays(h, lead, 'Do you do root canal treatment?');
    await h.drain();
    const [reply] = await repliesTo(h, (await inboundMessage(h, wamid)).id);
    expect(reply).toMatchObject({ sendIntent: 'AUTOMATED', generatorLabel: 'local-deterministic' });
  });

  it('a reply job queued before the handoff, run after the client switched the thread back to AUTO, sends nothing', async () => {
    const { lead, conversation } = await autoLead('Hello');
    // The customer's question is received and processed; its reply job waits in the queue.
    const wamid = await customerSays(h, lead, 'Do you do root canal treatment?');
    // Run jobs one at a time until the message is processed (its reply job is queued), and stop there.
    let job = null;
    for (let i = 0; i < 20 && job === null; i += 1) {
      await h.worker.tick();
      const question = await h.db.message.findFirst({ where: { workspaceId: WS_A, channel: 'WHATSAPP', providerMessageId: wamid } });
      job = question ? await h.db.job.findFirst({ where: { type: 'reply.auto', idempotencyKey: `reply.auto:${question.id}` } }) : null;
    }
    if (job === null) throw new Error('the customer message never queued a reply job');
    const question = await inboundMessage(h, wamid);
    expect(job.status).toBe('QUEUED');

    await handOverLead(operator, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey('lg') }, DEMO_AI);
    // The client may turn the thread's AI back on; the handoff still stands.
    await resumeConversationAi(owner, { conversationId: conversation.id });
    await setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'AUTO' });
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ aiMode: 'AUTO', humanTakeover: false });
    const before = await outboundFootprint(h.db, lead.id);

    await h.drain();
    expect(await h.db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await repliesTo(h, question.id)).toEqual([]);
    expect(await outboundFootprint(h.db, lead.id)).toEqual(before);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'reply.not_generated', targetId: question.id } });
    expect(audit.summary).toMatchObject({ conversationId: conversation.id, reason: 'HANDED_OVER' });
  });

  it('a question asked after the handoff queues no reply job and sends nothing, even in AUTO', async () => {
    const { lead, conversation } = await autoLead('Hello');
    await handOverLead(operator, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey('lg') }, DEMO_AI);
    await resumeConversationAi(owner, { conversationId: conversation.id });
    await setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'AUTO' });
    const before = await outboundFootprint(h.db, lead.id);
    const jobsBefore = await h.db.job.count({ where: { type: 'reply.auto' } });

    const wamid = await customerSays(h, lead, 'How long does a website take?');
    await h.drain();
    const question = await inboundMessage(h, wamid);
    expect(question).toMatchObject({ direction: 'IN', conversationId: conversation.id });
    expect(await h.db.job.count({ where: { type: 'reply.auto' } })).toBe(jobsBefore);
    expect(await repliesTo(h, question.id)).toEqual([]);
    expect(await outboundFootprint(h.db, lead.id)).toEqual(before);
  });

  it('a customer who writes first to a handed-over lead with no thread gets no reply, and the new thread is born off and taken over', async () => {
    const lead = await createLead(h.db);
    await handOverLead(operator, { leadId: lead.id, expectedStageVersion: await stageVersion(lead.id), requestKey: requestKey('lg') }, DEMO_AI);
    expect(await h.db.conversation.count({ where: { leadId: lead.id } })).toBe(0);
    const jobsBefore = await h.db.job.count({ where: { type: 'reply.auto' } });

    const first = await inbound(lead, { text: 'Can you send me your prices?' }, h.clock.now());
    expect(first.res.status).toBe(200);
    await h.drain();
    const conversation = await h.db.conversation.findFirstOrThrow({ where: { leadId: lead.id, channel: 'WHATSAPP' } });
    expect(await h.db.job.count({ where: { type: 'reply.auto' } })).toBe(jobsBefore);
    expect(await h.db.message.count({ where: { conversationId: conversation.id, direction: 'OUT' } })).toBe(0);
    // The handoff turned the AI off and took every thread over (ADR-124): a thread that opens
    // afterwards starts in the same state, so nothing in the UI promises drafts that never come.
    expect(conversation).toMatchObject({ aiMode: 'OFF', humanTakeover: true });
  });
});
