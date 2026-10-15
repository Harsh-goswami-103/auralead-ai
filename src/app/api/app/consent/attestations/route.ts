/**
 * POST /api/app/consent/attestations (T18, M2 / ADR-14, user decision D4): an employee attests a
 * B2B basis for emailing a business (actor, time, note). 403 `ATTESTATION_DISABLED` while the
 * workspace setting is off (the default; the control is hidden then). The attestation allows
 * manual single email sends only and never clears a suppression. Roles USER and EMPLOYEE,
 * capability `leads.write` in the selected workspace.
 */
import { B2bAttestationBody } from '@/lib/schemas/consent';
import { attestB2bEmail } from '@/server/services/messaging/consent';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';
import { suppressionDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: B2bAttestationBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return attestB2bEmail(target, body, suppressionDeps(runtime));
});
