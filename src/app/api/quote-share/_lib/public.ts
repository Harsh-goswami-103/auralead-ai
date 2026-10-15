/**
 * Shared bits of the public quote routes (T16): the public dependencies built from the runtime, the
 * rate-limit key (one bucket per client IP across the page, beacon, accept and PDF, plan §9:
 * 30/min/IP), the hashed client IP stored on view events and acceptances, and a PDF response.
 */
import type { Clock } from '@/lib/clock';
import type { Runtime } from '@/server/boot';
import { hashClientIp } from '@/server/auth/session';
import type { RateRule } from '@/app/api/_lib/with-route';
import type { PdfResult } from '@/server/pdf/serve';
import type { PublicDeps } from '@/server/services/quotes/public-share';

export const publicQuoteKey = (ip: string) => `quote:${ip}`;

export const PUBLIC_QUOTE_RATE: RateRule[] = [{ policy: 'publicQuote', key: ({ ip }) => publicQuoteKey(ip) }];

export function publicDeps(runtime: Runtime, clock: Clock, correlationId: string): PublicDeps {
  const key = runtime.config.secrets.shareNonceKey;
  if (!key) throw new Error('SHARE_NONCE_KEY is not configured');
  return { db: runtime.prisma, clock, mode: runtime.config.mode, correlationId, shareNonceKey: key };
}

export function viewerOf(runtime: Runtime, req: Request, ip: string): { userAgent: string | null; ipHash: string } {
  return { userAgent: req.headers.get('user-agent'), ipHash: hashClientIp(runtime.config.secrets.sessionSecret ?? '', ip) };
}

/** The stored PDF, or 503 + Retry-After while the render job runs. */
export function pdfResponse(result: PdfResult): Response {
  if (!result.ready) {
    return new Response(JSON.stringify({ code: 'PDF_RENDERING', message: 'The PDF is being prepared. Try again in a few seconds.' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(result.retryAfterSeconds) },
    });
  }
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(result.bytes.length),
      'content-disposition': `attachment; filename="${result.fileName}"`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
}
