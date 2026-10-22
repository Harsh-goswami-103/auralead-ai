/** Shared types and limits of the spreadsheet module (ADR-117). */

export type CellValue = string | number | boolean | null | undefined;

/** One sheet as a rectangle of strings: row 0 is usually the header. */
export type Table = { sheetName: string; rows: string[][] };

export const SPREADSHEET_LIMITS = {
  /** Largest upload accepted at all. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Largest inflated workbook part, and the sum of all parts read (zip bomb guard). */
  maxUncompressedBytes: 40 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 64,
} as const;

export type SpreadsheetErrorCode = 'NOT_A_WORKBOOK' | 'TOO_LARGE' | 'TOO_MANY_ROWS' | 'MALFORMED_CSV' | 'EMPTY_FILE';

export class SpreadsheetError extends Error {
  readonly code: SpreadsheetErrorCode;
  constructor(code: SpreadsheetErrorCode, message: string) {
    super(message);
    this.name = 'SpreadsheetError';
    this.code = code;
  }
}
