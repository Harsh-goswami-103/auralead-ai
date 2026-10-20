/**
 * `integration.health` (T32, hourly, LIVE): re-runs the live connection tester of a CONNECTED or
 * DEGRADED integration and stores its outcome exactly as Test connection does
 * (`persistLiveTestOutcome`), so an expired token or a removed permission becomes visible, and
 * sends stop (eligibility needs CONNECTED), without anyone pressing a button. A run that changes
 * nothing is not audited. The tester call happens outside any transaction; the outcome and the next
 * bucket of every check are written in the fenced settle.
 */
import { LeaseLostError } from '@/server/db/fence';
import { persistLiveTestOutcome } from '@/server/services/integrations/connection-test';
import { liveConnectionTesters } from '@/server/services/integrations/live-testers';
import { INTEGRATION_HEALTH_JOB, INTEGRATION_SCHEDULE_PAYLOAD_VERSION } from '@/server/services/integrations/schedules';
import type { JobDefinition } from '../types';
import { integrationPayloadSchema, jobDeps, jobMode, loadScheduledIntegration, type IntegrationJobOptions } from './integration-job-support';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

export function createIntegrationHealthJob(options: IntegrationJobOptions = {}): JobDefinition {
  const mode = jobMode(options);
  const deps = jobDeps(options);
  return {
    type: INTEGRATION_HEALTH_JOB,
    kind: 'fetch',
    payloadVersions: [INTEGRATION_SCHEDULE_PAYLOAD_VERSION],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, integrationPayloadSchema);
      if (!parsed.ok) return parsed.result;
      const m = mode();
      // DEMO never contacts a provider (and never schedules this job).
      if (m !== 'live') return { outcome: 'succeeded' };
      const ctx = jobCtx(job, parsed.workspaceId, m);
      const row = await loadScheduledIntegration(ctx, parsed.payload.integrationId);
      if (!row) return { outcome: 'succeeded' };
      const tester = liveConnectionTesters(deps())[row.kind];
      if (!tester) return { outcome: 'succeeded' };
      const outcome = await tester(ctx, row);
      if (job.signal.aborted) throw new LeaseLostError(job.job.id);
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await persistLiveTestOutcome(tx, ctx, row, outcome, { trigger: 'scheduled', causationId: job.job.id });
        },
      };
    },
  };
}

export const integrationHealthJob = createIntegrationHealthJob();
