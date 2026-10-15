/**
 * `webhook.purge` (T11, E1/ADR-35): nulls a WebhookEvent's encrypted processing payload once its
 * retention window has passed (`services/webhooks/purge.ts`). Scheduled per event by processing
 * (processedAt + 7 days) or by an unrouted or failed receipt (receivedAt + 30 days).
 */
import { WEBHOOK_JOB_PAYLOAD_VERSION, WEBHOOK_PURGE_JOB } from '@/server/services/webhooks/events';
import { purgeWebhookPayload } from '@/server/services/webhooks/purge';
import type { JobDefinition } from '../types';

export function createWebhookPurgeJob(): JobDefinition {
  return {
    type: WEBHOOK_PURGE_JOB,
    kind: 'default',
    payloadVersions: [WEBHOOK_JOB_PAYLOAD_VERSION],
    handler: (ctx) => purgeWebhookPayload(ctx),
  };
}

export const webhookPurgeJob = createWebhookPurgeJob();
