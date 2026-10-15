/**
 * POST /api/app/approvals/[approvalId]/approve (T22): approve the quote version on screen from the
 * queue. 409 APPROVAL_CHANGED ("This item changed since you opened it") when the item is no longer
 * open or its version is no longer current; 422 SEND_TO_APPROVE for a message draft (approved and
 * sent in one step). Roles USER and EMPLOYEE, `approvals.decide` in the `workspaceSlug` workspace.
 */
import { ApprovalApproveBody } from '@/lib/schemas/approvals';
import { approveFromQueue } from '@/server/services/approvals/queue';
import { withRoute } from '../../../../_lib/with-route';
import { approvalContext } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ApprovalApproveBody }, async ({ ctx, session, runtime, body, params }) => {
  const { workspaceSlug, ...input } = body;
  const target = await approvalContext({ ctx, session, runtime }, workspaceSlug);
  return approveFromQueue(target, String(params.approvalId), input);
});
