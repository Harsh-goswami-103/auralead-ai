/**
 * POST /api/app/consent/grants (T18): records an opt-in a person holds evidence for (purpose,
 * evidence source, evidence time, note). The OPT_IN clears an active suppression only when its
 * evidence time is strictly newer than the latest Stop (O2, E3); the answer says what happened.
 * Roles USER and EMPLOYEE, capability `leads.write` in the selected workspace (`workspaceSlug`, as
 * the lead console routes resolve it). A lead outside it is 404.
 */
import { ManualConsentBody } from '@/lib/schemas/consent';
import { grantManualConsent } from '@/server/services/messaging/consent';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';
import { suppressionDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ManualConsentBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  const result = await grantManualConsent(target, body, suppressionDeps(runtime));
  return { consentId: result.consentId, reoptIn: result.reoptIn };
});
