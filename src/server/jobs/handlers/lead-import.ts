/**
 * `leads.import` and `leads.importPurge` (ADR-120, slice F2). Payloads `{importId, chunk}` and
 * `{importId}`, workspace jobs; the work is in `services/leads/import-run.ts`.
 *
 * The factories take the storage directory, contact-key pepper and mode as dependency sources so
 * tests can inject them; production reads them from the boot config on first use, which fails
 * loudly (the job is retried, then DEAD) when SUPPRESSION_PEPPER is missing instead of importing
 * without consent keys.
 */
import { getConfig } from '@/lib/config';
import { LEAD_IMPORT_JOB, LEAD_IMPORT_PURGE_JOB } from '@/server/services/leads/import';
import { runLeadImportChunk, runLeadImportPurge, type ImportRunDeps } from '@/server/services/leads/import-run';
import type { JobDefinition } from '../types';

export { LEAD_IMPORT_JOB, LEAD_IMPORT_PURGE_JOB };

export function leadImportDepsFromConfig(): ImportRunDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`); imports cannot compute consent contact keys.');
  return { storageDir: config.paths.storageDir, contactKeyPepper: pepper, mode: config.mode };
}

export function createLeadImportJob(options: { deps?: () => ImportRunDeps } = {}): JobDefinition {
  const deps = options.deps ?? leadImportDepsFromConfig;
  return {
    type: LEAD_IMPORT_JOB,
    kind: 'default',
    payloadVersions: [1],
    handler: (job) => runLeadImportChunk(job, deps()),
  };
}

export function createLeadImportPurgeJob(options: { deps?: () => Pick<ImportRunDeps, 'storageDir' | 'mode'> } = {}): JobDefinition {
  const deps = options.deps ?? (() => ({ storageDir: getConfig().paths.storageDir, mode: getConfig().mode }));
  return {
    type: LEAD_IMPORT_PURGE_JOB,
    kind: 'default',
    payloadVersions: [1],
    handler: (job) => runLeadImportPurge(job, deps()),
  };
}

export const leadImportJob = createLeadImportJob();
export const leadImportPurgeJob = createLeadImportPurgeJob();
