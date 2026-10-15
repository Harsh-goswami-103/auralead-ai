/**
 * POST /api/admin/jobs/[jobId]/retry { reason } (T24, R33): the safe retry of a DEAD job (plan
 * §6.2). A job without provider side effects is requeued; a dispatch job gets attempt N+1 on a
 * new job (full preflight) only when its last attempt definitely did not send. An unresolved
 * AMBIGUOUS attempt answers 409 AMBIGUOUS_UNRESOLVED. Super admin, fresh authentication, audited.
 */
import { JobRetryBody } from '@/lib/schemas/admin';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { retryJob } from '@/server/services/jobs-admin/inspector';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: JobRetryBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return retryJob(ctx, { jobId: String(params.jobId), reason: body.reason });
});
