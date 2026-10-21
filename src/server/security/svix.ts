/**
 * Svix-style webhook signatures (Resend webhooks, T33; plan §9 Webhooks, A34, ADR-101).
 *
 * Resend signs each delivery the way Svix does (checked through search snippets of Resend's
 * "Verify webhooks requests" page and Svix's "How to verify" page on 2026-10-20; UNVERIFIED until
 * a live check):
 *  - headers `svix-id`, `svix-timestamp` (Unix seconds) and `svix-signature`;
 *  - the signed content is `${svix-id}.${svix-timestamp}.${raw body}` over the exact bytes;
 *  - the key is the base64 part of the `whsec_...` signing secret;
 *  - `svix-signature` holds one or more space-separated `v1,<base64 HMAC-SHA256>` values; any one
 *    matching is enough (secret rotation);
 *  - deliveries whose timestamp is more than 5 minutes from now are refused (replay window).
 * The comparison is constant-time per candidate. The signature is checked before the timestamp,
 * so an unsigned request learns nothing about the server clock. Pure: no I/O.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SVIX_TOLERANCE_SECONDS = 300;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const TS_RE = /^\d{1,12}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_KEY_BYTES = 16;
const MAX_CANDIDATES = 8;

export type SvixHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export type SvixFailure = 'SECRET_NOT_CONFIGURED' | 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID' | 'REPLAY_WINDOW';

export type SvixVerification = { ok: true; id: string; timestamp: number } | { ok: false; reason: SvixFailure };

/** The HMAC key of a `whsec_<base64>` secret, or null when it is not one. */
export function svixSecretKey(secret: string): Buffer | null {
  const body = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (!B64_RE.test(body)) return null;
  const key = Buffer.from(body, 'base64');
  return key.length >= MIN_KEY_BYTES ? key : null;
}

function expectedSignature(key: Buffer, id: string, timestamp: string, raw: Buffer): Buffer {
  return createHmac('sha256', key).update(Buffer.from(`${id}.${timestamp}.`, 'utf8')).update(raw).digest();
}

/** Reads the three headers from a request (null when absent). */
export function svixHeadersOf(headers: Headers): SvixHeaders {
  return { id: headers.get('svix-id'), timestamp: headers.get('svix-timestamp'), signature: headers.get('svix-signature') };
}

export function verifySvixSignature(input: { secret: string | null; headers: SvixHeaders; raw: Buffer; now: Date; toleranceSeconds?: number }): SvixVerification {
  const key = input.secret ? svixSecretKey(input.secret) : null;
  if (!key) return { ok: false, reason: 'SECRET_NOT_CONFIGURED' };
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'SIGNATURE_MISSING' };
  if (!ID_RE.test(id) || !TS_RE.test(timestamp)) return { ok: false, reason: 'SIGNATURE_INVALID' };

  const expected = expectedSignature(key, id, timestamp, input.raw);
  let matched = false;
  for (const candidate of signature.trim().split(/\s+/).slice(0, MAX_CANDIDATES)) {
    const comma = candidate.indexOf(',');
    if (comma < 0 || candidate.slice(0, comma) !== 'v1') continue;
    const value = candidate.slice(comma + 1);
    if (!B64_RE.test(value)) continue;
    const provided = Buffer.from(value, 'base64');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'SIGNATURE_INVALID' };

  const seconds = Number(timestamp);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (Math.abs(input.now.getTime() / 1000 - seconds) > tolerance) return { ok: false, reason: 'REPLAY_WINDOW' };
  return { ok: true, id, timestamp: seconds };
}
