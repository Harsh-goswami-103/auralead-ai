/**
 * HMAC-SHA256 helpers and constant-time comparison (plan §9 Webhooks, CSRF, contact key).
 * Everything here works on exact bytes: callers pass the raw request body from raw-body.ts,
 * never re-serialized JSON.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type BinaryLike = string | Buffer;

export function hmacSha256(key: BinaryLike, data: BinaryLike): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Constant-time string equality. Both sides are hashed to a fixed length first, so the
 * comparison never throws and does not short-circuit on the first differing byte.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/** Verifies a hex HMAC-SHA256 digest of `data` under `key`, in constant time. */
export function verifyHmacHex(key: BinaryLike, data: BinaryLike, providedHex: string): boolean {
  if (!HEX_SHA256.test(providedHex)) return false;
  const expected = hmacSha256(key, data);
  return timingSafeEqual(expected, Buffer.from(providedHex, 'hex'));
}

/**
 * Meta / WhatsApp `X-Hub-Signature-256: sha256=<hex>` over the raw body bytes (A34).
 * A missing or malformed header, or an unset secret, never verifies.
 */
export function verifyHubSignature256(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  return verifyHmacHex(appSecret, rawBody, header.slice('sha256='.length));
}
