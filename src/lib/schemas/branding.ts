/**
 * Branding request schemas (T27), shared by the /api/app/branding route handlers and the branding
 * page forms (plan §2: one Zod schema set). Shape only: domain rules (a #rrggbb brand colour, the
 * GSTIN format, the terms length, the logo's type, bytes and size) are enforced by the branding
 * service, so a bad value is a 422 (or 413 for a logo over 1 MB) with a code, not a Zod 400.
 */
import { z } from 'zod';

/** P7: the largest logo accepted, in decoded bytes. */
export const LOGO_MAX_BYTES = 1_048_576;
/** P7: the only logo types accepted (no SVG: it can carry script). */
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** The `accept` attribute of the file input. */
export const LOGO_ACCEPT = LOGO_CONTENT_TYPES.join(',');
/** Terms printed on quotations, in characters. */
export const TERMS_MAX_CHARS = 4000;

export const BrandingUpdateBody = z
  .object({
    brandColor: z.string().max(32).optional(),
    termsText: z.string().max(20_000).optional(),
    gstin: z.string().max(32).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Change at least one setting.' });
export type BrandingUpdateBody = z.output<typeof BrandingUpdateBody>;

/** The logo travels as base64 inside JSON (the one body format every app route reads). */
export const LogoUploadBody = z.object({
  contentType: z.string().max(100),
  fileName: z.string().max(255).optional(),
  dataBase64: z.string().min(1),
});
export type LogoUploadBody = z.output<typeof LogoUploadBody>;

/** The JSON body cap of the upload route: base64 of 1 MB plus the envelope. A larger body is 413. */
export const LOGO_UPLOAD_MAX_BODY_BYTES = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 64 * 1024;
