/**
 * POST /api/app/finder/runs/[runId]/import `{ workspaceSlug?, requestKey, resultIds[] }` (ADR-118,
 * slice F1): "Import as leads" for up to 200 selected results of the run, through `ingestBatch`
 * (source GOOGLE_PLACES) in chunks; answers the per-result outcome and counts. Needs `leads.write`;
 * a result that is not in this run is 404. Imported Places leads carry no WhatsApp consent.
 */
import { ImportFinderResultsBody } from '@/server/services/lead-finder/schemas';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { withRoute } from '../../../../../_lib/with-route';
import { consoleContext } from '../../../../leads/_lib/console-context';
import { finderIngestDeps } from '../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ImportFinderResultsBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return importFinderResults(target, { runId: String(params.runId), resultIds: body.resultIds, requestKey: body.requestKey }, finderIngestDeps(runtime));
});
