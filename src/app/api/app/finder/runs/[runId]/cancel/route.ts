/**
 * POST /api/app/finder/runs/[runId]/cancel `{ workspaceSlug? }` (ADR-118, slice F1): stops a queued
 * or running search; places already found stay. Answers `{ run, cancelled }` (false for a run that
 * had already finished). Needs `finder.run`; a run outside the workspace is 404.
 */
import { WorkspaceSlugBody } from '@/server/services/lead-finder/schemas';
import { cancelFinderRun } from '@/server/services/lead-finder/runs';
import { withRoute } from '../../../../../_lib/with-route';
import { consoleContext } from '../../../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: WorkspaceSlugBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return cancelFinderRun(target, String(params.runId));
});
