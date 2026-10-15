/**
 * `webhook.process` (T20): processes one inbound WhatsApp message event through
 * `services/messaging/inbound.ts` (lead match or creation, inbound Message, window, consent,
 * START, quick replies). Payload v1 `{ webhookEventId }`, workspace job, idempotency key
 * `webhook.process:<eventId>`. Stops were already applied by the route (C9).
 *
 * Production deps come from the boot config on first use: CREDENTIALS_KEYRING (the processing
 * payload is encrypted, E1) and SUPPRESSION_PEPPER; missing either fails loudly instead of
 * processing without them.
 */
import { getConfig } from '@/lib/config';
import { requireKeyRing } from '@/server/security/secrets';
import { INBOUND_PAYLOAD_VERSION, processWhatsAppInbound, WEBHOOK_PROCESS_JOB, type InboundDeps } from '@/server/services/messaging/inbound';
import type { JobDefinition } from '../types';

export function inboundDepsFromConfig(): InboundDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { keyRing: requireKeyRing(config), contactKeyPepper: pepper, mode: config.mode };
}

export function createWebhookProcessJob(options: { deps?: () => InboundDeps } = {}): JobDefinition {
  const deps = options.deps ?? inboundDepsFromConfig;
  return {
    type: WEBHOOK_PROCESS_JOB,
    kind: 'default',
    payloadVersions: [INBOUND_PAYLOAD_VERSION],
    handler: (ctx) => processWhatsAppInbound(ctx, deps()),
  };
}

export const webhookProcessJob = createWebhookProcessJob();
