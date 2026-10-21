/**
 * `campaign.metricsSync` (T35, every 6 hours, LIVE; P6): reads the ad account, its campaigns and
 * their last-7-days insights outside any transaction and stores them in the fenced settle
 * (`applyCampaignMetrics`: ad-account currency kept as returned, "As of" + window + attribution).
 * A failed read changes nothing, is audited FAILED and, for a rejected token or a missing
 * permission, marks the integration; the next bucket is armed either way while the integration
 * stays CONNECTED or DEGRADED (services/integrations/schedules.ts). A META_ADS integration without
 * an ad account has nothing to sync.
 */
import { LeaseLostError } from '@/server/db/fence';
import { CAMPAIGN_METRICS_SYNC_JOB } from '@/server/services/campaigns/constants';
import { applyCampaignMetrics, fetchCampaignMetrics, liveMarketingClient, recordMetricsFailure } from '@/server/services/campaigns/metrics';
import { INTEGRATION_SCHEDULE_PAYLOAD_VERSION } from '@/server/services/integrations/schedules';
import type { JobDefinition } from '../types';
import { integrationPayloadSchema, jobDeps, jobMode, loadScheduledIntegration, rearm, type IntegrationJobOptions } from './integration-job-support';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

export function createCampaignMetricsSyncJob(options: IntegrationJobOptions = {}): JobDefinition {
  const mode = jobMode(options);
  const deps = jobDeps(options);
  return {
    type: CAMPAIGN_METRICS_SYNC_JOB,
    kind: 'fetch',
    payloadVersions: [INTEGRATION_SCHEDULE_PAYLOAD_VERSION],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, integrationPayloadSchema);
      if (!parsed.ok) return parsed.result;
      const m = mode();
      if (m !== 'live') return { outcome: 'succeeded' };
      const ctx = jobCtx(job, parsed.workspaceId, m);
      const row = await loadScheduledIntegration(ctx, parsed.payload.integrationId);
      if (!row || row.kind !== 'META_ADS') return { outcome: 'succeeded' };
      const resolved = await liveMarketingClient(ctx, deps());
      if (!resolved.ok) return { outcome: 'succeeded', finalTx: (tx) => rearm(tx, ctx, row, job.job.id) };
      const fetched = await fetchCampaignMetrics(resolved.client);
      if (job.signal.aborted) throw new LeaseLostError(job.job.id);
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          if (fetched.ok) await applyCampaignMetrics(tx, ctx, resolved.integration, fetched.fetched, { simulated: false, trigger: 'scheduled' });
          else await recordMetricsFailure(tx, ctx, resolved.integration, fetched.failure, 'scheduled');
          await rearm(tx, ctx, row, job.job.id);
        },
      };
    },
  };
}

export const campaignMetricsSyncJob = createCampaignMetricsSyncJob();
