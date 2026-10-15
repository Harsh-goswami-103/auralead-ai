/**
 * `bulk.run` (T23, AT13): applies a confirmed bulk action to its selection. Payload v1
 * `{ bulkRunId }`, workspace job, kind default. The work happens in `processBulkRun`
 * (`services/bulk/bulk.ts`): fenced, tenant-scoped chunks that classify each row with the shared
 * eligibility function (sendIntent BULK), queue the eligible rows through the dispatch outbox and
 * persist each row's result in the same transaction. Sends happen later in the dispatch jobs, which
 * re-run eligibility at send time.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { BULK_RUN_JOB, BULK_RUN_PAYLOAD_VERSION, processBulkRun, type BulkDeps } from '@/server/services/bulk/bulk';
import type { JobDefinition, JobResult } from '../types';
import { deadResult, jobCtx, parseWorkspacePayload } from './lead-job-support';

const payloadSchema = z.object({ bulkRunId: z.string().min(1).max(64) });

export type BulkRunJobOptions = {
  deps?: () => BulkDeps;
  mode?: () => 'demo' | 'live';
};

export function bulkDepsFromConfig(): BulkDeps {
  const pepper = getConfig().secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is required for bulk actions (run npm run setup)');
  return { contactKeyPepper: pepper };
}

export function createBulkRunJob(options: BulkRunJobOptions = {}): JobDefinition {
  const deps = options.deps ?? bulkDepsFromConfig;
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: BULK_RUN_JOB,
    kind: 'default',
    payloadVersions: [BULK_RUN_PAYLOAD_VERSION],
    async handler(job): Promise<JobResult> {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const ctx = jobCtx(job, parsed.workspaceId, mode());
      const outcome = await processBulkRun(job, ctx, parsed.payload.bulkRunId, deps());
      if (outcome === 'missing') return deadResult('BULK_RUN_NOT_FOUND', `no bulk run ${parsed.payload.bulkRunId} in the job's workspace`);
      return { outcome: 'succeeded' };
    },
  };
}

export const bulkRunJob = createBulkRunJob();
