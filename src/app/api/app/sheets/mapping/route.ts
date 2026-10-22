/**
 * POST /api/app/sheets/mapping (T34; P1): confirms a column mapping as the new active version after
 * re-reading the Sheet's header (409 HEADER_CHANGED when it differs from the one the form used, 409
 * MAPPING_VERSION_CONFLICT when someone confirmed another meanwhile, 422 MAPPING_INVALID with the
 * problems). LIVE only. `sheets.manage`.
 */
import { SheetsMappingBody } from '@/lib/schemas/sheets';
import { confirmSheetMapping } from '@/server/services/sheets/mapping';
import { withRoute } from '../../../_lib/with-route';
import { sheetsContext, sheetsDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: SheetsMappingBody }, async ({ ctx, session, runtime, body }) => {
  const target = await sheetsContext({ ctx, session, runtime }, body.workspaceSlug);
  return confirmSheetMapping(target, { expectedVersion: body.expectedVersion, headerFingerprint: body.headerFingerprint, mapping: body.mapping }, sheetsDeps(runtime));
});
