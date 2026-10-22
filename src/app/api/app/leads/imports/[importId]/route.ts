/**
 * GET /api/app/leads/imports/[importId]?workspaceSlug= (ADR-120, slice F2): one of the caller's
 * own imports with its status, counts and row notes (row number, code, field; never a value), plus
 * the preview (header, first 20 rows, suggested mapping) while it is an unexpired PREVIEW. The
 * import page polls it while the import runs. Anyone else's import is 404. Needs `leads.import`.
 */
import { getLeadImportView } from '@/server/services/leads/import';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../_lib/console-context';
import { workspaceQuery } from '../../_lib/workspace-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  return getLeadImportView(target, String(params.importId), { storageDir: runtime.config.paths.storageDir });
});
