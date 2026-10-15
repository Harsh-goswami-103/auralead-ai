/**
 * CSRF for cookie-authenticated route handlers (A32, plan §9) and the public-accept form nonce (C5).
 *
 * Non-GET cookie requests need both:
 *  1. `Origin` equal to APP_ORIGIN (or, only when Origin is absent, the `Referer` origin);
 *  2. `X-CSRF-Token` equal to HMAC(SESSION_SECRET, sessionId), served to the page in a meta tag.
 * Webhook, extension and public quote routes ignore cookies and never call this.
 */
import { hmacSha256, safeEqual } from './hmac';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginCheck = { ok: true } | { ok: false; reason: 'ORIGIN_MISSING' | 'ORIGIN_MISMATCH' };
export type CsrfCheck = { ok: true } | { ok: false; reason: 'ORIGIN_MISSING' | 'ORIGIN_MISMATCH' | 'TOKEN_MISSING' | 'TOKEN_INVALID' };

/** The token the page embeds for this session (base64url HMAC-SHA256). */
export function csrfTokenFor(sessionSecret: string, sessionId: string): string {
  if (!sessionSecret) throw new Error('SESSION_SECRET is required to mint CSRF tokens');
  return hmacSha256(sessionSecret, sessionId).toString('base64url');
}

function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Origin check alone (also used by the public accept route, C5). Origin wins when present;
 * Referer is consulted only when Origin is absent.
 */
export function checkOrigin(headers: Headers, appOrigin: string): OriginCheck {
  const expected = originOf(appOrigin);
  if (!expected) throw new Error('APP_ORIGIN is not a valid origin');
  const origin = headers.get('origin');
  const referer = headers.get('referer');
  const presented = origin !== null ? origin : referer;
  if (presented === null || presented === '') return { ok: false, reason: 'ORIGIN_MISSING' };
  const actual = origin !== null ? (origin === 'null' ? null : originOf(origin)) : originOf(presented);
  return actual === expected ? { ok: true } : { ok: false, reason: 'ORIGIN_MISMATCH' };
}

export function checkCsrf(input: {
  method: string;
  headers: Headers;
  appOrigin: string;
  sessionSecret: string;
  sessionId: string;
}): CsrfCheck {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  const origin = checkOrigin(input.headers, input.appOrigin);
  if (!origin.ok) return origin;
  const presented = input.headers.get(CSRF_HEADER);
  if (!presented) return { ok: false, reason: 'TOKEN_MISSING' };
  const expected = csrfTokenFor(input.sessionSecret, input.sessionId);
  return safeEqual(presented, expected) ? { ok: true } : { ok: false, reason: 'TOKEN_INVALID' };
}

/**
 * Public accept nonce (C5): HMAC(SHARE_NONCE_KEY, tokenHash || versionId). tokenHash is a
 * fixed-length sha256 hex, so plain concatenation is unambiguous.
 */
export function formNonce(shareNonceKey: string, tokenHash: string, versionId: string): string {
  if (!shareNonceKey) throw new Error('SHARE_NONCE_KEY is required to mint form nonces');
  return hmacSha256(shareNonceKey, `${tokenHash}${versionId}`).toString('base64url');
}

export function verifyFormNonce(shareNonceKey: string, tokenHash: string, versionId: string, presented: string): boolean {
  if (!presented) return false;
  return safeEqual(presented, formNonce(shareNonceKey, tokenHash, versionId));
}
