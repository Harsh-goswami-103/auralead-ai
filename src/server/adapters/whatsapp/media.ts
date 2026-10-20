/**
 * WhatsApp media upload for the quotation PDF (P2, plan §4.4; T32). A document goes to the
 * provider as bytes, never as a link: a local URL is not reachable by Meta, and a public link would
 * expose the quote. The upload returns a media id that the message then references
 * (`document.id` or a DOCUMENT header parameter).
 *
 * Documented shape (developers.facebook.com, "Upload media"; read through search snippets only on
 * 2026-10-20, UNVERIFIED until a live check, see docs/integrations.md):
 *   POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/media, multipart/form-data with
 *   `messaging_product=whatsapp`, `type=<mime>` and `file`; answer `{ "id": "<MEDIA_ID>" }`.
 *   Documents up to 100 MB; uploaded media persists for 30 days unless deleted.
 */
import { randomBytes } from 'node:crypto';
import type { WaDocument } from './port';

export const WA_MEDIA_CHECKED_ON = '2026-10-20';
/** Documents (UNVERIFIED: third-party docs and snippets say 100 MB). */
export const WA_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
/** Uploaded media ids stay usable this long (UNVERIFIED: 30 days per the snippet). The adapter uploads per send, so it never relies on it. */
export const WA_MEDIA_TTL_DAYS = 30;

/** A file name the provider shows the customer: letters, digits, dot, dash and underscore only. */
export function safeDocumentFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'document.pdf';
}

/** The multipart body of a media upload (boundary injectable for byte-exact tests). */
export function mediaUploadBody(doc: WaDocument, boundary: string = `auralead-${randomBytes(12).toString('hex')}`): { body: Buffer; contentType: string } {
  const crlf = '\r\n';
  const part = (name: string, value: string) => `--${boundary}${crlf}Content-Disposition: form-data; name="${name}"${crlf}${crlf}${value}${crlf}`;
  const head = Buffer.from(
    part('messaging_product', 'whatsapp') +
      part('type', doc.mimeType) +
      `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="${safeDocumentFilename(doc.filename)}"${crlf}Content-Type: ${doc.mimeType}${crlf}${crlf}`,
    'utf8',
  );
  const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`, 'utf8');
  return { body: Buffer.concat([head, doc.bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
