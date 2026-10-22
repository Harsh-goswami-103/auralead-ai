/**
 * Lead import from Excel or CSV (ADR-120, slice F2), the request side.
 *
 * - `uploadLeadImport` (needs `leads.import`): decodes the base64 upload, parses it with
 *   `readTable` (ADR-117; a `SpreadsheetError` answers 422 with its code), keeps at most 2,000
 *   non-blank data rows, stores a PREVIEW `LeadImport` (header, counts, sha256, expiry 24 h; never
 *   the rows) and writes the rows to `STORAGE_DIR/imports/<ws>/<id>.json`. It schedules
 *   `leads.importPurge` at the expiry and audits `lead.import.upload` without the file name or any
 *   cell. Idempotent per request key. The answer carries the header, the first 20 rows and a
 *   mapping suggested from the header names.
 * - `getLeadImportView` / `listLeadImports`: the requester's own imports only (the rows file holds
 *   personal data); the preview rows only while the import is a live PREVIEW.
 * - `confirmLeadImport`: the person's mapping (name and a phone or email column required, one field
 *   per column) and data source; PREVIEW becomes QUEUED and the first `leads.import` chunk is
 *   enqueued (`import-run.ts` processes 200 rows per job through `ingestBatch`). The consent column
 *   is handled by `decideImportConsent` (ADR-120 guards).
 * - `buildLeadImportSampleWorkbook`: the header row first, then five clearly fictitious rows.
 */
import { createHash } from 'node:crypto';
import type { LeadImport, Prisma } from '@/generated/prisma/client';
import type { ImportDataSource, LeadImportStatus } from '@/lib/domain/enums';
import { LEAD_GEN_JOB_TYPES } from '@/lib/domain/lead-gen';
import { AppError, ConflictError, DomainRuleError, IdempotencyConflictError, NotFoundError } from '@/lib/errors';
import {
  consentAttestationText,
  IMPORT_MAPPABLE_FIELDS,
  LEAD_IMPORT_CONTENT_TYPES,
  LEAD_IMPORT_EXTENSIONS,
  LEAD_IMPORT_MAX_FILE_BYTES,
  LEAD_IMPORT_MAX_ROWS,
  LEAD_IMPORT_PREVIEW_ROWS,
  LEAD_IMPORT_TTL_HOURS,
  mappingOf,
  suggestImportMapping,
  type ConsentDecision,
  type ImportMappingValue,
  type ImportRowNote,
  type LeadImportConfirmBody,
  type LeadImportDto,
  type LeadImportUploadBody,
  type LeadImportView,
} from '@/lib/schemas/lead-import';
import { readTable, SpreadsheetError, SPREADSHEET_LIMITS, writeXlsx } from '@/lib/spreadsheet';
import { isZip } from '@/lib/spreadsheet/xlsx';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { deleteImportRows, leadImportRelPath, readImportRows, writeImportRows, type ImportRowsFile } from './import-files';

export const LEAD_IMPORT_JOB = LEAD_GEN_JOB_TYPES.leadImport;
export const LEAD_IMPORT_PURGE_JOB = LEAD_GEN_JOB_TYPES.importPurge;
/** Behind sends, PDFs and integration checks, like exports (claim order is ascending). */
export const LEAD_IMPORT_PRIORITY = 10;
const HOUR = 3_600_000;
const LIST_LIMIT = 10;
const HEADER_CELL_MAX = 200;

export class ImportExpiredError extends DomainRuleError {
  static override readonly status: number = 410;
  static override readonly defaultCode: string = 'IMPORT_EXPIRED';
  static override readonly defaultUserMessage: string = 'This upload has expired and its rows were deleted. Upload the file again.';
}
export class ImportNotInPreviewError extends ConflictError {
  static override readonly defaultCode: string = 'IMPORT_ALREADY_STARTED';
  static override readonly defaultUserMessage: string = 'This import was already started. Its progress is shown on the import page.';
}
export class ImportWriteError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'IMPORT_WRITE_FAILED';
  static override readonly defaultUserMessage: string = 'The file could not be stored for the preview. Try again.';
}

const FILE_MESSAGES: Readonly<Record<string, string>> = {
  NOT_A_WORKBOOK: 'This file is not a readable Excel workbook. Save it as .xlsx or .csv and upload it again.',
  TOO_LARGE: 'The file is larger than 5 MB. Split it into smaller files.',
  TOO_MANY_ROWS: `A file can hold at most ${LEAD_IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows below the header. Split it into smaller files.`,
  TOO_MANY_COLUMNS: `A file can have at most ${SPREADSHEET_LIMITS.maxColumns} columns.`,
  MALFORMED_CSV: 'The CSV file could not be read: a quoted value is never closed.',
  EMPTY_FILE: 'The file is empty.',
  UNSUPPORTED_FILE_TYPE: 'Upload an .xlsx or .csv file. Save older .xls workbooks as .xlsx first.',
  FILE_TYPE_MISMATCH: "The file's contents do not match its .xlsx or .csv name. Save it again and upload it.",
  FILE_ENCODING_INVALID: 'The upload was damaged on the way. Choose the file again.',
  NO_HEADER: 'The first row must hold the column names.',
  NO_DATA_ROWS: 'The file has a header row but no rows below it.',
};

function fileError(code: string, cause?: unknown): DomainRuleError {
  return new DomainRuleError({ code, userMessage: FILE_MESSAGES[code] ?? 'The file could not be read.', ...(cause ? { cause } : {}) });
}

// ---- DTO ----------------------------------------------------------------------------------------

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : '')) : [];
}

export function importNotesOf(value: unknown): ImportRowNote[] {
  if (!Array.isArray(value)) return [];
  const out: ImportRowNote[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { row, code, field } = item as { row?: unknown; code?: unknown; field?: unknown };
    if (!Number.isInteger(row) || typeof code !== 'string') continue;
    const note: ImportRowNote = { row: row as number, code };
    if (typeof field === 'string' && (IMPORT_MAPPABLE_FIELDS as readonly string[]).includes(field)) note.field = field as ImportRowNote['field'];
    out.push(note);
  }
  return out;
}

export function effectiveImportStatus(row: Pick<LeadImport, 'status' | 'expiresAt'>, now: Date): LeadImportStatus {
  if (row.status === 'PREVIEW' && now.getTime() >= row.expiresAt.getTime()) return 'EXPIRED';
  return row.status;
}

export function leadImportDto(row: LeadImport, now: Date): LeadImportDto {
  return {
    id: row.id,
    status: row.status,
    effectiveStatus: effectiveImportStatus(row, now),
    fileName: row.fileName,
    sheetName: row.sheetName,
    rowCount: row.rowCount,
    header: stringArray(row.header),
    mapping: row.mapping === null ? null : mappingOf(row.mapping as Record<string, unknown>),
    dataSource: (row.dataSource as ImportDataSource | null) ?? null,
    consentAttested: row.consentAttested,
    counts: {
      accepted: row.accepted,
      duplicates: row.duplicates,
      review: row.review,
      rejected: row.rejected,
      consentRecorded: row.consentRecorded,
      processed: row.accepted + row.duplicates + row.review + row.rejected,
    },
    notes: importNotesOf(row.rejections),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function previewOf(file: ImportRowsFile) {
  return { header: file.header, rows: file.rows.slice(0, LEAD_IMPORT_PREVIEW_ROWS), suggestedMapping: suggestImportMapping(file.header) };
}

function viewOf(row: LeadImport, now: Date, storageDir: string): LeadImportView {
  const dto = leadImportDto(row, now);
  if (dto.effectiveStatus !== 'PREVIEW' || row.storagePath === null) return { import: dto, preview: null };
  const file = readImportRows(storageDir, row.storagePath);
  return { import: dto, preview: file ? previewOf(file) : null };
}

// ---- Upload -------------------------------------------------------------------------------------

/** The last path segment, without control characters, at most 255 characters. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return (cleaned === '' ? 'upload' : cleaned).slice(0, 255);
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw fileError('FILE_ENCODING_INVALID');
  return Buffer.from(compact, 'base64');
}

/** Parses the upload into the stored rows file: the header and the non-blank data rows (numbered as in the sheet). */
export function parseImportUpload(input: { fileName: string; contentType: string; bytes: Uint8Array }): { file: ImportRowsFile; sheetName: string; kind: 'xlsx' | 'csv' } {
  const extension = (/\.[^.]+$/.exec(input.fileName.toLowerCase())?.[0] ?? '') as (typeof LEAD_IMPORT_EXTENSIONS)[number] | '';
  if (!(LEAD_IMPORT_EXTENSIONS as readonly string[]).includes(extension)) throw fileError('UNSUPPORTED_FILE_TYPE');
  const contentType = input.contentType.split(';')[0]!.trim().toLowerCase();
  if (!(LEAD_IMPORT_CONTENT_TYPES as readonly string[]).includes(contentType)) throw fileError('UNSUPPORTED_FILE_TYPE');
  if (input.bytes.length === 0) throw fileError('EMPTY_FILE');
  if (input.bytes.length > LEAD_IMPORT_MAX_FILE_BYTES) throw fileError('TOO_LARGE');
  const zip = isZip(input.bytes);
  if ((extension === '.xlsx') !== zip) throw fileError(extension === '.xlsx' ? 'NOT_A_WORKBOOK' : 'FILE_TYPE_MISMATCH');

  let table;
  try {
    table = readTable(input.bytes, input.fileName);
  } catch (error) {
    if (error instanceof SpreadsheetError) throw fileError(error.code, error);
    throw error;
  }
  const blank = (cells: readonly string[]) => cells.every((c) => c.trim() === '');
  const headerIndex = table.rows.findIndex((r) => !blank(r));
  if (headerIndex === -1) throw fileError(table.rows.length === 0 ? 'EMPTY_FILE' : 'NO_HEADER');
  const rawHeader = table.rows[headerIndex]!;
  if (rawHeader.length > SPREADSHEET_LIMITS.maxColumns) throw fileError('TOO_MANY_COLUMNS');
  const width = rawHeader.length;
  const header = rawHeader.map((h) => h.trim().slice(0, HEADER_CELL_MAX));
  const rows: ImportRowsFile['rows'] = [];
  for (let i = headerIndex + 1; i < table.rows.length; i += 1) {
    const cells = table.rows[i]!;
    if (blank(cells)) continue;
    if (rows.length === LEAD_IMPORT_MAX_ROWS) throw fileError('TOO_MANY_ROWS');
    rows.push({ row: i + 1, cells: Array.from({ length: width }, (_, c) => cells[c] ?? '') });
  }
  if (rows.length === 0) throw fileError('NO_DATA_ROWS');
  return { file: { version: 1, header, rows }, sheetName: table.sheetName.slice(0, 100), kind: zip ? 'xlsx' : 'csv' };
}

export async function uploadLeadImport(ctx: AppCtx, input: LeadImportUploadBody, deps: { storageDir: string }): Promise<LeadImportView & { created: boolean }> {
  requireCapability(ctx, 'leads.import');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const now = ctx.clock.now();

  const existing = await ctx.db.leadImport.findFirst({ where: { requestKey: input.requestKey } });
  if (existing) {
    if (existing.requestedBy !== actor.userId) throw new IdempotencyConflictError({ message: 'import request key used by another person' });
    return { ...viewOf(existing, now, deps.storageDir), created: false };
  }

  const fileName = safeFileName(input.fileName);
  const bytes = decodeBase64(input.dataBase64);
  const parsed = parseImportUpload({ fileName, contentType: input.contentType, bytes });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expiresAt = new Date(now.getTime() + LEAD_IMPORT_TTL_HOURS * HOUR);

  let row: LeadImport;
  try {
    row = await withTx(ctx.db, async (scoped) => {
      const tx = scoped as unknown as Prisma.TransactionClient;
      const created = await tx.leadImport.create({
        data: {
          workspaceId,
          requestKey: input.requestKey,
          requestedBy: actor.userId,
          fileName,
          sheetName: parsed.sheetName,
          sha256,
          rowCount: parsed.file.rows.length,
          header: parsed.file.header,
          rejections: [],
          status: 'PREVIEW',
          createdAt: now,
          expiresAt,
        },
      });
      const withPath = await tx.leadImport.update({ where: { id: created.id }, data: { storagePath: leadImportRelPath(workspaceId, created.id) } });
      await enqueueJob(tx as unknown as JobStore, ctx.clock, {
        type: LEAD_IMPORT_PURGE_JOB,
        payload: { importId: created.id },
        workspaceId,
        idempotencyKey: `${LEAD_IMPORT_PURGE_JOB}:${created.id}`,
        correlationId: ctx.correlationId,
        runAt: expiresAt,
        priority: LEAD_IMPORT_PRIORITY,
        kind: 'default',
      });
      await recordAudit(tx, ctx, {
        action: 'lead.import.upload',
        targetType: 'LeadImport',
        targetId: created.id,
        workspaceId,
        summary: { kind: parsed.kind, rowCount: parsed.file.rows.length, columns: parsed.file.header.length, bytes: bytes.length },
      });
      return withPath;
    });
  } catch (error) {
    // A second request with the same key won the race: answer with its import.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      const raced = await ctx.db.leadImport.findFirst({ where: { requestKey: input.requestKey } });
      if (raced && raced.requestedBy === actor.userId) return { ...viewOf(raced, now, deps.storageDir), created: false };
    }
    throw error;
  }

  const relPath = row.storagePath!;
  try {
    writeImportRows(deps.storageDir, relPath, parsed.file);
  } catch (cause) {
    await withTx(ctx.db, (scoped) =>
      (scoped as unknown as Prisma.TransactionClient).leadImport.updateMany({ where: { id: row.id, status: 'PREVIEW' }, data: { status: 'FAILED', storagePath: null, finishedAt: now } }),
    );
    throw new ImportWriteError({ message: 'the import rows file could not be written', cause });
  }
  // Ended while the file was written (`lead:erase`): the file may hold the erased person's row.
  const current = await ctx.db.leadImport.findFirst({ where: { id: row.id }, select: { status: true, storagePath: true } });
  if (current?.status !== 'PREVIEW' || current.storagePath === null) {
    deleteImportRows(deps.storageDir, relPath);
    throw new NotFoundError({ message: 'the import ended while its rows were written' });
  }
  return { import: leadImportDto(row, now), preview: previewOf(parsed.file), created: true };
}

// ---- Read ---------------------------------------------------------------------------------------

async function ownImport(ctx: AppCtx, importId: string): Promise<LeadImport> {
  requireCapability(ctx, 'leads.import');
  requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const row = await ctx.db.leadImport.findFirst({ where: { id: importId, requestedBy: actor.userId } });
  if (!row) throw new NotFoundError();
  return row;
}

export async function getLeadImportView(ctx: AppCtx, importId: string, deps: { storageDir: string }): Promise<LeadImportView> {
  const row = await ownImport(ctx, importId);
  return viewOf(row, ctx.clock.now(), deps.storageDir);
}

/** The caller's own recent imports in this workspace, newest first. */
export async function listLeadImports(ctx: AppCtx): Promise<LeadImportDto[]> {
  requireCapability(ctx, 'leads.import');
  const actor = requireActor(ctx);
  const rows = await ctx.db.leadImport.findMany({ where: { requestedBy: actor.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT });
  const now = ctx.clock.now();
  return rows.map((r) => leadImportDto(r, now));
}

// ---- Confirm ------------------------------------------------------------------------------------

/** Mapping rules: columns inside the header, one field per column, a name and a phone or email column. */
export function validateImportMapping(mapping: ImportMappingValue, headerLength: number): void {
  const used = new Map<number, string>();
  for (const [field, col] of Object.entries(mapping)) {
    if (col >= headerLength) throw new DomainRuleError({ code: 'MAPPING_COLUMN_UNKNOWN', userMessage: 'A mapped column is not in the file. Choose the columns again.' });
    if (used.has(col)) throw new DomainRuleError({ code: 'MAPPING_COLUMN_REUSED', userMessage: 'Each column can fill one field only. Choose a different column for one of them.' });
    used.set(col, field);
  }
  if (mapping.name === undefined) throw new DomainRuleError({ code: 'MAPPING_NAME_REQUIRED', userMessage: 'Choose the column that holds the business name.' });
  if (mapping.phone === undefined && mapping.email === undefined) {
    throw new DomainRuleError({ code: 'MAPPING_CONTACT_REQUIRED', userMessage: 'Choose a phone or an email column: a row without either cannot become a lead.' });
  }
}

export type ConfirmResult = { import: LeadImportDto; consent: ConsentDecision };

export async function confirmLeadImport(ctx: AppCtx, importId: string, body: Omit<LeadImportConfirmBody, 'workspaceSlug'>, deps: { storageDir: string }): Promise<ConfirmResult> {
  const row = await ownImport(ctx, importId);
  const workspaceId = requireWorkspace(ctx);
  const now = ctx.clock.now();
  const status = effectiveImportStatus(row, now);
  if (status === 'EXPIRED') throw new ImportExpiredError();
  if (status !== 'PREVIEW') throw new ImportNotInPreviewError();
  const header = stringArray(row.header);
  const mapping = mappingOf(body.mapping);
  validateImportMapping(mapping, header.length);
  if (row.storagePath === null || readImportRows(deps.storageDir, row.storagePath) === null) throw new ImportExpiredError();

  const consent: ConsentDecision = { requested: body.consent !== undefined, honoured: false, reason: body.consent === undefined ? 'NOT_REQUESTED' : null };
  // Without an honoured consent decision the consent columns are not imported at all.
  const stored: ImportMappingValue = { ...mapping };
  delete stored.consent;
  delete stored.consentDate;
  if (consent.requested && consent.reason === null) consent.reason = hasCapability(ctx, 'consent.import') ? 'NO_CONSENT_COLUMN' : 'NO_CAPABILITY';

  return withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Prisma.TransactionClient;
    const done = await tx.leadImport.updateMany({
      where: { id: row.id, status: 'PREVIEW' },
      data: { status: 'QUEUED', mapping: stored as Prisma.InputJsonValue, dataSource: body.dataSource ?? null },
    });
    if (done.count !== 1) throw new ImportNotInPreviewError();
    const { job } = await enqueueJob(tx as unknown as JobStore, ctx.clock, {
      type: LEAD_IMPORT_JOB,
      payload: { importId: row.id, chunk: 0 },
      workspaceId,
      idempotencyKey: `${LEAD_IMPORT_JOB}:${row.id}:0`,
      correlationId: ctx.correlationId,
      priority: LEAD_IMPORT_PRIORITY,
      kind: 'default',
    });
    await recordAudit(tx, ctx, {
      action: 'lead.import.confirm',
      targetType: 'LeadImport',
      targetId: row.id,
      workspaceId,
      summary: { fields: Object.keys(stored).sort(), dataSource: body.dataSource ?? null, rowCount: row.rowCount, consent: consent.honoured ? 'HONOURED' : (consent.reason ?? 'NOT_REQUESTED'), jobId: job.id },
    });
    const updated = await tx.leadImport.findUniqueOrThrow({ where: { id: row.id } });
    return { import: leadImportDto(updated, now), consent };
  });
}

// ---- Import page --------------------------------------------------------------------------------

export type LeadImportPageData = {
  workspace: { name: string; slug: string; timezone: string };
  canRead: boolean;
  canImport: boolean;
  /** ADR-120: only an owner (consent.import) sees the consent section. */
  canImportConsent: boolean;
  /** The workspace's WhatsApp opt-in notice (ADR-125), or a default that names the business and WhatsApp. */
  noticeDefault: string;
  attestationText: string;
  recent: LeadImportDto[];
  /** The import named by `?import=`, when it is one of the viewer's own. */
  current: LeadImportView | null;
};

export function defaultImportNotice(business: string): string {
  return `${business} will send you offers and updates about its products and services on WhatsApp. Reply STOP at any time to stop these messages.`;
}

export async function loadLeadImportPage(ctx: AppCtx, opts: { importId?: string | null; storageDir: string }): Promise<LeadImportPageData> {
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, slug: true, timezone: true } });
  const canImport = hasCapability(ctx, 'leads.import');
  const settings = await ctx.db.workspaceSettings.findFirst({ select: { whatsappOptInNotice: true } });
  const notice = settings?.whatsappOptInNotice?.trim();
  let current: LeadImportView | null = null;
  if (canImport && opts.importId) {
    try {
      current = await getLeadImportView(ctx, opts.importId, { storageDir: opts.storageDir });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  return {
    workspace,
    canRead: hasCapability(ctx, 'leads.read'),
    canImport,
    canImportConsent: canImport && hasCapability(ctx, 'consent.import'),
    noticeDefault: notice ? notice : defaultImportNotice(workspace.name),
    attestationText: consentAttestationText(workspace.name),
    recent: canImport ? await listLeadImports(ctx) : [],
    current,
  };
}

// ---- Sample workbook ----------------------------------------------------------------------------

/** The sample's header: one column per mappable field, named so the suggestions map every one. */
export const SAMPLE_WORKBOOK_HEADER: readonly string[] = ['Business name', 'Phone', 'Email', 'Website', 'Address', 'City', 'Category', 'Rating', 'Reviews', 'Pincode', 'WhatsApp opt-in', 'Opt-in date'];

/** Five clearly fictitious businesses: "Example" names, +91 90000 0000x numbers and example.com addresses. */
export const SAMPLE_WORKBOOK_ROWS: ReadonlyArray<readonly string[]> = [
  ['Example Sweets and Snacks', '+91 90000 00001', 'orders@sweets.example.com', '', '12 Example Market Road', 'Indore', 'Sweet shop', '4.5', '128', '452001', '', ''],
  ['Example Fitness Studio', '+91 90000 00002', '', 'https://fitness.example.com', '4 Example Lane, Koregaon Park', 'Pune', 'Gym', '4.2', '86', '411001', '', ''],
  ['Example Dental Care', '+91 90000 00003', 'hello@dental.example.org', 'https://dental.example.org', '88 Example Nagar', 'Jaipur', 'Dentist', '4.7', '210', '302001', 'yes', '14/09/2026'],
  ['Example Tailors', '+91 90000 00004', '', '', '3 Example Bazaar', 'Lucknow', 'Tailor', '', '', '226001', '', ''],
  ['Example Bakery House', '+91 90000 00005', 'contact@bakery.example.net', '', '21 Example Colony', 'Bhopal', 'Bakery', '4.8', '342', '462001', 'no', ''],
];

export function buildLeadImportSampleWorkbook(): Uint8Array {
  return writeXlsx({ sheetName: 'Leads', header: SAMPLE_WORKBOOK_HEADER, rows: SAMPLE_WORKBOOK_ROWS });
}
