/**
 * POST /api/app/quotes/[quoteId]/revise (T15): any edit creates version N+1 and moves the quote to
 * DRAFT (from DRAFT, APPROVED, SENT, VIEWED or EXPIRED). `expectedVersion` is the version the editor
 * saw (409 when stale); the same transaction invalidates approvals, cancels queued sends and
 * supersedes share links. `repriceToActive` prices against the current price list instead of the
 * revised version's.
 */
import { parsePaise } from '@/lib/money';
import { QuoteReviseBody } from '@/lib/schemas/quotes';
import { reviseQuote, serializeQuote, serializeVersion } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: QuoteReviseBody, capability: 'quotes.edit' }, async ({ ctx, body, params }) => {
  const { discount, ...rest } = body;
  const result = await reviseQuote(ctx, String(params.quoteId), { ...rest, discount: { kind: discount.kind, value: parsePaise(discount.value) } });
  return { quote: serializeQuote(result.quote, ctx.clock.now()), version: serializeVersion(result.version), invalidated: result.invalidated };
});
