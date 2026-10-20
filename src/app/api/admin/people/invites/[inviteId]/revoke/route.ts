/**
 * POST /api/admin/people/invites/[inviteId]/revoke { reason } (T29): ends a pending invite (its
 * link then answers like any unknown link). An invite already redeemed, expired or revoked is 404.
 * Audited. Super admin only, fresh sign-in within 15 minutes.
 */
import { ReasonBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { revokeInvite } from '@/server/services/admin/people';
import { withRoute } from '../../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: ReasonBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return revokeInvite(ctx, { inviteId: String(params.inviteId), reason: body.reason });
});
