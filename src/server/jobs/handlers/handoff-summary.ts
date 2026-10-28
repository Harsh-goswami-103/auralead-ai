/**
 * `handoff.summary` (ADR-124, lead-gen slice F5): writes the AI summary of a handed-over lead for
 * the client. Kind `ai` (3 attempts). The read and the generator call run outside any transaction
 * (services/ai/handoff-summary.ts); the outcome (READY, NOT_CONFIGURED or FAILED) is stored in the
 * job's fenced settle transaction, only while the handoff is still PENDING. A retryable provider
 * failure is rethrown so the runtime retries with backoff; on the last attempt it is stored FAILED.
 * A handoff that is gone (the lead was erased) or no longer PENDING settles with no effect.
 * Payload v1: `{ handoffId }`.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { getJobContext } from '@/server/auth/context';
import { generateHandoffSummary, persistHandoffSummary } from '@/server/services/ai/handoff-summary';
import { defaultAiDeps, type AiDeps } from '@/server/services/ai/run-task';
import { HANDOFF_SUMMARY_JOB, HANDOFF_SUMMARY_PAYLOAD_VERSION } from '@/server/services/leads/handoff';
import type { JobDefinition } from '../types';

export { HANDOFF_SUMMARY_JOB } from '@/server/services/leads/handoff';

export const handoffSummaryPayloadSchema = z.object({ handoffId: z.string().min(1).max(64) });

export type HandoffSummaryJobOptions = {
  mode?: () => 'demo' | 'live';
  deps?: () => AiDeps;
};

export function createHandoffSummaryJob(options: HandoffSummaryJobOptions = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const deps = options.deps ?? defaultAiDeps;
  return {
    type: HANDOFF_SUMMARY_JOB,
    kind: 'ai',
    payloadVersions: [HANDOFF_SUMMARY_PAYLOAD_VERSION],
    async handler(job) {
      const payload = handoffSummaryPayloadSchema.safeParse(job.job.payload);
      if (!payload.success) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'handoff.summary payload is not { handoffId }' };
      const workspaceId = job.job.workspaceId;
      if (workspaceId === null) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'handoff.summary needs a workspace job' };
      const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: mode(), clock: job.clock });
      const outcome = await generateHandoffSummary(ctx, { handoffId: payload.data.handoffId, finalAttempt: job.job.attempts >= job.job.maxAttempts }, deps());
      if (outcome === null) return { outcome: 'succeeded' };
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await persistHandoffSummary(tx, ctx, outcome);
        },
      };
    },
  };
}

export const handoffSummaryJob = createHandoffSummaryJob();
