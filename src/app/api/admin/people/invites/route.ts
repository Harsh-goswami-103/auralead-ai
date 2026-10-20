/**
 * POST /api/admin/people/invites { email, globalRole, targetWorkspaceId?, membershipRole?, reason }
 * (T29, R33): a single-use invite for a client user into a workspace (OWNER or MEMBER), an
 * employee or an administrator. The link is in this response only (the database keeps the token's
 * hash); the administrator sends it themselves. An address that already has an account is 409
 * EMAIL_IN_USE. Super admin only, fresh sign-in within 15 minutes, 10 invites per hour per
 * administrator.
 */
import { InviteCreateBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { createAccessInvite } from '@/server/services/admin/people';
import { withRoute } from '../../../_lib/with-route';
import { INVITE_RATE, oneTimeLink } from '../_lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: InviteCreateBody, rateLimit: [INVITE_RATE] }, async ({ ctx, session, body, runtime }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  const issued = await createAccessInvite(ctx, {
    email: body.email,
    globalRole: body.globalRole,
    workspaceId: body.targetWorkspaceId ?? null,
    membershipRole: body.membershipRole ?? null,
    reason: body.reason,
  });
  return { invite: issued.invite, link: oneTimeLink(runtime.config.appOrigin, 'invite', issued.token), supersededInvites: issued.supersededInvites };
});
