/**
 * POST /api/app/leads/[leadId]/confirm-contact `{ workspaceSlug? }` (ADR-118 (d), slice F1): the
 * operator's "Confirm details": the business confirmed its contact details, so the Places-sourced
 * fields of this lead are kept past their 30-day expiry (`contactConfirmedVia OPERATOR`). Idempotent;
 * audited `lead.contact_confirm`. Needs `leads.write`; a lead outside the workspace is 404.
 */
import { WorkspaceSlugBody } from '@/server/services/lead-finder/schemas';
import { confirmLeadContact } from '@/server/services/lead-finder/places-expire';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: WorkspaceSlugBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return confirmLeadContact(target, String(params.leadId));
});
