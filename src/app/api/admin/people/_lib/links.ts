/**
 * Shared pieces of the super admin's people and workspace routes (T29): the one-time link a
 * created credential is shown as (the token appears in that one response only; the database keeps
 * its hash), and the plan §9 "invite/reset 10/h" rate limits, kept per acting administrator.
 */
import type { RateRule } from '../../../_lib/with-route';

export function oneTimeLink(appOrigin: string, kind: 'invite' | 'reset', token: string): string {
  return new URL(`/${kind}/${token}`, appOrigin).toString();
}

/** Invites, including a new workspace's owner invite: 10 per hour per administrator. */
export const INVITE_RATE: RateRule = { policy: 'inviteReset', key: ({ ctx }) => (ctx.actor ? `admin-invite:${ctx.actor.userId}` : null) };

/** Password reset links: 10 per hour per administrator. */
export const RESET_RATE: RateRule = { policy: 'inviteReset', key: ({ ctx }) => (ctx.actor ? `admin-reset:${ctx.actor.userId}` : null) };
