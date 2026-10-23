/**
 * Lead import jobs (ADR-120, slice F2), the worker side.
 *
 * `leads.import` (payload `{importId, chunk}`): one job per chunk of 200 data rows.
 *  1. A QUEUED import becomes RUNNING in a fenced write (the lease check before any work).
 *  2. The rows file is read and the chunk's rows are mapped onto `IngestBatchInput` (source
 *     FILE_IMPORT, `externalBatchId` `import:<id>:<chunk>`, `externalId` `import:<id>:row:<n>`), so
 *     dedupe, merge review, scoring and pipeline pinning are those of every other source. A cell
 *     longer than the ingestion contract allows rejects its row FIELD_TOO_LONG before ingestion.
 *  3. Right before ingesting, the import is re-read: `lead:erase` may have ended it (FAILED,
 *     `storagePath` cleared, file deleted), and then nothing is ingested.
 *  4. The fenced settle adds the chunk's counts and row notes (row number, code, field; never a
 *     value) to the import, only while it is still RUNNING with its file and only once per chunk,
 *     then either enqueues the next chunk or, after the last one, marks it SUCCEEDED, clears
 *     `storagePath`, audits `lead.import.complete` and deletes the rows file.
 * A failure that cannot be retried (rows file missing, a stored mapping that no longer parses,
 * ingestion refusing the batch, the last attempt of a write) marks the import FAILED, audits
 * `lead.import.failed` with the code and deletes the file.
 *
 * `leads.importPurge` (payload `{importId}`, scheduled at `expiresAt` by the upload): deletes the
 * rows file; a PREVIEW import becomes EXPIRED. A QUEUED or RUNNING import is left to finish while
 * one of its chunk jobs is still queued or running (the purge looks again an hour later); with none
 * left (a chunk job died without its settle) it is marked FAILED `IMPORT_STALLED`, audited, and its
 * file deleted. A finished one only loses a leftover file.
 */
import { z } from 'zod';
import type { LeadImport } from '@/generated/prisma/client';
import { redactText } from '@/lib/redact';
import type { IngestBatchInput, IngestRecord } from '@/lib/schemas/ingest';
import {
  fileImportExternalId,
  IMPORT_CONSENT_TRUTHY_VALUES,
  IMPORT_FIELD_MAX_LENGTH,
  IMPORT_LEAD_FIELDS,
  LEAD_IMPORT_CHUNK,
  LEAD_IMPORT_MAX_ROWS,
  mappingOf,
  parseConsentDate,
  parseFileImportExternalId,
  type ImportField,
  type ImportMappingValue,
  type ImportRowNote,
} from '@/lib/schemas/lead-import';
import { AppError } from '@/lib/errors';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { enqueueJob } from '@/server/jobs/queue';
import type { JobHandlerContext, JobResult, TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { isTruthyAnswer } from '@/server/services/messaging/consent';
import { deleteImportRows, leadImportRelPath, readImportRows, type ImportRowsFile } from './import-files';
import { importNotesOf, LEAD_IMPORT_JOB, LEAD_IMPORT_PRIORITY } from './import';
import { ingestBatch, type IngestBatchResult } from './ingest';

export type ImportRunDeps = { storageDir: string; contactKeyPepper: string; mode: 'demo' | 'live' };

export const leadImportPayloadSchema = z.object({ importId: z.string().min(1).max(64), chunk: z.number().int().min(0).max(Math.ceil(LEAD_IMPORT_MAX_ROWS / LEAD_IMPORT_CHUNK)) });
export const leadImportPurgePayloadSchema = z.object({ importId: z.string().min(1).max(64) });

const HOUR = 3_600_000;

function dead(reason: string, error: string): JobResult {
  return { outcome: 'dead', reason, errorCode: reason, error };
}

function fsErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

// ---- Mapping rows onto the ingestion contract --------------------------------------------------

export type ChunkCounts = { accepted: number; duplicates: number; review: number; rejected: number; consentRecorded: number };

export type BuiltChunk = {
  records: IngestRecord[];
  /** Rows refused before ingestion (counted rejected) and opted-in rows whose date cannot be used. */
  notes: ImportRowNote[];
  rejectedBeforeIngest: number;
  /** External ids of the records that carry an opt-in answer and its date. */
  consentAsked: Set<string>;
};

/** An attested import's consent columns (ADR-120): the opt-in cell, its date, in the workspace's zone. */
export type ChunkConsent = { consentCol: number; dateCol: number; timeZone: string; now: Date };

/**
 * The chunk's rows as ingestion records; cells are trimmed, empty cells are null, over-long cells
 * reject the row. With `consent` (an attested import), a row marked as opted in carries its answer
 * and its date as the evidence time; a missing, unreadable or future date gives no consent and a
 * note instead.
 */
export function buildImportChunk(input: { importId: string; file: ImportRowsFile; mapping: ImportMappingValue; chunk: number; consent?: ChunkConsent | null }): BuiltChunk {
  const start = input.chunk * LEAD_IMPORT_CHUNK;
  const rows = input.file.rows.slice(start, start + LEAD_IMPORT_CHUNK);
  const records: IngestRecord[] = [];
  const notes: ImportRowNote[] = [];
  const consentAsked = new Set<string>();
  let rejectedBeforeIngest = 0;
  for (const { row, cells } of rows) {
    const fields: Record<string, string | null> = {};
    let tooLong: ImportField | null = null;
    for (const field of IMPORT_LEAD_FIELDS) {
      const col = input.mapping[field];
      if (col === undefined) continue;
      const value = (cells[col] ?? '').trim();
      if (value.length > IMPORT_FIELD_MAX_LENGTH[field]) {
        tooLong = field;
        break;
      }
      fields[field] = value === '' ? null : value;
    }
    if (tooLong !== null) {
      notes.push({ row, code: 'FIELD_TOO_LONG', field: tooLong });
      rejectedBeforeIngest += 1;
      continue;
    }
    const externalId = fileImportExternalId(input.importId, row);
    const record: IngestRecord = { externalId, fields, attribution: { importId: input.importId, row: String(row) } };
    const consent = input.consent;
    const answer = consent ? (cells[consent.consentCol] ?? '').trim().slice(0, IMPORT_FIELD_MAX_LENGTH.consent) : '';
    if (consent && isTruthyAnswer(answer, IMPORT_CONSENT_TRUTHY_VALUES)) {
      const at = parseConsentDate(cells[consent.dateCol] ?? '', consent.timeZone);
      if (at === null) notes.push({ row, code: 'CONSENT_DATE_INVALID', field: 'consentDate' });
      else if (at.getTime() > consent.now.getTime()) notes.push({ row, code: 'CONSENT_DATE_IN_FUTURE', field: 'consentDate' });
      else {
        record.answers = { [IMPORT_CONSENT_ANSWER_KEY]: answer };
        record.submittedAt = at.toISOString();
        consentAsked.add(externalId);
      }
    }
    records.push(record);
  }
  return { records, notes, rejectedBeforeIngest, consentAsked };
}

/** The answer key of the opt-in cell in ingestion records and the consent mapping. */
export const IMPORT_CONSENT_ANSWER_KEY = 'consent';

const CONSENT_NOTE_FOR: Readonly<Record<string, string>> = {
  SUPPRESSED_CONTACT: 'SUPPRESSED_CONTACT',
  NO_CONTACT_FOR_CHANNEL: 'CONSENT_NO_PHONE',
  PENDING_REVIEW: 'CONSENT_PENDING_REVIEW',
};

/** Counts and row notes of an ingested chunk. */
export function tallyIngested(result: IngestBatchResult | null, built: BuiltChunk): { counts: ChunkCounts; notes: ImportRowNote[] } {
  const counts: ChunkCounts = { accepted: 0, duplicates: 0, review: 0, rejected: built.rejectedBeforeIngest, consentRecorded: 0 };
  const notes: ImportRowNote[] = [];
  const rejectedRows = new Set<number>();
  for (const record of result?.records ?? []) {
    const row = parseFileImportExternalId(record.externalId)?.row ?? 0;
    if (record.status === 'ACCEPTED') counts.accepted += 1;
    else if (record.status === 'DUPLICATE') counts.duplicates += 1;
    else if (record.status === 'REVIEW') counts.review += 1;
    else {
      counts.rejected += 1;
      rejectedRows.add(row);
      const code = record.reasonCode ?? 'REJECTED';
      notes.push(code === 'MISSING_NAME' ? { row, code, field: 'name' } : { row, code });
      continue;
    }
    if (record.consent.outcome === 'CREATED') counts.consentRecorded += 1;
    else if (built.consentAsked.has(record.externalId)) notes.push({ row, code: CONSENT_NOTE_FOR[record.consent.reason] ?? 'CONSENT_NOT_RECORDED', field: 'consent' });
  }
  // A rejected row's opt-in date note says nothing more.
  for (const note of built.notes) if (note.code === 'FIELD_TOO_LONG' || !rejectedRows.has(note.row)) notes.push(note);
  notes.sort((a, b) => a.row - b.row);
  return { counts, notes };
}

// ---- leads.import -------------------------------------------------------------------------------

function processed(row: Pick<LeadImport, 'accepted' | 'duplicates' | 'review' | 'rejected'>): number {
  return row.accepted + row.duplicates + row.review + row.rejected;
}

/** Ends a QUEUED or RUNNING import as FAILED (fenced settle), then deletes its rows file. */
function failImport(job: JobHandlerContext, ctx: AppCtx, deps: Pick<ImportRunDeps, 'storageDir'>, input: { importId: string; workspaceId: string; errorCode: string }) {
  return async (tx: TxClient) => {
    const now = job.clock.now();
    const done = await tx.leadImport.updateMany({ where: { id: input.importId, workspaceId: input.workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', storagePath: null, finishedAt: now } });
    if (done.count !== 1) return;
    await recordAudit(tx, ctx, { action: 'lead.import.failed', targetType: 'LeadImport', targetId: input.importId, workspaceId: input.workspaceId, result: 'FAILED', summary: { errorCode: input.errorCode } });
    removeRowsFile(job, deps, input.workspaceId, input.importId);
  };
}

function removeRowsFile(job: JobHandlerContext, deps: Pick<ImportRunDeps, 'storageDir'>, workspaceId: string, importId: string): void {
  try {
    deleteImportRows(deps.storageDir, leadImportRelPath(workspaceId, importId));
  } catch (error) {
    // The purge at the expiry tries again.
    job.logger.error({ importId, workspaceId, errorCode: fsErrorCode(error) }, 'the rows file of a finished lead import could not be deleted; leads.importPurge retries at the expiry');
  }
}

export async function runLeadImportChunk(job: JobHandlerContext, deps: ImportRunDeps): Promise<JobResult> {
  const parsed = leadImportPayloadSchema.safeParse(job.job.payload);
  const workspaceId = job.job.workspaceId;
  if (!parsed.success || workspaceId === null) return dead('INVALID_PAYLOAD', `${LEAD_IMPORT_JOB} payload is not { importId, chunk } on a workspace job`);
  const { importId, chunk } = parsed.data;
  const row = await job.db.leadImport.findFirst({ where: { id: importId, workspaceId } });
  if (!row) return dead('IMPORT_NOT_FOUND', `no lead import ${importId} in the job's workspace`);
  if ((row.status !== 'QUEUED' && row.status !== 'RUNNING') || row.storagePath === null) return { outcome: 'succeeded' };

  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  const fail = (errorCode: string): JobResult => ({ outcome: 'succeeded', finalTx: failImport(job, ctx, deps, { importId, workspaceId, errorCode }) });

  // Lease check before any work; a QUEUED import starts running.
  await job.fencedTx((tx) => tx.leadImport.updateMany({ where: { id: importId, workspaceId, status: 'QUEUED' }, data: { status: 'RUNNING' } }));

  const mapping = mappingOf(row.mapping as Record<string, unknown> | null);
  if (mapping.name === undefined) return fail('IMPORT_MAPPING_INVALID');
  const file = readImportRows(deps.storageDir, row.storagePath);
  if (file === null) return fail('ROWS_FILE_MISSING');
  const start = chunk * LEAD_IMPORT_CHUNK;
  const last = start + LEAD_IMPORT_CHUNK >= file.rows.length;
  // ADR-120: the opt-in columns are read only for an import whose owner attested them at confirm.
  const attested = row.consentAttested && row.consentNoticeText !== null && mapping.consent !== undefined && mapping.consentDate !== undefined;
  let consent: ChunkConsent | null = null;
  if (attested) {
    const workspace = await job.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timezone: true } });
    consent = { consentCol: mapping.consent!, dateCol: mapping.consentDate!, timeZone: workspace.timezone, now: job.clock.now() };
  }
  const built = buildImportChunk({ importId, file, mapping, chunk, consent });

  let ingested: IngestBatchResult | null = null;
  if (built.records.length > 0) {
    // lead:erase may have ended the import while this job waited: ingest nothing then.
    const current = await job.db.leadImport.findFirst({ where: { id: importId, workspaceId }, select: { status: true, storagePath: true } });
    if (current?.status !== 'RUNNING' || current.storagePath === null) return { outcome: 'succeeded' };
    const input: IngestBatchInput = {
      source: 'FILE_IMPORT',
      externalBatchId: `import:${importId}:${chunk}`,
      records: built.records,
      ...(consent && row.consentNoticeText !== null
        ? {
            mapping: {
              formId: importId,
              consent: { column: IMPORT_CONSENT_ANSWER_KEY, truthyValues: [...IMPORT_CONSENT_TRUTHY_VALUES], channel: 'WHATSAPP' as const, purpose: 'MARKETING' as const, noticeText: row.consentNoticeText },
            },
          }
        : {}),
    };
    try {
      ingested = await ingestBatch(ctx, input, { contactKeyPepper: deps.contactKeyPepper });
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      const code = error instanceof AppError ? error.code : 'IMPORT_INGEST_FAILED';
      const retryable = !(error instanceof AppError) || error.retryable || error.status >= 500;
      if (retryable && job.job.attempts < job.job.maxAttempts) return { outcome: 'retry', errorCode: code, error: message };
      return { outcome: 'dead', reason: code, errorCode: code, error: message, finalTx: failImport(job, ctx, deps, { importId, workspaceId, errorCode: code }) };
    }
  }
  const { counts, notes } = tallyIngested(ingested, built);

  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      const current = await tx.leadImport.findFirst({ where: { id: importId, workspaceId } });
      // Ended meanwhile (lead:erase), or this chunk was already counted.
      if (!current || current.status !== 'RUNNING' || current.storagePath === null || processed(current) !== start) return;
      const now = job.clock.now();
      const totals = {
        accepted: current.accepted + counts.accepted,
        duplicates: current.duplicates + counts.duplicates,
        review: current.review + counts.review,
        rejected: current.rejected + counts.rejected,
        consentRecorded: current.consentRecorded + counts.consentRecorded,
      };
      const rejections = [...importNotesOf(current.rejections), ...notes];
      const done = await tx.leadImport.updateMany({
        where: { id: importId, workspaceId, status: 'RUNNING' },
        data: { ...totals, rejections, ...(last ? { status: 'SUCCEEDED' as const, finishedAt: now, storagePath: null } : {}) },
      });
      if (done.count !== 1) return;
      if (!last) {
        await enqueueJob(tx, job.clock, {
          type: LEAD_IMPORT_JOB,
          payload: { importId, chunk: chunk + 1 },
          workspaceId,
          idempotencyKey: `${LEAD_IMPORT_JOB}:${importId}:${chunk + 1}`,
          correlationId: job.correlationId,
          causationId: job.job.id,
          priority: LEAD_IMPORT_PRIORITY,
          kind: 'default',
        });
        return;
      }
      await recordAudit(tx, ctx, {
        action: 'lead.import.complete',
        targetType: 'LeadImport',
        targetId: importId,
        workspaceId,
        summary: { rowCount: current.rowCount, ...totals, notes: rejections.length },
      });
      removeRowsFile(job, deps, workspaceId, importId);
    },
  };
}

// ---- leads.importPurge --------------------------------------------------------------------------

export async function runLeadImportPurge(job: JobHandlerContext, deps: Pick<ImportRunDeps, 'storageDir' | 'mode'>): Promise<JobResult> {
  const parsed = leadImportPurgePayloadSchema.safeParse(job.job.payload);
  const workspaceId = job.job.workspaceId;
  if (!parsed.success || workspaceId === null) return dead('INVALID_PAYLOAD', 'leads.importPurge payload is not { importId } on a workspace job');
  const { importId } = parsed.data;
  const row = await job.db.leadImport.findFirst({ where: { id: importId, workspaceId } });
  if (!row) return { outcome: 'succeeded' };
  const now = job.clock.now();
  if (now.getTime() < row.expiresAt.getTime()) return { outcome: 'deferred', runAt: row.expiresAt, reason: 'IMPORT_NOT_EXPIRED' };
  const inProgress = row.status === 'QUEUED' || row.status === 'RUNNING';
  if (inProgress) {
    // Confirmed in time: the import deletes its own file when it finishes; look again later. But a
    // chunk job that died without its settle (a thrown error, the reaper at max attempts) leaves
    // nothing to finish it, and its rows would stay on disk past the 24 h (ADR-120).
    const live = await job.db.job.count({ where: { workspaceId, type: LEAD_IMPORT_JOB, status: { in: ['QUEUED', 'RUNNING'] }, idempotencyKey: { startsWith: `${LEAD_IMPORT_JOB}:${importId}:` } } });
    if (live > 0) return { outcome: 'deferred', runAt: new Date(now.getTime() + HOUR), reason: 'IMPORT_IN_PROGRESS' };
  }

  try {
    deleteImportRows(deps.storageDir, leadImportRelPath(workspaceId, importId));
  } catch (error) {
    const message = redactText(`the import rows file could not be deleted (${fsErrorCode(error)})`);
    if (job.job.attempts < job.job.maxAttempts) return { outcome: 'retry', errorCode: 'IMPORT_PURGE_FAILED', error: message };
    job.logger.error({ importId, workspaceId, errorCode: fsErrorCode(error) }, 'lead import purge gave up: the rows file could not be deleted and remains on disk');
    return { outcome: 'dead', reason: 'IMPORT_PURGE_FAILED', errorCode: 'IMPORT_PURGE_FAILED', error: message };
  }
  const ctx = getJobContext({ id: job.job.id, workspaceId, correlationId: job.correlationId }, { prisma: job.db, mode: deps.mode, clock: job.clock });
  if (inProgress) return { outcome: 'succeeded', finalTx: failImport(job, ctx, deps, { importId, workspaceId, errorCode: 'IMPORT_STALLED' }) };
  return {
    outcome: 'succeeded',
    finalTx: async (tx) => {
      if (row.status === 'PREVIEW') {
        const done = await tx.leadImport.updateMany({ where: { id: importId, workspaceId, status: 'PREVIEW' }, data: { status: 'EXPIRED', storagePath: null, finishedAt: now } });
        if (done.count === 1) await recordAudit(tx, ctx, { action: 'lead.import.expire', targetType: 'LeadImport', targetId: importId, workspaceId, summary: { rowCount: row.rowCount } });
        return;
      }
      if (row.storagePath !== null) await tx.leadImport.updateMany({ where: { id: importId, workspaceId, status: row.status }, data: { storagePath: null } });
    },
  };
}
