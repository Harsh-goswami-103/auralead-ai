/**
 * Merge review (R12): a record that matches two or more existing leads (for example its email
 * matches lead A and its phone matches lead B) is never merged automatically. Ingestion opens an
 * OPEN MergeReview naming the candidates and writes nothing to them. Resolution (merge, keep
 * separate, dismiss) is the lead console's job (T26).
 */
import type { Prisma } from '@/generated/prisma/client';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';

type ReviewDb = Pick<Prisma.TransactionClient, 'mergeReview' | 'auditEvent'>;

export async function openMergeReview(
  tx: ReviewDb,
  ctx: AuditCtx & { workspaceId: string },
  input: { sourceRecordId: string; candidateLeadIds: readonly string[]; simulated: boolean },
): Promise<string> {
  const review = await tx.mergeReview.create({
    data: {
      workspaceId: ctx.workspaceId,
      sourceRecordId: input.sourceRecordId,
      candidateLeadIds: [...input.candidateLeadIds],
      status: 'OPEN',
      createdAt: ctx.clock.now(),
    },
    select: { id: true },
  });
  await recordAudit(tx, ctx, {
    action: 'lead.merge_review.open',
    targetType: 'MergeReview',
    targetId: review.id,
    simulated: input.simulated,
    summary: { sourceRecordId: input.sourceRecordId, candidateLeadIds: [...input.candidateLeadIds], reasonCode: 'MULTIPLE_MATCHES' },
  });
  return review.id;
}
