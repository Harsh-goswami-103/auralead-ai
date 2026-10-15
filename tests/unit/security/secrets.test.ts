import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialAad,
  decryptSecret,
  decryptSecretString,
  encryptSecret,
  envelopeKid,
  reencryptToActive,
  requireKeyRing,
  SecretDecryptError,
  webhookPayloadAad,
  type KeyRing,
} from '@/server/security/secrets';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ring1: KeyRing = { activeKid: 'k1', keys: { k1 } };
const ring12: KeyRing = { activeKid: 'k2', keys: { k1, k2 } };
const aad = credentialAad({ workspaceId: 'ws_a', integrationId: 'int_1', field: 'accessToken' });

function splitEnvelope(env: string) {
  const parts = env.split('.');
  expect(parts).toHaveLength(5);
  return parts as [string, string, string, string, string];
}

function decodeError(fn: () => unknown): SecretDecryptError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SecretDecryptError);
    return err as SecretDecryptError;
  }
  throw new Error('expected decryption to fail');
}

describe('AES-256-GCM key ring (ADR-25)', () => {
  it('round trips and uses the envelope v1.<kid>.<nonce>.<ct>.<tag>', () => {
    const env = encryptSecret(ring1, 'EAAG-secret-token-1234', aad);
    const [version, kid, nonce, ct, tag] = splitEnvelope(env);
    expect(version).toBe('v1');
    expect(kid).toBe('k1');
    expect(Buffer.from(nonce, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
    expect(Buffer.from(ct, 'base64url').toString('utf8')).not.toContain('secret');
    expect(env).not.toContain('EAAG');
    expect(decryptSecretString(ring1, env, aad)).toBe('EAAG-secret-token-1234');
  });

  it('uses a fresh nonce for every encryption', () => {
    const a = encryptSecret(ring1, 'same', aad);
    const b = encryptSecret(ring1, 'same', aad);
    expect(a).not.toBe(b);
    expect(splitEnvelope(a)[2]).not.toBe(splitEnvelope(b)[2]);
  });

  it('round trips binary payloads and empty strings', () => {
    const bytes = randomBytes(300);
    expect(decryptSecret(ring1, encryptSecret(ring1, bytes, aad), aad).equals(bytes)).toBe(true);
    expect(decryptSecretString(ring1, encryptSecret(ring1, '', aad), aad)).toBe('');
  });

  it('fails with the wrong AAD (ciphertext copied to another tenant row)', () => {
    const env = encryptSecret(ring1, 'secret', aad);
    const otherTenant = credentialAad({ workspaceId: 'ws_b', integrationId: 'int_1', field: 'accessToken' });
    const otherField = credentialAad({ workspaceId: 'ws_a', integrationId: 'int_1', field: 'appSecret' });
    expect(decodeError(() => decryptSecret(ring1, env, otherTenant)).reason).toBe('AUTH_FAILED');
    expect(decodeError(() => decryptSecret(ring1, env, otherField)).reason).toBe('AUTH_FAILED');
  });

  it('binds webhook processing payloads to the webhook event id (ADR-35)', () => {
    const env = encryptSecret(ring1, JSON.stringify({ phone: '+919876543210' }), webhookPayloadAad('evt_1'));
    expect(JSON.parse(decryptSecretString(ring1, env, webhookPayloadAad('evt_1')))).toEqual({ phone: '+919876543210' });
    expect(decodeError(() => decryptSecret(ring1, env, webhookPayloadAad('evt_2'))).reason).toBe('AUTH_FAILED');
  });

  it('fails when the tag, ciphertext or nonce is tampered with', () => {
    const env = encryptSecret(ring1, 'secret-value', aad);
    const [v, kid, nonce, ct, tag] = splitEnvelope(env);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64url');
      buf[0] = buf[0]! ^ 0x01;
      return buf.toString('base64url');
    };
    expect(decodeError(() => decryptSecret(ring1, [v, kid, nonce, ct, flip(tag)].join('.'), aad)).reason).toBe('AUTH_FAILED');
    expect(decodeError(() => decryptSecret(ring1, [v, kid, nonce, flip(ct), tag].join('.'), aad)).reason).toBe('AUTH_FAILED');
    expect(decodeError(() => decryptSecret(ring1, [v, kid, flip(nonce), ct, tag].join('.'), aad)).reason).toBe('AUTH_FAILED');
  });

  it('rejects a truncated tag instead of accepting a short GCM tag', () => {
    const [v, kid, nonce, ct, tag] = splitEnvelope(encryptSecret(ring1, 'secret', aad));
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(decodeError(() => decryptSecret(ring1, [v, kid, nonce, ct, short].join('.'), aad)).reason).toBe('MALFORMED');
  });

  it('fails for an unknown kid', () => {
    const env = encryptSecret(ring12, 'secret', aad); // encrypted under k2
    expect(envelopeKid(env)).toBe('k2');
    expect(decodeError(() => decryptSecret(ring1, env, aad)).reason).toBe('UNKNOWN_KID');
  });

  it('rejects malformed envelopes', () => {
    for (const bad of ['', 'v1.k1.abc', 'v2.k1.a.b.c', 'plaintext', 'v1..a.b.c']) {
      expect(decodeError(() => decryptSecret(ring1, bad, aad)).reason).toBe('MALFORMED');
    }
  });

  it('error messages never contain plaintext or key material', () => {
    const env = encryptSecret(ring1, 'super-secret-plain', aad);
    const err = decodeError(() => decryptSecret(ring1, env, 'wrong'));
    expect(err.message).not.toContain('super-secret-plain');
    expect(err.message).not.toContain(k1.toString('base64'));
  });

  it('rotation decrypts old ciphertexts and re-encrypts them to the active kid', () => {
    const old = encryptSecret(ring1, 'rotate-me', aad);
    expect(envelopeKid(old)).toBe('k1');

    // Old ciphertext still decrypts with the new ring (k1 is still present).
    expect(decryptSecretString(ring12, old, aad)).toBe('rotate-me');

    const rotated = reencryptToActive(ring12, old, aad);
    expect(rotated.changed).toBe(true);
    expect(envelopeKid(rotated.envelope)).toBe('k2');
    expect(decryptSecretString(ring12, rotated.envelope, aad)).toBe('rotate-me');

    // After rotation the old key can be dropped.
    const ring2only: KeyRing = { activeKid: 'k2', keys: { k2 } };
    expect(decryptSecretString(ring2only, rotated.envelope, aad)).toBe('rotate-me');
    expect(decodeError(() => decryptSecret(ring2only, old, aad)).reason).toBe('UNKNOWN_KID');

    // Already on the active kid: unchanged.
    const again = reencryptToActive(ring12, rotated.envelope, aad);
    expect(again).toEqual({ envelope: rotated.envelope, changed: false });
  });

  it('rotation refuses to re-encrypt under the wrong AAD', () => {
    const old = encryptSecret(ring1, 'rotate-me', aad);
    expect(decodeError(() => reencryptToActive(ring12, old, 'other|aad|x')).reason).toBe('AUTH_FAILED');
  });

  it('validates the key ring', () => {
    expect(() => encryptSecret({ activeKid: 'k9', keys: { k1 } }, 'x', aad)).toThrow(/active kid/i);
    expect(() => encryptSecret({ activeKid: 'k1', keys: { k1: randomBytes(16) } }, 'x', aad)).toThrow(/32 bytes/);
    expect(() => encryptSecret({ activeKid: 'bad.kid', keys: { 'bad.kid': k1 } }, 'x', aad)).toThrow(/kid/i);
  });

  it('builds AAD as workspaceId|integrationId|field and rejects separators inside parts', () => {
    expect(credentialAad({ workspaceId: 'w', integrationId: 'i', field: 'f' })).toBe('w|i|f');
    expect(() => credentialAad({ workspaceId: 'w|x', integrationId: 'i', field: 'f' })).toThrow();
    expect(() => credentialAad({ workspaceId: '', integrationId: 'i', field: 'f' })).toThrow();
  });

  it('requireKeyRing throws a clear error when the ring is not configured', () => {
    expect(() => requireKeyRing({ secrets: { credentials: null } })).toThrow(/CREDENTIALS_KEYRING/);
    expect(requireKeyRing({ secrets: { credentials: ring1 } })).toBe(ring1);
  });
});
