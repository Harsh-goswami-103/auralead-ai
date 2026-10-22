/**
 * Next 16 proxy (plan §3, ADR-69). It only sets the request id and the document security headers
 * (nonce CSP, HSTS behind HTTPS). It never authorizes, rate-limits or reads the DB: every page and
 * route checks the session itself (critic 12.3). API routes answer JSON and the public quote page
 * sets its own hash-based CSP, so neither is matched.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { CORRELATION_HEADER, resolveCorrelationId } from '@/lib/correlation';
import { buildDocumentHeaders, newNonce } from '@/lib/security-headers';

export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
  const headers = buildDocumentHeaders({ appOrigin: getConfig().appOrigin, nonce, dev: process.env.NODE_ENV === 'development' });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(CORRELATION_HEADER, correlationId);
  // Next reads the nonce from the request's CSP while it renders.
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']!);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|quote/|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
