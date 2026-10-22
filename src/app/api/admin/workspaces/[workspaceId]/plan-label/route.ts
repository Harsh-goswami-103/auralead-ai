/**
 * POST /api/admin/workspaces/[workspaceId]/plan-label { planLabel, reason } (T29, R46): the
 * workspace's plan label (a label, no billing). Audited with the old and new label; the same label
 * is a no-op. Super admin only, fresh sign-in within 15 minutes.
 */
import { PlanLabelBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { setWorkspacePlanLabel } from '@/server/services/admin/workspaces';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: PlanLabelBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return setWorkspacePlanLabel(ctx, { workspaceId: String(params.workspaceId), planLabel: body.planLabel, reason: body.reason });
});
