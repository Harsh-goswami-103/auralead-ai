/**
 * POST /api/app/quotes/[quoteId]/mark-sent (T22, P15): "Copy link" or "Mark as sent manually".
 * Moves the current version of an APPROVED quote to SENT with sentVia MANUAL_LINK (409 for any other
 * status or a stale `expectedVersion`; a repeat on a quote already SENT or VIEWED is a no-op).
 * USER panel, capability `dispatch.send`; another workspace's quote is 404.
 */
import { QuoteMarkSentBody } from '@/lib/schemas/approvals';
import { markQuoteSentManually } from '@/server/services/quotes/manual-send';
import { serializeQuote } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: QuoteMarkSentBody, capability: 'dispatch.send' }, async ({ ctx, body, params }) => {
  const result = await markQuoteSentManually(ctx, String(params.quoteId), body);
  return { quote: serializeQuote(result.quote, ctx.clock.now()), changed: result.changed };
});
