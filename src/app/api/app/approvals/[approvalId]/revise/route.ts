/**
 * POST /api/app/approvals/[approvalId]/revise (T22): edit the quote behind a queue item. A new
 * version is priced by the server; a discount above the editor's own cap is 403
 * DISCOUNT_OVER_ACTOR_CAP (audited DENIED), above the effective limit 422. 409 for a stale item or
 * version. Roles USER and EMPLOYEE, `quotes.edit` in the `workspaceSlug` workspace.
 */
import { ApprovalReviseBody } from '@/lib/schemas/approvals';
import { reviseFromQueue } from '@/server/services/approvals/queue';
import { serializeQuote, serializeVersion } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../_lib/with-route';
import { approvalContext } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ApprovalReviseBody }, async ({ ctx, session, runtime, body, params }) => {
  const { workspaceSlug, ...input } = body;
  const target = await approvalContext({ ctx, session, runtime }, workspaceSlug);
  const result = await reviseFromQueue(target, String(params.approvalId), input);
  return { quote: serializeQuote(result.quote, target.clock.now()), version: serializeVersion(result.version) };
});
