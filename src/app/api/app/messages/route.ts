/**
 * POST /api/app/messages (T22): the inbox composer's Send. The sender approves the message
 * (`approvals.decide` + `dispatch.send`); the shared eligibility check runs for a single manual send
 * and a refusal is 422 `SEND_REFUSED` with the reasons and the next action (template or review),
 * nothing queued. Otherwise it is queued through the outbox (MANUAL_SINGLE) with its payload-hash
 * approval, idempotent per `requestKey`. USER panel; another workspace's conversation is 404.
 */
import { ComposerSendBody } from '@/lib/schemas/inbox';
import { inboxDepsFromConfig, sendComposerMessage } from '@/server/services/messaging/inbox';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ComposerSendBody, capability: 'dispatch.send' }, async ({ ctx, body, runtime }) => {
  return sendComposerMessage(ctx, body, inboxDepsFromConfig(runtime.config));
});
