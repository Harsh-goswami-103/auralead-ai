/**
 * POST /api/app/settings/reach-out (ADR-125, lead-gen F5): the workspace's WhatsApp opt-in notice
 * (prefilled when someone records an opt-in; it must name the business, else 422
 * NOTICE_MISSING_BUSINESS_NAME) and its privacy contact. Body `{ whatsappOptInNotice, privacyContact,
 * workspaceSlug? }`; empty clears a value. Needs `automation.manage` (an OWNER holds it), checked in
 * the service on the selected workspace. Roles USER (the session's workspace) and EMPLOYEE (by
 * slug). Audited `workspace.reach_out` with the changed field names.
 */
import { ReachOutSettingsBody } from '@/lib/schemas/reach-out';
import { updateReachOutSettings } from '@/server/services/leads/reach-out';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ReachOutSettingsBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return updateReachOutSettings(target, { whatsappOptInNotice: body.whatsappOptInNotice, privacyContact: body.privacyContact });
});
