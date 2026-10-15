/**
 * Quote PDF artifacts (T16, C1, plan §5.4 QuoteArtifact): where the rendered file lives, how it is
 * written, how a route reads it back, and the `quote.renderPdf` job that produces it.
 *
 *  - One artifact per QuoteVersion (`quoteVersionId` UNIQUE), stored at
 *    `STORAGE_DIR/quotes/<workspaceId>/<quoteVersionId>.pdf` (the row keeps the relative path,
 *    the sha256 and the size).
 *  - Files are written to a temp name and renamed into place, so a reader never sees half a PDF.
 *  - A read checks the stored sha256; a missing or altered file is an integrity error, never
 *    served.
 *  - `enqueueQuoteRenderPdf` is idempotent per version (`quote.renderPdf:<versionId>`), so version
 *    creation and every "PDF not ready" request share one render job.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { idempotencyKey } from '@/lib/ids';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';

export const QUOTE_RENDER_PDF_JOB = 'quote.renderPdf';
/** Seconds a client should wait before asking again for a PDF that is still rendering. */
export const PDF_RETRY_AFTER_SECONDS = 5;

export class ArtifactIntegrityError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'ARTIFACT_INTEGRITY';
  static override readonly defaultUserMessage: string = 'The stored PDF could not be verified. Contact the sender for a copy.';
}

export function quoteArtifactRelPath(workspaceId: string, quoteVersionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(quoteVersionId)) throw new Error('artifact ids must be plain identifiers');
  return `quotes/${workspaceId}/${quoteVersionId}.pdf`;
}

function absolute(storageDir: string, relPath: string): string {
  const root = path.resolve(storageDir);
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root + path.sep)) throw new Error('artifact path escapes the storage directory');
  return full;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes the PDF atomically (temp file + rename) and returns its relative path, hash and size. */
export function writeArtifactFile(storageDir: string, relPath: string, bytes: Buffer): { path: string; sha256: string; bytes: number } {
  const full = absolute(storageDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, full);
  return { path: relPath, sha256: sha256Hex(bytes), bytes: bytes.length };
}

/** Reads a stored artifact and checks it against the recorded hash and size. */
export function readArtifactFile(storageDir: string, artifact: { path: string; sha256: string; bytes: number }): Buffer {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute(storageDir, artifact.path));
  } catch (cause) {
    throw new ArtifactIntegrityError({ message: 'quote artifact file is missing', cause });
  }
  if (bytes.length !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) throw new ArtifactIntegrityError({ message: 'quote artifact hash mismatch' });
  return bytes;
}

export async function enqueueQuoteRenderPdf(db: JobStore, clock: Clock, input: { workspaceId: string; quoteVersionId: string; correlationId: string; causationId?: string | null }) {
  return enqueueJob(db, clock, {
    type: QUOTE_RENDER_PDF_JOB,
    payload: { quoteVersionId: input.quoteVersionId },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(QUOTE_RENDER_PDF_JOB, input.quoteVersionId),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    kind: 'pdf',
  });
}

export function pdfFileName(quoteNumber: string, versionNo: number): string {
  return `${quoteNumber.replace(/[^A-Za-z0-9-]/g, '')}-v${versionNo}.pdf`;
}
