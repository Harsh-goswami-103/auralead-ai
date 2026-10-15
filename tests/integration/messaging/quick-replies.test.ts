/**
 * R23, R45, P2, P3, P4, C15: quick replies with stable payload ids, a button-text fallback and
 * unknown payloads to human review.
 *  - AL_QR_QUOTE_V1 with an approved current quote: the quotation document is queued as an
 *    in-window reply and sent (a media document, never a localhost link), bound to the version's
 *    human approval;
 *  - AL_QR_QUOTE_V1 without one (P3): the lead's DRAFT quote (or a new one from its last proposal)
 *    gets its approval flagged `customer_requested`; no holding message unless auto-send is on;
 *  - AL_QR_CALL_V1 (P4): one CallRequest, a replay creates none; an https booking link becomes a
 *    reply that follows the approval rules;
 *  - button text fallback when the payload is missing; an unknown payload goes to review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveQuote, createQuote } from '@/server/services/quotes/versioning';
import { createDraft } from '../quotes/support';
import { createLead, quoteWithPdf, SERVICE_CONSULT } from '../dispatch/support';
import { createInboundHarness, inbound, nextWamid, postWhatsApp, waEnvelope, waFrom, waMessageValue, WS_A, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('quick-replies');
}, 120_000);
afterAll(async () => h?.destroy());

async function setAutoSend(on: boolean, bookingUrl: string | null = null) {
  await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { autoSendEnabled: on, bookingUrl } });
}

async function outboundFor(leadId: string) {
  return h.db.message.findMany({ where: { direction: 'OUT', conversation: { leadId } }, orderBy: { createdAt: 'asc' } });
}

describe('AL_QR_QUOTE_V1', () => {
  it('with an approved current quote: queues and sends the document in the window, never a link', async () => {
    await setAutoSend(false);
    const lead = await createLead(h.db);
    const { quote, version } = await quoteWithPdf(h, lead.id);
    await approveQuote(await h.owner(), quote.id, { expectedVersion: 1 });

    const calls0 = h.wa.calls.length;
    const { res } = await inbound(lead, { button: { payload: 'AL_QR_QUOTE_V1', text: 'Send my quote' } }, h.clock.now());
    expect(res.status).toBe(200);
    await h.drain();

    const [out] = await outboundFor(lead.id);
    expect(out).toMatchObject({ kind: 'DOCUMENT', quoteVersionId: version.id, sendIntent: 'CUSTOMER_REQUESTED_REPLY', status: 'SENT' });
    expect(h.wa.calls.length).toBe(calls0 + 1);
    const request = h.wa.calls.at(-1)!.request;
    expect(request.kind).toBe('freeform');
    expect(request.document?.mimeType).toBe('application/pdf');
    const serialized = JSON.stringify({ ...request, document: { ...request.document, bytes: undefined } });
    expect(serialized).not.toMatch(/localhost|https?:\/\/|\/quote\//);
    const approval = await h.db.approval.findFirstOrThrow({ where: { quoteVersionId: version.id, kind: 'QUOTE_VERSION', status: 'APPROVED' } });
    expect(approval.messageId).toBe(out!.id);
    expect(await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).toMatchObject({ status: 'SENT', sentVia: 'DISPATCH' });
  }, 60_000);

  it('without an approved quote: flags the DRAFT quote approval customer_requested, no holding message (auto-send off)', async () => {
    await setAutoSend(false);
    const lead = await createLead(h.db);
    const created = await createQuote(await h.owner(), {
      leadId: lead.id,
      items: [{ serviceId: SERVICE_CONSULT, qty: 1 }],
      discount: { kind: 'NONE', value: 0n },
      scopeText: 'Consultation.',
      timelineText: 'One visit',
    });
    const calls0 = h.wa.calls.length;
    await inbound(lead, { interactive: { id: 'AL_QR_QUOTE_V1', title: 'Get a quote' } }, h.clock.now());
    await h.drain();

    const approval = await h.db.approval.findFirstOrThrow({ where: { quoteVersionId: created.version.id, kind: 'QUOTE_VERSION' } });
    expect(approval.status).toBe('PENDING');
    expect(approval.flags).toEqual(expect.arrayContaining(['customer_requested']));
    expect(await outboundFor(lead.id)).toHaveLength(0);
    expect(h.wa.calls.length).toBe(calls0);
    const requested = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'quick_reply.quote_requested', workspaceId: WS_A, targetId: lead.id } });
    expect(requested.summary).toMatchObject({ action: 'QUOTE_DRAFT_FLAGGED', quoteId: created.quote.id });
  }, 60_000);

  it('without any quote: creates a DRAFT quote from the last proposal with a customer_requested approval', async () => {
    await setAutoSend(false);
    const lead = await createLead(h.db);
    await createDraft(h.db, lead.id, { items: [{ serviceId: SERVICE_CONSULT, qty: 2 }] });
    await inbound(lead, { button: { payload: 'AL_QR_QUOTE_V1', text: 'Send my quote' } }, h.clock.now());
    await h.drain();
    const quote = await h.db.quote.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(quote.status).toBe('DRAFT');
    const approval = await h.db.approval.findFirstOrThrow({ where: { quoteId: quote.id, kind: 'QUOTE_VERSION' } });
    expect(approval).toMatchObject({ status: 'PENDING' });
    expect(approval.flags).toEqual(expect.arrayContaining(['customer_requested']));
    expect(await outboundFor(lead.id)).toHaveLength(0);
  }, 60_000);

  it('with auto-send on: sends one fixed holding message inside the window', async () => {
    await setAutoSend(true);
    const lead = await createLead(h.db);
    await createDraft(h.db, lead.id, { items: [{ serviceId: SERVICE_CONSULT, qty: 1 }] });
    const calls0 = h.wa.calls.length;
    await inbound(lead, { button: { payload: 'AL_QR_QUOTE_V1', text: 'Send my quote' } }, h.clock.now());
    await h.drain();
    const out = await outboundFor(lead.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'TEXT', sendIntent: 'CUSTOMER_REQUESTED_REPLY', status: 'SENT' });
    expect(out[0]!.body).not.toMatch(/https?:\/\/|₹|\d{3,}/);
    expect(h.wa.calls.length).toBe(calls0 + 1);
    await setAutoSend(false);
  }, 60_000);
});

describe('AL_QR_CALL_V1', () => {
  it('creates exactly one CallRequest; a replayed delivery creates none', async () => {
    await setAutoSend(false);
    const lead = await createLead(h.db);
    const id = nextWamid('call');
    const payload = waEnvelope(waMessageValue({ from: waFrom(lead.phoneE164!), id, at: h.clock.now(), button: { payload: 'AL_QR_CALL_V1', text: 'Call me' } }));
    expect((await postWhatsApp(payload)).status).toBe(200);
    await h.drain();
    expect((await postWhatsApp(payload)).status).toBe(200);
    await h.drain();
    const requests = await h.db.callRequest.findMany({ where: { leadId: lead.id } });
    expect(requests).toHaveLength(1);
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: `wa:${id}` } });
    expect(requests[0]).toMatchObject({ source: 'QUICK_REPLY', status: 'OPEN', sourceEventId: event.id });
    expect(requests[0]!.conversationId).not.toBeNull();
    expect(await outboundFor(lead.id)).toHaveLength(0);
  }, 60_000);

  it('with an https booking link and auto-send off: a reply with the link waits for approval', async () => {
    await setAutoSend(false, 'https://cal.example.test/smile-avenue');
    const lead = await createLead(h.db);
    await inbound(lead, { interactive: { id: 'AL_QR_CALL_V1', title: 'Request a call' } }, h.clock.now());
    await h.drain();
    expect(await h.db.callRequest.count({ where: { leadId: lead.id } })).toBe(1);
    const [draft] = await outboundFor(lead.id);
    expect(draft).toMatchObject({ status: 'DRAFT', kind: 'TEXT' });
    expect(draft!.body).toContain('https://cal.example.test/smile-avenue');
    const approval = await h.db.approval.findFirstOrThrow({ where: { messageId: draft!.id } });
    expect(approval).toMatchObject({ status: 'PENDING', kind: 'OUTBOUND_MESSAGE' });
    expect(approval.flags).toEqual(expect.arrayContaining(['customer_requested']));
    await setAutoSend(false, null);
  }, 60_000);

  it('ignores a booking URL that is not https', async () => {
    await setAutoSend(true, 'http://cal.example.test/insecure');
    const lead = await createLead(h.db);
    await inbound(lead, { button: { payload: 'AL_QR_CALL_V1', text: 'Call me' } }, h.clock.now());
    await h.drain();
    expect(await h.db.callRequest.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await outboundFor(lead.id)).toHaveLength(0);
    await setAutoSend(false, null);
  }, 60_000);
});

describe('fallbacks and review', () => {
  it('uses the button text when the payload is missing', async () => {
    const lead = await createLead(h.db);
    await inbound(lead, { button: { text: 'Call me' } }, h.clock.now());
    await h.drain();
    expect(await h.db.callRequest.count({ where: { leadId: lead.id } })).toBe(1);
  }, 60_000);

  it('sends an unknown payload to human review: stored, audited, no automated action', async () => {
    const lead = await createLead(h.db);
    const { id } = await inbound(lead, { button: { payload: 'AL_QR_FOO_V9', text: 'Something new' } }, h.clock.now());
    await h.drain();
    const message = await h.db.message.findFirstOrThrow({ where: { channel: 'WHATSAPP', providerMessageId: id } });
    expect(message).toMatchObject({ direction: 'IN', kind: 'INTERACTIVE_REPLY', body: 'Something new' });
    expect(await h.db.auditEvent.count({ where: { action: 'quick_reply.review', targetId: message.id } })).toBe(1);
    expect(await h.db.callRequest.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await outboundFor(lead.id)).toHaveLength(0);
  }, 60_000);
});
