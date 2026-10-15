/**
 * GET /quote/[token] (T16, C2, C3, C4, ADR-09, ADR-57): the public quote page.
 *
 * This is a route handler, not a page.tsx: the share states need real status codes (live 200;
 * invalid, revoked or cancelled 404 with one identical body; expired or superseded 410 naming the
 * sender; 429 over the public quote limit), and App Router pages can only answer 200/401/403/404.
 * The HTML is the static render of `PublicQuotePage` (QuoteDocument for the quote itself).
 *
 * Every response carries Referrer-Policy no-referrer, Cache-Control private no-store,
 * X-Robots-Tag noindex and a hash-based CSP (no inline anything else, frame-ancestors none).
 * No cookie is read. A live page appends one FETCH view event and never changes the quote.
 */
import { createElement } from 'react';
import { PublicQuotePage, viewCsp, type PublicQuoteView } from '@/components/quote/PublicQuotePage';
import { renderStaticDocument } from '@/components/quote/static-markup';
import { CORRELATION_HEADER, resolveCorrelationId } from '@/lib/correlation';
import { NotFoundError } from '@/lib/errors';
import { getRuntime, requestClock, type Runtime } from '@/server/boot';
import { normalizeServerError } from '@/server/auth/http-errors';
import { clientIp } from '@/server/security/rate-limit';
import { readPublicQuote, ShareGoneError } from '@/server/services/quotes/public-share';
import { publicDeps, publicQuoteKey, viewerOf } from '../../../api/quote-share/_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Segment = { params: Promise<Record<string, string | string[] | undefined>> };

function htmlResponse(view: PublicQuoteView, status: number, correlationId: string, retryAfter?: number): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': viewCsp(view),
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    [CORRELATION_HEADER]: correlationId,
  });
  if (retryAfter !== undefined) headers.set('retry-after', String(retryAfter));
  return new Response(renderStaticDocument(createElement(PublicQuotePage, { view })), { status, headers });
}

export async function GET(req: Request, segment: Segment): Promise<Response> {
  const correlationId = resolveCorrelationId(req.headers.get(CORRELATION_HEADER));
  let rt: Runtime | null = null;
  try {
    rt = getRuntime();
    const clock = await requestClock(rt);
    const ip = clientIp(req.headers, null, rt.config.trustedProxyHops);
    const decision = rt.limiters.publicQuote.take(publicQuoteKey(ip));
    if (!decision.allowed) return htmlResponse({ kind: 'error', status: 429 }, 429, correlationId, decision.retryAfterSeconds);

    const params = await segment.params;
    const token = typeof params.token === 'string' ? params.token : '';
    const data = await readPublicQuote(publicDeps(rt, clock, correlationId), token, viewerOf(rt, req, ip));
    return htmlResponse({ kind: 'quote', model: data.model, token, state: data.status, accept: data.accept, acceptance: data.acceptance }, 200, correlationId);
  } catch (thrown) {
    const error = normalizeServerError(thrown);
    if (error instanceof ShareGoneError) return htmlResponse({ kind: 'gone', reason: error.reason, senderName: error.senderName }, 410, correlationId);
    if (error instanceof NotFoundError) return htmlResponse({ kind: 'not-found' }, 404, correlationId);
    if (rt) rt.logger.error({ err: thrown, correlationId }, 'public quote page failed');
    else console.error('public quote page failed before boot', { correlationId, name: (thrown as Error)?.name });
    return htmlResponse({ kind: 'error', status: 500 }, 500, correlationId);
  }
}
