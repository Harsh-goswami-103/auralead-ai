/**
 * /api/app/leads/exports (T26, ADR-70): the Leads "Export CSV" action.
 * - POST `{ requestKey, filters?, workspaceSlug? }` stores the export with the list filters and
 *   enqueues the `leads.export` job (audited; a repeated request key returns the same export).
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
  return requestLeadExport(target, { requestKey: body.requestKey, filters: body.filters });
});

export const GET = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'] }, async ({ req, ctx, session, runtime }) => {
  const target = await consoleContext({ ctx, session, runtime }, workspaceQuery(req).workspaceSlug);
  return { exports: await listLeadExports(target) };
});
