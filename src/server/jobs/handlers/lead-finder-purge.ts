/**
 * `leadFinder.purge` (ADR-118 (a), slice F1): ends the 24-hour working copy of a run's results.
 * Payload v1 `{ runId }`, a workspace job queued for the end of the hour bucket of a result's
 * `contentExpiresAt`. In its fenced settle it nulls the Places content of every result of the run
 * that has expired, audits the count and re-arms itself for the run's next expiry
 * (services/lead-finder/purge.ts). A run that no longer exists has nothing to purge.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { FINDER_PURGE_JOB } from '@/server/services/lead-finder/jobs';
import { purgeExpiredResults } from '@/server/services/lead-finder/purge';
import type { JobDefinition } from '../types';
import { jobCtx, parseWorkspacePayload } from './lead-job-support';

export { FINDER_PURGE_JOB };

const payloadSchema = z.object({ runId: z.string().min(1).max(64) });

export function createLeadFinderPurgeJob(options: { mode?: () => 'demo' | 'live' } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: FINDER_PURGE_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const run = await job.db.leadFinderRun.findFirst({ where: { id: payload.runId, workspaceId }, select: { id: true } });
      if (!run) return { outcome: 'succeeded' };
      const ctx = { ...jobCtx(job, workspaceId, mode()), workspaceId };
      return { outcome: 'succeeded', finalTx: async (tx) => void (await purgeExpiredResults(tx, ctx, { runId: run.id, jobId: job.job.id })) };
    },
  };
}

export const leadFinderPurgeJob = createLeadFinderPurgeJob();
