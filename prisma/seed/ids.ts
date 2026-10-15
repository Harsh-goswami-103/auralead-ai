/**
 * Deterministic seed ids. Every seeded row gets an id derived from a stable key, so two seeds
 * (and a reset) produce identical rows and `demo:refresh` can re-base times without changing ids
 * (R43, P20). The shape matches cuid2 (lowercase letter first, then lowercase alphanumerics,
 * 25 characters), so seeded ids are indistinguishable in format from runtime ids.
 */
import { createHash } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function seedId(kind: string, key: string): string {
  const digest = createHash('sha256').update(`auralead-seed:v1:${kind}:${key}`).digest();
  let out = ALPHABET[digest[0]! % 26]!;
  for (let i = 1; out.length < 25; i++) out += ALPHABET[digest[i]! % ALPHABET.length]!;
  return out;
}
