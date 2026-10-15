/**
 * `ingest.process` (T11, E1): processes one persisted lead-source WebhookEvent through
 * `services/webhooks/process-ingest.ts` (decrypt the processing payload, map, `ingestBatch`).
 *
 * `createIngestProcessJob` takes the key ring, contact-key pepper and mode as a dependency source
 * so tests can inject one config; production reads them from the boot config on first use, which
 * fails loudly (and the job is retried, then DEAD) when CREDENTIALS_KEYRING or SUPPRESSION_PEPPER
 * is missing instead of processing without them.
 */
import { getConfig } from '@/lib/config';
import { requireKeyRing } from '@/server/security/secrets';
import { INGEST_PROCESS_JOB, WEBHOOK_JOB_PAYLOAD_VERSION } from '@/server/services/webhooks/events';
import { processIngestEvent, type IngestProcessDeps } from '@/server/services/webhooks/process-ingest';
import type { JobDefinition } from '../types';

export type { IngestProcessDeps } from '@/server/services/webhooks/process-ingest';

export function ingestProcessDepsFromConfig(): IngestProcessDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`); ingestion cannot compute consent contact keys.');
  return { keyRing: requireKeyRing(config), contactKeyPepper: pepper, mode: config.mode };
}

export function createIngestProcessJob(options: { deps?: () => IngestProcessDeps } = {}): JobDefinition {
  const deps = options.deps ?? ingestProcessDepsFromConfig;
  return {
    type: INGEST_PROCESS_JOB,
    kind: 'default',
    payloadVersions: [WEBHOOK_JOB_PAYLOAD_VERSION],
    handler: (ctx) => processIngestEvent(ctx, deps()),
  };
}

export const ingestProcessJob = createIngestProcessJob();
