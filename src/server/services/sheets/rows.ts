/**
 * Sheet rows as push rows (T34, ADR-103), shared by the preview, the sync and the webhook (weak
 * ids). Values are keyed by the normalized header name and limited to the mapped columns (data
 * minimization: an unmapped "Notes" column never leaves the Sheet). The row key is the row's
 * `auralead_event_id` cell, the same id the Apps Script pushes, so a row arriving by both paths is
 * one source record. A Sheet without that column gets a weak content-hash id per row (flagged:
 * editing such a row gives it a new id; contact dedupe still matches the lead). A row in a Sheet
 * that has the column but whose cell is still empty is waiting for the script and is not ingested.
 * Dates read with `UNFORMATTED_VALUE` / `SERIAL_NUMBER` are days since 1899-12-30 as wall time in
 * the spreadsheet's time zone.
 */
import { createHash } from 'node:crypto';
import { normalizeHeaderName } from '@/lib/schemas/sheets';
import type { HeaderInfo } from './header';

export type AnswerValue = string | number | boolean | null;

export type SheetRowRecord = { rowNumber: number; rowKey: string; weakId: boolean; submittedAt?: string; values: Record<string, AnswerValue> };

function sortKeys(value: Record<string, AnswerValue>): Record<string, AnswerValue> {
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]!]));
}

export function weakRowKey(values: Record<string, AnswerValue>, submittedAt?: string): string {
  const digest = createHash('sha256').update(JSON.stringify({ values: sortKeys(values), submittedAt: submittedAt ?? null }), 'utf8').digest('hex');
  return `weak:${digest.slice(0, 40)}`;
}

const SERIAL_EPOCH_OFFSET_DAYS = 25569; // 1970-01-01 as a Sheets serial
const DAY_MS = 86_400_000;

function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** A Sheets serial date-time as an ISO instant, or undefined when it cannot be read. */
export function serialToIso(serial: number, timeZone: string | null): string | undefined {
  if (!Number.isFinite(serial) || serial <= 0) return undefined;
  const wall = Math.round((serial - SERIAL_EPOCH_OFFSET_DAYS) * DAY_MS);
  try {
    const zone = timeZone ?? 'UTC';
    let instant = wall - zoneOffsetMs(zone, wall);
    instant = wall - zoneOffsetMs(zone, instant);
    return new Date(instant).toISOString();
  } catch {
    return undefined;
  }
}

function cellValue(cell: unknown): AnswerValue {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'number' || typeof cell === 'boolean') return cell;
  return String(cell).slice(0, 2000);
}

function submittedAtOf(cell: unknown, timeZone: string | null): string | undefined {
  if (typeof cell === 'number') return serialToIso(cell, timeZone);
  if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(cell.trim())) {
    const at = new Date(cell.trim());
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  }
  return undefined;
}

export type RowsResult = {
  records: SheetRowRecord[];
  emptyRows: number[];
  /** Rows of a Sheet with an event id column whose id cell is still empty. */
  pendingRows: number[];
  /** Everything up to this row is done: the next read starts after it. */
  cursorRow: number;
};

export function rowsFromValues(
  header: HeaderInfo,
  rows: readonly unknown[][],
  opts: { firstRowNumber: number; submittedAtColumn: string | null; timeZone: string | null; columns: ReadonlySet<string> },
): RowsResult {
  const records: SheetRowRecord[] = [];
  const emptyRows: number[] = [];
  const pendingRows: number[] = [];
  rows.forEach((cells, i) => {
    const rowNumber = opts.firstRowNumber + i;
    const row = Array.isArray(cells) ? cells : [];
    if (row.every((c) => c === '' || c === null || c === undefined)) {
      emptyRows.push(rowNumber);
      return;
    }
    const values: Record<string, AnswerValue> = {};
    let submittedAt: string | undefined;
    header.columns.forEach((name, col) => {
      if (name === '' || col === header.eventIdIndex || !opts.columns.has(name) || name in values) return;
      values[name] = cellValue(row[col]);
      if (opts.submittedAtColumn !== null && name === opts.submittedAtColumn) submittedAt = submittedAtOf(row[col], opts.timeZone);
    });
    let rowKey: string;
    let weakId = false;
    if (header.eventIdIndex !== null) {
      const id = normalizeHeaderName(row[header.eventIdIndex]);
      if (id === '') {
        pendingRows.push(rowNumber);
        return;
      }
      rowKey = id.slice(0, 256);
    } else {
      rowKey = weakRowKey(values, submittedAt);
      weakId = true;
    }
    records.push({ rowNumber, rowKey, weakId, ...(submittedAt ? { submittedAt } : {}), values });
  });
  const lastRead = opts.firstRowNumber + rows.length - 1;
  const cursorRow = pendingRows.length > 0 ? pendingRows[0]! - 1 : lastRead;
  return { records, emptyRows, pendingRows, cursorRow };
}
