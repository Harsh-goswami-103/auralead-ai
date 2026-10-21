/**
 * `campaign.action` and `campaign.readback` (T35; plan §4.4): one CampaignAction moved SENDING
 * before the Marketing API call and settled in the fenced settle, and the read-back that resolves
 * an UNKNOWN outcome from the provider's own status (services/campaigns/controls.ts).
 */
import { getConfig } from '@/lib/config';
import { CAMPAIGN_ACTION_JOB, CAMPAIGN_READBACK_JOB, META_JOB_PAYLOAD_VERSION } from '@/server/services/campaigns/constants';
import { runCampaignAction, runCampaignReadBack, type CampaignJobDeps } from '@/server/services/campaigns/controls';
import { liveAdapterDepsFrom } from '@/server/services/integrations/live-adapters';
import type { JobDefinition } from '../types';

export type { CampaignJobDeps };

export function campaignJobDepsFromConfig(): CampaignJobDeps {
  const config = getConfig();
  return { ...liveAdapterDepsFrom(config), mode: config.mode };
}

export function createCampaignActionJob(options: { deps?: () => CampaignJobDeps } = {}): JobDefinition {
  const deps = options.deps ?? campaignJobDepsFromConfig;
  return { type: CAMPAIGN_ACTION_JOB, kind: 'send', payloadVersions: [META_JOB_PAYLOAD_VERSION], handler: (job) => runCampaignAction(job, deps()) };
}

export function createCampaignReadBackJob(options: { deps?: () => CampaignJobDeps } = {}): JobDefinition {
  const deps = options.deps ?? campaignJobDepsFromConfig;
  return { type: CAMPAIGN_READBACK_JOB, kind: 'fetch', payloadVersions: [META_JOB_PAYLOAD_VERSION], handler: (job) => runCampaignReadBack(job, deps()) };
}

export const campaignActionJob = createCampaignActionJob();
export const campaignReadBackJob = createCampaignReadBackJob();
