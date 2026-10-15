/**
 * POST /api/app/approvals/[approvalId]/reject (T22): close a pending item with a reason (audited
 * `approval.reject`); a message draft becomes NOT_SENT. 409 APPROVAL_CHANGED when already decided.
 * Roles USER and EMPLOYEE, `approvals.decide` in the `workspaceSlug` workspace.
 */
import { ApprovalRejectBody } from '@/lib/schemas/approvals';
import { rejectApproval } from '@/server/services/approvals/queue';
import { withRoute } from '../../../../_lib/with-route';
import { approvalContext } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ApprovalRejectBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await approvalContext({ ctx, session, runtime }, body.workspaceSlug);
  return rejectApproval(target, { approvalId: String(params.approvalId), reason: body.reason });
});
