/**
 * GET /api/app/quotes/[quoteId] (T15): one quote with its versions (persisted snapshots), approval
 * rows, share links (never tokens), the audit timeline and what the caller may do. A quote of
 * another workspace is 404.
 */
import { getQuoteDetail, serializeDetail } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER'] }, async ({ ctx, params }) =>
  serializeDetail(await getQuoteDetail(ctx, String(params.quoteId)), ctx.clock.now()),
);
