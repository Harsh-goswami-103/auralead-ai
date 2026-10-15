/**
 * Opaque bearer tokens (sessions, invites, quote share links: plan §9, C2) and extension tokens
 * (`alx_<keyId>_<secret>`, T8/C18). Tokens are 32 random bytes in unpadded base64url; only the
 * sha256 hex is stored, and lookups hash the presented token first.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const EXTENSION_RE = /^alx_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when the string has the shape of a token from generateToken(); check before hashing input. */
export function isWellFormedToken(token: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  // 43 chars carry 258 bits; the canonical encoding of 32 bytes has zero low bits in the last char.
  return Buffer.from(token, 'base64url').toString('base64url') === token;
}

export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export type ExtensionTokenParts = { prefix: string; keyId: string; secret: string };

/**
 * New extension token. `token` is shown once; store `prefix` (UNIQUE, used for lookup) and
 * `secretHash`.
 */
export function generateExtensionToken(): { token: string; prefix: string; secretHash: string } {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const prefix = `alx_${keyId}`;
  return { token: `${prefix}_${secret}`, prefix, secretHash: hashToken(secret) };
}

export function parseExtensionToken(token: string): ExtensionTokenParts | null {
  const m = EXTENSION_RE.exec(token);
  if (!m) return null;
  const keyId = m[1]!;
  const secret = m[2]!;
  return { prefix: `alx_${keyId}`, keyId, secret };
}

/** Constant-time check of a presented secret against the stored sha256 hex. */
export function verifyExtensionSecret(secret: string, storedHash: string): boolean {
  if (!SHA256_HEX_RE.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashToken(secret), 'hex'), Buffer.from(storedHash, 'hex'));
}
