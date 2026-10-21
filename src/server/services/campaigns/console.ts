/**
 * The live parts of the Meta console (T35), read beside T28's `getMetaConsole` (source-pages.ts):
 * the newest CampaignAction of each campaign, the recent backfill runs, the leads that could not
 * be fetched (by failure code) and the forms that sent leads without a mapping, the webhook
 * callback path, and the gates of each control (plan §12: configuration, permission or mode only).
 * Reading needs `leads.read`. Server configuration is passed in as booleans (whether the Graph
 * and Marketing API versions and the webhook secrets are set), never values.
 */
import type { IntegrationStatus } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability } from '@/server/auth/guards';
import type { WebhookEventResult } from '@/server/services/webhooks/events';
import { backfillView, type BackfillView } from './backfill';
import { isVerified, latestActions, type CampaignActionView } from './controls';

export const META_WEBHOOK_PATH = '/api/webhooks/meta-ads';

export type ServerMetaConfig = { graphVersionSet: boolean; marketingVersionSet: boolean; appSecretSet: boolean; verifyTokenSet: boolean };

export type ControlGate = { allowed: true } | { allowed: false; category: 'configuration' | 'permission' | 'mode'; reason: string };

export type MetaLiveParts = {
  mode: 'demo' | 'live';
  integrationStatus: IntegrationStatus;
  verified: boolean;
  server: ServerMetaConfig;
  webhookPath: string;
  actions: Record<string, CampaignActionView>;
  backfills: BackfillView[];
  /** META_ADS events FAILED by code, for "leads that could not be fetched". */
  fetchFailures: Array<{ code: string; count: number; oldest: Date }>;
  /** Form ids of events that failed for a missing mapping. */
  unmappedForms: string[];
  /** Routed events still waiting for the worker. */
  pendingFetch: number;
  gates: { control: ControlGate; sync: ControlGate; backfill: ControlGate; mapping: ControlGate };
};

const PERMISSION_MANAGE = 'Your assignment here does not include “Manage integrations”. A super admin can grant it.';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function getMetaLiveParts(ctx: AppCtx, server: ServerMetaConfig): Promise<MetaLiveParts> {
  requireCapability(ctx, 'leads.read');
  const integration = await ctx.db.integration.findFirst({ where: { kind: 'META_ADS' }, select: { id: true, status: true, verifiedAt: true, config: true } });
  const status: IntegrationStatus = integration?.status ?? 'NOT_CONFIGURED';
  const verified = isVerified(integration);
  const adAccountSet = typeof record(integration?.config).adAccountId === 'string';
  const campaigns = await ctx.db.campaign.findMany({ select: { id: true }, take: 50 });
  const actions = await latestActions(ctx, campaigns.map((c) => c.id));
  const backfills = await ctx.db.metaLeadBackfill.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10 });
  const failed = await ctx.db.webhookEvent.findMany({ where: { provider: 'META_ADS', status: 'FAILED', simulated: false }, orderBy: { receivedAt: 'asc' }, take: 500, select: { receivedAt: true, result: true, payloadRedacted: true } });
  const byCode = new Map<string, { count: number; oldest: Date }>();
  const unmapped = new Set<string>();
  for (const e of failed) {
    const r = e.result as WebhookEventResult | null;
    const code = r?.kind === 'failed' ? r.code : 'UNKNOWN';
    const entry = byCode.get(code) ?? { count: 0, oldest: e.receivedAt };
    entry.count += 1;
    byCode.set(code, entry);
    const formId = record(e.payloadRedacted).form_id;
    if (code === 'MAPPING_NOT_FOUND' && typeof formId === 'string' && /^\d{5,32}$/.test(formId)) unmapped.add(formId);
  }
  const mapped = new Set((await ctx.db.metaFormMapping.findMany({ select: { formId: true } })).map((m) => m.formId));
  const pendingFetch = await ctx.db.webhookEvent.count({ where: { provider: 'META_ADS', status: 'RECEIVED', simulated: false } });

  const canControl = hasCapability(ctx, 'campaigns.control');
  const canManage = hasCapability(ctx, 'integrations.manage');
  const control: ControlGate = !canControl
    ? { allowed: false, category: 'permission', reason: 'Your assignment here does not include “Control campaigns”. A super admin can grant it.' }
    : ctx.mode === 'live' && !verified
      ? { allowed: false, category: 'configuration', reason: 'Campaigns can be paused or resumed once Meta Lead Ads is connected and verified (Test connection on its setup page).' }
      : ctx.mode === 'live' && !server.marketingVersionSet
        ? { allowed: false, category: 'configuration', reason: 'The server has no META_MARKETING_VERSION configured, so the Marketing API cannot be called.' }
        : { allowed: true };
  const sync: ControlGate = !canManage
    ? { allowed: false, category: 'permission', reason: PERMISSION_MANAGE }
    : ctx.mode === 'live' && (!verified || !adAccountSet)
      ? { allowed: false, category: 'configuration', reason: 'Campaigns are synced once Meta Lead Ads is verified and an ad account ID is saved on its setup page.' }
      : ctx.mode === 'live' && !server.marketingVersionSet
        ? { allowed: false, category: 'configuration', reason: 'The server has no META_MARKETING_VERSION configured, so the Marketing API cannot be called.' }
        : { allowed: true };
  const backfill: ControlGate = !canManage
    ? { allowed: false, category: 'permission', reason: PERMISSION_MANAGE }
    : ctx.mode !== 'live'
      ? { allowed: false, category: 'mode', reason: 'A backfill reads leads from Meta, which DEMO never contacts. The lead simulation exercises the same ingestion.' }
      : status === 'NOT_CONFIGURED' || status === 'REVOKED' || status === 'SIMULATED'
        ? { allowed: false, category: 'configuration', reason: 'Save the Page ID and access token on the setup page first.' }
        : !server.graphVersionSet
          ? { allowed: false, category: 'configuration', reason: 'The server has no META_GRAPH_VERSION configured, so leads cannot be read.' }
          : { allowed: true };
  const mapping: ControlGate = !canManage
    ? { allowed: false, category: 'permission', reason: PERMISSION_MANAGE }
    : ctx.mode === 'live' && (status === 'NOT_CONFIGURED' || status === 'REVOKED')
      ? { allowed: false, category: 'configuration', reason: 'Save the Page ID and access token on the setup page first; form mappings belong to that integration.' }
      : { allowed: true };

  return {
    mode: ctx.mode,
    integrationStatus: status,
    verified,
    server,
    webhookPath: META_WEBHOOK_PATH,
    actions: Object.fromEntries(actions),
    backfills: backfills.map(backfillView),
    fetchFailures: [...byCode.entries()].map(([code, v]) => ({ code, count: v.count, oldest: v.oldest })).sort((a, b) => b.count - a.count),
    unmappedForms: [...unmapped].filter((f) => !mapped.has(f)).sort(),
    pendingFetch,
    gates: { control, sync, backfill, mapping },
  };
}
