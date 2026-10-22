/**
 * POST /api/app/conversations/[conversationId]/mode (T22 wraps T21, 06-design F7; ADR-121): AI mode
 * Off, Draft for approval or Auto, in both panels. Needs `leads.write` in the target workspace (the
 * session's for USER, `workspaceSlug` for EMPLOYEE); Auto also needs `automation.manage` and
 * workspace automatic sending on (422 AUTO_SEND_OFF). Audited; 409 MODE_VERSION_CONFLICT on a stale
 * `expectedModeVersion`; an operator gets 409 HANDED_OVER for a handed-over lead.
 */
import { ConversationAiModeBody } from '@/lib/schemas/inbox';
import { setConversationAiMode } from '@/server/services/messaging/conversations';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ConversationAiModeBody }, async ({ ctx, session, runtime, body, params }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return setConversationAiMode(target, { conversationId: String(params.conversationId), ...input });
});
