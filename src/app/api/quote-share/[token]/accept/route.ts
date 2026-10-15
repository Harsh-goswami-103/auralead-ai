/**
 * POST /api/quote-share/[token]/accept (T16, C5): public acceptance. No cookies; the request must
 * come from APP_ORIGIN and carry the token, the page's form nonce and the expected version id.
 * Idempotent per version: a repeat returns the same receipt. 403 for a missing or wrong nonce or
 * Origin, 404 / 410 as the page, 409 for a version that is not current or a quote not yet sent.
 */
import { z } from 'zod';
import { acceptSharedQuote } from '@/server/services/quotes/accept';
import { withRoute } from '../../../_lib/with-route';
import { PUBLIC_QUOTE_RATE, publicDeps, viewerOf } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AcceptBody = z.object({
  token: z.string().max(128),
  formNonce: z.string().max(128).optional().default(''),
  expectedVersionId: z.string().min(1).max(64),
  acceptorName: z.string().max(400),
});

export const POST = withRoute({ auth: 'none', body: AcceptBody, rateLimit: PUBLIC_QUOTE_RATE, maxBodyBytes: 4096 }, async ({ req, ctx, params, body, runtime, ip, correlationId }) => {
  const { receipt, created } = await acceptSharedQuote(publicDeps(runtime, ctx.clock, correlationId), String(params.token ?? ''), body, viewerOf(runtime, req, ip));
  return { receipt, created };
});
