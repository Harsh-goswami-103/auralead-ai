/**
 * POST /api/quote-share/[token]/view (T16, C4): the public page's view beacon, sent after the page
 * has been visible for 2 s. Appends a BEACON view event; on a SENT quote from a browser-class user
 * agent it moves the quote to VIEWED ("Opened (may be automated)"); on an APPROVED quote it records
 * the hint "Mark as sent?". No cookies: Origin must be APP_ORIGIN. 404 / 410 as the page (C3).
 */
import { recordQuoteBeacon } from '@/server/services/quotes/public-share';
import { withRoute } from '../../../_lib/with-route';
import { PUBLIC_QUOTE_RATE, publicDeps, viewerOf } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'none', rateLimit: PUBLIC_QUOTE_RATE, maxBodyBytes: 1024 }, async ({ req, ctx, params, runtime, ip, correlationId }) =>
  recordQuoteBeacon(publicDeps(runtime, ctx.clock, correlationId), String(params.token ?? ''), viewerOf(runtime, req, ip)),
);
