/**
 * POST /api/app/finder/runs/[runId]/refresh `{ workspaceSlug?, resultIds[] }` (ADR-118 (a), slice
 * F1): "Refresh details" for up to 10 results whose 24-hour working copy expired: one Place Details
 * call each by place ID (LIVE, paid; DEMO rebuilds the simulated listing). Answers the counts.
 * Needs `finder.run`; LIVE needs the workspace's Google Places key; a result outside the run is 404.
 */
import { RefreshFinderResultsBody } from '@/server/services/lead-finder/schemas';
import { refreshFinderResults } from '@/server/services/lead-finder/refresh';
import { withRoute } from '../../../../../_lib/with-route';
import { consoleContext } from '../../../../leads/_lib/console-context';
import { placesDeps } from '../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: RefreshFinderResultsBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return refreshFinderResults(target, { runId: String(params.runId), resultIds: body.resultIds }, placesDeps(runtime));
});
