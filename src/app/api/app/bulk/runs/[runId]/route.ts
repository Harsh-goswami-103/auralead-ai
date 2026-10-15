/**
 * GET /api/app/bulk/runs/[runId]?workspaceSlug= (T23, AT13): one bulk run with every persisted row
 * result, for the `BulkResultSummary` drawer (the same result after a reload). Roles USER and
 * EMPLOYEE, capability `leads.read`; a run of another workspace is 404.
 */
import { getBulkRun } from '@/server/services/bulk/bulk';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../../leads/_lib/console-context';
import { bulkQuery } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, bulkQuery(req).workspaceSlug);
  return { run: await getBulkRun(target, String(params.runId)) };
});
