/**
 * Random tokens and deterministic keys. Entity ids are Prisma `cuid(2)` defaults; this module
 * covers the other identifiers: job claim tokens, idempotency keys and scheduler time buckets
 * (plan §4.3: `quote-expiry:2026-10-15T10`). Uses Web Crypto so it works in Node and browsers.
 */

/** `bytes` cryptographically random bytes, base64url without padding. */
export function randomBase64Url(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 1024) throw new RangeError('bytes must be an integer from 1 to 1024');
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lease token written by the claim statement and checked by the fence (E5). 128 bits. */
export function newClaimToken(): string {
  return `ct_${randomBase64Url(16)}`;
}

/**
 * Joins parts with ':' after percent-escaping '%' and ':' inside each part, so
 * ('a:b','c') and ('a','b:c') never produce the same key.
 */
export function idempotencyKey(...parts: Array<string | number | bigint>): string {
  if (parts.length === 0) throw new RangeError('idempotencyKey needs at least one part');
  return parts
    .map((p) => {
      const s = String(p);
      if (s.length === 0) throw new RangeError('idempotencyKey parts must be non-empty');
      return s.replace(/%/g, '%25').replace(/:/g, '%3A');
    })
    .join(':');
}

export type TimeBucket = 'minute' | 'hour' | 'day';

/** UTC bucket key, so duplicate schedulers in the same bucket enqueue one job. */
export function timeBucketKey(prefix: string, at: Date, bucket: TimeBucket): string {
  if (Number.isNaN(at.getTime())) throw new RangeError('timeBucketKey needs a valid date');
  const iso = at.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const cut = bucket === 'day' ? 10 : bucket === 'hour' ? 13 : 16;
  return `${prefix}:${iso.slice(0, cut)}`;
}
