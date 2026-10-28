/**
 * /api/app/finder/runs (ADR-118, slice F1): the Lead Finder's searches.
 * - POST `{ workspaceSlug?, requestKey, keywords[], locations[], maxPerQuery, extractEmails,
 *   emailBlacklist[] }` starts a run (needs `finder.run`, checked in the service on the console
 *   target; at most 10 keywords x 10 locations; idempotent per request key; `finderRun` limit per
 *   workspace; LIVE needs the workspace's Google Places key) and answers `{ run, created }`.
 * - GET `?workspaceSlug=` lists the workspace's recent runs with their progress (`leads.read`).
 * Roles USER (the session's workspace) and EMPLOYEE (by slug).
 */
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { listFinderRuns, startFinderRun } from '@/server/services/lead-finder/runs';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';
import { workspaceQuery } from '../../leads/_lib/workspace-query';
import { finderRateLimit, placesDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: StartFinderRunBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return startFinderRun(target, body, { ...placesDeps(runtime), rateLimit: finderRateLimit(runtime, target) });
});

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  return { runs: await listFinderRuns(target) };
});
