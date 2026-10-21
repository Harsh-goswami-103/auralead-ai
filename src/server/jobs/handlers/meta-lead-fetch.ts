/**
 * `meta.lead.fetch` and `meta.lead.backfill` (T35): the Graph API lead reads of the Meta Lead Ads
 * source (services/campaigns/meta-leads.ts and backfill.ts). Both are fetch jobs (8 attempts):
 * throttling and provider errors retry with backoff; a rejected token or a missing permission is
 * DEAD with the integration marked, never retried blindly.
 *
 * Production deps come from the boot config on first use (key ring, SUPPRESSION_PEPPER, mode,
 * META_GRAPH_VERSION, META_MARKETING_VERSION); tests inject their own.
 */
import { getConfig } from '@/lib/config';
import { runMetaBackfill } from '@/server/services/campaigns/backfill';
import { META_JOB_PAYLOAD_VERSION, META_LEAD_BACKFILL_JOB } from '@/server/services/campaigns/constants';
import { processMetaLeadFetch, type MetaLeadDeps } from '@/server/services/campaigns/meta-leads';
import { liveAdapterDepsFrom } from '@/server/services/integrations/live-adapters';
import { META_LEAD_FETCH_JOB, WEBHOOK_JOB_PAYLOAD_VERSION } from '@/server/services/webhooks/events';
import type { JobDefinition } from '../types';

export type { MetaLeadDeps };

export function metaLeadDepsFromConfig(): MetaLeadDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`); ingestion cannot compute consent contact keys.');
  return { ...liveAdapterDepsFrom(config), contactKeyPepper: pepper, mode: config.mode };
}

export function createMetaLeadFetchJob(options: { deps?: () => MetaLeadDeps } = {}): JobDefinition {
  const deps = options.deps ?? metaLeadDepsFromConfig;
  return { type: META_LEAD_FETCH_JOB, kind: 'fetch', payloadVersions: [WEBHOOK_JOB_PAYLOAD_VERSION], handler: (job) => processMetaLeadFetch(job, deps()) };
}

export function createMetaLeadBackfillJob(options: { deps?: () => MetaLeadDeps } = {}): JobDefinition {
  const deps = options.deps ?? metaLeadDepsFromConfig;
  return { type: META_LEAD_BACKFILL_JOB, kind: 'fetch', payloadVersions: [META_JOB_PAYLOAD_VERSION], handler: (job) => runMetaBackfill(job, deps()) };
}

export const metaLeadFetchJob = createMetaLeadFetchJob();
export const metaLeadBackfillJob = createMetaLeadBackfillJob();
