/**
 * `leads.export` and `leads.exportPurge` (T26, ADR-70). Payload v1 `{ exportId }`, workspace jobs.
 *
 * - `leads.export` reads the export's filters and format, builds the CSV or Excel file (ADR-120)
 *   with the unscoped job client (the workspace bound explicitly), writes the file outside any transaction (local disk, no provider
 *   call), then in the fenced settle marks the export READY, schedules the purge at its expiry and
 *   audits it. A write failure is retried with backoff; on the last attempt the export is marked
 *   FAILED so the panel stops waiting. A replay of a finished export does nothing. When the settle
 *   finds the export no longer QUEUED (`lead:erase` cancelled it while it was built, ADR-73), it
 *   deletes the file it wrote instead of marking it READY.
 * - `leads.exportPurge` runs at the expiry (`runAt = expiresAt`): it deletes the file and marks the
 *   export EXPIRED. Run early (a clock change), it defers to the expiry. A file that cannot be
 *   deleted is retried with backoff (redacted error code only); after the last attempt the export is
 *   marked EXPIRED with PURGE_FAILED and the job is DEAD, logging that the file remains, so a retry
 *   from Platform admin > Jobs can delete it later (ADR-73).
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { redactText } from '@/lib/redact';
import { LEAD_EXPORT_ROW_CAP } from '@/lib/schemas/leads';
import {
  buildLeadExportFile,
  completeLeadExport,
  deleteExportFile,
  expireLeadExport,
  exportFiltersOf,
  exportFormatOf,
  exportNeedsPurge,
  failLeadExport,
  LEAD_EXPORT_JOB,
  LEAD_EXPORT_PURGE_JOB,
  leadExportRelPath,
  PURGE_FAILED,
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
      const format = exportFormatOf(row.format);
      if (format === null) {
        return { outcome: 'succeeded', finalTx: (tx) => failLeadExport(tx, ctx, { exportId: row.id, workspaceId, errorCode: 'EXPORT_FORMAT_INVALID' }) };
      }

      let file: { path: string; sha256: string; bytes: number };
      let rowCount: number;
      let truncated: boolean;
      try {
        const built = await buildLeadExportFile(job.db, workspaceId, filters, format, rowCap);
        rowCount = built.rowCount;
        truncated = built.truncated;
        file = writeExportFile(storageDir(), leadExportRelPath(workspaceId, row.id, format), built.bytes);
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
          const ready = await completeLeadExport(tx, ctx, { exportId: row.id, workspaceId, file, rowCount, truncated, jobId: job.job.id });
          if (ready) return;
          // Cancelled while it was built (lead:erase): the file may hold an erased person's row.
          try {
            deleteExportFile(storageDir(), file.path);
          } catch (error) {
            job.logger.error({ exportId: row.id, workspaceId, path: file.path, errorCode: fsErrorCode(error) }, 'the file of a cancelled lead export could not be deleted; it remains on disk');
          }
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
      if (!row || !exportNeedsPurge(row)) return { outcome: 'succeeded' };
      if (row.status === 'READY' && row.expiresAt !== null && job.clock.now().getTime() < row.expiresAt.getTime()) {
        return { outcome: 'deferred', runAt: row.expiresAt, reason: 'EXPORT_NOT_EXPIRED' };
      }
      const ctx = jobCtx(job, workspaceId, mode());
      if (row.path) {
        try {
          deleteExportFile(storageDir(), row.path);
        } catch (error) {
          // The fs message names the absolute path; only its code is stored.
          const message = redactText(`the export file could not be deleted (${fsErrorCode(error)})`);
          if (job.job.attempts < job.job.maxAttempts) return { outcome: 'retry', errorCode: 'EXPORT_PURGE_FAILED', error: message };
          job.logger.error({ exportId: row.id, workspaceId, path: row.path, errorCode: fsErrorCode(error) }, 'lead export purge gave up: the file could not be deleted and remains on disk');
          return {
            outcome: 'dead',
            reason: PURGE_FAILED,
            errorCode: PURGE_FAILED,
            error: message,
            finalTx: (tx) => expireLeadExport(tx, ctx, { exportId: row.id, workspaceId, purgeFailed: true }),
          };
        }
      }
      return { outcome: 'succeeded', finalTx: (tx) => expireLeadExport(tx, ctx, { exportId: row.id, workspaceId }) };
    },
  };
}

function fsErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

export const leadExportJob = createLeadExportJob();
export const leadExportPurgeJob = createLeadExportPurgeJob();
