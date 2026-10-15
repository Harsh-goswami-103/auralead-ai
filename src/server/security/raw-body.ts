/**
 * Read a request body exactly once as raw bytes, with a size cap (A34, C14, plan §9).
 *
 * Signatures (Meta, WhatsApp, Sheets, Resend) are computed over these exact bytes, so callers
 * must never call `req.text()` or `req.json()` first. A declared Content-Length over the cap is
 * refused before any byte is read; a body without (or lying about) Content-Length is counted while
 * streaming and the stream is cancelled as soon as the count passes the cap.
 */

/** Plan §9 caps, in bytes. */
export const RAW_BODY_LIMITS = {
  meta: 1_048_576,
  whatsapp: 1_048_576,
  sheets: 262_144,
  extension: 1_048_576,
} as const;

export type RawBodyErrorCode = 'PAYLOAD_TOO_LARGE' | 'BAD_CONTENT_LENGTH';

export class RawBodyError extends Error {
  readonly status: 400 | 413;
  readonly code: RawBodyErrorCode;
  constructor(code: RawBodyErrorCode, message: string) {
    super(message);
    this.name = 'RawBodyError';
    this.code = code;
    this.status = code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
  }
}

export type RawBodySource = { headers: Headers; body: ReadableStream<Uint8Array> | null };

export async function readRawBody(req: RawBodySource, opts: { maxBytes: number }): Promise<Buffer> {
  const { maxBytes } = opts;
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes must be a non-negative integer');

  const declared = req.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) throw new RawBodyError('BAD_CONTENT_LENGTH', 'Content-Length is not a valid byte count');
    if (Number(declared.trim()) > maxBytes) {
      throw new RawBodyError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`);
    }
  }

  if (!req.body) return Buffer.alloc(0);

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('payload too large');
        throw new RawBodyError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`);
      }
      // Copy: the producer may reuse its chunk buffers.
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
