import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateExtensionToken,
  generateToken,
  hashToken,
  isWellFormedToken,
  parseExtensionToken,
  verifyExtensionSecret,
} from '@/server/security/tokens';

describe('opaque tokens (sessions, invites, share links)', () => {
  it('are 32 random bytes encoded as unpadded base64url', () => {
    const { token } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(Buffer.from(token, 'base64url').toString('base64url')).toBe(token);
    expect(isWellFormedToken(token)).toBe(true);
  });

  it('are unique', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken().token));
    expect(seen.size).toBe(500);
  });

  it('store only the sha256 hex of the token, and lookup by hash finds it', () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(tokenHash).not.toContain(token);

    const table = new Map<string, { id: string }>();
    for (let i = 0; i < 20; i++) table.set(generateToken().tokenHash, { id: `other_${i}` });
    table.set(tokenHash, { id: 'session_1' });

    expect(table.get(hashToken(token))).toEqual({ id: 'session_1' });
    const altered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(table.get(hashToken(altered))).toBeUndefined();
  });

  it('isWellFormedToken rejects other shapes before any lookup', () => {
    for (const bad of ['', 'abc', `${'a'.repeat(43)}=`, 'a'.repeat(44), `${'a'.repeat(42)}+`, `${'a'.repeat(42)}/`]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });
});

describe('extension tokens alx_<keyId>_<secret> (T8, C18)', () => {
  it('have a public prefix, a 32-byte secret, and store only the secret hash', () => {
    const t = generateExtensionToken();
    expect(t.token).toMatch(/^alx_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(t.token.startsWith(`${t.prefix}_`)).toBe(true);
    expect(t.secretHash).toMatch(/^[0-9a-f]{64}$/);

    const parsed = parseExtensionToken(t.token);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(t.prefix);
    expect(Buffer.from(parsed!.secret, 'base64url')).toHaveLength(32);
    expect(hashToken(parsed!.secret)).toBe(t.secretHash);
  });

  it('parses secrets that contain underscores and dashes', () => {
    const token = `alx_0123456789abcdef_${'_-'.repeat(21)}A`;
    expect(parseExtensionToken(token)).toEqual({ prefix: 'alx_0123456789abcdef', keyId: '0123456789abcdef', secret: `${'_-'.repeat(21)}A` });
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'alx_', 'alx_zz_abc', 'Bearer alx_0123456789abcdef_x', `aly_0123456789abcdef_${'a'.repeat(43)}`, `alx_0123456789abcdef_${'a'.repeat(42)}`]) {
      expect(parseExtensionToken(bad)).toBeNull();
    }
  });

  it('verifies the secret against the stored hash in constant time', () => {
    const t = generateExtensionToken();
    const { secret } = parseExtensionToken(t.token)!;
    expect(verifyExtensionSecret(secret, t.secretHash)).toBe(true);
    expect(verifyExtensionSecret(secret, generateExtensionToken().secretHash)).toBe(false);
    expect(verifyExtensionSecret(secret, 'not-a-hash')).toBe(false);
  });
});
