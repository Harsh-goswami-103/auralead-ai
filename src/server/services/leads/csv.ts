/**
 * The leads CSV (T26, plan §9 XSS row, 03-security T11). Pure: no I/O, no clock.
 *
 * - RFC 4180: rows end with CRLF; a cell holding a comma, a double quote, CR or LF is quoted and
 *   its quotes are doubled.
 * - A UTF-8 byte order mark starts the file, so spreadsheet apps read Devanagari and the rupee
 *   sign correctly.
 * - Formula injection: every text cell that starts with `=`, `+`, `-`, `@`, TAB or CR is prefixed
 *   with an apostrophe, so a spreadsheet shows it as text instead of evaluating it. This includes
 *   E.164 phones (`'+9198...`), which is the documented cost of the rule. Numbers are written as
 *   numbers (they cannot carry a formula).
 * - Unknown values are empty cells, never a guess. Labels match the panel's vocabulary
 *   (tests/components/leads/lead-detail-parts.test.tsx keeps them in step).
 */
import type { LeadSource, SalesStage, WebsiteStatus } from '@/lib/domain/enums';

export type CsvValue = string | number | boolean | null | undefined;

export const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;
const NEEDS_QUOTES = /[",\r\n]/;

export function escapeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = value;
  if (text.length > 0 && (CSV_FORMULA_PREFIXES as readonly string[]).includes(text[0]!)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly CsvValue[]): string {
  return `${cells.map(escapeCsvCell).join(',')}\r\n`;
}

export const CSV_BOM = '﻿';

export function buildCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  let out = CSV_BOM + csvLine(header);
  for (const row of rows) out += csvLine(row);
  return out;
}

export const SALES_STAGE_CSV_LABELS: Readonly<Record<SalesStage, string>> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUOTE_SENT: 'Quote sent',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

export const LEAD_SOURCE_CSV_LABELS: Readonly<Record<LeadSource, string>> = {
  GOOGLE_SHEETS: 'Google Sheets',
  META_ADS: 'Meta Lead Ads',
  GMAPS_EXTENSION: 'Maps extension',
  WHATSAPP_INBOUND: 'WhatsApp',
  EMAIL_INBOUND: 'Email',
  MANUAL: 'Manual',
  GOOGLE_PLACES: 'Google Places',
  FILE_IMPORT: 'File import',
};

export const WEBSITE_STATUS_CSV_LABELS: Readonly<Record<WebsiteStatus, string>> = {
  UNKNOWN: 'Not checked',
  PRESENT_UNVERIFIED: 'Listed, not checked',
  REACHABLE: 'Reachable',
  UNREACHABLE: 'Unreachable',
  BLOCKED: 'Blocked by the safety check',
  VERIFIED_ABSENT: 'No website',
  NOT_LISTED: 'No website listed',
};

export const LEAD_CSV_HEADER: readonly string[] = [
  'Name',
  'Stage',
  'Score',
  'Source',
  'Phone',
  'Email',
  'Website',
  'Website status',
  'City',
  'Category',
  'Address',
  'Rating',
  'Reviews',
  'Added (UTC)',
  'Simulated',
  'Lead ID',
];

export type LeadCsvSource = {
  id: string;
  displayName: string;
  salesStage: SalesStage;
  score: number | null;
  firstSource: LeadSource;
  phoneE164: string | null;
  emailNormalized: string | null;
  website: string | null;
  websiteStatus: WebsiteStatus;
  city: string | null;
  category: string | null;
  address: string | null;
  /** Stars x10 (46 is 4.6). */
  rating: number | null;
  reviewCount: number | null;
  simulated: boolean;
  createdAt: Date;
};

export function leadCsvRow(lead: LeadCsvSource): CsvValue[] {
  return [
    lead.displayName,
    SALES_STAGE_CSV_LABELS[lead.salesStage] ?? lead.salesStage,
    lead.score,
    LEAD_SOURCE_CSV_LABELS[lead.firstSource] ?? lead.firstSource,
    lead.phoneE164,
    lead.emailNormalized,
    lead.website,
    WEBSITE_STATUS_CSV_LABELS[lead.websiteStatus] ?? lead.websiteStatus,
    lead.city,
    lead.category,
    lead.address,
    lead.rating === null ? null : lead.rating / 10,
    lead.reviewCount,
    lead.createdAt.toISOString(),
    lead.simulated ? 'yes' : 'no',
    lead.id,
  ];
}
