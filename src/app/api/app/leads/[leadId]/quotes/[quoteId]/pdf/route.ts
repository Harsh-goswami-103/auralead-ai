/**
 * GET /api/app/leads/[leadId]/quotes/[quoteId]/pdf?workspaceSlug=&version= (T17): the console's
 * "Download PDF". Serves the worker-rendered artifact of the current version (or `version`), or
 * 503 + Retry-After and enqueues the render when it does not exist yet (C1). Needs `leads.read`.
 * A quote of another lead or workspace is 404.
 */
import { LeadQuotePdfQuery } from '@/lib/schemas/lead-console';
import { getLeadQuotePdf } from '@/server/services/leads/console';
import { withRoute } from '../../../../../../_lib/with-route';
import { pdfResponse } from '../../../../../../quote-share/_lib/public';
import { consoleContext } from '../../../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime, params }) => {
  const search = new URL(req.url).searchParams;
  const query = LeadQuotePdfQuery.parse({ workspaceSlug: search.get('workspaceSlug') ?? undefined, version: search.get('version') ?? undefined });
  const target = await consoleContext({ ctx, session, runtime }, query.workspaceSlug);
  const result = await getLeadQuotePdf(target, runtime.prisma, {
    leadId: String(params.leadId),
    quoteId: String(params.quoteId),
    versionNo: query.version,
    storageDir: runtime.config.paths.storageDir,
  });
  return pdfResponse(result);
});
