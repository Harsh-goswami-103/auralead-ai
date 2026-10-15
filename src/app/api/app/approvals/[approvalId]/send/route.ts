/**
 * POST /api/app/approvals/[approvalId]/send (T22, AT12): approve and send. A quote version needs the
 * version on screen and a channel (WhatsApp also an approved template); a message draft is approved
 * as it stands. One transaction (T19), idempotent per version and channel: double clicks and retries
 * answer 200 with the same ids. 409 APPROVAL_CHANGED for a stale item. Roles USER and EMPLOYEE,
 * `approvals.decide` + `dispatch.send` in the `workspaceSlug` workspace.
 */
import { ApprovalSendBody } from '@/lib/schemas/approvals';
import { sendFromQueue } from '@/server/services/approvals/queue';
import { withRoute } from '../../../../_lib/with-route';
import { approvalContext, approvalDeps } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ApprovalSendBody }, async ({ ctx, session, runtime, body, params }) => {
  const { workspaceSlug, ...input } = body;
  const target = await approvalContext({ ctx, session, runtime }, workspaceSlug);
  return sendFromQueue(target, String(params.approvalId), input, approvalDeps(runtime.config));
});
