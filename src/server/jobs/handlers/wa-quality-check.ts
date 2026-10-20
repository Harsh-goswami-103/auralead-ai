/**
 * `wa.qualityCheck` (T32, hourly, LIVE; R26): reads the WhatsApp phone number's quality rating and
 * messaging limit outside any transaction and stores them raw (`qualityRaw`, `messagingLimitRaw`,
 * `limitsCheckedAt`) in the fenced settle, with the next bucket armed. Quality RED pauses
 * automated WhatsApp sends through the eligibility check QUALITY_PAUSED; human sends still go out.
 * A failed read stores nothing (the previous values and their time stay) and is audited.
 */
import { LeaseLostError } from '@/server/db/fence';
import { applyQualityResult, fetchWorkspaceQuality } from '@/server/services/integrations/quality';
import { INTEGRATION_SCHEDULE_PAYLOAD_VERSION, WA_QUALITY_CHECK_JOB } from '@/server/services/integrations/schedules';
import type { JobDefinition } from '../types';
import { integrationPayloadSchema, jobDeps, jobMode, loadScheduledIntegration, rearm, type IntegrationJobOptions } from './integration-job-support';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

export function createWaQualityCheckJob(options: IntegrationJobOptions = {}): JobDefinition {
  const mode = jobMode(options);
  const deps = jobDeps(options);
  return {
    type: WA_QUALITY_CHECK_JOB,
    kind: 'fetch',
    payloadVersions: [INTEGRATION_SCHEDULE_PAYLOAD_VERSION],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, integrationPayloadSchema);
      if (!parsed.ok) return parsed.result;
      const m = mode();
      if (m !== 'live') return { outcome: 'succeeded' };
      const ctx = jobCtx(job, parsed.workspaceId, m);
      const row = await loadScheduledIntegration(ctx, parsed.payload.integrationId);
      if (!row || row.kind !== 'WHATSAPP_CLOUD') return { outcome: 'succeeded' };
      const result = await fetchWorkspaceQuality(ctx, deps());
      if (job.signal.aborted) throw new LeaseLostError(job.job.id);
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await applyQualityResult(tx, ctx, row, result);
          await rearm(tx, ctx, row, job.job.id);
        },
      };
    },
  };
}

export const waQualityCheckJob = createWaQualityCheckJob();
