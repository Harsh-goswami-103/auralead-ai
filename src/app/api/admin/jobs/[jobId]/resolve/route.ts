/**
 * POST /api/admin/jobs/[jobId]/resolve { attemptId, resolution, requeue?, reason, confirmText? }
 * (T24, plan §4.4): an operator resolves an AMBIGUOUS ("Delivery unknown") attempt. DELIVERED
 * closes it as SENT; NOT_DELIVERED fails it and, with `requeue` and the confirm text RESEND,
 * queues attempt N+1 on a new job through the full preflight. Super admin, fresh authentication,
 * audited crossWorkspace with the typed reason.
 */
import { AttemptResolveBody } from '@/lib/schemas/admin';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { resolveAmbiguousAttempt } from '@/server/services/jobs-admin/inspector';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: AttemptResolveBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return resolveAmbiguousAttempt(ctx, { jobId: String(params.jobId), ...body });
});
