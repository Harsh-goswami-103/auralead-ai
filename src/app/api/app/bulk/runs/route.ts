/**
 * /api/app/bulk/runs (T23, AT13, 06-design F19).
 * - POST confirms a bulk action: stores the run with its selection and pre-flight counts and
 *   enqueues the `bulk.run` job, which queues the eligible rows through the dispatch outbox and
 *   persists one result per row. Idempotent by `requestKey` (a double click returns the same run).
 *   Needs `approvals.decide` and `dispatch.send`.
 * - GET lists the workspace's recent runs (counts only). Needs `leads.read`.
 * Roles USER and EMPLOYEE; the workspace is chosen by `workspaceSlug` as the lead console routes.
 */
import { BulkRunBody } from '@/lib/schemas/bulk';
import { listBulkRuns, requestBulkRun } from '@/server/services/bulk/bulk';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';
import { bulkDeps, bulkQuery } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: BulkRunBody }, async ({ ctx, session, runtime, body }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return { run: await requestBulkRun(target, input, bulkDeps(runtime)) };
});

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime }) => {
  const target = await consoleContext({ ctx, session, runtime }, bulkQuery(req).workspaceSlug);
  return { runs: await listBulkRuns(target) };
});
