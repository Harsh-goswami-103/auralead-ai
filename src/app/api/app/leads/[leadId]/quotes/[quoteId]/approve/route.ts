/**
 * POST /api/app/leads/[leadId]/quotes/[quoteId]/approve (T17): approves the current version of a
 * quote of this lead (the T15 CAS on `expectedVersion`, 409 when stale) and writes the APPROVED
 * Approval row. Needs `approvals.decide`. A quote of another lead is 404; a version that needs a
 * pricing review or is past its validity is 422.
 */
import { LeadQuoteApproveBody } from '@/lib/schemas/lead-console';
import { approveLeadQuote } from '@/server/services/leads/console';
import { serializeQuote } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../../../_lib/with-route';
import { consoleContext } from '../../../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadQuoteApproveBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  const result = await approveLeadQuote(target, { leadId: String(params.leadId), quoteId: String(params.quoteId), expectedVersion: body.expectedVersion });
  return { quote: serializeQuote(result.quote, target.clock.now()), approvalId: result.approvalId };
});
