/**
 * GET /api/app/leads/sample-workbook (ADR-120, slice F2): the "Download sample workbook" file of
 * the import page. One sheet whose first row is the header (one column per importable field, named
 * so the suggestions map each one), then five clearly fictitious businesses ("Example" names,
 * +91 90000 0000x numbers, example.com addresses). No workspace data: any signed-in panel person.
 * Served as an attachment with nosniff.
 */
import { LEAD_IMPORT_XLSX_CONTENT_TYPE } from '@/lib/schemas/lead-import';
import { buildLeadImportSampleWorkbook } from '@/server/services/leads/import';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async () => {
  const bytes = buildLeadImportSampleWorkbook();
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': LEAD_IMPORT_XLSX_CONTENT_TYPE,
      'content-length': String(bytes.length),
      'content-disposition': 'attachment; filename="auralead-lead-import-sample.xlsx"',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex',
    },
  });
});
