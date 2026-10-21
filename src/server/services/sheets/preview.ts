/**
 * Sheets preview, a dry run (T34; PRD "mapping, preview"): reads the rows the next "Sync now" would
 * read (after the sync cursor, at most 10), maps them through the same functions the sync and the
 * webhook use (`rowsFromValues`, `sheetsToIngest`, the ingestion schema and normalizer) and says per
 * row what ingestion would do: create a lead, merge into one existing lead, open a merge review,
 * skip a row already received, or reject it (with the reason), and whether WhatsApp/email consent
 * would be recorded (P1). It WRITES NOTHING: no lead, source record, batch, audit row or integration
 * status; only reads through the workspace-scoped client and Google.
 */
import { ingestBatchSchema, type IngestRecord } from '@/lib/schemas/ingest';
import { SHEETS_PREVIEW_ROWS, type SheetsMappingInput } from '@/lib/schemas/sheets';
import { ValidationError, DomainRuleError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { contactKeysFor, findMatchingLeadIds } from '@/server/services/leads/dedupe';
import { normalizeLeadFields } from '@/server/services/leads/normalize';
import { isTruthyAnswer, noticeTextHash } from '@/server/services/messaging/consent';
import { sheetsToIngest } from '@/server/services/webhooks/payload-mapping';
import { openSheets, readSheetHeader, readSheetRows, unwrap, type SheetsDeps } from './access';
import { columnDiff, type ColumnDiff } from './header';
import { loadActiveMapping, mappedColumns, validateMapping } from './mapping';
import { rowsFromValues } from './rows';
import { lastCursorRow } from './sync';

export type PreviewOutcome = 'CREATE' | 'MERGE' | 'REVIEW' | 'ALREADY_RECEIVED' | 'REJECT';

export type PreviewRow = {
  rowNumber: number;
  outcome: PreviewOutcome;
  reasonCode: string | null;
  displayName: string | null;
  contacts: Array<'phone' | 'email'>;
  /** WOULD_CAPTURE, or why no consent would be recorded. */
  consent: string;
  weakId: boolean;
};

export type PreviewResult = {
  mappingVersion: number | null;
  proposed: boolean;
  tab: string;
  columns: string[];
  headerFingerprint: string;
  drift: ColumnDiff | null;
  fromRow: number;
  rows: PreviewRow[];
  counts: Record<PreviewOutcome, number>;
  emptyRows: number[];
  pendingRows: number[];
};

function consentPrediction(mapping: { consent: { column: string; truthyValues: string[]; channel: string } | null }, record: IngestRecord, phone: string | null, email: string | null): string {
  const c = mapping.consent;
  if (!c) return 'NO_MAPPING';
  const answers = record.answers ?? {};
  if (!Object.prototype.hasOwnProperty.call(answers, c.column)) return 'COLUMN_MISSING';
  if (!isTruthyAnswer(answers[c.column], c.truthyValues)) return 'FALSY_VALUE';
  if (!record.submittedAt) return 'NO_EVIDENCE_TIME';
  if ((c.channel === 'WHATSAPP' ? phone : email) === null) return 'NO_CONTACT_FOR_CHANNEL';
  return 'WOULD_CAPTURE';
}

export async function previewSheetRows(ctx: AppCtx, input: { mapping?: SheetsMappingInput }, deps: SheetsDeps): Promise<PreviewResult> {
  requireCapability(ctx, 'sheets.manage');
  requireWorkspace(ctx);
  const opened = unwrap(await openSheets(ctx, deps));
  const read = unwrap(await readSheetHeader(opened));
  const active = await loadActiveMapping(ctx.db, opened.integration.id);

  let mapping: { version: number | null; fieldMap: SheetsMappingInput['fieldMap']; consent: (NonNullable<SheetsMappingInput['consent']> & { noticeTextHash?: string }) | null; submittedAtColumn: string | null };
  if (input.mapping) {
    const problems = validateMapping(input.mapping, read.header);
    if (problems.length > 0) throw new ValidationError({ code: 'MAPPING_INVALID', userMessage: problems[0]!.message, safeDetails: { problems } });
    mapping = { version: null, fieldMap: input.mapping.fieldMap, consent: input.mapping.consent ? { ...input.mapping.consent, noticeTextHash: noticeTextHash(input.mapping.consent.noticeText) } : null, submittedAtColumn: input.mapping.submittedAtColumn };
  } else {
    if (!active) throw new DomainRuleError({ code: 'MAPPING_NOT_CONFIRMED', userMessage: 'Confirm a column mapping first, or preview the mapping you are editing.' });
    mapping = { version: active.version, fieldMap: active.fieldMap, consent: active.consent, submittedAtColumn: active.submittedAtColumn };
  }
  const drift = active && active.headerFingerprint !== read.header.fingerprint ? columnDiff(active.headerColumns ?? [], read.header.names) : null;

  const fromRow = (await lastCursorRow(ctx, opened.integration.id)) + 1;
  const values = unwrap(await readSheetRows(opened, read.tab, fromRow, fromRow + SHEETS_PREVIEW_ROWS - 1));
  const parsedRows = rowsFromValues(read.header, values, { firstRowNumber: fromRow, submittedAtColumn: mapping.submittedAtColumn, timeZone: read.timeZone, columns: new Set(mappedColumns(mapping)) });

  const rows: PreviewRow[] = [];
  const counts: Record<PreviewOutcome, number> = { CREATE: 0, MERGE: 0, REVIEW: 0, ALREADY_RECEIVED: 0, REJECT: 0 };
  if (parsedRows.records.length > 0) {
    const sheetId = opened.client.spreadsheetId;
    const ingest = ingestBatchSchema.parse(
      sheetsToIngest(
        { version: 1, eventId: 'preview', sheetId, mappingVersion: mapping.version ?? 1, rows: parsedRows.records.map((r) => ({ rowKey: r.rowKey, ...(r.weakId ? { weakId: true } : {}), ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}), values: r.values })) },
        { version: mapping.version ?? undefined, fieldMap: mapping.fieldMap, consentMapping: mapping.consent },
        { externalBatchId: 'preview', simulated: false },
      ),
    );
    const seen = new Set<string>();
    for (const [i, record] of ingest.records.entries()) {
      const rowNumber = parsedRows.records[i]!.rowNumber;
      const weakId = parsedRows.records[i]!.weakId;
      const normalized = normalizeLeadFields(record.fields);
      const base = { rowNumber, weakId, displayName: normalized.ok ? normalized.lead.displayName : null, contacts: normalized.ok ? ([...(normalized.lead.phoneE164 ? ['phone'] : []), ...(normalized.lead.emailNormalized ? ['email'] : [])] as Array<'phone' | 'email'>) : [] };
      let row: PreviewRow;
      if (seen.has(record.externalId)) row = { ...base, outcome: 'REJECT', reasonCode: 'DUPLICATE_IN_BATCH', consent: 'REJECTED' };
      else if (await ctx.db.leadSourceRecord.findFirst({ where: { source: 'GOOGLE_SHEETS', externalId: record.externalId }, select: { id: true } })) row = { ...base, outcome: 'ALREADY_RECEIVED', reasonCode: 'ALREADY_RECEIVED', consent: 'NOT_CAPTURED' };
      else if (!normalized.ok) row = { ...base, outcome: 'REJECT', reasonCode: normalized.reasonCode, consent: 'REJECTED' };
      else {
        const matches = await findMatchingLeadIds(ctx.db as never, contactKeysFor(normalized.lead, 'GOOGLE_SHEETS'));
        const consent = consentPrediction(mapping, record, normalized.lead.phoneE164, normalized.lead.emailNormalized);
        if (matches.length > 1) row = { ...base, outcome: 'REVIEW', reasonCode: 'MULTIPLE_MATCHES', consent: 'PENDING_REVIEW' };
        else if (matches.length === 1) row = { ...base, outcome: 'MERGE', reasonCode: 'CONTACT_MATCH', consent };
        else row = { ...base, outcome: 'CREATE', reasonCode: null, consent };
      }
      seen.add(record.externalId);
      counts[row.outcome] += 1;
      rows.push(row);
    }
  }
  return {
    mappingVersion: mapping.version,
    proposed: input.mapping !== undefined,
    tab: read.tab,
    columns: read.header.names,
    headerFingerprint: read.header.fingerprint,
    drift,
    fromRow,
    rows,
    counts,
    emptyRows: parsedRows.emptyRows,
    pendingRows: parsedRows.pendingRows,
  };
}
