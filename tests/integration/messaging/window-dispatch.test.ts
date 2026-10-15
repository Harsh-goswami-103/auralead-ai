/**
 * R24, AT9 (dispatch-time half), C19: the 24 h window is opened only by an inbound message (at its
 * provider time, through the webhook) and checked when the job runs, not when it was queued.
 *  - a free-form reply queued at T0+23:59:59 whose job runs at T0+24:00:01 is skipped
 *    WINDOW_CLOSED (back to review), never sent free-form; a template still goes out;
 *  - a status webhook for an outbound message and a late, older inbound do not move the window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { approvedTemplate, createLead, DEPS, grantConsent } from '../dispatch/support';
import { createInboundHarness, inbound, postWhatsApp, waEnvelope, waFrom, waStatusValue, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('window-dispatch');
}, 120_000);
afterAll(async () => h?.destroy());

const HOUR = 3_600_000;

async function freeform(leadId: string, body: string) {
  const owner = await h.owner();
  const draft = await createMessageDraft(owner, { leadId, channel: 'WHATSAPP', kind: 'TEXT', body }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('window checked at dispatch time', () => {
  it('a free-form reply queued inside the window but run after it closes is never sent free-form', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const t0 = new Date(Math.floor(h.clock.now().getTime() / 1000) * 1000);
    await inbound(lead, { text: 'Hi, is the clinic open on Sunday?' }, t0);
    await h.drain();
    const conversation = await h.db.conversation.findFirstOrThrow({ where: { leadId: lead.id, channel: 'WHATSAPP' } });
    expect(conversation.lastInboundProviderAt?.toISOString()).toBe(t0.toISOString());

    // Control: inside the window a free-form reply is sent.
    h.clock.set(new Date(t0.getTime() + HOUR));
    const early = await freeform(lead.id, 'Yes, 10:00 to 14:00.');
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: early.attemptId } })).toMatchObject({ state: 'SENT' });

    // A status webhook for that outbound message does not reset the window.
    const sentMessage = await h.db.message.findUniqueOrThrow({ where: { id: early.messageId } });
    await postWhatsApp(waEnvelope(waStatusValue({ id: sentMessage.providerMessageId!, status: 'read', at: new Date(t0.getTime() + 2 * HOUR), recipient: waFrom(lead.phoneE164!) })));
    // A late, older inbound delivered now does not shrink it either.
    await inbound(lead, { text: 'Also, do you take cards?' }, new Date(t0.getTime() - HOUR));
    await h.drain();
    expect((await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).lastInboundProviderAt?.toISOString()).toBe(t0.toISOString());

    h.clock.set(new Date(t0.getTime() + 24 * HOUR - 1_000));
    const late = await freeform(lead.id, 'Following up on your question.');
    const template = await approvedTemplate(h.db);
    const owner = await h.owner();
    const tplDraft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
    const tpl = await approveAndSendMessage(owner, { messageId: tplDraft.messageId }, DEPS);

    // The worker only gets to them at T0+24:00:01.
    h.clock.set(new Date(t0.getTime() + 24 * HOUR + 1_000));
    const calls0 = h.wa.calls.length;
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: late.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'WINDOW_CLOSED' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: late.messageId } })).toMatchObject({ status: 'NOT_SENT' });
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: tpl.attemptId } })).toMatchObject({ state: 'SENT' });
    const newCalls = h.wa.calls.slice(calls0).map((c) => c.request);
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]).toMatchObject({ kind: 'template', attemptId: tpl.attemptId });
    expect(newCalls.some((r) => r.kind === 'freeform')).toBe(false);
  }, 60_000);
});
