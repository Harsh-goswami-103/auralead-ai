/**
 * `status.apply` (T20, C10, R28): applies one delivery status event (WhatsApp or email) through
 * the rank merge in `services/messaging/inbound.ts`. Payload v1 `{ webhookEventId }`, workspace
 * job, idempotency key `status.apply:<eventId>`, 6 attempts: an unknown provider message id is
 * retried 5 times about 2 minutes apart (PENDING_CORRELATION), then the event is ORPHAN.
 */
import { INBOUND_PAYLOAD_VERSION, processStatusEvent, STATUS_APPLY_JOB, type InboundDeps } from '@/server/services/messaging/inbound';
import type { JobDefinition } from '../types';
import { inboundDepsFromConfig } from './webhook-process';

export function createStatusApplyJob(options: { deps?: () => InboundDeps } = {}): JobDefinition {
  const deps = options.deps ?? inboundDepsFromConfig;
  return {
    type: STATUS_APPLY_JOB,
    kind: 'default',
    payloadVersions: [INBOUND_PAYLOAD_VERSION],
    handler: (ctx) => processStatusEvent(ctx, deps()),
  };
}

export const statusApplyJob = createStatusApplyJob();
