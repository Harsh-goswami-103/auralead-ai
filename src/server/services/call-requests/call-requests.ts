/**
 * Call requests (P4, R45). A customer's CALL quick reply (`AL_QR_CALL_V1`) records one
 * `CallRequest(source = QUICK_REPLY, status = OPEN)` for the lead and conversation. The row carries
 * the inbound WebhookEvent id in `sourceEventId` (UNIQUE), so a replayed delivery or a re-run of
 * the processing job creates no second request. People work the request from the inbox (T22).
 */
import type { Prisma } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';
import { recordAudit } from '@/server/services/audit/record';

export type QuickReplyCallInput = { leadId: string; conversationId: string | null; sourceEventId: string; requestedAt: Date; simulated: boolean };

export async function recordQuickReplyCallRequest(tx: ScopedTx, ctx: AppCtx, input: QuickReplyCallInput): Promise<{ callRequestId: string; created: boolean }> {
  const workspaceId = requireWorkspace(ctx);
  const existing = await tx.callRequest.findFirst({ where: { sourceEventId: input.sourceEventId }, select: { id: true } });
  if (existing) return { callRequestId: existing.id, created: false };
  const row = await tx.callRequest.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      source: 'QUICK_REPLY',
      status: 'OPEN',
      requestedAt: input.requestedAt,
      sourceEventId: input.sourceEventId,
    },
    select: { id: true },
  });
  await recordAudit(tx as unknown as Prisma.TransactionClient, ctx, {
    action: 'call_request.create',
    targetType: 'CallRequest',
    targetId: row.id,
    simulated: input.simulated,
    summary: { leadId: input.leadId, source: 'QUICK_REPLY' },
  });
  return { callRequestId: row.id, created: true };
}
