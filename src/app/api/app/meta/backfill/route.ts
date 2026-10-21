/**
 * POST /api/app/meta/backfill (T35; critic L-8 "Backfill from form since T"): queues one backfill
 * run of a mapped Instant Form's leads created after `since` (last 90 days). LIVE only (422 in
 * DEMO: no provider). The run's result (pages, leads, counts, error) shows on the Meta page.
 * Roles USER and EMPLOYEE, `integrations.manage` in the `workspaceSlug` workspace; CSRF.
 */
import { MetaBackfillBody } from '@/lib/schemas/meta';
import { requestMetaBackfill } from '@/server/services/campaigns/backfill';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: MetaBackfillBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return requestMetaBackfill(target, { formId: body.formId, since: body.since, requestKey: body.requestKey });
});
