/**
 * Job types and limits of the Meta Lead Ads and campaign services (T35). A leaf module: the
 * integration schedules (services/integrations/schedules.ts) and the job handlers import it
 * without pulling in the services. (`meta.lead.fetch` is `META_LEAD_FETCH_JOB` in
 * services/webhooks/events.ts, the persistence that enqueues it.)
 */

/** On-demand "Backfill from form since T" (critic L-8): one MetaLeadBackfill row per run. */
export const META_LEAD_BACKFILL_JOB = 'meta.lead.backfill';
/** Campaign list, ad account currency and campaign insights (scheduled every 6 hours while CONNECTED or DEGRADED, and on demand). */
export const CAMPAIGN_METRICS_SYNC_JOB = 'campaign.metricsSync';
/** One CampaignAction: SENDING before the provider call, settled in the fenced settle (plan §4.4). */
export const CAMPAIGN_ACTION_JOB = 'campaign.action';
/** Reads a campaign's status back after an UNKNOWN outcome (timeout after the write) or a failed read-back. */
export const CAMPAIGN_READBACK_JOB = 'campaign.readback';

export const META_JOB_PAYLOAD_VERSION = 1;

/** A scheduled metrics sync runs every 6 hours (insights are not real time). */
export const CAMPAIGN_METRICS_EVERY_MS = 6 * 60 * 60 * 1000;
/** One manual metrics sync per integration per minute. */
export const CAMPAIGN_SYNC_COOLDOWN_MS = 60_000;
/** Read-back waits this long after an UNKNOWN outcome, so the provider has applied the write. */
export const CAMPAIGN_READBACK_DELAY_MS = 30_000;

/** Pages of campaigns or insights one sync reads (100 each). */
export const CAMPAIGN_SYNC_MAX_PAGES = 20;
/** Pages of leads one backfill run reads (100 each). */
export const BACKFILL_MAX_PAGES = 10;

/** Rate-limit backoff for Meta reads: min(30 s * 2^(n-1), 1 h) (02-errors), the provider's Retry-After when longer. */
export function metaBackoffMs(failedAttempt: number, retryAfterMs?: number): number {
  const n = Math.max(1, Math.trunc(failedAttempt));
  const exponential = Math.min(30_000 * 2 ** Math.min(n - 1, 20), 60 * 60 * 1000);
  return Math.max(exponential, retryAfterMs ?? 0);
}
