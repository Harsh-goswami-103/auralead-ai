/**
 * Signing a user in (login, invite redemption, DEMO persona switch, re-auth): revoke whatever
 * session the browser presented, create a fresh one, and hand back the Set-Cookie value and the
 * CSRF token for the page's meta tag. One code path, so every entry point rotates the same way.
 */
import type { AppMode as DbAppMode, PrismaClient } from '@/generated/prisma/client';
import { csrfTokenFor } from '@/server/security/csrf';
import { clientIp } from '@/server/security/rate-limit';
import { buildSessionCookie, createSession, hashClientIp, readSessionToken, revokeSessionByToken, type SessionUser } from './session';

export type IssueConfig = { authCookieInsecureDev: boolean; trustedProxyHops: number; secrets: { sessionSecret: string | null } };

export type IssuedSession = { cookie: string; csrfToken: string; sessionId: string };

function sessionSecretOf(config: IssueConfig): string {
  const secret = config.secrets.sessionSecret;
  if (!secret) throw new Error('SESSION_SECRET is required to issue sessions (boot checks enforce it)');
  return secret;
}

export async function issueSession(
  prisma: PrismaClient,
  config: IssueConfig,
  req: Request,
  input: { user: Pick<SessionUser, 'id' | 'globalRole'>; mode: DbAppMode; activeWorkspaceId: string | null; now: Date; reauthAt?: Date | null },
): Promise<IssuedSession> {
  const secret = sessionSecretOf(config);
  await revokeSessionByToken(prisma, readSessionToken(req.headers, config), input.now);
  const ip = clientIp(req.headers, null, config.trustedProxyHops);
  const { token, session } = await createSession(prisma, {
    userId: input.user.id,
    globalRole: input.user.globalRole,
    mode: input.mode,
    activeWorkspaceId: input.activeWorkspaceId,
    ipHash: hashClientIp(secret, ip),
    userAgent: req.headers.get('user-agent') ?? '',
    now: input.now,
    reauthAt: input.reauthAt ?? null,
  });
  return {
    cookie: buildSessionCookie(config, token, session.absoluteExpiresAt, input.now),
    csrfToken: csrfTokenFor(secret, session.id),
    sessionId: session.id,
  };
}

/** The CSRF token for an existing session (served to pages in a meta tag). */
export function csrfTokenForSession(config: IssueConfig, sessionId: string): string {
  return csrfTokenFor(sessionSecretOf(config), sessionId);
}
