/**
 * POST /api/app/conversations/[conversationId]/takeover (T22 wraps T21; ADR-121): a person takes the
 * thread; automated replies stop at dispatch until "Resume AI". `expectedModeVersion` (optional) is
 * the version on screen (409 MODE_VERSION_CONFLICT when stale). Both panels: `leads.write` in the
 * session's workspace (USER) or the one named by `workspaceSlug` (EMPLOYEE); an operator gets 409
 * HANDED_OVER for a handed-over lead.
 */
import { ConversationModeVersionBody } from '@/lib/schemas/inbox';
import { takeOverConversation } from '@/server/services/messaging/conversations';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ConversationModeVersionBody }, async ({ ctx, session, runtime, body, params }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return takeOverConversation(target, { conversationId: String(params.conversationId), ...input });
});
