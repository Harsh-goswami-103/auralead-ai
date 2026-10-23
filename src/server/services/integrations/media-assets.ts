/**
 * The media library of the template studio (ADR-123, slice F4, P1): PDF brochures used as a
 * template's DOCUMENT header.
 *
 * Upload (`uploadMediaAsset`, `templates.manage`): base64 in JSON (route cap about 7 MB), decoded
 * to at most 5 MB, declared `application/pdf`, a `.pdf` file name, and the PDF magic bytes
 * (`%PDF-`); anything else is 422 (413 when too large). The bytes are written atomically to
 * `STORAGE_DIR/media/<workspaceId>/<assetId>.pdf` before the row is stored (the row keeps the
 * relative path, sha256 and size), and removed again when the row cannot be stored. Audited
 * `media.upload` with the size and hash prefix only (the file name may name a customer: never
 * logged).
 *
 * Reading (`readMediaAssetFile`) checks the stored size and sha256, like the quote PDF: a missing or
 * altered file is never sent (ARTIFACT_INTEGRITY). The document goes to Meta as bytes: at submission
 * through the resumable upload for the header sample (template-admin.ts), at send time through the
 * per-send media upload exactly as the quote PDF (dispatch-run.ts).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DomainRuleError, PayloadTooLargeError, ValidationError } from '@/lib/errors';
import { MEDIA_PDF_MAX_BYTES, type MediaUploadBody } from '@/lib/schemas/templates';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { TxClient } from '@/server/jobs/types';
import { readArtifactFile, writeArtifactFile } from '@/server/pdf/artifacts';
import { recordAudit } from '@/server/services/audit/record';

export const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

export type MediaAssetView = { id: string; fileName: string; byteSize: number; createdAt: string };

export function mediaRelPath(workspaceId: string, assetId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || !/^[A-Za-z0-9_-]+$/.test(assetId)) throw new Error('media ids must be plain identifiers');
  return `media/${workspaceId}/${assetId}.pdf`;
}

/** A name the provider and the person see: letters, digits, dot, dash, underscore and spaces; always `.pdf`. */
export function safePdfName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  const stem = base.replace(/\.pdf$/i, '');
  return `${stem.length > 0 ? stem : 'brochure'}.pdf`;
}

function decodeBase64(data: string): Buffer {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new ValidationError({ code: 'MEDIA_ENCODING_INVALID', userMessage: 'The file could not be read. Choose the PDF again.' });
  }
  return Buffer.from(compact, 'base64');
}

/** Checks an upload: a PDF by type, name and content, at most 5 MB. Returns the bytes. */
export function checkPdfUpload(input: Pick<MediaUploadBody, 'fileName' | 'contentType' | 'dataBase64'>): Buffer {
  const bytes = decodeBase64(input.dataBase64);
  if (bytes.length > MEDIA_PDF_MAX_BYTES) throw new PayloadTooLargeError({ code: 'MEDIA_TOO_LARGE', userMessage: 'The PDF is larger than 5 MB. Export a smaller file.' });
  if (input.contentType.trim().toLowerCase() !== 'application/pdf' || !/\.pdf$/i.test(input.fileName.trim())) {
    throw new DomainRuleError({ code: 'MEDIA_TYPE_UNSUPPORTED', userMessage: 'Upload a PDF file (.pdf). Other formats are not accepted for a document header.' });
  }
  if (bytes.length < PDF_MAGIC.length || !bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new DomainRuleError({ code: 'MEDIA_TYPE_MISMATCH', userMessage: "The file's contents are not a PDF. Export the brochure again as PDF." });
  }
  return bytes;
}

export async function uploadMediaAsset(ctx: AppCtx, input: MediaUploadBody, deps: { storageDir: string }): Promise<MediaAssetView> {
  requireCapability(ctx, 'templates.manage');
  const workspaceId = requireWorkspace(ctx);
  const bytes = checkPdfUpload(input);
  const id = `med${randomBytes(11).toString('hex')}`;
  const rel = mediaRelPath(workspaceId, id);
  const written = writeArtifactFile(deps.storageDir, rel, bytes);
  const fileName = safePdfName(input.fileName);
  const now = ctx.clock.now();
  try {
    await withTx(ctx.db, async (scoped) => {
      const tx = scoped as unknown as TxClient;
      await tx.mediaAsset.create({
        data: { id, workspaceId, kind: 'DOCUMENT', fileName, mimeType: 'application/pdf', byteSize: written.bytes, sha256: written.sha256, storagePath: written.path, uploadedBy: ctx.actor?.userId ?? `system:${ctx.kind}`, createdAt: now },
      });
      await recordAudit(tx, ctx, { action: 'media.upload', targetType: 'MediaAsset', targetId: id, simulated: ctx.mode === 'demo', summary: { kind: 'DOCUMENT', bytes: written.bytes, sha256: written.sha256.slice(0, 12) } });
    });
  } catch (error) {
    // Nothing points at the file without its row.
    fs.rmSync(path.join(deps.storageDir, rel), { force: true });
    throw error;
  }
  return { id, fileName, byteSize: written.bytes, createdAt: now.toISOString() };
}

/** The workspace's PDF brochures, newest first. */
export async function listMediaAssets(ctx: AppCtx): Promise<MediaAssetView[]> {
  requireWorkspace(ctx);
  const rows = await ctx.db.mediaAsset.findMany({ where: { kind: 'DOCUMENT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50, select: { id: true, fileName: true, byteSize: true, createdAt: true } });
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, byteSize: r.byteSize, createdAt: r.createdAt.toISOString() }));
}

export type StoredMedia = { storagePath: string; sha256: string; byteSize: number; fileName: string };

/** The asset's bytes, checked against the stored size and sha256 (throws ArtifactIntegrityError otherwise). */
export function readMediaAssetFile(storageDir: string, asset: StoredMedia): Buffer {
  return readArtifactFile(storageDir, { path: asset.storagePath, sha256: asset.sha256, bytes: asset.byteSize });
}
