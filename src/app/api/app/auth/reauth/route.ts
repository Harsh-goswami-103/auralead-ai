/**
 * POST /api/app/auth/reauth: password re-entry (plan §9: the global pause and elevated drilldown
 * need one within 15 minutes). Success rotates the session and stamps `reauthAt`; failure is the
 * generic 401 and counts toward the persisted lockout like a login failure.
 */
import { z } from 'zod';
import { issueSession } from '@/server/auth/issue';
import { authenticate } from '@/server/auth/login';
import { dbMode, SESSION_POLICY } from '@/server/auth/session';
import { withRoute } from '../../../_lib/with-route';
import { invalidCredentials } from '../_errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ password: z.string().min(1).max(1024) });

export const POST = withRoute(
  { auth: 'session', body: Body, rateLimit: [{ policy: 'loginEmail', key: ({ ctx }) => (ctx.actor ? `reauth:${ctx.actor.userId}` : null) }] },
  async ({ req, body, ctx, session, runtime, setCookie }) => {
    const now = ctx.clock.now();
    const mode = dbMode(runtime.config.mode);
    const current = session!;
    const result = await authenticate(runtime.prisma, { email: current.user.email, password: body.password }, { now, mode });
    if (!result.ok || result.user.id !== current.user.id) throw invalidCredentials();
    const issued = await issueSession(runtime.prisma, runtime.config, req, {
      user: current.user,
      mode,
      activeWorkspaceId: current.session.activeWorkspaceId,
      now,
      reauthAt: now,
    });
    setCookie(issued.cookie);
    return { csrfToken: issued.csrfToken, reauthUntil: new Date(now.getTime() + SESSION_POLICY.reauthWindowMs).toISOString() };
  },
);
