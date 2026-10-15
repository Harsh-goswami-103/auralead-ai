/**
 * GET /api/quotes/[id]/pdf (T16): authenticated download of a quote PDF for a signed-in member of
 * the quote's workspace (USER members, or an EMPLOYEE in their active assigned workspace with
 * `leads.read`). `?version=N` picks an earlier version; the default is the current one. Serves the
 * stored artifact, or 503 + Retry-After and enqueues the render when it is missing. Another
 * workspace's quote is 404.
 */
import { z } from 'zod';
import { getWorkspaceQuotePdf } from '@/server/pdf/serve';
import { withRoute } from '../../../_lib/with-route';
import { pdfResponse } from '../../../quote-share/_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VersionQuery = z.coerce.number().int().min(1).max(100_000).optional();

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], capability: 'leads.read' }, async ({ req, ctx, params, runtime }) => {
  const raw = new URL(req.url).searchParams.get('version');
  const versionNo = VersionQuery.parse(raw === null ? undefined : raw);
  return pdfResponse(await getWorkspaceQuotePdf(ctx, runtime.prisma, { quoteId: String(params.id ?? ''), versionNo, storageDir: runtime.config.paths.storageDir }));
});
