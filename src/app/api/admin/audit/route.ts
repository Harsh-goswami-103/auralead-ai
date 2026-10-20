/**
 * GET /api/admin/audit?actor&action&targetType&targetId&workspace&result&from&to&correlationId&before
 * (T29, R33): one page of the platform audit history, newest first, filtered and keyset-paginated.
 * Summaries and reasons are redacted (never PII or secrets); there is no export beyond this page.
 * Super admin only. Unknown parameters are 400; a browser-supplied `workspaceId` is 404 (A6).
 */
import { AuditSearchQuery } from '@/lib/schemas/admin-people';
import { searchAudit } from '@/server/services/admin/audit-search';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['SUPER_ADMIN'] }, async ({ req, ctx }) => {
  const params: Record<string, string> = {};
  for (const [key, value] of new URL(req.url).searchParams) if (value.trim() !== '') params[key] = value;
  return searchAudit(ctx, AuditSearchQuery.parse(params));
});
