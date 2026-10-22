/**
 * /api/app/leads/exports (T26, ADR-70): the Leads export action.
 * - POST `{ requestKey, filters?, format?, workspaceSlug? }` stores the export with the list filters
 *   and its format (`csv` by default or `xlsx`, ADR-120) and enqueues the `leads.export` job (audited; a repeated request key returns the same export, and
 *   so do the same filters as one of the caller's exports still preparing or ready). A workspace
 *   holds at most 3 active exports: past that, 409 `EXPORT_LIMIT_REACHED` (ADR-73).
 * - GET `?workspaceSlug=` lists the caller's own recent exports with their status and expiry.
 * Both need `leads.export`. Roles USER (the session's workspace) and EMPLOYEE (by slug).
 */
import { LeadExportBody } from '@/lib/schemas/leads';
import { listLeadExports, requestLeadExport } from '@/server/services/leads/export';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../_lib/console-context';
import { workspaceQuery } from '../_lib/workspace-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadExportBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return requestLeadExport(target, { requestKey: body.requestKey, filters: body.filters, format: body.format });
});

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  return { exports: await listLeadExports(target) };
});
