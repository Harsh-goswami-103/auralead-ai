/**
 * Password authentication with a persisted lockout (C6, ADR-12, plan §9 Auth).
 *
 * Every failure looks the same to the caller (`{ ok: false }`, rendered as one generic 401), and
 * every path runs exactly one argon2 verification: missing users and users without a password
 * verify against the dummy hash, so response time does not reveal whether an email exists.
 *
 * Lockout: 5 consecutive failures lock the account for 15 minutes (`User.lockedUntil`). The
 * counter is the only persisted rate-limit state and is written on failure only (plus the reset
 * on success). While locked, even the right password fails and the lock is not extended. After a
 * lock expires, counting starts again from one.
 */
import type { AppMode as DbAppMode, Prisma } from '@/generated/prisma/client';
import { argon2Hasher, type PasswordHasher } from './password';
import type { SessionUser } from './session';

export const LOGIN_LOCKOUT = { threshold: 5, durationMs: 15 * 60_000 } as const;

export type AuthenticateResult = { ok: true; user: SessionUser } | { ok: false };

export type AuthenticateDeps = { now: Date; mode: DbAppMode; hasher?: PasswordHasher };

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

export async function authenticate(
  db: Pick<Prisma.TransactionClient, 'user'>,
  input: { email: string; password: string },
  deps: AuthenticateDeps,
): Promise<AuthenticateResult> {
  const hasher = deps.hasher ?? argon2Hasher;
  const now = deps.now;
  const user = await db.user.findUnique({ where: { email: normalizeEmail(input.email) } });

  if (!user || user.passwordHash === null) {
    await hasher.verifyDummy(input.password);
    return { ok: false };
  }

  const lockActive = user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
  const passwordOk = await hasher.verify(user.passwordHash, input.password);
  if (lockActive) return { ok: false };

  const eligible = user.status === 'ACTIVE' && !(deps.mode === 'LIVE' && user.isDemo);
  if (!passwordOk || !eligible) {
    if (!passwordOk) {
      const lockExpired = user.lockedUntil !== null;
      const count = (lockExpired ? 0 : user.failedLoginCount) + 1;
      const lockedUntil = count >= LOGIN_LOCKOUT.threshold ? new Date(now.getTime() + LOGIN_LOCKOUT.durationMs) : null;
      await db.user.update({ where: { id: user.id }, data: { failedLoginCount: count, lockedUntil } });
    }
    return { ok: false };
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    select: { id: true, email: true, name: true, globalRole: true, status: true, isDemo: true },
  });
  return { ok: true, user: updated };
}
