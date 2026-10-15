/**
 * `quote.expireSweep` (T15, plan §6.1, P16): moves the workspace's APPROVED, SENT and VIEWED
 * quotes whose validity has passed (`now >= validUntil`) to EXPIRED, with one `quote.expire`
 * audit row each, inside the job's fenced settle. Version creation schedules one sweep per
 * workspace and UTC minute of a validUntil (`quote-expiry:<workspaceId>:<minute>`, run at the end
 * of that minute), so duplicate schedulers never double-run; each sweep handles every due quote of
 * the workspace, so a missed bucket is caught by the next one. Reads show the effective status in
 * between. Payload v1 `{ dueAt }` (informational; the sweep uses the job clock).
 */
import { getConfig } from '@/lib/config';
import { expireDueQuotesIn, QUOTE_EXPIRE_SWEEP_JOB } from '@/server/services/quotes/versioning';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx } from './lead-job-support';

export { QUOTE_EXPIRE_SWEEP_JOB };

export function createQuoteExpireSweepJob(options: { mode?: () => 'demo' | 'live' } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: QUOTE_EXPIRE_SWEEP_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const workspaceId = job.job.workspaceId;
      if (workspaceId === null) return deadResult('INVALID_PAYLOAD', `${QUOTE_EXPIRE_SWEEP_JOB} needs a workspace job`);
      const ctx = jobCtx(job, workspaceId, mode());
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await expireDueQuotesIn(tx, ctx);
        },
      };
    },
  };
}

export const quoteExpireSweepJob = createQuoteExpireSweepJob();
