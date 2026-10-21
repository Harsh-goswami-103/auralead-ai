/**
 * POST /api/app/sheets/header (T34): reads row 1 of the workspace's Sheet through the service
 * account for the mapping form: the column names, duplicates, whether the Apps Script's event id
 * column exists, the header fingerprint, and the column diff against the active mapping (drift).
 * LIVE only (DEMO: 422 SHEETS_LIVE_ONLY, nothing contacted). Roles USER and EMPLOYEE, `sheets.manage`.
 */
import { SheetsHeaderBody } from '@/lib/schemas/sheets';
import { readMappingHeader } from '@/server/services/sheets/mapping';
import { withRoute } from '../../../_lib/with-route';
import { sheetsContext, sheetsDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: SheetsHeaderBody }, async ({ ctx, session, runtime, body }) => {
  const target = await sheetsContext({ ctx, session, runtime }, body.workspaceSlug);
  return readMappingHeader(target, sheetsDeps(runtime));
});
