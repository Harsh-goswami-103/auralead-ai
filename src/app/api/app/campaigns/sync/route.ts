/**
 * POST /api/app/campaigns/sync (T35; P6): syncs the workspace's Meta campaigns and their last-7-days
 * metrics. DEMO: the demo adapter's simulated campaigns (labelled Simulated, zero outbound). LIVE:
 * the Marketing API through a CONNECTED or DEGRADED integration with an ad account (422 otherwise),
 * at most once a minute (429). Roles USER and EMPLOYEE, `integrations.manage` in the
 * `workspaceSlug` workspace; CSRF.
 */
import { CampaignSyncBody } from '@/lib/schemas/meta';
import { syncCampaignMetrics } from '@/server/services/campaigns/metrics';
import { liveAdapterDepsFrom } from '@/server/services/integrations/live-adapters';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: CampaignSyncBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return syncCampaignMetrics(target, liveAdapterDepsFrom(runtime.config));
});
