/**
 * Lead import from Excel or CSV (ADR-120, slice F2): the request bodies, the column mapping, the
 * row outcome codes and the pure helpers shared by the routes, the services, the import job and the
 * import page (plan §2: one schema set). Framework-free and browser-safe.
 *
 * - Upload: base64 inside JSON (`LeadImportUploadBody`, file at most 5 MB, body cap
 *   `LEAD_IMPORT_MAX_BODY_BYTES`); the server parses it with `readTable` (ADR-117).
 * - Mapping: `IMPORT_MAPPABLE_FIELDS` -> a column index of the header row. `suggestImportMapping`
 *   proposes one from header synonyms; the person confirms it on the preview.
 * - Rows: at most `LEAD_IMPORT_MAX_ROWS` data rows, processed `LEAD_IMPORT_CHUNK` per job.
 *   Outcomes keep the row number, a code and the field name only (never cell values).
 * - Consent (ADR-120 compliance rules): the consent column is honoured only for an owner with
 *   `consent.import`, an own data source, a notice naming the business and WhatsApp, the
 *   attestation below accepted verbatim, and a consent-date column with no future dates.
 */
import { z } from 'zod';
import { ImportDataSource, type LeadImportStatus } from '../domain/enums';
import { SPREADSHEET_LIMITS } from '../spreadsheet/types';
import { workspaceSlugField } from './lead-console';

// ---- Limits -------------------------------------------------------------------------------------

/** Data rows (below the header) one import may hold (ADR-120). */
export const LEAD_IMPORT_MAX_ROWS = 2_000;
/** Rows per `leads.import` job, each chunk one `ingestBatch` call. */
export const LEAD_IMPORT_CHUNK = 200;
/** Rows shown on the preview. */
export const LEAD_IMPORT_PREVIEW_ROWS = 20;
/** Hours a parsed file is kept before `leads.importPurge` deletes it (ADR-120). */
export const LEAD_IMPORT_TTL_HOURS = 24;
/** The largest file accepted (the spreadsheet module's own limit). */
export const LEAD_IMPORT_MAX_FILE_BYTES = SPREADSHEET_LIMITS.maxFileBytes;
/** Base64 characters of the largest file. */
export const LEAD_IMPORT_MAX_BASE64_CHARS = Math.ceil(LEAD_IMPORT_MAX_FILE_BYTES / 3) * 4;
/** The JSON body cap of the upload route: base64 of 5 MB plus the envelope (about 7 MB). A larger body is 413. */
export const LEAD_IMPORT_MAX_BODY_BYTES = LEAD_IMPORT_MAX_BASE64_CHARS + 64 * 1024;
/** File types the upload accepts (the bytes decide: a zip is a workbook, anything else UTF-8 CSV). */
export const LEAD_IMPORT_EXTENSIONS = ['.xlsx', '.csv'] as const;
export const LEAD_IMPORT_ACCEPT = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
/** Content types a browser may send for those files (Windows reports CSV as application/vnd.ms-excel). */
export const LEAD_IMPORT_CONTENT_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
  '',
] as const;
export const LEAD_IMPORT_XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---- Fields and mapping -------------------------------------------------------------------------

export const IMPORT_MAPPABLE_FIELDS = ['name', 'phone', 'email', 'website', 'address', 'city', 'category', 'rating', 'reviewCount', 'pincode', 'consent', 'consentDate'] as const;
export type ImportField = (typeof IMPORT_MAPPABLE_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Readonly<Record<ImportField, string>> = {
  name: 'Business name',
  phone: 'Phone',
  email: 'Email',
  website: 'Website',
  address: 'Address',
  city: 'City',
  category: 'Category',
  rating: 'Rating',
  reviewCount: 'Reviews',
  pincode: 'PIN code',
  consent: 'WhatsApp opt-in',
  consentDate: 'Opt-in date',
};

/** The lead fields (everything but the two consent columns). */
export const IMPORT_LEAD_FIELDS = IMPORT_MAPPABLE_FIELDS.filter((f): f is Exclude<ImportField, 'consent' | 'consentDate'> => f !== 'consent' && f !== 'consentDate');

/** Longest cell accepted per field (the ingestion contract's limits); a longer value rejects the row FIELD_TOO_LONG. */
export const IMPORT_FIELD_MAX_LENGTH: Readonly<Record<ImportField, number>> = {
  name: 300,
  phone: 300,
  email: 320,
  website: 2048,
  address: 1000,
  city: 200,
  category: 200,
  rating: 20,
  reviewCount: 40,
  pincode: 20,
  consent: 200,
  consentDate: 100,
};

const columnIndex = z
  .number()
  .int()
  .min(0)
  .max(SPREADSHEET_LIMITS.maxColumns - 1)
  .nullish();

/** Field -> column index of the header row (null or absent: not imported). */
export const ImportMapping = z.object({
  name: columnIndex,
  phone: columnIndex,
  email: columnIndex,
  website: columnIndex,
  address: columnIndex,
  city: columnIndex,
  category: columnIndex,
  rating: columnIndex,
  reviewCount: columnIndex,
  pincode: columnIndex,
  consent: columnIndex,
  consentDate: columnIndex,
});
export type ImportMapping = z.output<typeof ImportMapping>;
/** A mapping without the unmapped fields. */
export type ImportMappingValue = Partial<Record<ImportField, number>>;

export function mappingOf(mapping: ImportMapping | ImportMappingValue | null | undefined): ImportMappingValue {
  const out: ImportMappingValue = {};
  if (!mapping) return out;
  for (const field of IMPORT_MAPPABLE_FIELDS) {
    const value = (mapping as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[field] = value;
  }
  return out;
}

/** `B: Phone number` (or the letter alone for a blank header cell). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function columnLabel(index: number, header: string | undefined): string {
  const name = (header ?? '').trim();
  return name === '' ? columnLetter(index) : `${columnLetter(index)}: ${name}`;
}

// ---- Header synonyms ----------------------------------------------------------------------------

/** Lower case, width folded (NFKC), every run of punctuation or spaces one space. */
export function normalizeHeaderText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whole header names that mean a field outright. */
const EXACT: Readonly<Record<ImportField, readonly string[]>> = {
  name: ['name', 'business', 'business name', 'company', 'company name', 'shop', 'shop name', 'store', 'store name', 'firm', 'firm name', 'brand', 'organisation', 'organization'],
  phone: ['phone', 'phone number', 'phone no', 'mobile', 'mobile number', 'mobile no', 'whatsapp', 'whatsapp number', 'whatsapp no', 'contact', 'contact number', 'contact no', 'number', 'tel', 'telephone', 'cell', 'mob'],
  email: ['email', 'e mail', 'email address', 'e mail address', 'mail', 'email id', 'mail id'],
  website: ['website', 'web site', 'site', 'url', 'web', 'website url', 'homepage', 'domain'],
  address: ['address', 'full address', 'street address', 'location', 'addr'],
  city: ['city', 'town', 'district'],
  category: ['category', 'type', 'business type', 'business category', 'industry'],
  rating: ['rating', 'ratings', 'stars', 'star rating', 'google rating', 'avg rating'],
  reviewCount: ['reviews', 'review', 'review count', 'reviews count', 'number of reviews', 'no of reviews', 'total reviews'],
  pincode: ['pincode', 'pin code', 'pin', 'zip', 'zip code', 'zipcode', 'postal code', 'postcode', 'post code'],
  consent: ['consent', 'consented', 'opt in', 'optin', 'opted in', 'whatsapp opt in', 'whatsapp optin', 'whatsapp consent'],
  consentDate: ['consent date', 'opt in date', 'optin date', 'opted in on', 'consented on', 'consent on', 'date of consent', 'opt in on', 'consent time', 'opt in time'],
};

const CONSENT_WORDS = ['consent', 'consented', 'opt in', 'optin', 'opted in'];
const DATE_WORDS = ['date', 'on', 'when', 'time', 'at', 'timestamp', 'day'];

const has = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);
const hasAny = (text: string, phrases: readonly string[]) => phrases.some((p) => has(text, p));

/**
 * Word rules for headers that are not an exact name, most specific first. A column takes the
 * first rule it matches; if that field is already mapped the column stays unmapped (an "Email
 * address" column never becomes the address).
 */
const RULES: ReadonlyArray<readonly [ImportField, (text: string) => boolean]> = [
  ['consentDate', (t) => hasAny(t, CONSENT_WORDS) && hasAny(t, DATE_WORDS)],
  ['consent', (t) => hasAny(t, CONSENT_WORDS)],
  ['email', (t) => hasAny(t, ['email', 'e mail', 'mail'])],
  ['website', (t) => hasAny(t, ['website', 'web site', 'site', 'url', 'web', 'homepage', 'domain'])],
  ['pincode', (t) => hasAny(t, ['pincode', 'pin code', 'pin', 'zip', 'zipcode', 'postal code', 'postcode', 'post code'])],
  ['reviewCount', (t) => hasAny(t, ['reviews', 'review'])],
  ['rating', (t) => hasAny(t, ['rating', 'ratings', 'stars', 'star'])],
  ['name', (t) => has(t, 'name')],
  ['phone', (t) => hasAny(t, ['phone', 'mobile', 'whatsapp', 'contact', 'number', 'tel', 'telephone', 'cell', 'mob'])],
  ['address', (t) => hasAny(t, ['address', 'addr', 'location', 'street', 'area', 'locality'])],
  ['city', (t) => hasAny(t, ['city', 'town', 'district'])],
  ['category', (t) => hasAny(t, ['category', 'type', 'industry', 'segment'])],
  ['name', (t) => hasAny(t, ['business', 'company', 'shop', 'store', 'firm', 'brand', 'organisation', 'organization'])],
];

/** A suggested mapping from the header row: exact names first, then the word rules, column by column. */
export function suggestImportMapping(header: readonly string[]): ImportMappingValue {
  const texts = header.map((h) => normalizeHeaderText(h ?? ''));
  const out: ImportMappingValue = {};
  const usedColumns = new Set<number>();
  texts.forEach((text, col) => {
    if (text === '') return;
    const field = IMPORT_MAPPABLE_FIELDS.find((f) => EXACT[f].includes(text));
    if (field !== undefined && out[field] === undefined) {
      out[field] = col;
      usedColumns.add(col);
    }
  });
  texts.forEach((text, col) => {
    if (text === '' || usedColumns.has(col)) return;
    if (IMPORT_MAPPABLE_FIELDS.some((f) => EXACT[f].includes(text))) return; // an exact name whose field was taken
    const rule = RULES.find(([, test]) => test(text));
    if (!rule) return;
    const [field] = rule;
    if (out[field] !== undefined) return;
    out[field] = col;
    usedColumns.add(col);
  });
  return out;
}

// ---- Request bodies -----------------------------------------------------------------------------

/** A client-generated key per upload: a double click or retry returns the same import. */
export const LeadImportRequestKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'requestKey must be 8-64 letters, digits, _ or -');

export const LeadImportUploadBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  requestKey: LeadImportRequestKey,
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(200),
  dataBase64: z.string().min(1).max(LEAD_IMPORT_MAX_BASE64_CHARS + 16),
});
export type LeadImportUploadBody = z.output<typeof LeadImportUploadBody>;

export const LeadImportConsentBody = z.object({
  /** The notice the people on the list saw: must name the business and WhatsApp. Stored verbatim with its hash. */
  noticeText: z.string().trim().min(1).max(5000),
  /** The attestation text exactly as shown (`consentAttestationText`). */
  attestation: z.string().trim().min(1).max(2000),
});
export type LeadImportConsentBody = z.output<typeof LeadImportConsentBody>;

export const LeadImportConfirmBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  mapping: ImportMapping,
  dataSource: z.enum(ImportDataSource).optional(),
  consent: LeadImportConsentBody.optional(),
});
export type LeadImportConfirmBody = z.output<typeof LeadImportConfirmBody>;

export const LeadImportQuery = z.object({ workspaceSlug: workspaceSlugField.optional() });

// ---- Data source and consent --------------------------------------------------------------------

export const IMPORT_DATA_SOURCE_LABELS: Readonly<Record<ImportDataSource, string>> = {
  OWN_CUSTOMERS: 'Our own customers or enquiries',
  OWN_FORM_OR_EVENT: 'Our own form, event or visiting cards',
  PUBLIC_DIRECTORY: 'A public directory or listing',
  THIRD_PARTY_LIST: 'A list from another company',
};

/** Data sources whose consent column can be honoured: lists the business collected itself. */
export const OWN_DATA_SOURCES: readonly ImportDataSource[] = ['OWN_CUSTOMERS', 'OWN_FORM_OR_EVENT'];

export function isOwnDataSource(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && (OWN_DATA_SOURCES as readonly string[]).includes(value);
}

/** Cell values that mean "this person opted in" (case, width and spacing folded when compared). */
export const IMPORT_CONSENT_TRUTHY_VALUES = ['yes', 'y', 'true', '1', 'opted in', 'opt in', 'opt-in', 'consented', 'agreed'] as const;

/** The <purpose> of the attestation: an OPT_IN MARKETING consent. */
export const IMPORT_CONSENT_PURPOSE_TEXT = 'its products and services';

/** ADR-120 attestation, verbatim, with the workspace's business name. */
export function consentAttestationText(business: string): string {
  return (
    `I confirm that each row marked as consented is a person who, on the date given, agreed to receive WhatsApp messages from ${business} ` +
    `about ${IMPORT_CONSENT_PURPOSE_TEXT} after seeing the notice below; that ${business} collected this list itself (it was not bought or scraped); ` +
    'and that I can produce the evidence on request. I understand this import will not re-subscribe anyone who has replied STOP.'
  );
}

export type NoticeProblem = 'NOTICE_MISSING_BUSINESS' | 'NOTICE_MISSING_WHATSAPP';

const fold = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** What a consent notice lacks: the business name and the word WhatsApp (ADR-120). */
export function noticeProblems(notice: string, business: string): NoticeProblem[] {
  const text = fold(notice);
  const problems: NoticeProblem[] = [];
  if (fold(business) === '' || !text.includes(fold(business))) problems.push('NOTICE_MISSING_BUSINESS');
  if (!text.includes('whatsapp')) problems.push('NOTICE_MISSING_WHATSAPP');
  return problems;
}

// ---- Consent dates ------------------------------------------------------------------------------

const SERIAL_EPOCH_OFFSET_DAYS = 25569; // 1970-01-01 as an Excel serial
const SERIAL_MIN = 25569; // 1970-01-01
const SERIAL_MAX = 73050; // 2099-12-31
const DAY_MS = 86_400_000;

function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(
    new Date(at),
  );
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** A wall-clock time in `timeZone` as an instant. */
function wallToInstant(wallUtcMs: number, timeZone: string): Date | null {
  try {
    let instant = wallUtcMs - zoneOffsetMs(timeZone, wallUtcMs);
    instant = wallUtcMs - zoneOffsetMs(timeZone, instant);
    return new Date(instant);
  } catch {
    return null;
  }
}

function wall(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SERIAL = /^\d{5}(?:\.\d+)?$/;

/**
 * A consent-date cell as an instant: ISO dates (with an offset, or wall time in the workspace's
 * zone), day-first Indian dates (`14/09/2026`, `14-09-2026`, `14.09.2026`, optional `HH:MM`) or an
 * Excel date serial (the reader returns dates as serials). A date without a time is the start of
 * that day in the zone. Anything else, or an impossible date, is null.
 */
export function parseConsentDate(raw: string, timeZone: string): Date | null {
  const value = raw.trim();
  if (value === '') return null;
  if (ISO_WITH_ZONE.test(value)) {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  let m = ISO_LOCAL.exec(value);
  if (m) {
    const ms = wall(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return ms === null ? null : wallToInstant(ms, timeZone);
  }
  m = DAY_FIRST.exec(value);
  if (m) {
    const ms = wall(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return ms === null ? null : wallToInstant(ms, timeZone);
  }
  if (SERIAL.test(value)) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial < SERIAL_MIN || serial > SERIAL_MAX) return null;
    return wallToInstant(Math.round((serial - SERIAL_EPOCH_OFFSET_DAYS) * DAY_MS), timeZone);
  }
  return null;
}

// ---- Rows and outcomes --------------------------------------------------------------------------

/** The per-row identity of a file-import record (`LeadSourceRecord.externalId`, consent `responseId`). */
export function fileImportExternalId(importId: string, row: number): string {
  return `import:${importId}:row:${row}`;
}

export function parseFileImportExternalId(externalId: string): { importId: string; row: number } | null {
  const m = /^import:([A-Za-z0-9_-]+):row:(\d{1,7})$/.exec(externalId);
  return m ? { importId: m[1]!, row: Number(m[2]) } : null;
}

/** Codes of rows that were not imported. */
export const IMPORT_REJECTION_CODES = ['MISSING_NAME', 'NO_VALID_CONTACT', 'FIELD_TOO_LONG'] as const;
/** Codes of imported rows whose consent was not recorded. */
export const IMPORT_CONSENT_NOTE_CODES = ['SUPPRESSED_CONTACT', 'CONSENT_DATE_INVALID', 'CONSENT_DATE_IN_FUTURE', 'CONSENT_NO_PHONE', 'CONSENT_PENDING_REVIEW', 'CONSENT_NOT_RECORDED'] as const;
export type ImportConsentNoteCode = (typeof IMPORT_CONSENT_NOTE_CODES)[number];

export const IMPORT_ROW_CODE_LABELS: Readonly<Record<string, string>> = {
  MISSING_NAME: 'No business name',
  NO_VALID_CONTACT: 'No valid phone number or email',
  FIELD_TOO_LONG: 'A value is too long',
  DUPLICATE_IN_BATCH: 'The same row twice',
  SUPPRESSED_CONTACT: 'Replied STOP earlier: consent not recorded',
  CONSENT_DATE_INVALID: 'Opt-in date missing or not a date: consent not recorded',
  CONSENT_DATE_IN_FUTURE: 'Opt-in date in the future: consent not recorded',
  CONSENT_NO_PHONE: 'No valid WhatsApp number: consent not recorded',
  CONSENT_PENDING_REVIEW: 'Possible duplicate in review: consent not recorded',
  CONSENT_NOT_RECORDED: 'Consent not recorded',
};

export function importRowCodeLabel(code: string): string {
  return IMPORT_ROW_CODE_LABELS[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

export function isConsentNoteCode(code: string): code is ImportConsentNoteCode {
  return (IMPORT_CONSENT_NOTE_CODES as readonly string[]).includes(code);
}

/** One row outcome kept on the import: the row number, a code and the field, never a value. */
export type ImportRowNote = { row: number; code: string; field?: ImportField };

// ---- Read models --------------------------------------------------------------------------------

export type LeadImportCounts = { accepted: number; duplicates: number; review: number; rejected: number; consentRecorded: number; processed: number };

export type LeadImportDto = {
  id: string;
  status: LeadImportStatus;
  /** PREVIEW whose expiry passed reads EXPIRED even before the purge ran. */
  effectiveStatus: LeadImportStatus;
  fileName: string;
  sheetName: string;
  rowCount: number;
  header: string[];
  mapping: ImportMappingValue | null;
  dataSource: ImportDataSource | null;
  consentAttested: boolean;
  counts: LeadImportCounts;
  notes: ImportRowNote[];
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
};

export type LeadImportPreviewDto = {
  header: string[];
  rows: Array<{ row: number; cells: string[] }>;
  suggestedMapping: ImportMappingValue;
};

export type LeadImportView = { import: LeadImportDto; preview: LeadImportPreviewDto | null };

/**
 * What confirm did with the consent column (ADR-120): honoured, or ignored with the reason (no
 * attestation, no `consent.import`, a data source the business did not collect itself).
 */
export type ConsentDecision = { requested: boolean; honoured: boolean; reason: 'NOT_REQUESTED' | 'NO_CAPABILITY' | 'DATA_SOURCE_NOT_OWN' | null };

export function leadImportHref(importId: string, workspaceSlug?: string): string {
  const q = workspaceSlug ? `?${new URLSearchParams({ workspaceSlug }).toString()}` : '';
  return `/api/app/leads/imports/${encodeURIComponent(importId)}${q}`;
}

export const LEAD_IMPORT_SAMPLE_WORKBOOK_PATH = '/api/app/leads/sample-workbook';
