/**
 * Fresh authentication for the super admin's dangerous actions (plan §9: the global outbound pause
 * and every inspector mutation, which elevate into a workspace through `adminContext`).
 *
 * A session counts as freshly authenticated when the person proved who they are within the
 * re-auth window (15 minutes): either a password re-entry (`Session.reauthAt`, set by
 * `/api/app/auth/reauth`) or the sign-in that created the session (`Session.createdAt`). In LIVE
 * every session is created by a password sign-in (login, invite acceptance) or a re-auth, so
 * both are a password entry within the window. In DEMO the seeded personas have no password; a
 * persona sign-in through the role switcher is their authentication (ADR-64).
 */
import { AuthError } from '@/lib/errors';
import { SESSION_POLICY } from '@/server/auth/session';

export const FRESH_AUTH_WINDOW_MS = SESSION_POLICY.reauthWindowMs;

export type AuthTimes = { createdAt: Date; reauthAt: Date | null };

function within(at: Date | null, now: Date): boolean {
  if (at === null) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age < FRESH_AUTH_WINDOW_MS;
}

export function hasFreshAuthentication(session: AuthTimes, now: Date): boolean {
  return within(session.reauthAt, now) || within(session.createdAt, now);
}

export function requireFreshAuthentication(session: AuthTimes, now: Date): void {
  if (!hasFreshAuthentication(session, now)) {
    throw new AuthError({ code: 'REAUTH_REQUIRED', userMessage: 'Confirm your identity again to continue.' });
  }
}
