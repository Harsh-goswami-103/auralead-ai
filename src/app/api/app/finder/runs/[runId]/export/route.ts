/**
 * GET /api/app/finder/runs/[runId]/export?workspaceSlug= (ADR-118 (c), slice F1): "Download Excel"
 * of a run, built on request by `writeXlsx` and served as an attachment with nosniff and no caching.
 * Only the person who started the run can download it (anyone else: 404). LIVE files hold the
 * place ID, a Maps link built from it, keyword, location, imported / lead ID / stage and
 * website-sourced emails only; DEMO files hold the full simulated columns. Every download is
 * audited. Needs `leads.export`.
 */
import { buildFinderExport, FINDER_XLSX_CONTENT_TYPE } from '@/server/services/lead-finder/export';
import { withRoute } from '../../../../../_lib/with-route';
import { consoleContext } from '../../../../leads/_lib/console-context';
import { workspaceQuery } from '../../../../leads/_lib/workspace-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  const file = await buildFinderExport(target, String(params.runId));
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'content-type': FINDER_XLSX_CONTENT_TYPE,
      'content-length': String(file.bytes.length),
      'content-disposition': `attachment; filename="${file.fileName}"`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
});
