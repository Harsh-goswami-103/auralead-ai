/**
 * GET /api/app/finder/runs/[runId]?workspaceSlug=&noWebsite=1&hasPhone=1&notImported=1&page=
 * (ADR-118, slice F1): one run with its progress and a page of 50 results, filtered on real columns
 * (no website listed, has a phone, not imported yet), with the per-filter counts and the LIVE
 * attributions to show. Places content past its 24-hour expiry is never returned. Needs
 * `leads.read`; a run outside the workspace is 404.
 */
import { getFinderRunView } from '@/server/services/lead-finder/runs';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../../leads/_lib/console-context';
import { finderResultsQuery } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime, params }) => {
  const query = finderResultsQuery(req);
  const target = await consoleContext({ ctx, session, runtime }, query.workspaceSlug);
  return getFinderRunView(target, String(params.runId), { noWebsite: query.noWebsite, hasPhone: query.hasPhone, notImported: query.notImported }, query.page);
});
