/**
 * `wa.templateSync` (T32, every 6 hours, LIVE; ADR-17, P12): fetches the WABA's templates outside
 * any transaction and stores them in the fenced settle with raw status and category
 * (`applyTemplateSync`), so a template paused or rejected in WhatsApp Manager blocks the queued
 * sends that use it (TEMPLATE_NOT_APPROVED) at their next preflight. A failed fetch changes no
 * template and is audited FAILED. The next bucket is armed either way while the integration stays
 * CONNECTED or DEGRADED.
 */
import { LeaseLostError } from '@/server/db/fence';
import { INTEGRATION_SCHEDULE_PAYLOAD_VERSION, WA_TEMPLATE_SYNC_JOB } from '@/server/services/integrations/schedules';
import { applyTemplateSync, fetchTemplatesForIntegration, recordTemplateSyncFailure } from '@/server/services/integrations/template-sync';
import type { JobDefinition } from '../types';
import { integrationPayloadSchema, jobDeps, jobMode, loadScheduledIntegration, rearm, type IntegrationJobOptions } from './integration-job-support';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

export function createTemplateSyncJob(options: IntegrationJobOptions = {}): JobDefinition {
  const mode = jobMode(options);
  const deps = jobDeps(options);
  return {
    type: WA_TEMPLATE_SYNC_JOB,
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
      const fetched = await fetchTemplatesForIntegration(ctx, deps());
      if (job.signal.aborted) throw new LeaseLostError(job.job.id);
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          if (!fetched.ok) await recordTemplateSyncFailure(tx, ctx, row, { errorCode: fetched.code, error: fetched.reason }, 'scheduled');
          else if (!fetched.fetch.ok) await recordTemplateSyncFailure(tx, ctx, row, fetched.fetch, 'scheduled');
          else await applyTemplateSync(tx as never, ctx, row, fetched.fetch, { trigger: 'scheduled' });
          await rearm(tx, ctx, row, job.job.id);
        },
      };
    },
  };
}

export const templateSyncJob = createTemplateSyncJob();
