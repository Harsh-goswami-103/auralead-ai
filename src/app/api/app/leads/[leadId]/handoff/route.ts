/**
 * POST /api/app/leads/[leadId]/handoff (ADR-124, lead-gen F5): "Hand over to client". Body
 * `{ expectedStageVersion, note?, requestKey, workspaceSlug? }`. In one transaction the lead moves to
 * Converted (unless it already is), its conversations get AI off and a human takeover, its pending
 * message drafts are withdrawn, its pipeline stops and the handoff is recorded with an AI summary
 * on the way (or NOT_CONFIGURED in LIVE without AI). A stale version is 409 STAGE_VERSION_CONFLICT,
 * a second handoff 409 ALREADY_HANDED_OVER (the same request key replayed returns the first
 * result). Needs `leads.handoff` (checked in the service on the selected workspace). Roles USER
 * (the session's workspace) and EMPLOYEE (the workspace named by `workspaceSlug`). Limited per
 * person (`handoff`).
 */
import { LeadHandoffBody } from '@/lib/schemas/handoff';
import { handOverLead } from '@/server/services/leads/handoff';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  {
    auth: 'session',
    roles: ['USER', 'EMPLOYEE'],
    body: LeadHandoffBody,
    rateLimit: [{ policy: 'handoff', key: ({ ctx }) => (ctx.actor ? `handoff:${ctx.actor.userId}` : null) }],
  },
  async ({ ctx, session, runtime, body, params }) => {
    const { workspaceSlug, ...input } = body;
    const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
    return handOverLead(target, { leadId: String(params.leadId), ...input }, { keyRing: runtime.config.secrets.credentials });
  },
);
