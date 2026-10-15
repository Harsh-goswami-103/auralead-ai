/**
 * `webhook.purge` (E1/ADR-35): nulls `WebhookEvent.processingPayload` (the encrypted full body) and
 * sets `processingPurgedAt` once the retention window has passed: processedAt + 7 days for a
 * processed event, receivedAt + 30 days for anything else (failed, unrouted, never processed).
 * The redacted inspector view and the stored per-record result are kept.
 *
 * Scheduled once per event (idempotency key `webhook.purge:<eventId>`) by processing or by an
 * unrouted receipt. A run before the due time defers to it (attempt refunded) and never purges
 * early; a run after the payload is already gone is a no-op.
 */
import type { JobHandlerContext, JobResult } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { purgeDueAt } from './events';
import { webhookJobPayloadSchema } from './process-ingest';

export async function purgeWebhookPayload(job: JobHandlerContext): Promise<JobResult> {
  const payload = webhookJobPayloadSchema.safeParse(job.job.payload);
  if (!payload.success) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'webhook.purge payload is not { webhookEventId }' };
  const eventId = payload.data.webhookEventId;

  const event = await job.db.webhookEvent.findFirst({ where: { id: eventId, workspaceId: job.job.workspaceId } });
  if (!event || event.processingPayload === null) return { outcome: 'succeeded' };

  const due = purgeDueAt(event);
  if (job.clock.now().getTime() < due.getTime()) return { outcome: 'deferred', runAt: due, reason: 'RETENTION_WINDOW' };

  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const now = job.clock.now();
      const updated = await tx.webhookEvent.updateMany({
        where: { id: eventId, processingPayload: { not: null } },
        data: { processingPayload: null, processingPurgedAt: now },
      });
      if (updated.count !== 1) return;
      await recordAudit(
        tx,
        { kind: 'job', actor: null, workspaceId: event.workspaceId, correlationId: job.correlationId, clock: job.clock },
        {
          action: 'webhook.purge',
          targetType: 'WebhookEvent',
          targetId: eventId,
          simulated: event.simulated,
          summary: { provider: event.provider, status: event.status, retentionDays: Math.round((due.getTime() - (event.processedAt ?? event.receivedAt).getTime()) / 86_400_000) },
        },
      );
    },
  };
}
