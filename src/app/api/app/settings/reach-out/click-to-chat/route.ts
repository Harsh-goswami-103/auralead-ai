/**
 * POST /api/app/settings/reach-out/click-to-chat (ADR-125, lead-gen F5): builds the click-to-chat
 * link `https://wa.me/<display number>?text=<prefill>` for the workspace's WhatsApp number. A
 * prefill that folds to a START or STOP keyword is refused (422 PREFILL_IS_KEYWORD); without a
 * WhatsApp display number it is 422 CLICK_TO_CHAT_NOT_CONFIGURED. Nothing is stored or sent. Body
 * `{ prefill, workspaceSlug? }`. Roles USER and EMPLOYEE, `leads.read` in the selected workspace.
 */
import { ClickToChatBody } from '@/lib/schemas/reach-out';
import { buildClickToChat } from '@/server/services/leads/reach-out';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ClickToChatBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return buildClickToChat(target, { prefill: body.prefill });
});
