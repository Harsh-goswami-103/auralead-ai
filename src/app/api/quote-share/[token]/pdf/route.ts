/**
 * GET /api/quote-share/[token]/pdf (T16, C1): the stored PDF of the version a live share link points
 * at, or 503 + Retry-After while the render job (enqueued here if missing) runs. 404 / 410 exactly
 * as the public page (C3). Never renders at request time.
 */
import { getSharedQuotePdf } from '@/server/pdf/serve';
import { withRoute } from '../../../_lib/with-route';
import { pdfResponse, PUBLIC_QUOTE_RATE, publicDeps } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'none', rateLimit: PUBLIC_QUOTE_RATE }, async ({ ctx, params, runtime, correlationId }) =>
  pdfResponse(await getSharedQuotePdf(publicDeps(runtime, ctx.clock, correlationId), String(params.token ?? ''), runtime.config.paths.storageDir)),
);
