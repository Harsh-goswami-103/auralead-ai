/**
 * Password hashing (ADR-11, plan §9 Auth): argon2id via @node-rs/argon2 with the OWASP baseline
 * m=19456 KiB, t=2, p=1. `verifyDummy` runs one full verification against a fixed hash so that a
 * login for a missing user, or a user without a password, costs the same as a wrong password.
 */
import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2';
import { ValidationError } from '@/lib/errors';

/** `Algorithm.Argon2id` is an ambient const enum, which isolatedModules cannot read. */
const ARGON2ID = 2 as Algorithm;

export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const OPTIONS: Options = { ...ARGON2_PARAMS, algorithm: ARGON2ID };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Throws a 400 for a password outside the length policy. */
export function assertPasswordPolicy(password: string): void {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError({
      code: 'PASSWORD_POLICY',
      userMessage: `Use a password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
      safeDetails: { issues: [{ path: 'password', code: 'too_short_or_long', message: 'length' }] },
    });
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, OPTIONS);
}

/** False for a wrong password and for a stored value that is not a valid argon2 hash. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Verifies against a process-wide dummy hash and always returns false. */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hash(randomBytes(24).toString('base64url'), OPTIONS);
  await verifyPassword(await dummyHash, password);
  return false;
}

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(storedHash: string, password: string): Promise<boolean>;
  verifyDummy(password: string): Promise<false>;
};

export const argon2Hasher: PasswordHasher = { hash: hashPassword, verify: verifyPassword, verifyDummy };
