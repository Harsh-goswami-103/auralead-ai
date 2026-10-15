/**
 * DRAFT stage (T14, E9, ADR-43): generates the lead's draft bundle once per pipeline execution.
 * - An execution that already has its AiDraft (UNIQUE executionId) reuses it: a rerun never
 *   produces a second draft or a second provider effect on the stored state.
 * - Generation runs in `run` (it may call a provider); the AiDraft, its audit rows and the stage
 *   run's `outputRef` ({ draftId, status, generatorLabel }) commit in `finalTx`, inside the job's
 *   fenced settle transaction.
 * - A retryable provider failure throws while job attempts remain (the executor retries); on the
 *   last attempt the draft is stored as NEEDS_REVIEW and the pipeline moves on to review. A
 *   NEEDS_REVIEW draft is still DONE for the stage: review is the APPROVAL stage's job (T23).
 */
import { defaultDraftDeps } from '@/server/services/ai/deps';
import { generateLeadDraft, persistLeadDraft, type DraftDeps } from '@/server/services/ai/drafts';
import type { StageHandler } from './types';

export const DRAFT_STAGE_REQUESTED_BY = 'system:pipeline.advance';

export function createDraftStage(deps: () => DraftDeps = defaultDraftDeps): StageHandler {
  return {
    stage: 'DRAFT',
    async run({ ctx, job, execution, lead }) {
      const existing = await ctx.db.aiDraft.findFirst({ where: { executionId: execution.id }, select: { id: true, status: true, generatorLabel: true } });
      if (existing) return { status: 'DONE', outputRef: { draftId: existing.id, status: existing.status, generatorLabel: existing.generatorLabel } };

      const draft = await generateLeadDraft(
        ctx,
        { leadId: lead.id, trigger: 'PIPELINE', requestedBy: DRAFT_STAGE_REQUESTED_BY, executionId: execution.id, finalAttempt: job.job.attempts >= job.job.maxAttempts },
        deps(),
      );
      return {
        status: 'DONE',
        outputRef: { status: draft.status, generatorLabel: draft.generatorLabel },
        finalTx: async (tx) => {
          const { id } = await persistLeadDraft(tx, ctx, draft);
          await tx.pipelineStageRun.update({
            where: { executionId_stage: { executionId: execution.id, stage: 'DRAFT' } },
            data: { outputRef: { draftId: id, status: draft.status, generatorLabel: draft.generatorLabel } },
          });
        },
      };
    },
  };
}

export const draftStage = createDraftStage();
