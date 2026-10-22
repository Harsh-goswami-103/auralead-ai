/**
 * Quotation branding (T27; plan §5.2 WorkspaceSettings, §9 Logo P7, §10 F14): the brand colour,
 * the GSTIN and terms printed on quotations, and the workspace logo.
 *
 *  - Brand colour: #rrggbb only, stored upper-case as chosen. Where it is used as text it is
 *    darkened in OKLCH until it reads at 4.5:1 (F14, `brandTextColor`); the stored value is the
 *    workspace's choice.
 *  - GSTIN: format only (it is printed, never interpreted), stored upper-case; empty clears it.
 *  - Terms: line endings normalised, trailing spaces trimmed, at most 4000 characters.
 *  - New quote versions snapshot sender name, brand colour, terms and GSTIN when they are created
 *    (ADR-57, `readDocumentSnapshot`), so a change here applies to the next version and never to
 *    an issued one.
 *  - Logo (P7, A37): PNG, JPEG or WebP only, at most 1 MB. The declared type, the file name's
 *    extension, the magic bytes and the format sharp decodes must all agree (an SVG, a GIF or any
 *    polyglot is refused). The image is decoded with a pixel limit, auto-oriented, fitted inside
 *    512 px and re-encoded to WebP; sharp writes no metadata unless asked, so EXIF, ICC, XMP and
 *    anything appended to the source are gone, and the stored file is never the uploaded bytes.
 *    It is stored content-addressed at `STORAGE_DIR/branding/<workspaceId>/<sha256>.webp`
 *    (temp file + rename) before the transaction that records the path; the replaced file is
 *    removed after commit. Reads check the file against the hash in its name.
 * Reads need a workspace; every change needs `pricing.override` (the workspace OWNER, as for
 * pricing, ADR-52) and is one transaction with its AuditEvent, whose summary names the changed
 * fields and never the values or the file name.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { AppError, DomainRuleError, NotFoundError, PayloadTooLargeError, ValidationError } from '@/lib/errors';
import { isBrandHex } from '@/lib/branding/contrast';
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, TERMS_MAX_CHARS, type BrandingUpdateBody, type LogoUploadBody } from '@/lib/schemas/branding';
import { GSTIN_PATTERN } from '@/lib/schemas/pricing';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';

/** The stored logo fits inside this square (px); smaller images are not enlarged. */
export const LOGO_MAX_EDGE = 512;
/** Decoding refuses images above this many pixels (a decompression bomb guard). */
export const LOGO_MAX_INPUT_PIXELS = 25_000_000;
export const LOGO_ROUTE = '/api/app/branding/logo';

export type LogoKind = 'png' | 'jpeg' | 'webp';
type Sniffed = LogoKind | 'gif' | 'svg' | 'unknown';

const KIND_OF_TYPE: Readonly<Record<(typeof LOGO_CONTENT_TYPES)[number], LogoKind>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
const KIND_OF_EXTENSION: Readonly<Record<string, LogoKind>> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };

export class LogoIntegrityError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'LOGO_INTEGRITY';
  static override readonly defaultUserMessage: string = 'The stored logo could not be verified. Upload it again.';
}

export type BrandingView = {
  workspace: { name: string; timezone: string };
  brandColor: string;
  termsText: string;
  gstin: string | null;
  logo: { sha256: string; url: string } | null;
  updatedAt: Date;
  canEdit: boolean;
};

const rule = (code: string, userMessage: string, field: string) => new DomainRuleError({ code, userMessage, safeDetails: { field } });

// ---- Logo bytes ------------------------------------------------------------------------------------

/** What the first bytes say the file is (magic numbers), whatever it claims to be. */
export function sniffImage(bytes: Buffer): Sniffed {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg')) return 'svg';
  return 'unknown';
}

function decodeBase64(data: string): Buffer {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new ValidationError({ code: 'LOGO_ENCODING_INVALID', userMessage: 'The file could not be read. Choose the image again.' });
  }
  return Buffer.from(compact, 'base64');
}

const unsupported = () =>
  new DomainRuleError({ code: 'LOGO_TYPE_UNSUPPORTED', userMessage: 'Use a PNG, JPEG or WebP image. SVG and other formats are not accepted.', safeDetails: { field: 'logo' } });
const mismatch = () =>
  new DomainRuleError({ code: 'LOGO_TYPE_MISMATCH', userMessage: "The file's contents do not match its type or name. Export the logo again as PNG, JPEG or WebP.", safeDetails: { field: 'logo' } });
const unreadable = () => new DomainRuleError({ code: 'LOGO_UNREADABLE', userMessage: 'The image could not be read. Export the logo again as PNG, JPEG or WebP.', safeDetails: { field: 'logo' } });

export type ProcessedLogo = { bytes: Buffer; sha256: string; width: number; height: number; sourceType: LogoKind; sourceBytes: number };

/** Validates an uploaded logo and re-encodes it to metadata-free WebP. Throws 400/413/422 with a code. */
export async function processLogo(input: LogoUploadBody): Promise<ProcessedLogo> {
  const raw = decodeBase64(input.dataBase64);
  if (raw.length > LOGO_MAX_BYTES) throw new PayloadTooLargeError({ code: 'LOGO_TOO_LARGE', userMessage: 'The logo is larger than 1 MB. Export a smaller file.' });
  const declared = KIND_OF_TYPE[input.contentType.trim().toLowerCase() as keyof typeof KIND_OF_TYPE];
  if (!declared) throw unsupported();
  const sniffed = sniffImage(raw);
  if (sniffed !== declared) throw mismatch();
  if (input.fileName !== undefined) {
    const ext = path.extname(input.fileName).slice(1).toLowerCase();
    if (KIND_OF_EXTENSION[ext] !== declared) throw mismatch();
  }

  let decodedFormat: string | undefined;
  let out: { data: Buffer; info: OutputInfo };
  try {
    const image = sharp(raw, { limitInputPixels: LOGO_MAX_INPUT_PIXELS, failOn: 'error', autoOrient: true });
    decodedFormat = (await image.metadata()).format;
    if (decodedFormat !== declared) throw mismatch();
    out = await image.resize({ width: LOGO_MAX_EDGE, height: LOGO_MAX_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof DomainRuleError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new DomainRuleError({ code: 'LOGO_DIMENSIONS', userMessage: 'The image has too many pixels. Export it at a smaller size.', safeDetails: { field: 'logo' } });
    }
    throw unreadable();
  }
  return { bytes: out.data, sha256: createHash('sha256').update(out.data).digest('hex'), width: out.info.width, height: out.info.height, sourceType: declared, sourceBytes: raw.length };
}

// ---- Storage ---------------------------------------------------------------------------------------

const SHA_FILE = /^[0-9a-f]{64}\.webp$/;

export function logoRelPath(workspaceId: string, sha256: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('logo path parts must be plain identifiers');
  return `branding/${workspaceId}/${sha256}.webp`;
}

/** The stored path is ours only if it is exactly branding/<this workspace>/<sha256>.webp. */
function ownedLogoPath(workspaceId: string, rel: string | null): string | null {
  if (rel === null) return null;
  const parts = rel.split('/');
  return parts.length === 3 && parts[0] === 'branding' && parts[1] === workspaceId && SHA_FILE.test(parts[2]!) ? rel : null;
}

function absolute(storageDir: string, rel: string): string {
  const root = path.resolve(storageDir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error('logo path escapes the storage directory');
  return full;
}

function writeAtomic(full: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, full);
}

function removeQuietly(storageDir: string, rel: string | null): void {
  if (rel === null) return;
  fs.rmSync(absolute(storageDir, rel), { force: true, maxRetries: 3, retryDelay: 100 });
}

// ---- Reads -----------------------------------------------------------------------------------------

type SettingsRow = { brandColor: string; termsText: string; gstin: string | null; logoPath: string | null; updatedAt: Date };

function toView(ctx: AppCtx, workspace: { name: string; timezone: string }, row: SettingsRow): BrandingView {
  const workspaceId = requireWorkspace(ctx);
  const owned = ownedLogoPath(workspaceId, row.logoPath);
  const sha256 = owned ? owned.split('/')[2]!.slice(0, 64) : null;
  return {
    workspace,
    brandColor: row.brandColor,
    termsText: row.termsText,
    gstin: row.gstin,
    logo: sha256 ? { sha256, url: `${LOGO_ROUTE}?v=${sha256.slice(0, 16)}` } : null,
    updatedAt: row.updatedAt,
    canEdit: hasCapability(ctx, 'pricing.override'),
  };
}

async function readRow(ctx: AppCtx): Promise<{ workspace: { name: string; timezone: string }; row: SettingsRow }> {
  const workspaceId = requireWorkspace(ctx);
  const [workspace, row] = await Promise.all([
    ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, timezone: true } }),
    ctx.db.workspaceSettings.findFirst({ select: { brandColor: true, termsText: true, gstin: true, logoPath: true, updatedAt: true } }),
  ]);
  if (!workspace || !row) throw new NotFoundError({ message: 'workspace settings missing' });
  return { workspace, row };
}

export async function getBranding(ctx: AppCtx): Promise<BrandingView> {
  const { workspace, row } = await readRow(ctx);
  return toView(ctx, workspace, row);
}

/** The workspace's logo bytes, checked against the hash in the file name. */
export async function readLogo(ctx: AppCtx, deps: { storageDir: string }): Promise<{ bytes: Buffer; sha256: string }> {
  const workspaceId = requireWorkspace(ctx);
  const row = await ctx.db.workspaceSettings.findFirst({ select: { logoPath: true } });
  const rel = ownedLogoPath(workspaceId, row?.logoPath ?? null);
  if (!rel) throw new NotFoundError({ code: 'LOGO_NOT_SET', userMessage: 'This workspace has no logo.' });
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute(deps.storageDir, rel));
  } catch (cause) {
    throw new LogoIntegrityError({ message: 'logo file is missing', cause });
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!rel.endsWith(`/${sha256}.webp`)) throw new LogoIntegrityError({ message: 'logo file hash mismatch' });
  return { bytes, sha256 };
}

// ---- Changes ---------------------------------------------------------------------------------------

function normaliseTerms(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .trim();
}

const FIELDS = ['brandColor', 'gstin', 'termsText'] as const;

export async function updateBranding(ctx: AppCtx, input: BrandingUpdateBody): Promise<BrandingView> {
  const workspaceId = requireWorkspace(ctx);
  requireCapability(ctx, 'pricing.override');
  const next: { brandColor?: string; gstin?: string | null; termsText?: string } = {};
  if (input.brandColor !== undefined) {
    const colour = input.brandColor.trim();
    if (!isBrandHex(colour)) throw rule('BRAND_COLOR_INVALID', 'Enter the brand colour as # and six hex digits, for example #0F766E.', 'brandColor');
    next.brandColor = colour.toUpperCase();
  }
  if (input.gstin !== undefined) {
    const g = input.gstin === null ? '' : input.gstin.trim().toUpperCase();
    if (g !== '' && !GSTIN_PATTERN.test(g)) throw rule('GSTIN_INVALID', 'The GSTIN must be 15 characters, for example 07AAACR5055K1Z5.', 'gstin');
    next.gstin = g === '' ? null : g;
  }
  if (input.termsText !== undefined) {
    const terms = normaliseTerms(input.termsText);
    if (terms.length > TERMS_MAX_CHARS) throw rule('TERMS_INVALID', `The terms can be at most ${TERMS_MAX_CHARS.toLocaleString('en-IN')} characters.`, 'termsText');
    next.termsText = terms;
  }

  return withTx(ctx.db, async (tx) => {
    const current = await tx.workspaceSettings.findFirst({ select: { brandColor: true, termsText: true, gstin: true } });
    if (!current) throw new NotFoundError({ message: 'workspace settings missing' });
    const changed = FIELDS.filter((f) => next[f] !== undefined && next[f] !== current[f]);
    if (changed.length > 0) {
      await tx.workspaceSettings.update({ where: { workspaceId }, data: { ...next, updatedBy: ctx.actor?.userId ?? null } });
      await recordAudit(tx, ctx, { action: 'branding.update', targetType: 'WorkspaceSettings', targetId: workspaceId, summary: { fields: changed } });
    }
    const [workspace, row] = await Promise.all([
      tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, timezone: true } }),
      tx.workspaceSettings.findFirstOrThrow({ select: { brandColor: true, termsText: true, gstin: true, logoPath: true, updatedAt: true } }),
    ]);
    return toView(ctx, workspace, row);
  });
}

export async function uploadLogo(ctx: AppCtx, input: LogoUploadBody, deps: { storageDir: string }): Promise<BrandingView> {
  const workspaceId = requireWorkspace(ctx);
  requireCapability(ctx, 'pricing.override');
  const logo = await processLogo(input);
  const rel = logoRelPath(workspaceId, logo.sha256);
  writeAtomic(absolute(deps.storageDir, rel), logo.bytes);

  let previous = null as string | null;
  let view: BrandingView;
  try {
    view = await withTx(ctx.db, async (tx) => {
      const current = await tx.workspaceSettings.findFirst({ select: { logoPath: true } });
      if (!current) throw new NotFoundError({ message: 'workspace settings missing' });
      previous = current.logoPath;
      await tx.workspaceSettings.update({ where: { workspaceId }, data: { logoPath: rel, updatedBy: ctx.actor?.userId ?? null } });
      await recordAudit(tx, ctx, {
        action: 'branding.logo.update',
        targetType: 'WorkspaceSettings',
        targetId: workspaceId,
        summary: { fields: ['logoPath'], sourceType: logo.sourceType, sourceBytes: logo.sourceBytes, bytes: logo.bytes.length, width: logo.width, height: logo.height },
      });
      const [workspace, row] = await Promise.all([
        tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, timezone: true } }),
        tx.workspaceSettings.findFirstOrThrow({ select: { brandColor: true, termsText: true, gstin: true, logoPath: true, updatedAt: true } }),
      ]);
      return toView(ctx, workspace, row);
    });
  } catch (error) {
    // Nothing points at the new file unless it was already the current logo.
    if (previous !== rel) removeQuietly(deps.storageDir, rel);
    throw error;
  }
  const replaced = ownedLogoPath(workspaceId, previous);
  if (replaced && replaced !== rel) removeQuietly(deps.storageDir, replaced);
  return view;
}

export async function removeLogo(ctx: AppCtx, deps: { storageDir: string }): Promise<BrandingView> {
  const workspaceId = requireWorkspace(ctx);
  requireCapability(ctx, 'pricing.override');
  let previous = null as string | null;
  const view = await withTx(ctx.db, async (tx) => {
    const current = await tx.workspaceSettings.findFirst({ select: { logoPath: true } });
    if (!current) throw new NotFoundError({ message: 'workspace settings missing' });
    previous = current.logoPath;
    if (previous !== null) {
      await tx.workspaceSettings.update({ where: { workspaceId }, data: { logoPath: null, updatedBy: ctx.actor?.userId ?? null } });
      await recordAudit(tx, ctx, { action: 'branding.logo.remove', targetType: 'WorkspaceSettings', targetId: workspaceId, summary: { fields: ['logoPath'] } });
    }
    const [workspace, row] = await Promise.all([
      tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, timezone: true } }),
      tx.workspaceSettings.findFirstOrThrow({ select: { brandColor: true, termsText: true, gstin: true, logoPath: true, updatedAt: true } }),
    ]);
    return toView(ctx, workspace, row);
  });
  removeQuietly(deps.storageDir, ownedLogoPath(workspaceId, previous));
  return view;
}

export function serializeBranding(view: BrandingView) {
  return { ...view, updatedAt: view.updatedAt.toISOString() };
}
export type BrandingDto = ReturnType<typeof serializeBranding>;
