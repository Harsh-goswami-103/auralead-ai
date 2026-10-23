/**
 * POST /api/app/settings/auto-send (ADR-121): the workspace's "Automatic sending" switch, the
 * existing audited `WorkspaceSettings.autoSendEnabled` opt-in. It gates AI replies in Auto
 * conversations and automated pipeline sends alike, which is how the UI labels it. Needs
 * `automation.manage` in the target workspace (checked by `setWorkspaceAutoSend`): the session's for
 * USER, the one named by `workspaceSlug` for EMPLOYEE (consoleContext; 404 outside the caller's
 * access, 403 without the capability). Body `{ enabled, workspaceSlug? }`; answers
 * `{ enabled, changed }` (a repeat is a no-op and is not audited again).
 */
import { AutoSendBody } from '@/lib/schemas/inbox';
import { setWorkspaceAutoSend } from '@/server/services/messaging/conversations';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: AutoSendBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return setWorkspaceAutoSend(target, { enabled: body.enabled });
});
