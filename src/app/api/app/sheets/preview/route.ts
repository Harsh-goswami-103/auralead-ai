/**
 * POST /api/app/sheets/preview (T34): a dry run of the rows the next sync would read, with the
 * active mapping or the one being edited: what would be created, merged, reviewed, skipped or
 * rejected, and whether consent would be recorded. Writes nothing. LIVE only. `sheets.manage`.
 */
import { SheetsPreviewBody } from '@/lib/schemas/sheets';
import { previewSheetRows } from '@/server/services/sheets/preview';
import { withRoute } from '../../../_lib/with-route';
import { sheetsContext, sheetsDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: SheetsPreviewBody }, async ({ ctx, session, runtime, body }) => {
  const target = await sheetsContext({ ctx, session, runtime }, body.workspaceSlug);
  return previewSheetRows(target, body.mapping ? { mapping: body.mapping } : {}, sheetsDeps(runtime));
});
