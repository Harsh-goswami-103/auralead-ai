/**
 * `ai.draft` (T14): generates one lead draft on request ("Generate draft", or the explicit
 * "Generate with local template" action, C13) and stores it with its audit rows in the job's
 * fenced settle transaction. Kind `ai` (3 attempts). A retryable provider failure is rethrown so
 * the runtime retries with backoff; on the last attempt it is stored as a NEEDS_REVIEW draft.
 * Payload v1: `{ leadId, trigger: MANUAL | LOCAL_EXPLICIT, requestedBy }`.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { getJobContext } from '@/server/auth/context';
import { defaultDraftDeps } from '@/server/services/ai/deps';
import { AI_DRAFT_JOB, AI_DRAFT_PAYLOAD_VERSION, generateLeadDraft, persistLeadDraft, type DraftDeps } from '@/server/services/ai/drafts';
import type { JobDefinition } from '../types';

export { AI_DRAFT_JOB } from '@/server/services/ai/drafts';

export const aiDraftPayloadSchema = z.object({
  leadId: z.string().min(1).max(64),
  trigger: z.enum(['MANUAL', 'LOCAL_EXPLICIT']),
  requestedBy: z.string().min(1).max(128),
});

export type AiDraftJobOptions = {
  mode?: () => 'demo' | 'live';
  deps?: () => DraftDeps;
};

export function createAiDraftJob(options: AiDraftJobOptions = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const deps = options.deps ?? defaultDraftDeps;
  return {
    type: AI_DRAFT_JOB,
    kind: 'ai',
    payloadVersions: [AI_DRAFT_PAYLOAD_VERSION],
    async handler(job) {
      const payload = aiDraftPayloadSchema.safeParse(job.job.payload);
      if (!payload.success) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'ai.draft payload is not { leadId, trigger, requestedBy }' };
      const workspaceId = job.job.workspaceId;
      if (workspaceId === null) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'ai.draft needs a workspace job' };
      const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: mode(), clock: job.clock });
      const draft = await generateLeadDraft(
        ctx,
        { leadId: payload.data.leadId, trigger: payload.data.trigger, requestedBy: payload.data.requestedBy, finalAttempt: job.job.attempts >= job.job.maxAttempts },
        deps(),
      );
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await persistLeadDraft(tx, ctx, draft);
        },
      };
    },
  };
}

export const aiDraftJob = createAiDraftJob();
