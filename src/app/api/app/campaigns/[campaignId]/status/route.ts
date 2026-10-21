/**
 * POST /api/app/campaigns/[campaignId]/status (T35; AT14, R44): pause or resume one Meta campaign,
 * confirmed by typing PAUSE or RESUME. DEMO: the simulated campaign changes status at once,
 * labelled Simulated, with zero outbound traffic. LIVE: 412 INTEGRATION_NOT_VERIFIED without a
 * verified integration (the adapter is never called); otherwise a CampaignAction is queued and the
 * worker calls the Marketing API (SENDING before the call, read-back after). Roles USER and
 * EMPLOYEE, `campaigns.control` in the `workspaceSlug` workspace; CSRF.
 */
import { CampaignStatusBody } from '@/lib/schemas/meta';
import { NotFoundError } from '@/lib/errors';
import { requestCampaignStatusChange } from '@/server/services/campaigns/controls';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: CampaignStatusBody }, async ({ ctx, session, runtime, body, params }) => {
  const campaignId = typeof params.campaignId === 'string' ? params.campaignId : null;
  if (!campaignId || campaignId.length > 64) throw new NotFoundError();
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return requestCampaignStatusChange(target, { campaignId, targetStatus: body.targetStatus, confirm: body.confirm, requestKey: body.requestKey });
});
