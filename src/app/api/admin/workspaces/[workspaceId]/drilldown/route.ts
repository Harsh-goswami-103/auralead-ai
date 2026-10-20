/**
 * POST /api/admin/workspaces/[workspaceId]/drilldown { reason } (T29, R33): the audited, read-only
 * view of one workspace. `adminContext` commits the `admin.elevate` AuditEvent (reason,
 * crossWorkspace) before any tenant row is read; the answer is aggregates and configuration only.
 * A POST rather than a page GET, so opening it is CSRF-checked and a link alone can never trigger
 * it. Super admin only, fresh sign-in within 15 minutes.
 */
import { DrilldownBody } from '@/lib/schemas/admin-people';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { openWorkspaceDrilldown } from '@/server/services/admin/workspaces';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: DrilldownBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return openWorkspaceDrilldown(ctx, { workspaceId: String(params.workspaceId), reason: body.reason });
});
