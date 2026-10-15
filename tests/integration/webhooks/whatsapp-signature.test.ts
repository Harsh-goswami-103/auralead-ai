/**
 * AT8 (WhatsApp half), plan §9 Webhooks: POST /api/webhooks/whatsapp verifies X-Hub-Signature-256
 * over the raw bytes, routes by phone_number_id through Integration.routingKey (never payload
 * trust), and answers the GET verification challenge only for the configured token.
 *  - valid signature: 200, one WebhookEvent routed to workspace A, `webhook.process` queued;
 *  - one flipped byte, JSON re-serialized with \u escapes for Devanagari, missing header: 401,
 *    nothing persisted, a WebhookRejection counter per reason;
 *  - unknown phone_number_id: stored UNROUTED with no processing job;
 *  - replayed delivery: one event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLead } from '../dispatch/support';
import {
  createInboundHarness,
  getWhatsApp,
  nextWamid,
  postWhatsApp,
  postWhatsAppRaw,
  signBody,
  VERIFY_TOKEN,
  waEnvelope,
  waFrom,
  waMessageValue,
  WS_A,
  type InboundHarness,
} from '../messaging/inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('wa-signature');
}, 120_000);
afterAll(async () => h?.destroy());

const jobsFor = async (eventId: string) =>
  (await h.db.job.findMany({ where: { type: 'webhook.process' } })).filter((j) => (j.payload as { webhookEventId?: string }).webhookEventId === eventId).length;
const rejections = (reason: string) => h.db.webhookRejection.findFirst({ where: { provider: 'WHATSAPP', workspaceId: null, reason } });

describe('POST /api/webhooks/whatsapp signature and routing', () => {
  it('accepts a correctly signed delivery and routes it by phone_number_id', async () => {
    const lead = await createLead(h.db);
    const id = nextWamid();
    const res = await postWhatsApp(waEnvelope(waMessageValue({ from: waFrom(lead.phoneE164!), id, at: h.clock.now(), text: 'Hello there' })));
    expect(res.status).toBe(200);
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { provider: 'WHATSAPP', externalKey: `wa:${id}` } });
    expect(event).toMatchObject({ workspaceId: WS_A, integrationId: h.integrationId, scopeKey: h.integrationId, status: 'RECEIVED', simulated: false });
    expect(event.processingPayload).not.toBeNull();
    // The inspector view never carries the sender's number or the text.
    expect(JSON.stringify(event.payloadRedacted)).not.toContain(waFrom(lead.phoneE164!));
    const job = await h.db.job.findFirstOrThrow({ where: { type: 'webhook.process', workspaceId: WS_A } });
    expect(job.payload).toEqual({ webhookEventId: event.id });

    // Meta redelivers the same POST: still one event, one job.
    const again = await postWhatsApp(waEnvelope(waMessageValue({ from: waFrom(lead.phoneE164!), id, at: h.clock.now(), text: 'Hello there' })));
    expect(again.status).toBe(200);
    expect(await h.db.webhookEvent.count({ where: { externalKey: `wa:${id}` } })).toBe(1);
    expect(await jobsFor(event.id)).toBe(1);
  });

  it('rejects a body with one flipped byte (401) and stores nothing', async () => {
    const id = nextWamid();
    const raw = JSON.stringify(waEnvelope(waMessageValue({ from: '919800000001', id, at: h.clock.now(), text: 'Hello' })));
    const signature = signBody(raw);
    const flipped = raw.replace('Hello', 'Hellp');
    const res = await postWhatsAppRaw(flipped, { 'x-hub-signature-256': signature });
    expect(res.status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { externalKey: `wa:${id}` } })).toBe(0);
    expect((await rejections('SIGNATURE_INVALID'))?.count).toBeGreaterThanOrEqual(1);
  });

  it('rejects JSON re-serialized with \\u escapes for Devanagari (signature is over raw bytes)', async () => {
    const id = nextWamid();
    const original = JSON.stringify(waEnvelope(waMessageValue({ from: '919800000002', id, at: h.clock.now(), text: 'बंद' })));
    expect(original).toContain('बंद');
    const escaped = original.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(JSON.parse(escaped)).toEqual(JSON.parse(original));
    const res = await postWhatsAppRaw(escaped, { 'x-hub-signature-256': signBody(original) });
    expect(res.status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { externalKey: `wa:${id}` } })).toBe(0);
    expect(await h.db.suppression.count()).toBe(0);
  });

  it('rejects a delivery without the signature header (401)', async () => {
    const id = nextWamid();
    const res = await postWhatsAppRaw(JSON.stringify(waEnvelope(waMessageValue({ from: '919800000003', id, at: h.clock.now(), text: 'Hi' }))), {});
    expect(res.status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { externalKey: `wa:${id}` } })).toBe(0);
    expect((await rejections('SIGNATURE_MISSING'))?.count).toBeGreaterThanOrEqual(1);
  });

  it('stores an event for an unknown phone_number_id as UNROUTED, with no processing job', async () => {
    const id = nextWamid();
    const res = await postWhatsApp(waEnvelope(waMessageValue({ from: '919800000004', id, at: h.clock.now(), text: 'Hi' }, '999999999999999')));
    expect(res.status).toBe(200);
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: `wa:${id}` } });
    expect(event).toMatchObject({ workspaceId: null, integrationId: null, scopeKey: 'unrouted', status: 'UNROUTED' });
    expect(await jobsFor(event.id)).toBe(0);
  });
});

describe('GET /api/webhooks/whatsapp verification', () => {
  it('echoes a well-formed challenge for the configured verify token', async () => {
    const res = await getWhatsApp(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
  });

  it('refuses a wrong token, a wrong mode and a challenge outside [0-9A-Za-z_-]{1,128}', async () => {
    expect((await getWhatsApp('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status).toBe(403);
    expect((await getWhatsApp(`hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`)).status).toBe(403);
    const bad = await getWhatsApp(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${encodeURIComponent('<script>')}`);
    expect(bad.status).toBe(403);
    expect(await bad.text()).not.toContain('<script>');
  });
});
