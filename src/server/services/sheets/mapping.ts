/**
 * The Sheets column mapping (T34; plan §5.3 SheetMapping, P1, ADR-103). A mapping is confirmed
 * against the Sheet's live header row: the server re-reads row 1 (never trusting the browser's
 * copy), refuses a mapping made for a different header (409 HEADER_CHANGED), checks every mapped
 * column exists and is used once, that a name and a phone or email are mapped, and that the
 * consent column (P1) has its yes answers and the verbatim notice text (hashed). Confirming
 * creates version N+1 as the only active version (CAS on the version the editor started from), with
 * the header fingerprint and names, so later drift can be shown as a column diff.
 */
import type { Prisma } from '@/generated/prisma/client';
import type { ConsentMapping } from '@/lib/schemas/ingest';
import { consentMappingSchema } from '@/lib/schemas/ingest';
import { SHEETS_EVENT_ID_COLUMN, type SheetsMappingInput } from '@/lib/schemas/sheets';
import { fieldMapSchema, type FieldMap } from '@/lib/schemas/webhooks';
import { ConflictError, ValidationError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { noticeTextHash } from '@/server/services/messaging/consent';
import { openSheets, readSheetHeader, unwrap, type SheetsDeps } from './access';
import { columnDiff, type HeaderInfo } from './header';

export type ActiveSheetMapping = {
  id: string;
  version: number;
  headerFingerprint: string;
  headerColumns: string[] | null;
  fieldMap: FieldMap;
  consent: ConsentMapping | null;
  submittedAtColumn: string | null;
};

type MappingRow = { id: string; version: number; headerFingerprint: string; headerColumns: unknown; fieldMap: unknown; consentMapping: unknown; submittedAtColumn: string | null };

export function toActiveMapping(row: MappingRow): ActiveSheetMapping {
  const fields = fieldMapSchema.safeParse(row.fieldMap);
  const consent = row.consentMapping === null || row.consentMapping === undefined ? null : consentMappingSchema.safeParse(row.consentMapping);
  return {
    id: row.id,
    version: row.version,
    headerFingerprint: row.headerFingerprint,
    headerColumns: Array.isArray(row.headerColumns) ? row.headerColumns.filter((c): c is string => typeof c === 'string') : null,
    fieldMap: fields.success ? fields.data : {},
    consent: consent && consent.success ? consent.data : null,
    submittedAtColumn: row.submittedAtColumn,
  };
}

type MappingDb = { sheetMapping: { findFirst(args: { where: { integrationId: string; active: true }; orderBy: { version: 'desc' } }): PromiseLike<MappingRow | null> } };

export async function loadActiveMapping(db: MappingDb, integrationId: string): Promise<ActiveSheetMapping | null> {
  const row = await db.sheetMapping.findFirst({ where: { integrationId, active: true }, orderBy: { version: 'desc' } });
  return row ? toActiveMapping(row) : null;
}

/** The columns a mapping reads (fields, consent, submission time): what the script and the sync send. */
export function mappedColumns(mapping: { fieldMap: FieldMap; consent: { column: string } | null; submittedAtColumn: string | null }): string[] {
  const out: string[] = [];
  const add = (c: string | null | undefined) => {
    if (c && !out.includes(c)) out.push(c);
  };
  if (mapping.submittedAtColumn) add(mapping.submittedAtColumn);
  for (const c of Object.values(mapping.fieldMap)) add(c);
  add(mapping.consent?.column);
  return out;
}

export type MappingProblem = { field: string; message: string };

export function validateMapping(input: SheetsMappingInput, header: HeaderInfo): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const exists = new Set(header.names);
  if (header.names.length === 0) problems.push({ field: 'header', message: 'Row 1 of the Sheet is empty: the first row must hold the column names.' });
  for (const d of header.duplicates) problems.push({ field: 'header', message: `Two columns are named "${d}". Rename one in the Sheet so each column has its own name.` });
  const used = new Map<string, string>();
  const claim = (field: string, column: string) => {
    if (column === SHEETS_EVENT_ID_COLUMN) problems.push({ field, message: `"${SHEETS_EVENT_ID_COLUMN}" is the Apps Script's own column and cannot be mapped.` });
    else if (!exists.has(column)) problems.push({ field, message: `The Sheet has no column "${column}".` });
    const previous = used.get(column);
    if (previous !== undefined) problems.push({ field, message: `"${column}" is already used for ${previous}.` });
    else used.set(column, field);
  };
  for (const [field, column] of Object.entries(input.fieldMap)) if (column) claim(field, column);
  if (!input.fieldMap.name) problems.push({ field: 'name', message: 'Map the column with the person’s name.' });
  if (!input.fieldMap.phone && !input.fieldMap.email) problems.push({ field: 'phone', message: 'Map a phone or an email column: a row without either cannot become a lead.' });
  if (input.submittedAtColumn) claim('submittedAtColumn', input.submittedAtColumn);
  if (input.consent) {
    claim('consent', input.consent.column);
    if (!input.submittedAtColumn) problems.push({ field: 'submittedAtColumn', message: 'Consent needs the submission time: map the form’s Timestamp column.' });
  }
  return problems;
}

function invalid(problems: MappingProblem[]): ValidationError {
  return new ValidationError({ code: 'MAPPING_INVALID', userMessage: problems[0]!.message + (problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''), safeDetails: { problems } });
}

export type ConfirmMappingInput = { expectedVersion: number; headerFingerprint: string; mapping: SheetsMappingInput };
export type ConfirmMappingResult = { version: number; previousVersion: number | null; headerFingerprint: string; columns: string[] };

export async function confirmSheetMapping(ctx: AppCtx, input: ConfirmMappingInput, deps: SheetsDeps): Promise<ConfirmMappingResult> {
  requireCapability(ctx, 'sheets.manage');
  const workspaceId = requireWorkspace(ctx);
  const opened = unwrap(await openSheets(ctx, deps));
  const read = unwrap(await readSheetHeader(opened));
  if (read.header.fingerprint !== input.headerFingerprint) {
    throw new ConflictError({
      code: 'HEADER_CHANGED',
      userMessage: 'The Sheet’s columns changed since you loaded them. Load the columns again and check the mapping.',
      safeDetails: { current: read.header.names },
    });
  }
  const problems = validateMapping(input.mapping, read.header);
  if (problems.length > 0) throw invalid(problems);
  const consent = input.mapping.consent ? { ...input.mapping.consent, noticeTextHash: noticeTextHash(input.mapping.consent.noticeText) } : null;

  return withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Prisma.TransactionClient;
    const active = await tx.sheetMapping.findFirst({ where: { workspaceId, integrationId: opened.integration.id, active: true }, orderBy: { version: 'desc' } });
    if ((active?.version ?? 0) !== input.expectedVersion) {
      throw new ConflictError({ code: 'MAPPING_VERSION_CONFLICT', userMessage: 'Someone confirmed another mapping meanwhile. Reload the page and check it.' });
    }
    const latest = await tx.sheetMapping.findFirst({ where: { workspaceId, integrationId: opened.integration.id }, orderBy: { version: 'desc' }, select: { version: true } });
    await tx.sheetMapping.updateMany({ where: { workspaceId, integrationId: opened.integration.id, active: true }, data: { active: false } });
    const created = await tx.sheetMapping.create({
      data: {
        workspaceId,
        integrationId: opened.integration.id,
        version: (latest?.version ?? 0) + 1,
        headerFingerprint: read.header.fingerprint,
        headerColumns: read.header.names,
        fieldMap: input.mapping.fieldMap,
        consentMapping: consent ?? undefined,
        submittedAtColumn: input.mapping.submittedAtColumn,
        active: true,
      },
    });
    const diff = active?.headerColumns && Array.isArray(active.headerColumns) ? columnDiff(active.headerColumns as string[], read.header.names) : null;
    await recordAudit(tx, ctx, {
      action: 'sheets.mapping.confirm',
      targetType: 'SheetMapping',
      targetId: created.id,
      summary: { version: created.version, previousVersion: active?.version ?? null, fields: Object.keys(input.mapping.fieldMap), consentMapped: consent !== null, columnsAdded: diff?.added.length ?? null, columnsRemoved: diff?.removed.length ?? null },
    });
    return { version: created.version, previousVersion: active?.version ?? null, headerFingerprint: read.header.fingerprint, columns: read.header.names };
  });
}

/** POST /api/app/sheets/header: row 1 as the mapping form needs it, with the drift against the active mapping. */
export async function readMappingHeader(ctx: AppCtx, deps: SheetsDeps) {
  requireCapability(ctx, 'sheets.manage');
  const opened = unwrap(await openSheets(ctx, deps));
  const read = unwrap(await readSheetHeader(opened));
  const active = await loadActiveMapping(ctx.db, opened.integration.id);
  const drift = active && active.headerFingerprint !== read.header.fingerprint ? columnDiff(active.headerColumns ?? [], read.header.names) : null;
  return {
    tab: read.tab,
    columns: read.header.names,
    duplicates: read.header.duplicates,
    hasEventIdColumn: read.header.eventIdIndex !== null,
    headerFingerprint: read.header.fingerprint,
    activeVersion: active?.version ?? 0,
    drift,
  };
}
