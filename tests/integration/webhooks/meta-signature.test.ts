/**
 * AT8 (Meta half), AT3, R9, plan §9 Webhooks: POST /api/webhooks/meta-ads verifies
 * X-Hub-Signature-256 over the raw bytes, routes by page_id through Integration.routingKey (never
 * payload trust), persists `meta:{page}:{leadgen}` and enqueues only `meta.lead.fetch`; GET answers
 * the verification challenge only for the configured token.
 *  - the documented delivery with Devanagari text verifies as sent; the same JSON re-serialized
 *    with \u escapes, or one flipped byte, is 401 with nothing persisted and a rejection counted;
 *  - a redelivered leadgen creates no second event, job or lead (after the worker fetched it);
 *  - an unknown Page is stored UNROUTED with no job; identical leadgen ids for two workspaces' Pages
 *    are two distinct events (E2);
 *  - the metaWebhook rate limit answers 429 without persisting anything.
 * Zero outbound: the lead fetch goes to the scripted Graph stand-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getRuntime } from '@/server/boot';
import { RATE_LIMIT_POLICIES } from '@/server/security/rate-limit';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import {
  createMetaHarness,
  getMeta,
  leadgenDelivery,
  leadWithId,
  metaFixture,
  PAGE_A,
  PAGE_B,
  postMeta,
  postMetaRaw,
  signBody,
  storeFormMapping,
  storeMeta,
  VERIFY_TOKEN,
  type MetaHarness,
} from '../campaigns/meta-support';

let h: MetaHarness;
let integrationA: string;
beforeAll(async () => {
  h = await createMetaHarness('t35-meta-signature');
  integrationA = (await storeMeta(h)).id;
  await storeFormMapping(h, integrationA);
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(() => {
  h.graph.reset();
  resetOutboundAttempts();
});

const rejection = (reason: string) => h.db.webhookRejection.findFirst({ where: { provider: 'META_ADS', workspaceId: null, reason } });
const jobsFor = async (eventId: string) => (await h.db.job.findMany({ where: { type: 'meta.lead.fetch' } })).filter((j) => (j.payload as { webhookEventId?: string }).webhookEventId === eventId);

describe('POST /api/webhooks/meta-ads: raw-body signature', () => {
  it('accepts the documented delivery (Devanagari text, signed over the exact bytes), routes it and enqueues only meta.lead.fetch', async () => {
    const raw = JSON.stringify(metaFixture('webhook.leadgen.json'));
    expect(raw).toContain('नमस्ते');
    const res = await postMetaRaw(raw, { 'x-hub-signature-256': signBody(raw) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, accepted: 1, ignored: 1 });
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { provider: 'META_ADS', externalKey: `meta:${PAGE_A}:610000000000001` } });
    expect(event).toMatchObject({ workspaceId: h.wsA, integrationId: integrationA, scopeKey: integrationA, status: 'RECEIVED', simulated: false });
    expect(event.processingPayload).not.toBeNull();
    const jobs = await jobsFor(event.id);
    expect(jobs.map((j) => j.type)).toEqual(['meta.lead.fetch']);
    expect(await h.db.job.count({ where: { type: { not: 'meta.lead.fetch' }, workspaceId: h.wsA } })).toBe(0);
    // The route never calls Meta: the lead is fetched by the worker.
    expect(h.graph.requests).toHaveLength(0);
    expect(outboundAttempts()).toHaveLength(0);
  });

  it('rejects the same JSON re-serialized with \\u escapes for Devanagari (401), stores nothing, counts it', async () => {
    const original = JSON.stringify({ ...leadgenDelivery(['610000000000050']), note: 'राहुल शर्मा' });
    expect(original).toContain('राहुल');
    const escaped = original.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(JSON.parse(escaped)).toEqual(JSON.parse(original));
    const res = await postMetaRaw(escaped, { 'x-hub-signature-256': signBody(original) });
    expect(res.status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { externalKey: `meta:${PAGE_A}:610000000000050` } })).toBe(0);
    expect((await rejection('SIGNATURE_INVALID'))?.count).toBeGreaterThanOrEqual(1);
  });

  it('rejects a body with one flipped byte (401) and stores nothing', async () => {
    const raw = JSON.stringify(leadgenDelivery(['610000000000051']));
    const signature = signBody(raw);
    const flipped = raw.replace('610000000000051', '610000000000052');
    const res = await postMetaRaw(flipped, { 'x-hub-signature-256': signature });
    expect(res.status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { provider: 'META_ADS', externalKey: { in: [`meta:${PAGE_A}:610000000000051`, `meta:${PAGE_A}:610000000000052`] } } })).toBe(0);
  });

  it('rejects a missing header (401) and a body signed with another secret (401)', async () => {
    const raw = JSON.stringify(leadgenDelivery(['610000000000053']));
    expect((await postMetaRaw(raw, {})).status).toBe(401);
    expect((await rejection('SIGNATURE_MISSING'))?.count).toBeGreaterThanOrEqual(1);
    expect((await postMetaRaw(raw, { 'x-hub-signature-256': signBody(raw, 'another-secret') })).status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { externalKey: `meta:${PAGE_A}:610000000000053` } })).toBe(0);
  });

  it('a signed body that is not a Page notification is 400 INVALID_PAYLOAD, counted, not stored', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await postMetaRaw(raw, { 'x-hub-signature-256': signBody(raw) });
    expect(res.status).toBe(400);
    expect((await rejection('INVALID_PAYLOAD'))?.count).toBeGreaterThanOrEqual(1);
  });
});

describe('idempotency and routing', () => {
  it('a duplicate leadgen delivery creates no second event, job or lead', async () => {
    const id = '610000000000060';
    expect((await postMeta(leadgenDelivery([id]))).status).toBe(200);
    h.graph.on('GET', new RegExp(`^/v24\\.0/${id}$`), leadWithId(id));
    await h.drain();
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: `meta:${PAGE_A}:${id}` } });
    expect(event.status).toBe('PROCESSED');
    expect(await h.db.leadSourceRecord.count({ where: { workspaceId: h.wsA, source: 'META_ADS', externalId: id } })).toBe(1);
    const leadsBefore = await h.db.lead.count({ where: { workspaceId: h.wsA } });

    const again = await postMeta(leadgenDelivery([id]));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ accepted: 0, duplicate: 1 });
    await h.drain();
    expect(await h.db.webhookEvent.count({ where: { externalKey: `meta:${PAGE_A}:${id}` } })).toBe(1);
    expect(await jobsFor(event.id)).toHaveLength(1);
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA } })).toBe(leadsBefore);
    // Meta was asked for the lead once.
    expect(h.graph.requests.filter((r) => r.path === `/v24.0/${id}`)).toHaveLength(1);
  });

  it('an unmapped Page is stored UNROUTED with no processing job', async () => {
    const res = await postMeta(leadgenDelivery(['610000000000070'], { pageId: '199999999999999' }));
    expect(res.status).toBe(200);
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: 'meta:199999999999999:610000000000070' } });
    expect(event).toMatchObject({ workspaceId: null, integrationId: null, scopeKey: 'unrouted', status: 'UNROUTED' });
    expect(await jobsFor(event.id)).toHaveLength(0);
  });

  it('routing never trusts the payload: a change whose page_id differs from its entry is not stored', async () => {
    const delivery = leadgenDelivery(['610000000000071']);
    delivery.entry[0]!.id = PAGE_B;
    const res = await postMeta(delivery);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 0, ignored: 1 });
    expect(await h.db.webhookEvent.count({ where: { externalKey: { contains: '610000000000071' } } })).toBe(0);
  });

  it('identical leadgen ids for two workspaces are two events, each scoped by its own integration (E2)', async () => {
    const integrationB = (await storeMeta(h, { workspaceId: h.wsB, pageId: PAGE_B })).id;
    await storeFormMapping(h, integrationB, h.wsB);
    await postMeta(leadgenDelivery(['610000000000080']));
    await postMeta(leadgenDelivery(['610000000000080'], { pageId: PAGE_B }));
    const events = await h.db.webhookEvent.findMany({ where: { externalKey: { endsWith: ':610000000000080' } }, orderBy: { workspaceId: 'asc' } });
    expect(events.map((e) => e.scopeKey).sort()).toEqual([integrationA, integrationB].sort());
    expect(new Set(events.map((e) => e.workspaceId))).toEqual(new Set([h.wsA, h.wsB]));
  });

  it('a delivery over the per-integration metaWebhook limit is 429 and persists nothing', async () => {
    const limit = RATE_LIMIT_POLICIES.metaWebhook.limit;
    const limiter = getRuntime().limiters.metaWebhook;
    for (let i = 0; i < limit; i += 1) limiter.take(`meta-webhook:integration:${integrationA}`);
    const res = await postMeta(leadgenDelivery(['610000000000090']));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
    expect(await h.db.webhookEvent.count({ where: { externalKey: { endsWith: ':610000000000090' } } })).toBe(0);
    expect(await h.db.webhookRejection.findFirst({ where: { provider: 'META_ADS', workspaceId: h.wsA, reason: 'RATE_LIMITED' } })).not.toBeNull();
  });
});

describe('GET /api/webhooks/meta-ads verification', () => {
  it('echoes a well-formed challenge for the configured verify token', async () => {
    const res = await getMeta(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
  });

  it('refuses a wrong token, a wrong mode and a challenge outside [0-9A-Za-z_-]{1,128}', async () => {
    expect((await getMeta('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status).toBe(403);
    expect((await getMeta(`hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=123`)).status).toBe(403);
    const bad = await getMeta(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${encodeURIComponent('<script>')}`);
    expect(bad.status).toBe(403);
    expect(await bad.text()).not.toContain('<script>');
    expect((await getMeta(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${'a'.repeat(129)}`)).status).toBe(403);
  });
});

