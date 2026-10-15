/**
 * GET /api/app/auth/session: who is signed in, the resolved workspace, capabilities, mode and
 * the CSRF token for this session. Panels use it for the shell (T08); 401 without a session.
 */
import { csrfTokenForSession } from '@/server/auth/issue';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session' }, async ({ ctx, session, runtime }) => {
  const current = session!;
  const workspace =
    ctx.workspaceId === null
      ? null
      : await runtime.prisma.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { id: true, slug: true, name: true, mode: true } });
  return {
    mode: runtime.config.mode,
    user: { id: current.user.id, name: current.user.name, email: current.user.email, role: current.user.globalRole, isDemo: current.user.isDemo },
    workspace,
    capabilities: [...ctx.capabilities].sort(),
    maxDiscountBps: ctx.maxDiscountBps,
    csrfToken: csrfTokenForSession(runtime.config, current.session.id),
  };
});
