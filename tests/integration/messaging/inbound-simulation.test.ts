/**
 * T20 goal "demo inbound simulation": POST /api/webhooks/whatsapp/simulate plays the customer in
 * DEMO through the same receive path as the verified webhook (simulated events, Stop synchronous,
 * the rest processed by the worker). A lead of another workspace is 404 (E10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as simulateRoute } from '@/app/api/webhooks/whatsapp/simulate/route';
import { makeRequest } from '../auth/support';
import { createLead } from '../dispatch/support';
import { sessionFor, type Auth } from '../webhooks/support';
import { activeSuppression, createInboundHarness, phoneKey, WS_A, type InboundHarness } from './inbound-support';
import { seedId } from '../../../prisma/seed/ids';

let h: InboundHarness;
let owner: Auth;
beforeAll(async () => {
  h = await createInboundHarness('inbound-simulation');
  owner = await sessionFor(h, 'owner');
}, 120_000);
afterAll(async () => h?.destroy());

async function simulate(body: Record<string, unknown>, auth: Auth | null = owner) {
  const res = await simulateRoute(makeRequest('/api/webhooks/whatsapp/simulate', { body, cookie: auth?.cookie ?? null, csrf: auth?.csrf ?? null }), { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/webhooks/whatsapp/simulate (DEMO)', () => {
  it('a simulated CALL quick reply becomes a simulated event and one CallRequest', async () => {
    const lead = await createLead(h.db);
    const call = await simulate({ leadId: lead.id, event: 'quick_reply_call' });
    expect(call.status).toBe(200);
    const [event] = call.body.events as Array<{ eventId: string; outcome: string }>;
    expect(event!.outcome).toBe('ACCEPTED');
    expect(await h.db.webhookEvent.findUniqueOrThrow({ where: { id: event!.eventId } })).toMatchObject({ simulated: true, workspaceId: WS_A, provider: 'WHATSAPP' });
    await h.drain();
    expect(await h.db.callRequest.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('a simulated STOP is applied before the response returns', async () => {
    const lead = await createLead(h.db);
    const call = await simulate({ leadId: lead.id, event: 'quick_reply_stop' });
    expect(call.status).toBe(200);
    expect((call.body.events as Array<{ suppressed: string }>)[0]!.suppressed).toBe('CREATED');
    expect(await activeSuppression(h, 'WHATSAPP', phoneKey(lead.phoneE164!))).toMatchObject({ reason: 'STOP_BUTTON' });
  });

  it('refuses a lead of another workspace (404) and an anonymous caller (401)', async () => {
    const foreign = seedId('lead', 'ironpulse-fitness:Q-0001');
    expect((await simulate({ leadId: foreign, event: 'text', text: 'hi' })).status).toBe(404);
    expect((await simulate({ leadId: foreign, event: 'text' }, null)).status).toBe(401);
  });
});
