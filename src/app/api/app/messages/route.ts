/**
 * POST /api/app/messages (T22; ADR-121): the inbox composer's Send, in both panels. The sender
 * approves the message (`approvals.decide` + `dispatch.send`, checked by the service for the target
 * workspace); the shared eligibility check runs for a single manual send and a refusal is 422
 * `SEND_REFUSED` with the reasons and the next action (template or review), nothing queued. A
 * template's values are resolved for the lead (422 `TEMPLATE_VARIABLES_MISSING` names a missing
 * one). Otherwise it is queued through the outbox (MANUAL_SINGLE) with its payload-hash approval,
 * idempotent per `requestKey`. USER: the session's workspace; EMPLOYEE: the workspace named by
 * `workspaceSlug` (consoleContext), 409 HANDED_OVER once the lead is the client's. Another
 * workspace's conversation is 404.
 */
import { ComposerSendBody } from '@/lib/schemas/inbox';
import { inboxDepsFromConfig, sendComposerMessage } from '@/server/services/messaging/inbox';
import { withRoute } from '../../_lib/with-route';
import { consoleContext } from '../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ComposerSendBody }, async ({ ctx, session, body, runtime }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return sendComposerMessage(target, input, inboxDepsFromConfig(runtime.config));
});
