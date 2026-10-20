/**
 * POST /api/admin/people/[userId]/memberships { targetWorkspaceId, membershipRole: OWNER | MEMBER |
 * null, reason } (T29, R33): grants, changes or removes (null) a client user's workspace
 * membership, revoking every session of theirs. A workspace's last active owner is never removed
 * or demoted (422 LAST_OWNER); only client users are members (422 NOT_A_CLIENT_USER). Super admin
 * only, fresh sign-in within 15 minutes, audited on the workspace.
 */
import { MembershipSetBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { setMembership } from '@/server/services/admin/people';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: MembershipSetBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return setMembership(ctx, { userId: String(params.userId), workspaceId: body.targetWorkspaceId, membershipRole: body.membershipRole, reason: body.reason });
});
