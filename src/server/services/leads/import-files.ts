/**
 * The parsed rows of a lead import (ADR-120): `STORAGE_DIR/imports/<workspaceId>/<importId>.json`,
 * never the database. Written to a temporary name and renamed (a reader never sees half a file),
 * read by the preview and the `leads.import` job, deleted when the import finishes or by
 * `leads.importPurge` at its expiry (and by `lead:erase`, which reads `LeadImport.storagePath`).
 * Every path is checked to stay inside the storage directory.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The rows file: the header as read and every non-blank data row with its spreadsheet row number. */
export type ImportRowsFile = { version: 1; header: string[]; rows: Array<{ row: number; cells: string[] }> };

const PLAIN_ID = /^[A-Za-z0-9_-]+$/;

/** `imports/<workspaceId>/<importId>.json`, relative to STORAGE_DIR. */
export function leadImportRelPath(workspaceId: string, importId: string): string {
  if (!PLAIN_ID.test(workspaceId) || !PLAIN_ID.test(importId)) throw new Error('import ids must be plain identifiers');
  return `imports/${workspaceId}/${importId}.json`;
}

function absolute(storageDir: string, relPath: string): string {
  const root = path.resolve(storageDir);
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root + path.sep)) throw new Error('import path escapes the storage directory');
  return full;
}

export function writeImportRows(storageDir: string, relPath: string, file: ImportRowsFile): void {
  const full = absolute(storageDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), 'utf8');
  fs.renameSync(tmp, full);
}

function isRowsFile(value: unknown): value is ImportRowsFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { version?: unknown; header?: unknown; rows?: unknown };
  if (v.version !== 1 || !Array.isArray(v.header) || !Array.isArray(v.rows)) return false;
  if (!v.header.every((h) => typeof h === 'string')) return false;
  return v.rows.every((r) => {
    const row = r as { row?: unknown; cells?: unknown };
    return typeof row === 'object' && row !== null && Number.isInteger(row.row) && Array.isArray(row.cells) && row.cells.every((c) => typeof c === 'string');
  });
}

/** The rows file, or null when it is missing (purged, erased) or unreadable. */
export function readImportRows(storageDir: string, relPath: string): ImportRowsFile | null {
  let text: string;
  try {
    text = fs.readFileSync(absolute(storageDir, relPath), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRowsFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function deleteImportRows(storageDir: string, relPath: string): void {
  fs.rmSync(absolute(storageDir, relPath), { force: true, maxRetries: 5, retryDelay: 200 });
}

export function importRowsExist(storageDir: string, relPath: string): boolean {
  return fs.existsSync(absolute(storageDir, relPath));
}
