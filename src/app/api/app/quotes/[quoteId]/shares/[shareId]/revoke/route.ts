/**
 * POST /api/app/quotes/[quoteId]/shares/[shareId]/revoke (T15, C3): revokes one share link; the
 * public page then answers 404. Revoking an already revoked link changes nothing.
 */
import { revokeQuoteShare, serializeShare } from '@/server/services/quotes/share';
import { withRoute } from '../../../../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], capability: 'dispatch.send' }, async ({ ctx, params }) => {
  const { share, changed } = await revokeQuoteShare(ctx, String(params.quoteId), String(params.shareId));
  return { share: serializeShare(share, ctx.clock.now()), changed };
});
