/**
 * Leads CSV export (T26, plan §11 M4, §9 XSS row, ADR-70).
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
 * The file lives at `STORAGE_DIR/exports/<workspaceId>/<exportId>.csv`, outside the repository,
 * written to a temp name and renamed so a reader never sees half a file.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LeadExport, Prisma, PrismaClient } from '@/generated/prisma/client';
import { AppError, ConflictError, DomainRuleError, IdempotencyConflictError, NotFoundError } from '@/lib/errors';
import {
  LEAD_EXPORT_ROW_CAP,
  LEAD_EXPORT_TTL_HOURS,
  LeadFilters,
  type LeadExportDto,
  type LeadExportStatus,
  type LeadFilters as LeadFiltersType,
} from '@/lib/schemas/leads';
import type { AppCtx } from '@/server/auth/context';
import { requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { buildCsv, LEAD_CSV_HEADER, leadCsvRow } from './csv';
import { leadFilterWhere, leadsAfter, leadSortOrder } from './list';

export const LEAD_EXPORT_JOB = 'leads.export';
export const LEAD_EXPORT_PURGE_JOB = 'leads.exportPurge';
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
export class ExportIntegrityError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'EXPORT_INTEGRITY';
  static override readonly defaultUserMessage: string = 'The export file could not be verified. Start a new export.';
}

// ---- Files --------------------------------------------------------------------------------------

export function leadExportRelPath(workspaceId: string, exportId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(exportId)) throw new Error('export ids must be plain identifiers');
  return `exports/${workspaceId}/${exportId}.csv`;
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

export function effectiveExportStatus(row: Pick<LeadExport, 'status' | 'expiresAt'>, now: Date): LeadExportStatus {
  if (row.status === 'READY' && row.expiresAt !== null && now.getTime() >= row.expiresAt.getTime()) return 'EXPIRED';
  return row.status;
}

export function leadExportDto(row: LeadExport, now: Date): LeadExportDto {
  return {
    id: row.id,
    status: row.status,
    effectiveStatus: effectiveExportStatus(row, now),
    filters: filtersOf(row.filters),
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

export async function requestLeadExport(ctx: AppCtx, input: { requestKey: string; filters: unknown }): Promise<{ export: LeadExportDto; created: boolean }> {
  requireCapability(ctx, 'leads.export');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const filters = LeadFilters.parse(input.filters ?? {});
  const now = ctx.clock.now();

  return withTx(ctx.db, async (tx) => {
    const existing = await tx.leadExport.findFirst({ where: { requestKey: input.requestKey } });
    if (existing) {
      if (existing.requestedBy !== actor.userId) throw new IdempotencyConflictError({ message: 'export request key used by another person' });
      return { export: leadExportDto(existing, now), created: false };
    }
    const row = await tx.leadExport.create({
      data: { workspaceId, requestKey: input.requestKey, filters: filters as unknown as Prisma.InputJsonValue, requestedBy: actor.userId, correlationId: ctx.correlationId, createdAt: now },
    });
    const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
      type: LEAD_EXPORT_JOB,
      payload: { exportId: row.id },
      workspaceId,
      idempotencyKey: `${LEAD_EXPORT_JOB}:${row.id}`,
      correlationId: ctx.correlationId,
      kind: 'default',
    });
    const updated = await tx.leadExport.update({ where: { id: row.id }, data: { jobId: job.id } });
    await recordAudit(tx, ctx, {
      action: 'lead.export.request',
      targetType: 'LeadExport',
      targetId: row.id,
      workspaceId,
      summary: { filters: auditFilters(filters), jobId: job.id },
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

/** `leads-<workspace slug>-<yyyymmdd>-<hhmm>.csv`, the time the file was written in the workspace zone. */
export function leadExportFileName(slug: string, at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '-');
  return `leads-${safeSlug}-${parts.year}${parts.month}${parts.day}-${pad(Number(parts.hour) % 24)}${parts.minute}.csv`;
}

export async function getLeadExportDownload(ctx: AppCtx, exportId: string, deps: { storageDir: string }): Promise<{ bytes: Buffer; fileName: string }> {
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
  return { bytes, fileName: leadExportFileName(workspace.slug, row.completedAt ?? now, workspace.timezone) };
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
 * The CSV for a workspace's leads matching `filters`, in the list's order, walked in keyset
 * batches with the unscoped job client (the workspace is bound explicitly). Stops at `rowCap`.
 */
export async function buildLeadExportCsv(
  db: Pick<PrismaClient, 'lead'>,
  workspaceId: string,
  filters: LeadFiltersType,
  rowCap: number = LEAD_EXPORT_ROW_CAP,
): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
  const base: Prisma.LeadWhereInput = { AND: [{ workspaceId }, leadFilterWhere(filters)] };
  const order = leadSortOrder(filters.sort);
  const rows: ReturnType<typeof leadCsvRow>[] = [];
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
  return { csv: buildCsv(LEAD_CSV_HEADER, rows), rowCount: rows.length, truncated };
}

export function exportFiltersOf(row: Pick<LeadExport, 'filters'>): LeadFiltersType | null {
  const parsed = LeadFilters.safeParse(row.filters);
  return parsed.success ? parsed.data : null;
}

type JobAuditCtx = AuditCtx;

/** Marks a QUEUED export READY, schedules its purge at the expiry and audits it (fenced settle). */
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

/** Marks a QUEUED export FAILED (the job gave up) and audits it. */
export async function failLeadExport(tx: TxClient, ctx: JobAuditCtx, input: { exportId: string; workspaceId: string; errorCode: string }): Promise<void> {
  const done = await tx.leadExport.updateMany({
    where: { id: input.exportId, workspaceId: input.workspaceId, status: 'QUEUED' },
    data: { status: 'FAILED', errorCode: input.errorCode, completedAt: ctx.clock.now() },
  });
  if (done.count !== 1) return;
  await recordAudit(tx, ctx, { action: 'lead.export.failed', targetType: 'LeadExport', targetId: input.exportId, workspaceId: input.workspaceId, result: 'FAILED', summary: { errorCode: input.errorCode } });
}

/** Marks a READY export EXPIRED after its file was deleted, and audits it. */
export async function expireLeadExport(tx: TxClient, ctx: JobAuditCtx, input: { exportId: string; workspaceId: string }): Promise<void> {
  const done = await tx.leadExport.updateMany({ where: { id: input.exportId, workspaceId: input.workspaceId, status: 'READY' }, data: { status: 'EXPIRED', purgedAt: ctx.clock.now() } });
  if (done.count !== 1) return;
  await recordAudit(tx, ctx, { action: 'lead.export.expire', targetType: 'LeadExport', targetId: input.exportId, workspaceId: input.workspaceId, summary: {} });
}
