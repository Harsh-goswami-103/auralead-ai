/**
 * The Sheet's header row (T34, ADR-103). Row 1 is read as normalized names
 * (`normalizeHeaderName`). The fingerprint is sha256 over the sorted set of non-empty names other
 * than `auralead_event_id`: reordering columns or the script adding its id column is not drift
 * (values are read by name), while a renamed, added or removed column is, and blocks sync and pushes
 * until the mapping is re-confirmed. Duplicate names make a mapping ambiguous and are refused.
 */
import { createHash } from 'node:crypto';
import { normalizeHeaderName, SHEETS_EVENT_ID_COLUMN } from '@/lib/schemas/sheets';

export type HeaderInfo = {
  /** Every cell of row 1, normalized ('' for an empty cell), in column order. */
  columns: string[];
  /** Distinct non-empty names other than the event id column, in column order. */
  names: string[];
  duplicates: string[];
  /** 0-based index of the `auralead_event_id` column, or null. */
  eventIdIndex: number | null;
  fingerprint: string;
};

export function headerFingerprint(names: readonly string[]): string {
  const set = [...new Set(names.map(normalizeHeaderName).filter((n) => n !== '' && n !== SHEETS_EVENT_ID_COLUMN))].sort();
  return createHash('sha256').update(JSON.stringify(set), 'utf8').digest('hex');
}

export function analyzeHeader(raw: readonly unknown[]): HeaderInfo {
  const columns = raw.map(normalizeHeaderName);
  const names: string[] = [];
  const duplicates: string[] = [];
  let eventIdIndex: number | null = null;
  columns.forEach((name, i) => {
    if (name === '') return;
    if (name === SHEETS_EVENT_ID_COLUMN) {
      if (eventIdIndex === null) eventIdIndex = i;
      return;
    }
    if (names.includes(name)) {
      if (!duplicates.includes(name)) duplicates.push(name);
      return;
    }
    names.push(name);
  });
  return { columns, names, duplicates, eventIdIndex, fingerprint: headerFingerprint(names) };
}

export type ColumnDiff = { added: string[]; removed: string[] };

export function columnDiff(previous: readonly string[], current: readonly string[]): ColumnDiff {
  const before = new Set(previous);
  const now = new Set(current);
  return { added: current.filter((c) => !before.has(c)), removed: previous.filter((c) => !now.has(c)) };
}
