/**
 * POST /api/admin/people/[userId]/assignments { targetWorkspaceId, capabilities, maxDiscountBps,
 * active, reason } (T29, R33): creates or updates an employee's assignment to a workspace (its
 * capabilities and own discount cap, or deactivates it), revoking every session of theirs. Only
 * employees are assigned (422 NOT_AN_EMPLOYEE); an active assignment needs at least one
 * capability. Super admin only, fresh sign-in within 15 minutes, audited on the workspace.
 */
import { AssignmentSetBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { setAssignment } from '@/server/services/admin/people';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: AssignmentSetBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return setAssignment(ctx, {
    userId: String(params.userId),
    workspaceId: body.targetWorkspaceId,
    capabilities: body.capabilities,
    maxDiscountBps: body.maxDiscountBps,
    active: body.active,
    reason: body.reason,
  });
});
