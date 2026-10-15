/**
 * POST /api/app/conversations/[conversationId]/resume (T22 wraps T21): "Resume AI". Replies queued
 * before keep their old mode version and stay blocked at dispatch. USER panel, `leads.write`;
 * 409 MODE_VERSION_CONFLICT on a stale `expectedModeVersion`.
 */
import { ConversationModeVersionBody } from '@/lib/schemas/inbox';
import { resumeConversationAi } from '@/server/services/messaging/conversations';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ConversationModeVersionBody, capability: 'leads.write' }, async ({ ctx, body, params }) => {
  return resumeConversationAi(ctx, { conversationId: String(params.conversationId), ...body });
});
