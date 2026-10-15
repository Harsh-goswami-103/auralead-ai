/**
 * POST /api/app/quotes/[quoteId]/shares (T15, C2, P16): creates a share link for the current
 * version of an APPROVED, SENT or VIEWED quote. The token is in this response only (the database
 * keeps its sha256); the link expires at the quote's validUntil or sooner (`expiresInDays`).
 * Creating a link does not mark the quote as sent.
 */
import { QuoteShareCreateBody } from '@/lib/schemas/quotes';
import { createQuoteShare, quoteShareUrl, serializeShare } from '@/server/services/quotes/share';
import { withRoute } from '../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: QuoteShareCreateBody, capability: 'dispatch.send' }, async ({ ctx, body, params, runtime }) => {
  const { share, token } = await createQuoteShare(ctx, String(params.quoteId), body);
  return { share: serializeShare(share, ctx.clock.now()), url: quoteShareUrl(runtime.config.appOrigin, token) };
});
