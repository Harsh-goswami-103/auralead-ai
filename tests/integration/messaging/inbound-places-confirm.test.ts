/**
 * ADR-118 (d), adversarial review: a WhatsApp message from a Places lead's number is a first-party
 * confirmation (`INBOUND_WHATSAPP`), so the 30-day sweep keeps the phone and its contact key and the
 * thread is not split. A STOP is not a confirmation; a lead that is not from Places is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as simulateRoute } from '@/app/api/webhooks/whatsapp/simulate/route';
import { makeRequest } from '../auth/support';
import { createLead } from '../dispatch/support';
import { sessionFor, type Auth } from '../webhooks/support';
import { createInboundHarness, type InboundHarness } from './inbound-support';

let h: InboundHarness;
let owner: Auth;
beforeAll(async () => {
  h = await createInboundHarness('inbound-places-confirm');
  owner = await sessionFor(h, 'owner');
}, 120_000);
afterAll(async () => h?.destroy());

async function simulate(body: Record<string, unknown>) {
  const res = await simulateRoute(makeRequest('/api/webhooks/whatsapp/simulate', { body, cookie: owner.cookie, csrf: owner.csrf }), { params: Promise.resolve({}) });
  return res.status;
}

describe('inbound WhatsApp confirms a Places contact', () => {
  it('records INBOUND_WHATSAPP on a Places lead that is not yet confirmed', async () => {
    const lead = await createLead(h.db);
    await h.db.lead.update({ where: { id: lead.id }, data: { placeId: 'ChIJplacesconfirm001', placesContentExpiresAt: new Date(h.clock.now().getTime() + 30 * 86_400_000) } });
    expect(await simulate({ leadId: lead.id, event: 'text', text: 'Hello, I saw your listing' })).toBe(200);
    await h.drain();
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactConfirmedVia: 'INBOUND_WHATSAPP', contactConfirmedAt: expect.any(Date) });
  });

  it('does not confirm on a STOP, nor touch a lead that did not come from Places', async () => {
    const stopped = await createLead(h.db);
    await h.db.lead.update({ where: { id: stopped.id }, data: { placeId: 'ChIJplacesconfirm002', placesContentExpiresAt: new Date(h.clock.now().getTime() + 86_400_000) } });
    expect(await simulate({ leadId: stopped.id, event: 'quick_reply_stop' })).toBe(200);
    await h.drain();
    expect((await h.db.lead.findUniqueOrThrow({ where: { id: stopped.id } })).contactConfirmedAt).toBeNull();

    const plain = await createLead(h.db);
    expect(await simulate({ leadId: plain.id, event: 'text', text: 'Hi' })).toBe(200);
    await h.drain();
    expect(await h.db.lead.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ contactConfirmedAt: null, contactConfirmedVia: null });
  });
});
