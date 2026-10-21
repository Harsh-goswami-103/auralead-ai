/**
 * R9, plan §11 T35, 02-errors §2.3: `meta.lead.fetch` and the backfill against documented-shape
 * Graph fixtures (tests/fixtures/meta/documented-shape, SOURCES.json; not recorded live traffic).
 *  - the lead is read with the saved token (Authorization header only) on META_GRAPH_VERSION,
 *    mapped with the form's mapping and consent question (P1) and ingested once;
 *  - Graph code 190 puts the integration to "Verification required" (CONFIGURED_UNVERIFIED) and the
 *    job is DEAD after one attempt, not retried;
 *  - a permission refusal names the permission (leads_retrieval), whether or not Meta named it;
 *  - throttling backs off (min(30 s * 2^(n-1), 1 h), Retry-After when longer) and then succeeds;
 *  - a lead Meta does not return is FAILED LEAD_UNRETRIEVABLE without a stub record;
 *  - an unmapped form and a server without META_GRAPH_VERSION never reach Meta;
 *  - "Backfill from form since T" pages through the form's leads with the time filter, dedupes
 *    against leads that came by webhook, and keeps a visible result;
 *  - the Meta connection tester (Page on the Graph version, ad account on the Marketing version).
 * Zero outbound connections: the scripted Graph stand-in answers or the test fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { requestMetaBackfill } from '@/server/services/campaigns/backfill';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import {
  ACCESS_TOKEN,
  AD_ACCOUNT,
  createMetaHarness,
  FORM_A,
  leadgenDelivery,
  leadWithId,
  metaAnswer,
  PAGE_A,
  postMeta,
  storeFormMapping,
  storeMeta,
  type MetaHarness,
} from '../campaigns/meta-support';

let h: MetaHarness;
let integrationId: string;
beforeAll(async () => {
  h = await createMetaHarness('t35-meta-leads');
  integrationId = (await storeMeta(h)).id;
  await storeFormMapping(h, integrationId);
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(async () => {
  h.graph.reset();
  resetOutboundAttempts();
  h.flags.graphVersion = 'v24.0';
  await storeMeta(h);
  // Earlier tests' waiting retries never run into a later test.
  await h.db.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
});

const leadPath = (id: string) => new RegExp(`^/v24\\.0/${id}$`);
const eventOf = (id: string) => h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: `meta:${PAGE_A}:${id}` } });
const jobOf = async (eventId: string) => (await h.db.job.findMany({ where: { type: 'meta.lead.fetch' } })).find((j) => (j.payload as { webhookEventId?: string }).webhookEventId === eventId)!;
const integration = () => h.db.integration.findFirstOrThrow({ where: { id: integrationId } });

async function deliver(id: string) {
  expect((await postMeta(leadgenDelivery([id]))).status).toBe(200);
  return eventOf(id);
}

describe('meta.lead.fetch', () => {
  it('reads the lead with the saved token, maps fields and consent, ingests it once', async () => {
    const id = '620000000000001';
    const event = await deliver(id);
    h.graph.on('GET', leadPath(id), leadWithId(id));
    await h.drain();
    const req = h.graph.requests[0]!;
    expect(req.query.fields).toBe('id,created_time,ad_id,form_id,campaign_id,field_data,custom_disclaimer_responses');
    expect(req.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(req.url).not.toContain(ACCESS_TOKEN);
    expect((await eventOf(id)).status).toBe('PROCESSED');
    const record = await h.db.leadSourceRecord.findFirstOrThrow({ where: { workspaceId: h.wsA, source: 'META_ADS', externalId: id } });
    expect(record.status).toBe('ACCEPTED');
    expect(record.attribution).toMatchObject({ page: PAGE_A, form: FORM_A, campaign: '410000000000001' });
    const lead = await h.db.lead.findFirstOrThrow({ where: { id: record.leadId! } });
    expect(lead).toMatchObject({ displayName: 'राहुल शर्मा', phoneE164: '+919812345678', emailNormalized: 'rahul.sharma@auralead-fixture.in', firstSource: 'META_ADS' });
    const consent = await h.db.consentRecord.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(consent).toMatchObject({ channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', source: 'META_FORM' });
    expect(consent.collectedAt.toISOString()).toBe('2026-10-20T05:59:50.000Z');
    expect((await jobOf(event.id)).status).toBe('SUCCEEDED');
    expect(outboundAttempts()).toHaveLength(0);
  });

  it('190: the integration becomes "Verification required" and the job is not retried', async () => {
    const id = '620000000000002';
    const event = await deliver(id);
    h.graph.on('GET', leadPath(id), metaAnswer('error.190.json'), leadWithId(id));
    await h.drain();
    const job = await jobOf(event.id);
    expect(job).toMatchObject({ status: 'DEAD', deadReason: 'PROVIDER_AUTH', attempts: 1 });
    expect(h.graph.requests).toHaveLength(1);
    expect(await integration()).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', lastErrorCode: 'PROVIDER_AUTH', verifiedAt: null });
    expect((await integration()).lastErrorRedacted ?? '').not.toContain(ACCESS_TOKEN);
    expect(await eventOf(id)).toMatchObject({ status: 'FAILED', result: { kind: 'failed', code: 'PROVIDER_AUTH' } });
    expect(await h.db.auditEvent.count({ where: { action: 'integration.verification_required', targetId: integrationId } })).toBeGreaterThanOrEqual(1);
    // The event keeps its payload, so the same job can run again once a new token is saved.
    expect((await eventOf(id)).processingPayload).not.toBeNull();
    await storeMeta(h);
    await h.db.job.update({ where: { id: job.id }, data: { status: 'QUEUED', attempts: 0, runAt: h.clock.now() } });
    await h.drain();
    expect((await eventOf(id)).status).toBe('PROCESSED');
  });

  it('a permission refusal names the permission, whether Meta named it or not', async () => {
    for (const [i, fixture] of ['error.200-leads-retrieval.json', 'error.10-no-name.json'].entries()) {
      await storeMeta(h);
      const id = `62000000000001${i}`;
      const event = await deliver(id);
      h.graph.on('GET', leadPath(id), metaAnswer(fixture));
      await h.drain();
      expect(await jobOf(event.id)).toMatchObject({ status: 'DEAD', deadReason: 'PERMISSION_MISSING', attempts: 1 });
      const row = await integration();
      expect(row).toMatchObject({ status: 'ERROR', lastErrorCode: 'PERMISSION_MISSING' });
      expect(row.lastErrorRedacted).toContain('Missing permission: leads_retrieval');
      expect((await eventOf(id)).result).toMatchObject({ code: 'PERMISSION_MISSING' });
    }
  });

  it('throttling backs off (30 s, then Retry-After when longer) and the lead arrives on a later attempt', async () => {
    const id = '620000000000020';
    const event = await deliver(id);
    h.graph.on('GET', leadPath(id), metaAnswer('error.4-rate-limit.json'), metaAnswer('error.80004.json', { 'retry-after': '120' }), leadWithId(id));
    await h.drain();
    let job = await jobOf(event.id);
    expect(job).toMatchObject({ status: 'QUEUED', attempts: 1, lastErrorCode: 'PROVIDER_RATE_LIMITED' });
    expect(job.runAt.getTime() - h.clock.now().getTime()).toBe(30_000);
    h.clock.set(new Date(job.runAt.getTime()));
    await h.drain();
    job = await jobOf(event.id);
    expect(job).toMatchObject({ status: 'QUEUED', attempts: 2 });
    expect(job.runAt.getTime() - h.clock.now().getTime()).toBe(120_000);
    h.clock.set(new Date(job.runAt.getTime()));
    await h.drain();
    expect(await jobOf(event.id)).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    expect((await eventOf(id)).status).toBe('PROCESSED');
    expect(await integration()).toMatchObject({ status: 'CONNECTED' });
  });

  it('a lead Meta does not return is FAILED LEAD_UNRETRIEVABLE, handled, with no stub record', async () => {
    const id = '620000000000030';
    const event = await deliver(id);
    h.graph.on('GET', leadPath(id), metaAnswer('error.100-not-found.json'));
    await h.drain();
    expect(await jobOf(event.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await eventOf(id)).result).toMatchObject({ code: 'LEAD_UNRETRIEVABLE' });
    expect(await h.db.leadSourceRecord.count({ where: { externalId: id } })).toBe(0);
  });

  it('an unmapped form and a server without META_GRAPH_VERSION never reach Meta', async () => {
    expect((await postMeta(leadgenDelivery(['620000000000040'], { formId: '299999999999999' }))).status).toBe(200);
    await h.drain();
    expect((await eventOf('620000000000040')).result).toMatchObject({ code: 'MAPPING_NOT_FOUND' });

    h.flags.graphVersion = null;
    const event = await deliver('620000000000041');
    await h.drain();
    expect(await jobOf(event.id)).toMatchObject({ status: 'DEAD', deadReason: 'INTEGRATION_NOT_CONFIGURED' });
    expect((await eventOf('620000000000041')).result).toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(h.graph.requests).toHaveLength(0);
  });
});

describe('Backfill from form since T', () => {
  it('pages through the form with the time filter, dedupes against webhook leads and keeps the result', async () => {
    const owner = await h.ownerCtx();
    const since = new Date(h.clock.now().getTime() - 3 * 24 * 60 * 60 * 1000);
    const run = await requestMetaBackfill(owner, { formId: FORM_A, since: since.toISOString(), requestKey: 'backfill-request-0001' });
    expect(run).toMatchObject({ status: 'QUEUED', created: true });
    const again = await requestMetaBackfill(owner, { formId: FORM_A, since: since.toISOString(), requestKey: 'backfill-request-0001' });
    expect(again).toMatchObject({ id: run.id, created: false });

    const formPath = new RegExp(`^/v24\\.0/${FORM_A}/leads$`);
    h.graph.on('GET', formPath, metaAnswer('response.form-leads-page-1.json'), metaAnswer('response.form-leads-page-2.json'));
    await h.drain();
    const [first, second] = h.graph.requests;
    expect(JSON.parse(first!.query.filtering!)).toEqual([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(since.getTime() / 1000) }]);
    expect(first!.query.after).toBeUndefined();
    expect(second!.query.after).toBe('QVFIUmJi');
    const stored = await h.db.metaLeadBackfill.findFirstOrThrow({ where: { id: run.id } });
    expect(stored).toMatchObject({ status: 'COMPLETED', pages: 2, fetched: 3, truncated: false, errorCode: null });
    // The first lead has the phone of the lead the webhook path ingested above: a duplicate of it, not a second lead.
    expect(stored.counts).toMatchObject({ received: 3, accepted: 2, duplicate: 1 });
    expect(await h.db.auditEvent.count({ where: { action: 'meta.backfill.run', targetId: run.id, result: 'SUCCESS' } })).toBe(1);

    // A second run over the same window adds nothing: every leadgen id is already known.
    const rerun = await requestMetaBackfill(owner, { formId: FORM_A, since: since.toISOString(), requestKey: 'backfill-request-0002' });
    h.graph.on('GET', formPath, metaAnswer('response.form-leads-page-1.json'), metaAnswer('response.form-leads-page-2.json'));
    const leadsBefore = await h.db.lead.count({ where: { workspaceId: h.wsA } });
    await h.drain();
    expect(await h.db.metaLeadBackfill.findFirstOrThrow({ where: { id: rerun.id } })).toMatchObject({ status: 'COMPLETED', counts: { received: 3, accepted: 0, duplicate: 3 } });
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA } })).toBe(leadsBefore);
  });

  it('a 190 during a backfill fails the run visibly and sets "Verification required"', async () => {
    const run = await requestMetaBackfill(await h.ownerCtx(), { formId: FORM_A, since: new Date(h.clock.now().getTime() - 86_400_000).toISOString(), requestKey: 'backfill-request-0190' });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${FORM_A}/leads$`), metaAnswer('error.190.json'));
    await h.drain();
    expect(await h.db.metaLeadBackfill.findFirstOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_AUTH' });
    expect(await integration()).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', lastErrorCode: 'PROVIDER_AUTH' });
  });

  it('refuses an unmapped form, a start older than 90 days, and a member without integrations.manage', async () => {
    const owner = await h.ownerCtx();
    await expect(requestMetaBackfill(owner, { formId: '299999999999999', since: new Date(h.clock.now().getTime() - 86_400_000).toISOString(), requestKey: 'backfill-request-0003' })).rejects.toMatchObject({ code: 'MAPPING_NOT_FOUND', status: 422 });
    await expect(requestMetaBackfill(owner, { formId: FORM_A, since: new Date(h.clock.now().getTime() - 91 * 86_400_000).toISOString(), requestKey: 'backfill-request-0004' })).rejects.toMatchObject({ code: 'BACKFILL_SINCE_INVALID' });
    await expect(requestMetaBackfill(await h.memberCtx(), { formId: FORM_A, since: new Date(h.clock.now().getTime() - 86_400_000).toISOString(), requestKey: 'backfill-request-0005' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('Meta connection tester', () => {
  const run = async () => testIntegrationConnection(await h.ownerCtx(), { kind: 'META_ADS' }, { testers: liveAdapters(h.deps()).testers });

  it('CONNECTED only when the Page (Graph version) and the ad account (Marketing version) answer as configured', async () => {
    await storeMeta(h, { status: 'CONFIGURED_UNVERIFIED' });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PAGE_A}$`), { status: 200, body: { id: PAGE_A, name: 'Smile Avenue Dental' } });
    h.graph.on('GET', new RegExp(`^/v25\\.0/act_${AD_ACCOUNT}$`), metaAnswer('response.ad-account-usd.json'));
    expect(await run()).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED' });
    expect(h.graph.requests.map((r) => r.path)).toEqual([`/v24.0/${PAGE_A}`, `/v25.0/act_${AD_ACCOUNT}`]);
    expect(await integration()).toMatchObject({ status: 'CONNECTED', verifiedAt: h.clock.now() });
  });

  it('a different Page id, a rejected token, or a server without META_MARKETING_VERSION is never CONNECTED', async () => {
    await storeMeta(h, { status: 'CONFIGURED_UNVERIFIED' });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PAGE_A}$`), { status: 200, body: { id: '199999999999999' } });
    expect(await run()).toMatchObject({ status: 'ERROR', errorCode: 'CONFIG_INVALID' });

    h.graph.reset();
    await storeMeta(h, { status: 'CONFIGURED_UNVERIFIED' });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PAGE_A}$`), metaAnswer('error.190.json'));
    expect(await run()).toMatchObject({ status: 'ERROR', errorCode: 'PROVIDER_AUTH' });

    h.graph.reset();
    await storeMeta(h, { status: 'CONFIGURED_UNVERIFIED' });
    h.flags.marketingVersion = null;
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PAGE_A}$`), { status: 200, body: { id: PAGE_A } });
    const result = await run();
    h.flags.marketingVersion = 'v25.0';
    expect(result).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED' });
    expect(result.message).toContain('META_MARKETING_VERSION');
  });
});
