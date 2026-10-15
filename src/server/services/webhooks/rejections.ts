/**
 * Rejected webhook deliveries (plan §9 Webhooks): a bad or missing signature, an unconfigured
 * secret or an unreadable body is never persisted; only a daily counter per (provider, workspace,
 * reason) is incremented, written on rejection only. Rejections before routing have no workspace
 * and use the unrouted partial unique (ADR-47).
 */
import type { PrismaClient, WebhookProvider } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { withTx } from '@/server/db/tx';

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export async function recordWebhookRejection(db: PrismaClient, clock: Clock, input: { provider: WebhookProvider; reason: string; workspaceId?: string | null }): Promise<void> {
  const day = utcDay(clock.now());
  const workspaceId = input.workspaceId ?? null;
  await withTx(db, async (tx) => {
    const updated = await tx.webhookRejection.updateMany({ where: { provider: input.provider, workspaceId, reason: input.reason, day }, data: { count: { increment: 1 } } });
    if (updated.count === 0) await tx.webhookRejection.create({ data: { provider: input.provider, workspaceId, reason: input.reason, day, count: 1 } });
  });
}
