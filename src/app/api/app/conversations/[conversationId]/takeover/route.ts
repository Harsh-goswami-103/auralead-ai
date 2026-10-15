/**
 * POST /api/app/conversations/[conversationId]/takeover (T22 wraps T21): a person takes the thread;
 * automated replies stop at dispatch until "Resume AI". `expectedModeVersion` (optional) is the
 * version on screen (409 MODE_VERSION_CONFLICT when stale). USER panel, `leads.write`.
 */
import { ConversationModeVersionBody } from '@/lib/schemas/inbox';
import { takeOverConversation } from '@/server/services/messaging/conversations';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ConversationModeVersionBody, capability: 'leads.write' }, async ({ ctx, body, params }) => {
  return takeOverConversation(ctx, { conversationId: String(params.conversationId), ...body });
});
