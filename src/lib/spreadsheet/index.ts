/**
 * Spreadsheet module (ADR-117): XLSX write/read (./xlsx) and CSV parsing for lead imports and
 * Excel exports. Framework-free and pure.
 */
import { readXlsx, isZip } from './xlsx';
import { SpreadsheetError, SPREADSHEET_LIMITS, type Table } from './types';

export { cleanSheetName, readXlsx, writeXlsx, type XlsxInput } from './xlsx';
export { SpreadsheetError, SPREADSHEET_LIMITS, type CellValue, type SpreadsheetErrorCode, type Table } from './types';

/** Our own CSV export prefixes formula characters with an apostrophe (src/server/services/leads/csv.ts); undo it on the way in. */
const EXPORT_GUARD = /^'(?=[=+\-@\t\r])/;

/** RFC 4180 CSV (comma separated, double-quote escaping), with a tolerated BOM and LF or CRLF. */
export function parseCsv(input: string): string[][] {
  return parseCsvRecords(input).rows;
}

/**
 * Like {@link parseCsv}, also giving each kept record's physical line (1-based, where the record
 * starts), so a blank line or a multi-line cell does not shift the row numbers shown to people.
 */
export function parseCsvRecords(input: string): { rows: string[][]; lines: number[] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  let line = 1;
  let recordLine = 1;
  const pushRow = () => {
    row.push(field);
    if (row.some((c) => c !== '')) {
      rows.push(row.map((c) => c.replace(EXPORT_GUARD, '')));
      lines.push(recordLine);
    }
    if (rows.length > SPREADSHEET_LIMITS.maxRows) throw new SpreadsheetError('TOO_MANY_ROWS', `A file can hold at most ${SPREADSHEET_LIMITS.maxRows} rows.`);
    row = [];
    field = '';
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '\n') line += 1;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      pushRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new SpreadsheetError('MALFORMED_CSV', 'The CSV file has an unterminated quoted field.');
  if (field !== '' || row.length > 0) pushRow();
  return { rows, lines };
}

/** Drops trailing empty cells and trailing empty rows, keeping the table rectangular. */
function trimTable(rows: string[][]): string[][] {
  const kept = rows.map((r) => r.map((c) => c));
  while (kept.length > 0 && kept[kept.length - 1]!.every((c) => c.trim() === '')) kept.pop();
  let width = 0;
  for (const r of kept) {
    for (let c = r.length - 1; c >= 0; c--) {
      if (r[c]!.trim() !== '') {
        width = Math.max(width, c + 1);
        break;
      }
    }
  }
  return kept.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ''));
}

/** Reads an uploaded table: an .xlsx workbook (detected by its zip signature) or UTF-8 CSV. */
export function readTable(bytes: Uint8Array, fileName: string): Table {
  if (bytes.length === 0) throw new SpreadsheetError('EMPTY_FILE', 'The file is empty.');
  if (bytes.length > SPREADSHEET_LIMITS.maxFileBytes) throw new SpreadsheetError('TOO_LARGE', 'The file is larger than 5 MB.');
  if (isZip(bytes)) {
    const table = readXlsx(bytes);
    return { sheetName: table.sheetName, rows: trimTable(table.rows) };
  }
  const base = fileName.replace(/\.[^.]*$/, '') || 'Sheet1';
  const csv = parseCsvRecords(new TextDecoder('utf-8').decode(bytes));
  const rows = trimTable(csv.rows);
  return { sheetName: base, rows, rowNumbers: csv.lines.slice(0, rows.length) };
}
