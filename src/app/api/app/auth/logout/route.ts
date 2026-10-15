/** POST /api/app/auth/logout: revokes the current session and clears the cookie (CSRF-checked). */
import { buildClearedSessionCookie, revokeSession } from '@/server/auth/session';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session' }, async ({ session, ctx, runtime, setCookie }) => {
  if (session) await revokeSession(runtime.prisma, session.session.id, ctx.clock.now());
  setCookie(buildClearedSessionCookie(runtime.config));
  return { redirectTo: '/login' };
});
