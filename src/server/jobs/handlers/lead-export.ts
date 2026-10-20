/**
 * `leads.export` and `leads.exportPurge` (T26, ADR-70). Payload v1 `{ exportId }`, workspace jobs.
 *
 * - `leads.export` reads the export's filters, builds the CSV with the unscoped job client (the
 *   workspace bound explicitly), writes the file outside any transaction (local disk, no provider
 *   call), then in the fenced settle marks the export READY, schedules the purge at its expiry and
 *   audits it. A write failure is retried with backoff; on the last attempt the export is marked
 *   FAILED so the panel stops waiting. A replay of a finished export does nothing.
 * - `leads.exportPurge` runs at the expiry (`runAt = expiresAt`): it deletes the file and marks the
 *   export EXPIRED. Run early (a clock change), it defers to the expiry.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { redactText } from '@/lib/redact';
import { LEAD_EXPORT_ROW_CAP } from '@/lib/schemas/leads';
import {
  buildLeadExportCsv,
  completeLeadExport,
  deleteExportFile,
  expireLeadExport,
  exportFiltersOf,
  failLeadExport,
  LEAD_EXPORT_JOB,
  LEAD_EXPORT_PURGE_JOB,
  leadExportRelPath,
  writeExportFile,
} from '@/server/services/leads/export';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, parseWorkspacePayload } from './lead-job-support';

export { LEAD_EXPORT_JOB, LEAD_EXPORT_PURGE_JOB };

const payloadSchema = z.object({ exportId: z.string().min(1).max(64) });

type Options = { mode?: () => 'demo' | 'live'; storageDir?: () => string; rowCap?: number };

export function createLeadExportJob(options: Options = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const storageDir = options.storageDir ?? (() => getConfig().paths.storageDir);
  const rowCap = options.rowCap ?? LEAD_EXPORT_ROW_CAP;
  return {
    type: LEAD_EXPORT_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const row = await job.db.leadExport.findFirst({ where: { id: payload.exportId, workspaceId } });
      if (!row) return deadResult('EXPORT_NOT_FOUND', `no lead export ${payload.exportId} in the job's workspace`);
      if (row.status !== 'QUEUED') return { outcome: 'succeeded' };
      const ctx = jobCtx(job, workspaceId, mode());
      const filters = exportFiltersOf(row);
      if (filters === null) {
        return { outcome: 'succeeded', finalTx: (tx) => failLeadExport(tx, ctx, { exportId: row.id, workspaceId, errorCode: 'EXPORT_FILTERS_INVALID' }) };
      }

      let file: { path: string; sha256: string; bytes: number };
      let rowCount: number;
      let truncated: boolean;
      try {
        const built = await buildLeadExportCsv(job.db, workspaceId, filters, rowCap);
        rowCount = built.rowCount;
        truncated = built.truncated;
        file = writeExportFile(storageDir(), leadExportRelPath(workspaceId, row.id), Buffer.from(built.csv, 'utf8'));
      } catch (error) {
        const message = redactText(error instanceof Error ? error.message : String(error));
        if (job.job.attempts < job.job.maxAttempts) return { outcome: 'retry', errorCode: 'EXPORT_WRITE_FAILED', error: message };
        return {
          outcome: 'dead',
          reason: 'EXPORT_WRITE_FAILED',
          errorCode: 'EXPORT_WRITE_FAILED',
          error: message,
          finalTx: (tx) => failLeadExport(tx, ctx, { exportId: row.id, workspaceId, errorCode: 'EXPORT_WRITE_FAILED' }),
        };
      }
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await completeLeadExport(tx, ctx, { exportId: row.id, workspaceId, file, rowCount, truncated, jobId: job.job.id });
        },
      };
    },
  };
}

export function createLeadExportPurgeJob(options: Omit<Options, 'rowCap'> = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const storageDir = options.storageDir ?? (() => getConfig().paths.storageDir);
  return {
    type: LEAD_EXPORT_PURGE_JOB,
    kind: 'default',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const row = await job.db.leadExport.findFirst({ where: { id: payload.exportId, workspaceId } });
      if (!row || row.status !== 'READY') return { outcome: 'succeeded' };
      if (row.expiresAt !== null && job.clock.now().getTime() < row.expiresAt.getTime()) {
        return { outcome: 'deferred', runAt: row.expiresAt, reason: 'EXPORT_NOT_EXPIRED' };
      }
      if (row.path) deleteExportFile(storageDir(), row.path);
      const ctx = jobCtx(job, workspaceId, mode());
      return { outcome: 'succeeded', finalTx: (tx) => expireLeadExport(tx, ctx, { exportId: row.id, workspaceId }) };
    },
  };
}

export const leadExportJob = createLeadExportJob();
export const leadExportPurgeJob = createLeadExportPurgeJob();
