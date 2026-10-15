/**
 * POST /api/app/auth/active-workspace { workspaceSlug }: switches the session's active workspace
 * (WorkspaceChip). The slug must resolve to a membership (USER) or an active assignment
 * (EMPLOYEE); anything else is 404. Super admins open workspaces only through adminContext.
 */
import { z } from 'zod';
import { resolveSwitchableWorkspace } from '@/server/auth/context';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ workspaceSlug: z.string().min(1).max(64) });

export const POST = withRoute({ auth: 'session', body: Body, roles: ['USER', 'EMPLOYEE'] }, async ({ body, ctx, session, runtime }) => {
  const current = session!;
  const workspaceId = await resolveSwitchableWorkspace(current, body.workspaceSlug, { prisma: runtime.prisma, mode: runtime.config.mode, clock: ctx.clock });
  await runtime.prisma.session.update({ where: { id: current.session.id }, data: { activeWorkspaceId: workspaceId } });
  return { workspaceId };
});
