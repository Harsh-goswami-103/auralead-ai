/**
 * Leads export (T26, plan §11 M4, §9 XSS row, ADR-70), as CSV or an Excel workbook (ADR-120).
 *
 * - `requestLeadExport` (needs `leads.export`): stores a LeadExport with the list filters, enqueues
 *   `leads.export` and audits `lead.export.request`, in one transaction. Idempotent per client
 *   request key. The audit names the filters but never the search text, which may be a name or a
 *   phone number.
 * - The job (`jobs/handlers/lead-export.ts`) calls `buildLeadExportCsv` and `writeExportFile`
 *   (same filters and order as the list, merged leads left out, cells escaped by `csv.ts`), then
 *   `completeLeadExport` marks it READY until `expiresAt` (24 h), audits `lead.export.ready` and
 *   schedules `leads.exportPurge` at the expiry, which deletes the file (`expireLeadExport`).
 * - `getLeadExportDownload`: only the person who asked for the export can download it, only while
 *   it is READY and unexpired (410 after), only when the stored sha256 still matches; every
 *   download is audited `lead.export.download`.
 *
 * The file lives at `STORAGE_DIR/exports/<workspaceId>/<exportId>.<format>` (`leadExportRelPath`;
 * csv, or xlsx per ADR-120), outside the repository, written to a temp name and renamed so a reader
 * never sees half a file. Both formats hold the same header and rows (`LEAD_CSV_HEADER`,
 * `leadCsvRow`): the CSV escapes formula cells with an apostrophe, the workbook writes every text
 * cell as an inline string, which a spreadsheet never evaluates (ADR-117).
 *
 * Load and retention (ADR-73): a request with the same filters as one of the requester's exports
 * still preparing or ready reuses it; a workspace holds at most `LEAD_EXPORT_ACTIVE_CAP` active
 * exports (QUEUED plus unexpired READY, 409 `EXPORT_LIMIT_REACHED`); export and purge jobs run at
 * `LEAD_EXPORT_PRIORITY`, behind sends and PDFs. The search text (`q`, possibly a name or phone) is
 * kept only while the export is in flight: it is dropped when the export fails or expires, never
 * shown for one that did, and `lead:erase` drops it from every export of the workspace.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LeadExport, Prisma, PrismaClient } from '@/generated/prisma/client';
import { AppError, ConflictError, DomainRuleError, IdempotencyConflictError, NotFoundError } from '@/lib/errors';
import {
  LEAD_EXPORT_FORMATS,
  LEAD_EXPORT_ROW_CAP,
  LEAD_EXPORT_TTL_HOURS,
  LeadFilters,
  type LeadExportDto,
  type LeadExportFormat,
  type LeadExportStatus,
  type LeadFilters as LeadFiltersType,
} from '@/lib/schemas/leads';
import { writeXlsx } from '@/lib/spreadsheet';
import type { AppCtx } from '@/server/auth/context';
import { requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { buildCsv, LEAD_CSV_HEADER, leadCsvRow, type CsvValue } from './csv';
import { leadFilterWhere, leadsAfter, leadSortOrder } from './list';

export const LEAD_EXPORT_JOB = 'leads.export';
export const LEAD_EXPORT_PURGE_JOB = 'leads.exportPurge';
/** Claim order is ascending (`ORDER BY priority, runAt`): sends and PDFs (0) and integration checks (5) go first. */
export const LEAD_EXPORT_PRIORITY = 10;
/** QUEUED plus unexpired READY exports a workspace may hold at once. */
export const LEAD_EXPORT_ACTIVE_CAP = 3;
/** errorCode of an export whose purge could not delete the file (it remains on disk). */
export const PURGE_FAILED = 'PURGE_FAILED';
const HOUR = 3_600_000;
const BATCH = 500;
const LIST_LIMIT = 10;

export class ExportNotReadyError extends ConflictError {
  static override readonly defaultCode: string = 'EXPORT_NOT_READY';
  static override readonly defaultUserMessage: string = 'This export is still being prepared. Try again in a moment.';
}
export class ExportFailedError extends ConflictError {
  static override readonly defaultCode: string = 'EXPORT_FAILED';
  static override readonly defaultUserMessage: string = 'This export could not be prepared. Start a new export.';
}
export class ExportExpiredError extends DomainRuleError {
  static override readonly status: number = 410;
  static override readonly defaultCode: string = 'EXPORT_EXPIRED';
  static override readonly defaultUserMessage: string = 'This export has expired and its file was deleted. Start a new export.';
}
export class ExportLimitError extends ConflictError {
  static override readonly defaultCode: string = 'EXPORT_LIMIT_REACHED';
  static override readonly defaultUserMessage: string = `This workspace already has ${LEAD_EXPORT_ACTIVE_CAP} exports preparing or ready. Download or wait for one to expire, then try again.`;
}
export class ExportIntegrityError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'EXPORT_INTEGRITY';
  static override readonly defaultUserMessage: string = 'The export file could not be verified. Start a new export.';
}

// ---- Files --------------------------------------------------------------------------------------

/** `LeadExport.format` values (ADR-120); the column defaults to csv. */
export { LEAD_EXPORT_FORMATS, type LeadExportFormat };

/** The stored format, or null for a value this version does not write. */
export function exportFormatOf(value: string): LeadExportFormat | null {
  return (LEAD_EXPORT_FORMATS as readonly string[]).includes(value) ? (value as LeadExportFormat) : null;
}

/** The download's content type per format. */
export const LEAD_EXPORT_CONTENT_TYPES: Readonly<Record<LeadExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** `exports/<workspaceId>/<exportId>.<format>`, relative to STORAGE_DIR. */
export function leadExportRelPath(workspaceId: string, exportId: string, format: LeadExportFormat): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(exportId)) throw new Error('export ids must be plain identifiers');
  if (!(LEAD_EXPORT_FORMATS as readonly string[]).includes(format)) throw new Error('unknown export format');
  return `exports/${workspaceId}/${exportId}.${format}`;
}

function absolute(storageDir: string, relPath: string): string {
  const root = path.resolve(storageDir);
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root + path.sep)) throw new Error('export path escapes the storage directory');
  return full;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function writeExportFile(storageDir: string, relPath: string, bytes: Buffer): { path: string; sha256: string; bytes: number } {
  const full = absolute(storageDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, full);
  return { path: relPath, sha256: sha256Hex(bytes), bytes: bytes.length };
}

export function deleteExportFile(storageDir: string, relPath: string): void {
  fs.rmSync(absolute(storageDir, relPath), { force: true, maxRetries: 5, retryDelay: 200 });
}

function readExportFile(storageDir: string, row: { path: string | null; sha256: string | null; bytes: number | null }): Buffer {
  if (!row.path || !row.sha256 || row.bytes === null) throw new ExportIntegrityError({ message: 'export row has no file' });
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute(storageDir, row.path));
  } catch (cause) {
    throw new ExportIntegrityError({ message: 'export file is missing', cause });
  }
  if (bytes.length !== row.bytes || sha256Hex(bytes) !== row.sha256) throw new ExportIntegrityError({ message: 'export file hash mismatch' });
  return bytes;
}

// ---- DTO ----------------------------------------------------------------------------------------

function filtersOf(value: unknown): LeadFiltersType {
  const parsed = LeadFilters.safeParse(value);
  return parsed.success ? parsed.data : { sort: 'newest' };
}

/** The stored filters without the search text (kept for the panel and audits; `q` may be PII). */
export function withoutSearchText(value: unknown): Prisma.InputJsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { sort: 'newest' };
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete rest.q;
  return rest as Prisma.InputJsonValue;
}

function sameFilters(a: LeadFiltersType, b: LeadFiltersType): boolean {
  return (a.q ?? null) === (b.q ?? null) && (a.stage ?? null) === (b.stage ?? null) && (a.source ?? null) === (b.source ?? null) && (a.score ?? null) === (b.score ?? null) && a.sort === b.sort;
}

/** QUEUED, or READY and not yet expired at `now`. */
function activeExportWhere(now: Date): Prisma.LeadExportWhereInput {
  return { OR: [{ status: 'QUEUED' }, { status: 'READY', expiresAt: { gt: now } }] };
}

export function effectiveExportStatus(row: Pick<LeadExport, 'status' | 'expiresAt'>, now: Date): LeadExportStatus {
  if (row.status === 'READY' && row.expiresAt !== null && now.getTime() >= row.expiresAt.getTime()) return 'EXPIRED';
  return row.status;
}

export function leadExportDto(row: LeadExport, now: Date): LeadExportDto {
  const effectiveStatus = effectiveExportStatus(row, now);
  const filters = filtersOf(row.filters);
  if (effectiveStatus === 'EXPIRED' || effectiveStatus === 'FAILED') delete filters.q;
  return {
    id: row.id,
    format: exportFormatOf(row.format) ?? 'csv',
    status: row.status,
    effectiveStatus,
    filters,
    rowCount: row.rowCount,
    truncated: row.truncated,
    bytes: row.bytes,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    downloadCount: row.downloadCount,
  };
}

/** What the audit may say about the filters: their names and enum values, never the search text. */
function auditFilters(filters: LeadFiltersType) {
  return { stage: filters.stage ?? null, source: filters.source ?? null, score: filters.score ?? null, sort: filters.sort, search: Boolean(filters.q) };
}

// ---- Request, list, download --------------------------------------------------------------------

export async function requestLeadExport(ctx: AppCtx, input: { requestKey: string; filters: unknown; format?: LeadExportFormat }): Promise<{ export: LeadExportDto; created: boolean }> {
  requireCapability(ctx, 'leads.export');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const filters = LeadFilters.parse(input.filters ?? {});
  const format: LeadExportFormat = input.format ?? 'csv';
  const now = ctx.clock.now();

  return withTx(ctx.db, async (tx) => {
    const existing = await tx.leadExport.findFirst({ where: { requestKey: input.requestKey } });
    if (existing) {
      if (existing.requestedBy !== actor.userId) throw new IdempotencyConflictError({ message: 'export request key used by another person' });
      return { export: leadExportDto(existing, now), created: false };
    }
    // The same export still preparing or ready (a second click later, another tab): reuse it.
    const inFlight = await tx.leadExport.findMany({ where: { requestedBy: actor.userId, ...activeExportWhere(now) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const same = inFlight.find((e) => {
      const stored = exportFiltersOf(e);
      return stored !== null && sameFilters(stored, filters) && (exportFormatOf(e.format) ?? 'csv') === format;
    });
    if (same) return { export: leadExportDto(same, now), created: false };
    const active = await tx.leadExport.count({ where: activeExportWhere(now) });
    if (active >= LEAD_EXPORT_ACTIVE_CAP) throw new ExportLimitError({ safeDetails: { limit: LEAD_EXPORT_ACTIVE_CAP } });
    const row = await tx.leadExport.create({
      data: { workspaceId, requestKey: input.requestKey, filters: filters as unknown as Prisma.InputJsonValue, format, requestedBy: actor.userId, correlationId: ctx.correlationId, createdAt: now },
    });
    const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
      type: LEAD_EXPORT_JOB,
      payload: { exportId: row.id },
      workspaceId,
      idempotencyKey: `${LEAD_EXPORT_JOB}:${row.id}`,
      correlationId: ctx.correlationId,
      priority: LEAD_EXPORT_PRIORITY,
      kind: 'default',
    });
    const updated = await tx.leadExport.update({ where: { id: row.id }, data: { jobId: job.id } });
    await recordAudit(tx, ctx, {
      action: 'lead.export.request',
      targetType: 'LeadExport',
      targetId: row.id,
      workspaceId,
      summary: { filters: auditFilters(filters), format, jobId: job.id },
    });
    return { export: leadExportDto(updated, now), created: true };
  });
}

/** The caller's own recent exports in this workspace, newest first. */
export async function listLeadExports(ctx: AppCtx): Promise<LeadExportDto[]> {
  requireCapability(ctx, 'leads.export');
  const actor = requireActor(ctx);
  const rows = await ctx.db.leadExport.findMany({ where: { requestedBy: actor.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT });
  const now = ctx.clock.now();
  return rows.map((r) => leadExportDto(r, now));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `leads-<workspace slug>-<yyyymmdd>-<hhmm>.<csv|xlsx>`, the time the file was written in the workspace zone. */
export function leadExportFileName(slug: string, at: Date, timeZone: string, format: LeadExportFormat = 'csv'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '-');
  return `leads-${safeSlug}-${parts.year}${parts.month}${parts.day}-${pad(Number(parts.hour) % 24)}${parts.minute}.${format}`;
}

export async function getLeadExportDownload(
  ctx: AppCtx,
  exportId: string,
  deps: { storageDir: string },
): Promise<{ bytes: Buffer; fileName: string; format: LeadExportFormat; contentType: string }> {
  requireCapability(ctx, 'leads.export');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const row = await ctx.db.leadExport.findFirst({ where: { id: exportId, requestedBy: actor.userId } });
  if (!row) throw new NotFoundError();
  const now = ctx.clock.now();
  const status = effectiveExportStatus(row, now);
  if (status === 'QUEUED') throw new ExportNotReadyError();
  if (status === 'FAILED') throw new ExportFailedError();
  if (status === 'EXPIRED') throw new ExportExpiredError();
  const bytes = readExportFile(deps.storageDir, row);
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true, timezone: true } });

  await withTx(ctx.db, async (tx) => {
    await tx.leadExport.update({ where: { id: row.id }, data: { downloadCount: { increment: 1 }, lastDownloadedAt: now } });
    await recordAudit(tx, ctx, { action: 'lead.export.download', targetType: 'LeadExport', targetId: row.id, workspaceId, summary: { rowCount: row.rowCount, bytes: row.bytes } });
  });
  const format = exportFormatOf(row.format) ?? 'csv';
  return { bytes, fileName: leadExportFileName(workspace.slug, row.completedAt ?? now, workspace.timezone, format), format, contentType: LEAD_EXPORT_CONTENT_TYPES[format] };
}

// ---- Job side -----------------------------------------------------------------------------------

const CSV_SELECT = {
  id: true,
  displayName: true,
  nameNormalized: true,
  salesStage: true,
  score: true,
  firstSource: true,
  phoneE164: true,
  emailNormalized: true,
  website: true,
  websiteStatus: true,
  city: true,
  category: true,
  address: true,
  rating: true,
  reviewCount: true,
  simulated: true,
  createdAt: true,
} as const satisfies Prisma.LeadSelect;

/**
 * The rows of a workspace's leads matching `filters`, in the list's order, walked in keyset
 * batches with the unscoped job client (the workspace is bound explicitly). Stops at `rowCap`.
 */
export async function buildLeadExportRows(
  db: Pick<PrismaClient, 'lead'>,
  workspaceId: string,
  filters: LeadFiltersType,
  rowCap: number = LEAD_EXPORT_ROW_CAP,
): Promise<{ rows: CsvValue[][]; rowCount: number; truncated: boolean }> {
  const base: Prisma.LeadWhereInput = { AND: [{ workspaceId }, leadFilterWhere(filters)] };
  const order = leadSortOrder(filters.sort);
  const rows: CsvValue[][] = [];
  let after: Prisma.LeadWhereInput | null = null;
  let truncated = false;
  for (;;) {
    const take = Math.min(BATCH, rowCap + 1 - rows.length);
    const batch = await db.lead.findMany({ where: after ? { AND: [base, after] } : base, orderBy: order, take, select: CSV_SELECT });
    for (const lead of batch) {
      if (rows.length === rowCap) {
        truncated = true;
        break;
      }
      rows.push(leadCsvRow(lead));
    }
    if (truncated || batch.length < take) break;
    after = leadsAfter(filters.sort, batch[batch.length - 1]!);
  }
  return { rows, rowCount: rows.length, truncated };
}

/** The CSV of `buildLeadExportRows`. */
export async function buildLeadExportCsv(
  db: Pick<PrismaClient, 'lead'>,
  workspaceId: string,
  filters: LeadFiltersType,
  rowCap: number = LEAD_EXPORT_ROW_CAP,
): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
  const built = await buildLeadExportRows(db, workspaceId, filters, rowCap);
  return { csv: buildCsv(LEAD_CSV_HEADER, built.rows), rowCount: built.rowCount, truncated: built.truncated };
}

/** The export file in `format`: the same header and rows as CSV (with its BOM) or as one Excel sheet "Leads". */
export async function buildLeadExportFile(
  db: Pick<PrismaClient, 'lead'>,
  workspaceId: string,
  filters: LeadFiltersType,
  format: LeadExportFormat,
  rowCap: number = LEAD_EXPORT_ROW_CAP,
): Promise<{ bytes: Buffer; rowCount: number; truncated: boolean }> {
  const built = await buildLeadExportRows(db, workspaceId, filters, rowCap);
  const bytes =
    format === 'xlsx' ? Buffer.from(writeXlsx({ sheetName: 'Leads', header: LEAD_CSV_HEADER, rows: built.rows })) : Buffer.from(buildCsv(LEAD_CSV_HEADER, built.rows), 'utf8');
  return { bytes, rowCount: built.rowCount, truncated: built.truncated };
}

export function exportFiltersOf(row: Pick<LeadExport, 'filters'>): LeadFiltersType | null {
  const parsed = LeadFilters.safeParse(row.filters);
  return parsed.success ? parsed.data : null;
}

type JobAuditCtx = AuditCtx;

/**
 * Marks a QUEUED export READY, schedules its purge at the expiry and audits it (fenced settle).
 * False when the export is no longer QUEUED (cancelled by `lead:erase` while it was built): the
 * caller then deletes the file it wrote.
 */
export async function completeLeadExport(
  tx: TxClient,
  ctx: JobAuditCtx,
  input: { exportId: string; workspaceId: string; file: { path: string; sha256: string; bytes: number }; rowCount: number; truncated: boolean; jobId: string },
): Promise<boolean> {
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + LEAD_EXPORT_TTL_HOURS * HOUR);
  const done = await tx.leadExport.updateMany({
    where: { id: input.exportId, workspaceId: input.workspaceId, status: 'QUEUED' },
    data: { status: 'READY', rowCount: input.rowCount, truncated: input.truncated, path: input.file.path, sha256: input.file.sha256, bytes: input.file.bytes, completedAt: now, expiresAt },
  });
  if (done.count !== 1) return false;
  await enqueueJob(tx, ctx.clock, {
    type: LEAD_EXPORT_PURGE_JOB,
    payload: { exportId: input.exportId },
    workspaceId: input.workspaceId,
    idempotencyKey: `${LEAD_EXPORT_PURGE_JOB}:${input.exportId}`,
    correlationId: ctx.correlationId,
    causationId: input.jobId,
    runAt: expiresAt,
    priority: LEAD_EXPORT_PRIORITY,
    kind: 'default',
  });
  await recordAudit(tx, ctx, {
    action: 'lead.export.ready',
    targetType: 'LeadExport',
    targetId: input.exportId,
    workspaceId: input.workspaceId,
    summary: { rowCount: input.rowCount, truncated: input.truncated, bytes: input.file.bytes },
  });
  return true;
}

/** Marks a QUEUED export FAILED (the job gave up), drops its search text and audits it. */
export async function failLeadExport(tx: TxClient, ctx: JobAuditCtx, input: { exportId: string; workspaceId: string; errorCode: string }): Promise<void> {
  const row = await tx.leadExport.findFirst({ where: { id: input.exportId, workspaceId: input.workspaceId, status: 'QUEUED' }, select: { filters: true } });
  if (!row) return;
  const done = await tx.leadExport.updateMany({
    where: { id: input.exportId, workspaceId: input.workspaceId, status: 'QUEUED' },
    data: { status: 'FAILED', errorCode: input.errorCode, completedAt: ctx.clock.now(), filters: withoutSearchText(row.filters) },
  });
  if (done.count !== 1) return;
  await recordAudit(tx, ctx, { action: 'lead.export.failed', targetType: 'LeadExport', targetId: input.exportId, workspaceId: input.workspaceId, result: 'FAILED', summary: { errorCode: input.errorCode } });
}

/**
 * Marks a READY export EXPIRED and drops its search text, and audits it. `purgeFailed`: the purge
 * gave up deleting the file (it stays on disk, errorCode PURGE_FAILED, retryable from Platform
 * admin > Jobs). Called again for such an export once its file is deleted, it clears the code.
 */
export async function expireLeadExport(tx: TxClient, ctx: JobAuditCtx, input: { exportId: string; workspaceId: string; purgeFailed?: boolean }): Promise<void> {
  const now = ctx.clock.now();
  const row = await tx.leadExport.findFirst({ where: { id: input.exportId, workspaceId: input.workspaceId }, select: { status: true, errorCode: true, filters: true } });
  if (!row) return;
  const afterFailure = row.status === 'EXPIRED' && row.errorCode === PURGE_FAILED;
  if (row.status !== 'READY' && !afterFailure) return;
  if (afterFailure && input.purgeFailed) return;
  const done = await tx.leadExport.updateMany({
    where: { id: input.exportId, workspaceId: input.workspaceId, status: row.status, errorCode: row.errorCode },
    data: { status: 'EXPIRED', purgedAt: now, filters: withoutSearchText(row.filters), errorCode: input.purgeFailed ? PURGE_FAILED : null },
  });
  if (done.count !== 1) return;
  await recordAudit(tx, ctx, {
    action: 'lead.export.expire',
    targetType: 'LeadExport',
    targetId: input.exportId,
    workspaceId: input.workspaceId,
    ...(input.purgeFailed ? { result: 'FAILED' as const } : {}),
    summary: input.purgeFailed ? { fileDeleted: false, errorCode: PURGE_FAILED } : afterFailure ? { fileDeleted: true, afterPurgeFailure: true } : {},
  });
}

/** An export the purge job still has to delete the file of: READY, or EXPIRED after a failed purge. */
export function exportNeedsPurge(row: Pick<LeadExport, 'status' | 'errorCode'>): boolean {
  return row.status === 'READY' || (row.status === 'EXPIRED' && row.errorCode === PURGE_FAILED);
}
