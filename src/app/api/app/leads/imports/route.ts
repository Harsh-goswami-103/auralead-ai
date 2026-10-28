/**
 * /api/app/leads/imports (ADR-120, slice F2): lead import from Excel or CSV.
 * - POST `{ workspaceSlug?, requestKey, fileName, contentType, dataBase64 }` uploads a .xlsx or
 *   .csv file (at most 5 MB; the JSON body is capped near 7 MB, 413 above it) and answers with a
 *   PREVIEW import: the header, the first 20 rows and a suggested column mapping. A file the
 *   spreadsheet reader refuses is 422 with its code (NOT_A_WORKBOOK, TOO_LARGE, TOO_MANY_ROWS,
 *   MALFORMED_CSV, EMPTY_FILE), as are unsupported types and more than 2,000 rows. A repeated
 *   request key returns the same import. Rate limited (`leadImport`).
 * - GET `?workspaceSlug=` lists the caller's own recent imports.
 * Both need `leads.import` (checked in the service). Roles USER (the session's workspace) and
 * EMPLOYEE (by slug).
 */
import { LEAD_IMPORT_MAX_BODY_BYTES, LeadImportUploadBody } from '@/lib/schemas/lead-import';
import { listLeadImports, uploadLeadImport } from '@/server/services/leads/import';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../_lib/console-context';
import { workspaceQuery } from '../_lib/workspace-query';
import { leadImportRateRule } from './_lib/rate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadImportUploadBody, maxBodyBytes: LEAD_IMPORT_MAX_BODY_BYTES, rateLimit: [leadImportRateRule] },
  async ({ ctx, session, runtime, body }) => {
    const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
    return uploadLeadImport(target, body, { storageDir: runtime.config.paths.storageDir });
  },
);

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  return { imports: await listLeadImports(target) };
});
