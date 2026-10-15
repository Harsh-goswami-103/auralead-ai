/**
 * Message delivery projection (C10, plan §6.3, §6.4). `Message.status` is a projection of the
 * outbox and of provider status events; `statusRank` only ever grows for sent (1), delivered (2)
 * and read (3). This module holds the rank table, the projection of each DispatchAttempt outcome,
 * and the rank-guarded writes the dispatch settle uses. Status webhooks (T20) apply later ranks
 * with the same guard (`statusRank < incoming`), so a settle that lands after a faster webhook
 * never moves a message backwards.
 *
 * UI copy: AMBIGUOUS attempts and UNKNOWN messages read "Delivery unknown" (plan §5.1).
 */
import type { MessageStatus, Prisma } from '@/generated/prisma/client';

export const STATUS_RANK = { SENT: 1, DELIVERED: 2, READ: 3 } as const;

export const DELIVERY_UNKNOWN_LABEL = 'Delivery unknown';

type Tx = Prisma.TransactionClient;

/** Projection of a settled attempt outcome onto its Message (never lowers a higher rank). */
export async function projectSent(tx: Tx, ref: { workspaceId: string; messageId: string }, sent: { providerMessageId: string; simulated: boolean; providerTs: Date }): Promise<void> {
  await tx.message.updateMany({
    where: { id: ref.messageId, workspaceId: ref.workspaceId },
    data: { providerMessageId: sent.providerMessageId, simulated: sent.simulated, providerTs: sent.providerTs },
  });
  await tx.message.updateMany({
    where: { id: ref.messageId, workspaceId: ref.workspaceId, statusRank: { lt: STATUS_RANK.SENT } },
    data: { status: 'SENT', statusRank: STATUS_RANK.SENT },
  });
}

/** Terminal outcomes that leave nothing delivered: FAILED, NOT_SENT (skipped or cancelled) or UNKNOWN (ambiguous). */
export async function projectUnsent(tx: Tx, ref: { workspaceId: string; messageId: string }, status: Extract<MessageStatus, 'FAILED' | 'NOT_SENT' | 'UNKNOWN'>): Promise<void> {
  await tx.message.updateMany({
    where: { id: ref.messageId, workspaceId: ref.workspaceId, statusRank: { lt: STATUS_RANK.SENT } },
    data: { status },
  });
}

/** Many attempts at once (reaper, cancellations). */
export async function projectUnsentMany(tx: Tx, messageIds: readonly string[], status: Extract<MessageStatus, 'FAILED' | 'NOT_SENT' | 'UNKNOWN'>): Promise<void> {
  if (messageIds.length === 0) return;
  await tx.message.updateMany({ where: { id: { in: [...messageIds] }, statusRank: { lt: STATUS_RANK.SENT } }, data: { status } });
}

export function deliveryLabel(status: MessageStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'PENDING':
      return 'Queued';
    case 'SENT':
      return 'Sent';
    case 'DELIVERED':
      return 'Delivered';
    case 'READ':
      return 'Read';
    case 'FAILED':
      return 'Failed';
    case 'NOT_SENT':
      return 'Not sent';
    case 'UNKNOWN':
      return DELIVERY_UNKNOWN_LABEL;
  }
}
