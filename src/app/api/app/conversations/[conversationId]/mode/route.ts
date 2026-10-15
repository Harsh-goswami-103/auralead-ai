/**
 * POST /api/app/conversations/[conversationId]/mode (T22 wraps T21, 06-design F7): AI mode Off,
 * Draft for approval or Auto. Auto needs `automation.manage` and workspace auto-send on (422
 * AUTO_SEND_OFF). Audited; 409 MODE_VERSION_CONFLICT on a stale `expectedModeVersion`.
 */
import { ConversationAiModeBody } from '@/lib/schemas/inbox';
import { setConversationAiMode } from '@/server/services/messaging/conversations';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ConversationAiModeBody, capability: 'leads.write' }, async ({ ctx, body, params }) => {
  return setConversationAiMode(ctx, { conversationId: String(params.conversationId), ...body });
});
