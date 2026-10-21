/**
 * Campaign metrics sync (T35; PRD "Meta console: metrics, spend, leads, CPL"; P6; plan §5.6).
 *
 * LIVE: outside any transaction, through the Marketing API client (META_MARKETING_VERSION, kept
 * separate from META_GRAPH_VERSION): the ad account (its currency), its campaigns (100 per page,
 * at most 20 pages) and campaign-level insights for the last 7 days (`date_preset=last_7d`,
 * `use_unified_attribution_setting=true`). Then, in one transaction (`applyCampaignMetrics`):
 *  - each listed campaign is upserted by (workspace, provider campaign id) with its raw configured
 *    and effective status and the ad account's currency exactly as Meta returned it;
 *  - each insights row becomes the snapshot of that campaign for that date window (upserted by
 *    (campaign, dateStart, dateStop)): spend and cost per lead in integer minor units of the SAME
 *    currency (never converted), the lead count, the attribution setting as returned, and "As of"
 *    = the sync time. A value that cannot be read is skipped and counted, never guessed;
 *  - campaigns Meta no longer lists are left unchanged; the audit row `campaign.metrics.sync`
 *    holds the counts only.
 * DEMO: the demo adapter stands in for the Marketing API (simulated campaigns in INR, labelled
 * Simulated, `simulated = true`); Meta is never contacted.
 *
 * Manual sync (`syncCampaignMetrics`, `integrations.manage`): LIVE needs a CONNECTED or DEGRADED
 * integration with an ad account (422 otherwise) and runs at most once a minute (429). The
 * `campaign.metricsSync` job runs the same fetch every 6 hours while the integration is CONNECTED
 * or DEGRADED (services/integrations/schedules.ts). A rejected token sets "Verification required".
 */
import { decimalToMinor } from '@/lib/ad-currency';
import { DomainRuleError, NotFoundError, ProviderRejectedError, RateLimitedError } from '@/lib/errors';
import { buildDemoCampaignMetrics } from '@/server/adapters/meta/demo';
import { classifyMetaFailure, INSIGHTS_DATE_PRESET, parseAdAccount, parseCampaign, parseInsight, type MetaMarketingClient } from '@/server/adapters/meta/graph';
import type { CampaignMetricsFetch, FetchedCampaign, FetchedInsight } from '@/server/adapters/meta/port';
import { metaMarketingClient, SEND_USABLE_STATUSES } from '@/server/adapters/registry';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { loadIntegrationForUse } from '@/server/services/integrations/credentials';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import { ensureSimulatedMeta } from '@/server/services/webhooks/simulate';
import { CAMPAIGN_SYNC_COOLDOWN_MS, CAMPAIGN_SYNC_MAX_PAGES } from './constants';
import { recordMetaAccessProblem } from './integration-problems';

export type MetricsFetchFailure = { code: string; message: string; permission: string | null; retryAfterMs?: number };
export type MetricsFetch = { ok: true; fetched: CampaignMetricsFetch } | { ok: false; failure: MetricsFetchFailure };

export type MetricsSyncResult = {
  integrationId: string;
  simulated: boolean;
  currency: string;
  campaigns: number;
  snapshots: number;
  skipped: number;
  datePreset: string;
  complete: boolean;
  asOf: Date;
};

function failureOf(call: Parameters<typeof classifyMetaFailure>[0]): MetricsFetchFailure {
  const f = classifyMetaFailure(call, 'ads_read');
  return { code: f.code === 'NOT_FOUND' ? 'CONFIG_INVALID' : f.code, message: f.message, permission: f.permission, ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}) };
}

/** Reads the ad account, its campaigns and their insights (bounded), outside any transaction. */
export async function fetchCampaignMetrics(client: MetaMarketingClient): Promise<MetricsFetch> {
  const accountRes = await client.getAdAccount();
  if (!accountRes.ok) return { ok: false, failure: failureOf(accountRes) };
  const account = parseAdAccount(accountRes.data);
  if (!account) return { ok: false, failure: { code: 'PROVIDER_REJECTED', message: 'Meta answered for the ad account without its id or currency.', permission: null } };

  let complete = true;
  const campaigns: FetchedCampaign[] = [];
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= CAMPAIGN_SYNC_MAX_PAGES) {
      complete = false;
      break;
    }
    const res = await client.listCampaigns({ after });
    if (!res.ok) return { ok: false, failure: failureOf(res) };
    for (const item of res.data.data) {
      const c = parseCampaign(item);
      if (c) campaigns.push(c);
    }
    if (res.data.after === null) break;
    after = res.data.after;
  }

  const insights: FetchedInsight[] = [];
  after = null;
  for (let page = 0; ; page += 1) {
    if (page >= CAMPAIGN_SYNC_MAX_PAGES) {
      complete = false;
      break;
    }
    const res = await client.listCampaignInsights({ datePreset: INSIGHTS_DATE_PRESET, after });
    if (!res.ok) return { ok: false, failure: failureOf(res) };
    for (const item of res.data.data) {
      const i = parseInsight(item);
      if (i) insights.push(i);
    }
    if (res.data.after === null) break;
    after = res.data.after;
  }
  return { ok: true, fetched: { account, campaigns, insights, datePreset: INSIGHTS_DATE_PRESET, complete } };
}

const utcDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/** Stores a fetched sync inside the caller's transaction (every query names the workspace). */
export async function applyCampaignMetrics(
  tx: TxClient,
  ctx: AuditCtx,
  integration: { id: string; workspaceId: string },
  fetched: CampaignMetricsFetch,
  opts: { simulated: boolean; trigger: 'manual' | 'scheduled' },
): Promise<MetricsSyncResult> {
  const now = ctx.clock.now();
  const currency = fetched.account.currency;
  const ids = new Map<string, string>();
  for (const c of fetched.campaigns) {
    const data = { name: c.name, currency, configuredStatus: c.configuredStatus, effectiveStatus: c.effectiveStatus, lastSyncedAt: now, integrationId: integration.id, simulated: opts.simulated };
    const existing = await tx.campaign.findFirst({ where: { workspaceId: integration.workspaceId, providerCampaignId: c.providerCampaignId }, select: { id: true } });
    const row = existing
      ? await tx.campaign.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.campaign.create({ data: { workspaceId: integration.workspaceId, providerCampaignId: c.providerCampaignId, ...data }, select: { id: true } });
    ids.set(c.providerCampaignId, row.id);
  }
  let snapshots = 0;
  let skipped = 0;
  for (const i of fetched.insights) {
    const campaignId = ids.get(i.providerCampaignId);
    const spendMinor = decimalToMinor(i.spend, currency);
    const cplMinor = i.costPerLead === null ? null : decimalToMinor(i.costPerLead, currency);
    if (!campaignId || spendMinor === null || (i.costPerLead !== null && cplMinor === null)) {
      skipped += 1;
      continue;
    }
    const dateStart = utcDate(i.dateStart);
    const dateStop = utcDate(i.dateStop);
    const data = { spendMinor, leads: i.leads, cplMinor, attributionSetting: i.attributionSetting, asOf: now };
    const existing = await tx.campaignMetricSnapshot.findFirst({ where: { workspaceId: integration.workspaceId, campaignId, dateStart, dateStop }, select: { id: true } });
    if (existing) await tx.campaignMetricSnapshot.update({ where: { id: existing.id }, data });
    else await tx.campaignMetricSnapshot.create({ data: { workspaceId: integration.workspaceId, campaignId, dateStart, dateStop, ...data } });
    snapshots += 1;
  }
  await recordAudit(tx, ctx, {
    action: 'campaign.metrics.sync',
    targetType: 'Integration',
    targetId: integration.id,
    workspaceId: integration.workspaceId,
    simulated: opts.simulated,
    summary: { currency, campaigns: fetched.campaigns.length, snapshots, skipped, datePreset: fetched.datePreset, complete: fetched.complete, trigger: opts.trigger },
  });
  return { integrationId: integration.id, simulated: opts.simulated, currency, campaigns: fetched.campaigns.length, snapshots, skipped, datePreset: fetched.datePreset, complete: fetched.complete, asOf: now };
}

/** A failed fetch stored on the integration (auth and permission) and audited, inside the caller's transaction. */
export async function recordMetricsFailure(tx: TxClient, ctx: AuditCtx, integration: { id: string; workspaceId: string }, failure: MetricsFetchFailure, trigger: 'manual' | 'scheduled'): Promise<void> {
  if (failure.code === 'PROVIDER_AUTH' || failure.code === 'PERMISSION_MISSING') {
    await recordMetaAccessProblem(tx, ctx, integration, { code: failure.code, message: failure.message, permission: failure.permission }, 'campaign.metricsSync');
  }
  await recordAudit(tx, ctx, {
    action: 'campaign.metrics.sync',
    targetType: 'Integration',
    targetId: integration.id,
    workspaceId: integration.workspaceId,
    result: 'FAILED',
    summary: { errorCode: failure.code, permission: failure.permission, trigger },
  });
}

/** The Marketing client of the workspace's verified Meta integration, or why there is none. */
export async function liveMarketingClient(ctx: AppCtx, deps: LiveAdapterDeps): Promise<{ ok: true; client: MetaMarketingClient; integration: { id: string; workspaceId: string } } | { ok: false; code: string; reason: string; integrationId: string | null; field?: string }> {
  const use = await loadIntegrationForUse(ctx.db, 'META_ADS', deps.keyRing);
  const r = metaMarketingClient({ mode: ctx.mode, integration: use, graphVersion: deps.graphVersion, marketingVersion: deps.marketingVersion ?? null, clock: ctx.clock, usable: SEND_USABLE_STATUSES, ...(deps.graph ? { graph: deps.graph } : {}) });
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason, integrationId: r.integrationId, ...(r.field ? { field: r.field } : {}) };
  return { ok: true, client: r.value, integration: { id: use!.id, workspaceId: requireWorkspace(ctx) } };
}

export async function syncCampaignMetrics(ctx: AppCtx, deps: LiveAdapterDeps): Promise<MetricsSyncResult> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError();

  if (ctx.mode === 'demo') {
    const setup = await ensureSimulatedMeta(ctx);
    const fetched = buildDemoCampaignMetrics(ctx.clock.now());
    return withTx(ctx.db, (tx) => applyCampaignMetrics(tx as unknown as TxClient, ctx, { id: setup.integrationId, workspaceId }, fetched, { simulated: true, trigger: 'manual' }));
  }

  const resolved = await liveMarketingClient(ctx, deps);
  if (!resolved.ok) {
    throw new DomainRuleError({ code: resolved.code === 'CREDENTIAL_UNREADABLE' ? 'CREDENTIAL_UNREADABLE' : 'INTEGRATION_NOT_CONFIGURED', userMessage: `Campaigns cannot be synced: ${resolved.reason}.` });
  }
  const now = ctx.clock.now();
  const last = await ctx.db.auditEvent.findFirst({
    where: { action: 'campaign.metrics.sync', targetType: 'Integration', targetId: resolved.integration.id, createdAt: { gt: new Date(now.getTime() - CAMPAIGN_SYNC_COOLDOWN_MS) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (last) {
    const wait = Math.max(1, Math.ceil((last.createdAt.getTime() + CAMPAIGN_SYNC_COOLDOWN_MS - now.getTime()) / 1000));
    throw new RateLimitedError({ code: 'CAMPAIGN_SYNC_TOO_SOON', userMessage: `Campaigns were synced less than a minute ago. Try again in ${wait} seconds.`, retryAfterSeconds: wait });
  }
  // Provider calls happen outside any transaction (plan §3).
  const fetched = await fetchCampaignMetrics(resolved.client);
  if (!fetched.ok) {
    const failure = fetched.failure;
    await withTx(ctx.db, (tx) => recordMetricsFailure(tx as unknown as TxClient, ctx, resolved.integration, failure, 'manual'));
    throw new ProviderRejectedError({ provider: 'meta', code: 'CAMPAIGN_SYNC_FAILED', message: failure.message, userMessage: `Meta did not return the campaigns (${failure.code}${failure.permission ? `: missing ${failure.permission}` : ''}). Nothing was changed.` });
  }
  return withTx(ctx.db, (tx) => applyCampaignMetrics(tx as unknown as TxClient, ctx, resolved.integration, fetched.fetched, { simulated: false, trigger: 'manual' }));
}
