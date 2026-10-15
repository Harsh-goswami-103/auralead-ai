/**
 * DELIVERY stage (T23; E4, E9, O5, ADR-43, ADR-45). Acts on the APPROVAL stage's recorded decision
 * for the same execution:
 *
 * - `POLICY_APPROVED`: queues the first-touch send through the dispatch outbox
 *   (`queueOutboundMessage`) with sendIntent AUTOMATED and initiatedBy `system:pipeline.advance`
 *   (POLICY_AUTO_INITIATOR), so the dispatch preflight can still skip it with AUTO_SEND_DISABLED if
 *   auto-send is turned off or the policy origin no longer holds (E4). The dedupe key
 *   `pipeline:<executionId>:DELIVERY` makes one dispatch per execution, whatever replays.
 * - `HUMAN_REVIEW`: SKIPPED `AWAITING_HUMAN_APPROVAL`. The drafted message waits in the approval
 *   queue; a person's approve-and-send dispatches it (MANUAL_SINGLE). Nothing is sent here.
 * - APPROVAL not DONE (no draft, nothing sendable): SKIPPED `NOTHING_APPROVED`.
 *
 * Eligibility is not decided here: the dispatch preflight runs the shared function at send time.
 * The write happens in `finalTx`, inside the job's fenced settle, with the stage run's ids.
 */
import type { Prisma } from '@/generated/prisma/client';
import { queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { POLICY_AUTO_INITIATOR } from '@/server/services/messaging/eligibility';
import { draftTemplate, firstTouchFor, pipelineStageDepsFromConfig, scopeTransaction, type PipelineStageDeps } from './approval';
import type { StageHandler } from './types';

type ApprovalRef = { decision?: unknown; channel?: unknown; draftId?: unknown; approvalId?: unknown; messageId?: unknown };

function approvalRef(value: Prisma.JsonValue | null): ApprovalRef {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ApprovalRef) : {};
}

export function deliveryDedupeKey(executionId: string): string {
  return `pipeline:${executionId}:DELIVERY`;
}

export function createDeliveryStage(deps: () => PipelineStageDeps = pipelineStageDepsFromConfig): StageHandler {
  return {
    stage: 'DELIVERY',
    async run({ ctx, execution, lead }) {
      const approval = await ctx.db.pipelineStageRun.findFirst({ where: { executionId: execution.id, stage: 'APPROVAL' } });
      if (!approval || approval.status !== 'DONE') {
        return { status: 'SKIPPED', reasonCode: 'NOTHING_APPROVED', outputRef: { approvalStatus: approval?.status ?? null, approvalReason: approval?.reasonCode ?? null } };
      }
      const ref = approvalRef(approval.outputRef);
      if (ref.decision === 'HUMAN_REVIEW') {
        return { status: 'SKIPPED', reasonCode: 'AWAITING_HUMAN_APPROVAL', outputRef: { approvalId: ref.approvalId ?? null, messageId: ref.messageId ?? null } };
      }
      if (ref.decision !== 'POLICY_APPROVED' || (ref.channel !== 'WHATSAPP' && ref.channel !== 'EMAIL') || typeof ref.draftId !== 'string') {
        return { status: 'FAILED', reasonCode: 'APPROVAL_DECISION_INVALID' };
      }
      const channel = ref.channel;
      const draft = await ctx.db.aiDraft.findFirst({ where: { id: ref.draftId, executionId: execution.id } });
      if (!draft) return { status: 'FAILED', reasonCode: 'DRAFT_MISSING' };
      const found = firstTouchFor(channel, draft, lead, await draftTemplate(ctx, draft));
      if (!found.ok) return { status: 'FAILED', reasonCode: 'FIRST_TOUCH_UNAVAILABLE', outputRef: { channel, missing: found.missing } };
      const touch = found.touch;
      const { contactKeyPepper } = deps();

      return {
        status: 'DONE',
        outputRef: { decision: 'POLICY_APPROVED', channel },
        finalTx: async (raw) => {
          const tx = scopeTransaction(raw, execution.workspaceId);
          const queued = await queueOutboundMessage(
            tx,
            ctx,
            {
              leadId: lead.id,
              channel,
              kind: touch.kind,
              body: touch.body,
              subject: touch.subject,
              templateId: touch.templateId,
              variables: touch.variables,
              generatorLabel: draft.generatorLabel,
              sendIntent: 'AUTOMATED',
              initiatedBy: POLICY_AUTO_INITIATOR,
              dedupeKey: deliveryDedupeKey(execution.id),
            },
            { contactKeyPepper },
          );
          await tx.pipelineStageRun.update({
            where: { executionId_stage: { executionId: execution.id, stage: 'DELIVERY' } },
            data: { outputRef: { decision: 'POLICY_APPROVED', channel, messageId: queued.messageId, attemptId: queued.attemptId, jobId: queued.jobId, conversationId: queued.conversationId } },
          });
        },
      };
    },
  };
}

export const deliveryStage = createDeliveryStage();
