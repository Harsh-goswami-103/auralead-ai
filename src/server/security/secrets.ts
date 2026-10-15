/**
 * Credential encryption with a key ring (A33, ADR-25; also webhook processing payloads, ADR-35).
 *
 * AES-256-GCM, 12-byte random nonce, 16-byte tag. Envelope: `v1.<kid>.<nonce>.<ct>.<tag>` with
 * the binary parts in unpadded base64url. AAD binds a ciphertext to its row and field
 * (`workspaceId|integrationId|field`, or the webhook event id), so a ciphertext copied to another
 * tenant's row fails to decrypt. Encrypt uses the active kid; decrypt accepts any kid in the ring.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type KeyRing = { activeKid: string; keys: Record<string, Buffer> };

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export type SecretDecryptReason = 'MALFORMED' | 'UNKNOWN_KID' | 'AUTH_FAILED';

/** Decryption failure. The message never includes plaintext, ciphertext or key material. */
export class SecretDecryptError extends Error {
  readonly reason: SecretDecryptReason;
  constructor(reason: SecretDecryptReason, detail: string) {
    super(`Secret decryption failed (${reason}): ${detail}`);
    this.name = 'SecretDecryptError';
    this.reason = reason;
  }
}

export class KeyRingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyRingError';
  }
}

function keyFor(ring: KeyRing, kid: string): Buffer | undefined {
  return Object.prototype.hasOwnProperty.call(ring.keys, kid) ? ring.keys[kid] : undefined;
}

function activeKey(ring: KeyRing): Buffer {
  if (!KID_RE.test(ring.activeKid)) throw new KeyRingError('Key ring active kid must match [A-Za-z0-9_-]{1,64}');
  const key = keyFor(ring, ring.activeKid);
  if (!key) throw new KeyRingError(`Key ring has no key for the active kid "${ring.activeKid}"`);
  if (key.length !== KEY_BYTES) throw new KeyRingError(`Key "${ring.activeKid}" must be ${KEY_BYTES} bytes`);
  return key;
}

/** The configured ring, or a clear error naming the env vars when it is not configured. */
export function requireKeyRing(config: { secrets: { credentials: KeyRing | null } }): KeyRing {
  const ring = config.secrets.credentials;
  if (!ring) throw new KeyRingError('CREDENTIALS_KEYRING and CREDENTIALS_ACTIVE_KID are not configured (run `npm run setup`).');
  return ring;
}

function assertAadPart(name: string, value: string): void {
  if (!value || value.includes('|')) throw new Error(`AAD part "${name}" must be non-empty and must not contain "|"`);
}

/** AAD for an Integration credential field: `workspaceId|integrationId|field`. */
export function credentialAad(parts: { workspaceId: string; integrationId: string; field: string }): string {
  assertAadPart('workspaceId', parts.workspaceId);
  assertAadPart('integrationId', parts.integrationId);
  assertAadPart('field', parts.field);
  return `${parts.workspaceId}|${parts.integrationId}|${parts.field}`;
}

/**
 * AAD for `WebhookEvent.processingPayload` (E1, ADR-35): the webhook event id itself. It cannot
 * collide with a credential AAD because ids never contain "|".
 */
export function webhookPayloadAad(webhookEventId: string): string {
  assertAadPart('webhookEventId', webhookEventId);
  return webhookEventId;
}

export function encryptSecret(ring: KeyRing, plaintext: string | Buffer, aad: string): string {
  const key = activeKey(ring);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ring.activeKid, nonce.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

type ParsedEnvelope = { kid: string; nonce: Buffer; ct: Buffer; tag: Buffer };

function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split('.');
  if (parts.length !== 5) throw new SecretDecryptError('MALFORMED', 'expected 5 envelope parts');
  const [version, kid, nonceB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  if (version !== VERSION) throw new SecretDecryptError('MALFORMED', 'unsupported envelope version');
  if (!KID_RE.test(kid)) throw new SecretDecryptError('MALFORMED', 'invalid kid');
  if (![nonceB64, ctB64, tagB64].every((p) => B64URL_RE.test(p))) throw new SecretDecryptError('MALFORMED', 'invalid encoding');
  const nonce = Buffer.from(nonceB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (nonce.length !== NONCE_BYTES) throw new SecretDecryptError('MALFORMED', 'invalid nonce length');
  // Never accept a truncated GCM tag.
  if (tag.length !== TAG_BYTES) throw new SecretDecryptError('MALFORMED', 'invalid tag length');
  return { kid, nonce, ct: Buffer.from(ctB64, 'base64url'), tag };
}

/** The kid an envelope was encrypted under (used by `creds:rotate` reporting). */
export function envelopeKid(envelope: string): string {
  return parseEnvelope(envelope).kid;
}

export function decryptSecret(ring: KeyRing, envelope: string, aad: string): Buffer {
  const { kid, nonce, ct, tag } = parseEnvelope(envelope);
  const key = keyFor(ring, kid);
  if (!key) throw new SecretDecryptError('UNKNOWN_KID', `kid "${kid}" is not in the key ring`);
  if (key.length !== KEY_BYTES) throw new KeyRingError(`Key "${kid}" must be ${KEY_BYTES} bytes`);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SecretDecryptError('AUTH_FAILED', 'authentication tag mismatch (wrong key, AAD, or tampered data)');
  }
}

export function decryptSecretString(ring: KeyRing, envelope: string, aad: string): string {
  return decryptSecret(ring, envelope, aad).toString('utf8');
}

/**
 * Rotation step for `npm run creds:rotate`: decrypts with whatever kid the envelope names and
 * re-encrypts under the active kid. Envelopes already on the active kid are returned unchanged.
 */
export function reencryptToActive(ring: KeyRing, envelope: string, aad: string): { envelope: string; changed: boolean } {
  const plain = decryptSecret(ring, envelope, aad);
  if (envelopeKid(envelope) === ring.activeKid) return { envelope, changed: false };
  return { envelope: encryptSecret(ring, plain, aad), changed: true };
}
