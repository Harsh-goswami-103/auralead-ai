/**
 * POST /api/app/quotes/[quoteId]/cancel (T15): cancels a DRAFT, APPROVED, SENT or VIEWED quote,
 * revoking its share links, invalidating approvals and cancelling queued sends in one transaction.
 * `expectedVersion` guards against cancelling a version the caller has not seen.
 */
import { QuoteDecisionBody } from '@/lib/schemas/quotes';
import { cancelQuote, serializeQuote } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: QuoteDecisionBody, capability: 'quotes.edit' }, async ({ ctx, body, params }) => {
  const result = await cancelQuote(ctx, String(params.quoteId), body);
  return { quote: serializeQuote(result.quote, ctx.clock.now()), released: result.released };
});
