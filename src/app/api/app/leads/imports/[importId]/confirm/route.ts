/**
 * POST /api/app/leads/imports/[importId]/confirm (ADR-120, slice F2): starts a previewed import.
 * Body `{ workspaceSlug?, mapping, dataSource?, consent? }`: the mapping needs a business-name
 * column and a phone or email column (422 otherwise); the import becomes QUEUED and the worker
 * ingests it 200 rows at a time. 409 when it was already started, 410 once its upload expired.
 * The consent column is honoured only under every ADR-120 rule (owner capability
 * `consent.import`, an own data source, a notice naming the business and WhatsApp, the
 * attestation verbatim, a consent-date column with no future dates). Needs `leads.import`; rate
 * limited (`leadImport`).
 */
import { LeadImportConfirmBody } from '@/lib/schemas/lead-import';
import { confirmLeadImport } from '@/server/services/leads/import';
import { withRoute } from '../../../../../_lib/with-route';
import { consoleContext } from '../../../_lib/console-context';
import { leadImportRateRule } from '../../_lib/rate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadImportConfirmBody, rateLimit: [leadImportRateRule] },
  async ({ ctx, session, runtime, body, params }) => {
    const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
    const { workspaceSlug: _slug, ...input } = body;
    return confirmLeadImport(target, String(params.importId), input, { storageDir: runtime.config.paths.storageDir });
  },
);
