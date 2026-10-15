/**
 * POST /api/admin/jobs/[jobId]/cancel { reason } (T24, R33): cancel a QUEUED job (a dispatch job's
 * queued attempt with it) or request the cancel of a RUNNING one. Super admin only, fresh
 * authentication within 15 minutes, audited crossWorkspace with the reason.
 */
import { JobCancelBody } from '@/lib/schemas/admin';
import { requireFreshAuthentication } from '@/server/services/admin/fresh-auth';
import { cancelJob } from '@/server/services/jobs-admin/inspector';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'], body: JobCancelBody }, async ({ ctx, session, body, params }) => {
  requireFreshAuthentication(session!.session, ctx.clock.now());
  return cancelJob(ctx, { jobId: String(params.jobId), reason: body.reason });
});
