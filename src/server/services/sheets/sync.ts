/**
 * "Sync now" for a Google Sheet (T34, ADR-104; PRD "sync status"). A person's request creates a
 * QUEUED SheetSyncRun (at most one open run per integration, a partial unique index) and one
 * `sheets.sync` job; the worker:
 *  1. marks the run RUNNING in a fenced write (lease check before anything else);
 *  2. reads the tab list and row 1 through the service account (no network inside a transaction);
 *  3. compares the header fingerprint with the active mapping's: any change BLOCKS the run with the
 *     column diff and reads no row, until a person re-confirms the mapping (drift);
 *  4. reads at most 200 rows after the last successful run's cursor, maps them exactly like an
 *     Apps Script push (`rowsFromValues` -> `sheetsToIngest`) and ingests them through
 *     `ingestBatch` (ImportBatch `sheets-sync:<runId>`). Each row's key is its `auralead_event_id`,
 *     the same key the script pushes, so a row arriving by both paths is one source record and never
 *     a second lead; rows of a Sheet without that column get a flagged weak content-hash id;
 *  5. settles the run (counts, cursor, the rows still waiting for their event id) with its audit.
 * Provider failures settle the run FAILED with the code and guidance (not retried: a person presses
 * Sync now again); ingestion follows ADR-54 (idempotent per batch and record, its own short
 * transactions after the fenced lease check).
 */
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { AppError, ConflictError, DomainRuleError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { SHEETS_SYNC_MAX_ROWS } from '@/lib/schemas/sheets';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { LeaseLostError } from '@/server/db/fence';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import type { JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { ingestBatch, type IngestBatchResult } from '@/server/services/leads/ingest';
import { sheetsToIngest } from '@/server/services/webhooks/payload-mapping';
import { redactText } from '@/lib/redact';
import { openSheets, readSheetHeader, readSheetRows, type SheetsDeps, type SheetsFailure } from './access';
import { columnDiff } from './header';
import { loadActiveMapping, mappedColumns } from './mapping';
import { rowsFromValues } from './rows';

export const SHEETS_SYNC_JOB = 'sheets.sync';
export const SHEETS_SYNC_PAYLOAD_VERSION = 1;
export const sheetsSyncPayloadSchema = z.object({ runId: z.string().min(1).max(64) });

type CursorDb = { sheetSyncRun: { findFirst(args: { where: { integrationId: string; status: 'SUCCEEDED' }; orderBy: Array<Record<string, 'desc'>>; select: { cursorRow: true } }): PromiseLike<{ cursorRow: number | null } | null> } };

/** The row up to which the Sheet has been synced (1 = only the header). */
export async function lastCursorRow(ctx: { db: unknown }, integrationId: string): Promise<number> {
  const last = await (ctx.db as CursorDb).sheetSyncRun.findFirst({ where: { integrationId, status: 'SUCCEEDED' }, orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }], select: { cursorRow: true } });
  return Math.max(1, last?.cursorRow ?? 1);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

export type SyncRequestResult = { runId: string; status: string; jobId: string | null; alreadyQueued: boolean };

export async function requestSheetsSync(ctx: AppCtx): Promise<SyncRequestResult> {
  requireCapability(ctx, 'sheets.manage');
  const workspaceId = requireWorkspace(ctx);
  if (ctx.mode !== 'live') throw new DomainRuleError({ code: 'SHEETS_LIVE_ONLY', userMessage: 'DEMO never contacts Google. Use the simulator on this page; syncing a real Sheet happens in a LIVE install.' });
  const integration = await ctx.db.integration.findFirst({ where: { kind: 'GOOGLE_SHEETS' }, select: { id: true, status: true } });
  if (!integration || ['NOT_CONFIGURED', 'REVOKED', 'SIMULATED'].includes(integration.status)) {
    throw new DomainRuleError({ code: 'INTEGRATION_NOT_CONFIGURED', userMessage: 'Save the service account key and spreadsheet ID in the Google Sheets setup first.' });
  }
  const mapping = await loadActiveMapping(ctx.db as never, integration.id);
  if (!mapping) throw new DomainRuleError({ code: 'MAPPING_NOT_CONFIRMED', userMessage: 'Confirm a column mapping before syncing.' });
  try {
    return await withTx(ctx.db, async (scoped) => {
      const tx = scoped as unknown as Prisma.TransactionClient;
      const open = await tx.sheetSyncRun.findFirst({ where: { workspaceId, integrationId: integration.id, status: { in: ['QUEUED', 'RUNNING'] } } });
      if (open) return { runId: open.id, status: open.status, jobId: open.jobId, alreadyQueued: true };
      const now = ctx.clock.now();
      const run = await tx.sheetSyncRun.create({ data: { workspaceId, integrationId: integration.id, status: 'QUEUED', mappingVersion: mapping.version, requestedBy: ctx.actor?.userId ?? 'system', correlationId: ctx.correlationId, createdAt: now } });
      const { job } = await enqueueJob(tx, ctx.clock, {
        type: SHEETS_SYNC_JOB,
        payload: { runId: run.id },
        payloadVersion: SHEETS_SYNC_PAYLOAD_VERSION,
        workspaceId,
        idempotencyKey: idempotencyKey(SHEETS_SYNC_JOB, run.id),
        correlationId: ctx.correlationId,
        kind: 'fetch',
      });
      await tx.sheetSyncRun.update({ where: { id: run.id }, data: { jobId: job.id } });
      await recordAudit(tx, ctx, { action: 'sheets.sync.request', targetType: 'SheetSyncRun', targetId: run.id, summary: { mappingVersion: mapping.version, jobId: job.id } });
      return { runId: run.id, status: 'QUEUED', jobId: job.id, alreadyQueued: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError({ code: 'SYNC_ALREADY_QUEUED', userMessage: 'A sync is already queued for this Sheet.' });
    throw error;
  }
}

export type SheetsSyncDeps = SheetsDeps & { mode: 'demo' | 'live'; contactKeyPepper: string };

type Settle = { status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED'; data: Prisma.SheetSyncRunUpdateManyMutationInput; audit: { result: 'SUCCESS' | 'FAILED'; summary: Record<string, unknown> } };

export async function runSheetsSync(job: JobHandlerContext, deps: SheetsSyncDeps): Promise<JobResult> {
  const parsed = sheetsSyncPayloadSchema.safeParse(job.job.payload);
  const workspaceId = job.job.workspaceId;
  if (!parsed.success || workspaceId === null) return { outcome: 'dead', reason: 'INVALID_PAYLOAD', errorCode: 'INVALID_PAYLOAD', error: 'sheets.sync payload is not { runId } on a workspace job' };
  const runId = parsed.data.runId;
  const run = await job.db.sheetSyncRun.findFirst({ where: { id: runId, workspaceId } });
  if (!run) return { outcome: 'dead', reason: 'RUN_NOT_FOUND', errorCode: 'RUN_NOT_FOUND', error: `no sheet sync run ${runId} in the job's workspace` };
  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') return { outcome: 'succeeded' };

  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  await job.fencedTx((tx) => tx.sheetSyncRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: job.clock.now() } }));

  const settle = (s: Settle): JobResult => ({
    outcome: 'succeeded',
    finalTx: async (tx: TxClient) => {
      const updated = await tx.sheetSyncRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { ...s.data, status: s.status, finishedAt: job.clock.now() } });
      if (updated.count !== 1) return;
      await recordAudit(tx, ctx, { action: `sheets.sync.${s.status === 'SUCCEEDED' ? 'run' : s.status.toLowerCase()}`, targetType: 'SheetSyncRun', targetId: runId, result: s.audit.result, summary: { jobId: job.job.id, ...s.audit.summary } });
    },
  });
  const failed = (f: SheetsFailure): JobResult => settle({ status: 'FAILED', data: { errorCode: f.code, errorRedacted: redactText(f.message).slice(0, 500) }, audit: { result: 'FAILED', summary: { errorCode: f.code } } });

  const opened = await openSheets(ctx, deps);
  if (!opened.ok) return failed(opened.failure);
  const header = await readSheetHeader(opened.value);
  if (job.signal.aborted) throw new LeaseLostError(job.job.id);
  if (!header.ok) return failed(header.failure);
  const mapping = await loadActiveMapping(job.db as never, opened.value.integration.id);
  if (!mapping) return failed({ code: 'INTEGRATION_NOT_CONFIGURED', message: 'No column mapping is confirmed for this Sheet.', transient: false });
  if (mapping.headerFingerprint !== header.value.header.fingerprint) {
    const diff = columnDiff(mapping.headerColumns ?? [], header.value.header.names);
    return settle({
      status: 'BLOCKED',
      data: { mappingVersion: mapping.version, detail: { added: diff.added, removed: diff.removed }, errorCode: 'HEADER_DRIFT', errorRedacted: 'The Sheet’s columns changed since the mapping was confirmed. Re-confirm the mapping to sync again.' },
      audit: { result: 'FAILED', summary: { errorCode: 'HEADER_DRIFT', mappingVersion: mapping.version, added: diff.added.length, removed: diff.removed.length } },
    });
  }

  const cursor = await lastCursorRow({ db: job.db }, opened.value.integration.id);
  const fromRow = cursor + 1;
  const values = await readSheetRows(opened.value, header.value.tab, fromRow, fromRow + SHEETS_SYNC_MAX_ROWS - 1);
  if (job.signal.aborted) throw new LeaseLostError(job.job.id);
  if (!values.ok) return failed(values.failure);
  const rows = rowsFromValues(header.value.header, values.value, { firstRowNumber: fromRow, submittedAtColumn: mapping.submittedAtColumn, timeZone: header.value.timeZone, columns: new Set(mappedColumns(mapping)) });
  const cursorRow = values.value.length === 0 ? cursor : rows.cursorRow;
  const skipped = rows.emptyRows.length + rows.pendingRows.length;
  const weakIdRows = rows.records.filter((r) => r.weakId).length;
  const base = { mappingVersion: mapping.version, fromRow, cursorRow, rowsRead: values.value.length, skipped, weakIdRows, detail: { pendingRows: rows.pendingRows.slice(0, 50) } };

  if (rows.records.length === 0) {
    return settle({ status: 'SUCCEEDED', data: base, audit: { result: 'SUCCESS', summary: { rowsRead: base.rowsRead, created: 0, skipped, cursorRow } } });
  }

  let ingested: IngestBatchResult;
  try {
    ingested = await ingestBatch(
      ctx,
      sheetsToIngest(
        { version: 1, eventId: runId, sheetId: opened.value.client.spreadsheetId, mappingVersion: mapping.version, rows: rows.records.map((r) => ({ rowKey: r.rowKey, ...(r.weakId ? { weakId: true } : {}), ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}), values: r.values })) },
        { version: mapping.version, fieldMap: mapping.fieldMap, consentMapping: mapping.consent },
        { externalBatchId: `sheets-sync:${runId}`, simulated: false },
      ),
      { contactKeyPepper: deps.contactKeyPepper },
    );
  } catch (error) {
    if (error instanceof AppError && error.retryable) throw error;
    if (error instanceof AppError && error.status < 500) return failed({ code: error.code as SheetsFailure['code'], message: error.userMessage, transient: false });
    throw error;
  }
  const c = ingested.counts;
  return settle({
    status: 'SUCCEEDED',
    data: { ...base, created: c.accepted, duplicate: c.duplicate, review: c.review, rejected: c.rejected, importBatchId: ingested.batchId },
    audit: { result: 'SUCCESS', summary: { rowsRead: base.rowsRead, created: c.accepted, duplicate: c.duplicate, review: c.review, rejected: c.rejected, skipped, weakIdRows, cursorRow, importBatchId: ingested.batchId } },
  });
}
