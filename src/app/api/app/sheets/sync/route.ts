/**
 * POST /api/app/sheets/sync (T34, ADR-104): "Sync now". Queues one `sheets.sync` run (a second press
 * while one is open answers that run). The worker reads the rows after the last sync cursor and
 * ingests them; a header that drifted from the mapping blocks the run with the column diff. LIVE
 * only. `sheets.manage`.
 */
import { SheetsSyncBody } from '@/lib/schemas/sheets';
import { requestSheetsSync } from '@/server/services/sheets/sync';
import { withRoute } from '../../../_lib/with-route';
import { sheetsContext } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: SheetsSyncBody }, async ({ ctx, session, runtime, body }) => {
  const target = await sheetsContext({ ctx, session, runtime }, body.workspaceSlug);
  return requestSheetsSync(target);
});
