/**
 * POST /api/admin/people/[userId]/status { status: ACTIVE | DISABLED, reason } (T29, R33): disables
 * or re-enables a person, revoking every session of theirs (a disabled person cannot sign in or
 * redeem a reset link). Refused (422) for yourself, for the last active administrator and for a
 * DEMO role-switcher persona; a demo user in LIVE is 404. Super admin only, fresh sign-in within
 * 15 minutes, audited.
 */
import { StatusChangeBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { changeUserStatus } from '@/server/services/admin/people';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: StatusChangeBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return changeUserStatus(ctx, { userId: String(params.userId), status: body.status, reason: body.reason });
});
