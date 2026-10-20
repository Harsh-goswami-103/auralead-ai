/**
 * POST /api/admin/people/[userId]/reset-link { reason } (T29, ADR-67): a single-use password reset
 * link valid for one hour, for an active person of this mode. A newer link ends earlier unused
 * ones. The link is in this response only (the database keeps the token's hash); redeeming it
 * revokes every session of the person and signs nobody in. Super admin only, fresh sign-in within
 * 15 minutes, 10 links per hour per administrator, audited without the token.
 */
import { ReasonBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { issueResetLink } from '@/server/services/admin/people';
import { withRoute } from '../../../../_lib/with-route';
import { oneTimeLink, RESET_RATE } from '../../_lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: ReasonBody, rateLimit: [RESET_RATE] }, async ({ ctx, session, body, params, runtime }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  const issued = await issueResetLink(ctx, { userId: String(params.userId), reason: body.reason });
  return { link: oneTimeLink(runtime.config.appOrigin, 'reset', issued.token), expiresAt: issued.expiresAt, email: issued.email };
});
