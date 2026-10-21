/**
 * `sheets.sync` (T34, ADR-104): one "Sync now" run of a Google Sheet, read through the service
 * account and ingested through `ingestBatch` (services/sheets/sync.ts). LIVE only: a DEMO process
 * settles the run FAILED with SHEETS_LIVE_ONLY and contacts nobody. Payload v1 `{ runId }`.
 */
import { getConfig } from '@/lib/config';
import { SHEETS_SYNC_JOB, SHEETS_SYNC_PAYLOAD_VERSION, runSheetsSync, type SheetsSyncDeps } from '@/server/services/sheets/sync';
import type { JobDefinition } from '../types';

export function sheetsSyncDepsFromConfig(): SheetsSyncDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`); ingestion cannot compute consent contact keys.');
  return { keyRing: config.secrets.credentials, mode: config.mode, contactKeyPepper: pepper };
}

export function createSheetsSyncJob(options: { deps?: () => SheetsSyncDeps } = {}): JobDefinition {
  const deps = options.deps ?? sheetsSyncDepsFromConfig;
  return {
    type: SHEETS_SYNC_JOB,
    kind: 'fetch',
    payloadVersions: [SHEETS_SYNC_PAYLOAD_VERSION],
    handler: (job) => runSheetsSync(job, deps()),
  };
}

export const sheetsSyncJob = createSheetsSyncJob();
