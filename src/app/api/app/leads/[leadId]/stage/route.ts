/**
 * POST /api/app/leads/[leadId]/stage (T26, R4): move a lead to another sales stage from the Leads
 * table, the Kanban board ("Move to stage" menu, drag, keyboard) or the detail sheet. Body
 * `{ toStage, expectedStageVersion, reason?, workspaceSlug? }`; a stale version answers 409
 * STAGE_VERSION_CONFLICT, LOST without a reason 422. Needs `leads.write`. Roles USER (the
 * session's workspace) and EMPLOYEE (the workspace named by `workspaceSlug`, as the lead console).
 */
import { LeadStageBody } from '@/lib/schemas/leads';
import { moveLeadStage } from '@/server/services/leads/stage';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadStageBody }, async ({ ctx, session, runtime, body, params }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return moveLeadStage(target, { leadId: String(params.leadId), ...input });
});
