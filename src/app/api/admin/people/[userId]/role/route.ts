/**
 * POST /api/admin/people/[userId]/role { globalRole, reason } (T29, R33): changes a person's global
 * role, revoking every session of theirs in the same transaction (plan §9). Refused (422) for
 * yourself, for the last active administrator, while the person still holds workspace access,
 * and for a DEMO role-switcher persona; a demo user in LIVE is 404. Super admin only, fresh
 * sign-in within 15 minutes, audited.
 */
import { RoleChangeBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { changeUserRole } from '@/server/services/admin/people';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: RoleChangeBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return changeUserRole(ctx, { userId: String(params.userId), globalRole: body.globalRole, reason: body.reason });
});
