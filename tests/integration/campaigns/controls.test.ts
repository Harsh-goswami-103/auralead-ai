/**
 * AT14, R44, P6, plan §4.4: Meta campaign metrics and pause/resume.
 *  - DEMO: a pause persists at once, labelled Simulated (CampaignAction SIMULATED, simulated audit),
 *    with zero outbound attempts; simulated campaigns come from the demo stand-in for the
 *    Marketing API.
 *  - LIVE without a verified integration: 412 INTEGRATION_NOT_VERIFIED over HTTP, nothing queued,
 *    the adapter never called, the refusal audited.
 *  - LIVE verified: the action is SENDING when Meta is called (outbox rule), the status is read
 *    back and stored; an adapter error leaves the campaign's status unchanged and is shown as
 *    FAILED with the permission named, never as success; a timeout after the write is UNKNOWN and
 *    a read-back resolves it from Meta's own status (applied -> SUCCEEDED, not applied -> FAILED);
 *    throttling retries.
 *  - Spend and cost per lead stay in the ad account's currency (USD here), as integer minor units of
 *    that currency, never converted to INR; the snapshot carries its date window, attribution
 *    setting and As of time; META_MARKETING_VERSION (v25.0) is used, not the Graph version.
 * Zero outbound connections: the scripted Graph stand-in answers or the test fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { requestCampaignStatusChange } from '@/server/services/campaigns/controls';
import { syncCampaignMetrics } from '@/server/services/campaigns/metrics';
import { POST as statusRoute } from '@/app/api/app/campaigns/[campaignId]/status/route';
import { makeRequest } from '../auth/support';
import { networkError } from '../contract/whatsapp-support';
import { createIntegrationsHarness, employeeCtx, nehaCtx, WS_A, type IntegrationsHarness } from '../integrations/support';
import { AD_ACCOUNT, CAMPAIGN, createMetaHarness, metaAnswer, storeMeta, type MetaHarness } from './meta-support';

describe('DEMO (AT14): pause persists labelled Simulated, zero outbound', () => {
  let d: IntegrationsHarness;
  beforeAll(async () => {
    d = await createIntegrationsHarness('t35-controls-demo');
  }, 120_000);
  afterAll(async () => d?.testDb.destroy());

  it('sync creates simulated campaigns in INR; pause and resume are SIMULATED, audited, with no outbound attempt', async () => {
    resetOutboundAttempts();
    const ctx = await employeeCtx(d);
    const synced = await syncCampaignMetrics(ctx, { keyRing: null, graphVersion: null, marketingVersion: null });
    expect(synced).toMatchObject({ simulated: true, currency: 'INR', campaigns: 2, snapshots: 1 });
    const campaign = await d.db.campaign.findFirstOrThrow({ where: { workspaceId: WS_A, configuredStatus: 'ACTIVE' } });
    expect(campaign).toMatchObject({ simulated: true, currency: 'INR' });

    const paused = await requestCampaignStatusChange(ctx, { campaignId: campaign.id, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'demo-pause-0001' });
    expect(paused).toMatchObject({ state: 'SIMULATED', simulated: true, created: true, previousStatus: 'ACTIVE', targetStatus: 'PAUSED' });
    expect(await d.db.campaign.findFirstOrThrow({ where: { id: campaign.id } })).toMatchObject({ configuredStatus: 'PAUSED', effectiveStatus: 'PAUSED' });
    const audit = await d.db.auditEvent.findFirstOrThrow({ where: { action: 'campaign.status.change', targetId: campaign.id } });
    expect(audit).toMatchObject({ simulated: true, result: 'SUCCESS' });
    // A repeat of the same request is the same action, not a second one.
    expect(await requestCampaignStatusChange(ctx, { campaignId: campaign.id, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'demo-pause-0001' })).toMatchObject({ id: paused.id, created: false });
    const resumed = await requestCampaignStatusChange(ctx, { campaignId: campaign.id, targetStatus: 'ACTIVE', confirm: 'resume', requestKey: 'demo-resume-0001' });
    expect(resumed.state).toBe('SIMULATED');
    expect(await d.db.campaignAction.count({ where: { campaignId: campaign.id } })).toBe(2);
    expect(await d.db.job.count({ where: { type: { in: ['campaign.action', 'campaign.readback'] } } })).toBe(0);
    expect(outboundAttempts()).toHaveLength(0);
  });

  it('needs the typed confirmation and campaigns.control', async () => {
    const ctx = await employeeCtx(d);
    const campaign = await d.db.campaign.findFirstOrThrow({ where: { workspaceId: WS_A, configuredStatus: 'ACTIVE' } });
    await expect(requestCampaignStatusChange(ctx, { campaignId: campaign.id, targetStatus: 'PAUSED', confirm: 'yes', requestKey: 'demo-pause-0002' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 422 });
    await expect(requestCampaignStatusChange(await nehaCtx(d), { campaignId: campaign.id, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'demo-pause-0003' })).rejects.toMatchObject({ status: 403 });
    expect(await d.db.campaign.findFirstOrThrow({ where: { id: campaign.id } })).toMatchObject({ configuredStatus: 'ACTIVE' });
  });
});

describe('LIVE', () => {
  let h: MetaHarness;
  let campaignId: string;
  beforeAll(async () => {
    h = await createMetaHarness('t35-controls-live');
  }, 120_000);
  afterAll(async () => h?.destroy());
  beforeEach(async () => {
    h.graph.reset();
    h.hooks.beforeRequest = null;
    resetOutboundAttempts();
    await h.db.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED' } });
    await h.db.campaignAction.updateMany({ where: { state: { in: ['PENDING', 'SENDING', 'UNKNOWN'] } }, data: { state: 'FAILED' } });
    if (campaignId) await h.db.campaign.update({ where: { id: campaignId }, data: { configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE' } });
  });

  const marketing = (path: string) => new RegExp(`^/v25\\.0/${path}$`);

  it('metrics: ad-account currency kept (USD minor units, never INR), window, attribution and As of; Marketing API version', async () => {
    await storeMeta(h);
    h.graph.on('GET', marketing(`act_${AD_ACCOUNT}`), metaAnswer('response.ad-account-usd.json'));
    h.graph.on('GET', marketing(`act_${AD_ACCOUNT}/campaigns`), metaAnswer('response.campaigns.json'));
    h.graph.on('GET', marketing(`act_${AD_ACCOUNT}/insights`), metaAnswer('response.insights.json'));
    const result = await syncCampaignMetrics(await h.ownerCtx(), h.deps());
    expect(result).toMatchObject({ simulated: false, currency: 'USD', campaigns: 2, snapshots: 1, skipped: 0, datePreset: 'last_7d' });
    const insights = h.graph.requests.find((r) => r.path.endsWith('/insights'))!;
    expect(insights.query).toMatchObject({ level: 'campaign', date_preset: 'last_7d', use_unified_attribution_setting: 'true' });
    expect(insights.query.fields).toContain('attribution_setting');
    expect(h.graph.requests.every((r) => r.path.startsWith('/v25.0/'))).toBe(true);

    const campaign = await h.db.campaign.findFirstOrThrow({ where: { workspaceId: h.wsA, providerCampaignId: CAMPAIGN } });
    campaignId = campaign.id;
    expect(campaign).toMatchObject({ currency: 'USD', configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE', simulated: false, lastSyncedAt: h.clock.now() });
    const snapshot = await h.db.campaignMetricSnapshot.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(snapshot).toMatchObject({
      spendMinor: 12345n,
      leads: 9,
      cplMinor: 1372n,
      attributionSetting: '7-day click or 1-day view',
      dateStart: new Date('2026-10-13T00:00:00.000Z'),
      dateStop: new Date('2026-10-19T00:00:00.000Z'),
      asOf: h.clock.now(),
    });
    expect(await h.db.campaign.count({ where: { workspaceId: h.wsA, currency: { not: 'USD' } } })).toBe(0);
    // A second manual sync within a minute is refused (provider quota).
    await expect(syncCampaignMetrics(await h.ownerCtx(), h.deps())).rejects.toMatchObject({ code: 'CAMPAIGN_SYNC_TOO_SOON', status: 429 });
  });

  it('LIVE without a verified integration: 412 over HTTP, nothing queued, adapter not called, refusal audited', async () => {
    await storeMeta(h, { status: 'CONFIGURED_UNVERIFIED' });
    const owner = await h.db.membership.findFirstOrThrow({ where: { workspaceId: h.wsA, role: 'OWNER' } });
    const { token, session } = await createSession(h.db, { userId: owner.userId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: h.wsA, ipHash: 'live', userAgent: 'vitest', now: h.clock.now() });
    const req = makeRequest(`/api/app/campaigns/${campaignId}/status`, {
      body: { targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'live-pause-0412' },
      cookie: `${sessionCookieName(h.config)}=${token}`,
      csrf: csrfTokenForSession(h.config, session.id),
    });
    const res = await statusRoute(req, { params: Promise.resolve({ campaignId }) });
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ code: 'INTEGRATION_NOT_VERIFIED' });
    expect(await h.db.campaignAction.count({ where: { idempotencyKey: { contains: 'live-pause-0412' } } })).toBe(0);
    expect(await h.db.job.count({ where: { type: 'campaign.action', status: 'QUEUED' } })).toBe(0);
    await h.drain();
    expect(h.graph.requests).toHaveLength(0);
    expect(outboundAttempts()).toHaveLength(0);
    expect(await h.db.auditEvent.findFirst({ where: { action: 'campaign.status.request', targetId: campaignId, result: 'DENIED' } })).not.toBeNull();
    expect(await h.db.campaign.findFirstOrThrow({ where: { id: campaignId } })).toMatchObject({ configuredStatus: 'ACTIVE' });
  });

  it('verified: SENDING before the call, then the read-back effective status is stored (SUCCEEDED)', async () => {
    await storeMeta(h);
    const action = await requestCampaignStatusChange(await h.ownerCtx(), { campaignId, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'live-pause-0001' });
    expect(action).toMatchObject({ state: 'PENDING', created: true, simulated: false });
    const seen: string[] = [];
    h.hooks.beforeRequest = async (url) => {
      const row = await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } });
      seen.push(`${new URL(url).pathname}:${row.state}`);
    };
    h.graph.on('POST', marketing(CAMPAIGN), metaAnswer('response.update-success.json'));
    h.graph.on('GET', marketing(CAMPAIGN), metaAnswer('response.campaign-paused.json'));
    await h.drain();
    expect(seen).toEqual([`/v25.0/${CAMPAIGN}:SENDING`, `/v25.0/${CAMPAIGN}:SENDING`]);
    expect(h.graph.requests[0]!.raw?.toString('utf8')).toBe('status=PAUSED');
    const stored = await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } });
    expect(stored).toMatchObject({ state: 'SUCCEEDED', readBackStatus: 'PAUSED', previousStatus: 'ACTIVE', reasonCode: null });
    expect(stored.resolvedAt).not.toBeNull();
    expect(await h.db.campaign.findFirstOrThrow({ where: { id: campaignId } })).toMatchObject({ configuredStatus: 'PAUSED', effectiveStatus: 'PAUSED' });
    expect(await h.db.auditEvent.findFirst({ where: { action: 'campaign.status.change', targetId: campaignId, result: 'SUCCESS' } })).not.toBeNull();
  });

  it('an adapter error leaves the status unchanged and is shown FAILED with the permission named, never success', async () => {
    await storeMeta(h);
    const action = await requestCampaignStatusChange(await h.ownerCtx(), { campaignId, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'live-pause-0002' });
    h.graph.on('POST', marketing(CAMPAIGN), metaAnswer('error.10-no-name.json'));
    await h.drain();
    const stored = await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } });
    expect(stored).toMatchObject({ state: 'FAILED', reasonCode: 'PERMISSION_MISSING', readBackStatus: null });
    expect(stored.providerResultRedacted).toContain('ads_management');
    expect(await h.db.campaign.findFirstOrThrow({ where: { id: campaignId } })).toMatchObject({ configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE' });
    expect(h.graph.requests.map((r) => r.method)).toEqual(['POST']);
    expect(await h.db.auditEvent.findFirst({ where: { action: 'campaign.status.change', targetId: campaignId, result: 'FAILED' } })).not.toBeNull();
  });

  it('a timeout after the write is UNKNOWN, then the read-back resolves it from Meta (applied, and not applied)', async () => {
    for (const [i, readBack, expected] of [
      [3, 'response.campaign-paused.json', { state: 'SUCCEEDED', readBackStatus: 'PAUSED', configured: 'PAUSED' }],
      [4, 'response.campaign-active.json', { state: 'FAILED', readBackStatus: 'ACTIVE', configured: 'ACTIVE' }],
    ] as const) {
      await storeMeta(h);
      await h.db.campaign.update({ where: { id: campaignId }, data: { configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE' } });
      h.graph.reset();
      const action = await requestCampaignStatusChange(await h.ownerCtx(), { campaignId, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: `live-pause-000${i}` });
      h.graph.on('POST', marketing(CAMPAIGN), { throw: networkError('UND_ERR_HEADERS_TIMEOUT') });
      await h.drain();
      let stored = await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } });
      expect(stored).toMatchObject({ state: 'UNKNOWN', reasonCode: 'WRITE_TIMEOUT' });
      // Never re-sent: one POST, and the campaign keeps its last known status meanwhile.
      expect(h.graph.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
      expect(await h.db.campaign.findFirstOrThrow({ where: { id: campaignId } })).toMatchObject({ configuredStatus: 'ACTIVE' });
      const readJob = await h.db.job.findFirstOrThrow({ where: { type: 'campaign.readback', idempotencyKey: `campaign.readback:${action.id}` } });
      expect(readJob.runAt.getTime() - h.clock.now().getTime()).toBe(30_000);
      h.graph.on('GET', marketing(CAMPAIGN), metaAnswer(readBack));
      h.clock.set(new Date(readJob.runAt.getTime()));
      await h.drain();
      stored = await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } });
      expect(stored).toMatchObject({ state: expected.state, readBackStatus: expected.readBackStatus });
      if (expected.state === 'FAILED') expect(stored.reasonCode).toBe('READBACK_NOT_APPLIED');
      expect(await h.db.campaign.findFirstOrThrow({ where: { id: campaignId } })).toMatchObject({ configuredStatus: expected.configured });
      expect(h.graph.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    }
  });

  it('throttling puts the action back to PENDING and retries; one action in flight per campaign', async () => {
    await storeMeta(h);
    await h.db.campaign.update({ where: { id: campaignId }, data: { configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE' } });
    const action = await requestCampaignStatusChange(await h.ownerCtx(), { campaignId, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'live-pause-0005' });
    await expect(requestCampaignStatusChange(await h.ownerCtx(), { campaignId, targetStatus: 'PAUSED', confirm: 'PAUSE', requestKey: 'live-pause-0006' })).rejects.toMatchObject({ code: 'CAMPAIGN_ACTION_IN_FLIGHT', status: 409 });
    h.graph.on('POST', marketing(CAMPAIGN), metaAnswer('error.80004.json'), metaAnswer('response.update-success.json'));
    h.graph.on('GET', marketing(CAMPAIGN), metaAnswer('response.campaign-paused.json'));
    await h.drain();
    expect(await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } })).toMatchObject({ state: 'PENDING', reasonCode: 'PROVIDER_RATE_LIMITED' });
    const job = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `campaign.action:${action.id}` } });
    expect(job.runAt.getTime() - h.clock.now().getTime()).toBe(30_000);
    h.clock.set(new Date(job.runAt.getTime()));
    await h.drain();
    expect(await h.db.campaignAction.findFirstOrThrow({ where: { id: action.id } })).toMatchObject({ state: 'SUCCEEDED', readBackStatus: 'PAUSED' });
  });
});
