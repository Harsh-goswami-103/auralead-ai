/**
 * GET /api/app/leads/exports/[exportId]/download?workspaceSlug= (T26, ADR-70): the CSV file of a
 * READY export, for the person who requested it only (anyone else: 404). 409 while it is being
 * prepared, 410 once it expired (24 h after it was written). Every download is audited. Served as
 * an attachment with nosniff and no caching. Needs `leads.export`.
 */
import { getLeadExportDownload } from '@/server/services/leads/export';
import { withRoute } from '../../../../../_lib/with-route';
import { consoleContext } from '../../../_lib/console-context';
import { workspaceQuery } from '../../../_lib/workspace-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  const file = await getLeadExportDownload(target, String(params.exportId), { storageDir: runtime.config.paths.storageDir });
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-length': String(file.bytes.length),
      'content-disposition': `attachment; filename="${file.fileName}"`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  });
});
