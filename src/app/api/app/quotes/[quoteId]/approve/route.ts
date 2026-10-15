/**
 * POST /api/app/quotes/[quoteId]/approve (T15): approves the current version (CAS on
 * `status = DRAFT AND currentVersionNo = expectedVersion`, 409 when stale), writing the APPROVED
 * Approval row. Needs `approvals.decide`; refused (422) while the version needs a pricing review or
 * is past its validity.
 */
import { QuoteDecisionBody } from '@/lib/schemas/quotes';
import { approveQuote, serializeQuote } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: QuoteDecisionBody, capability: 'approvals.decide' }, async ({ ctx, body, params }) => {
  const result = await approveQuote(ctx, String(params.quoteId), body);
  return { quote: serializeQuote(result.quote, ctx.clock.now()), approvalId: result.approvalId };
});
