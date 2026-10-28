/**
 * POST /api/app/leads/[leadId]/draft (T17, C13): "Generate draft" (`local: false`) and "Generate
 * with local template" (`local: true`) for a lead of the selected workspace. Enqueues one
 * `ai.draft` job (the worker writes the AiDraft) and answers with its id. Needs `drafts.generate`;
 * limited to 30 requests a minute per workspace (plan §9 aiDraft).
 */
import { RateLimitedError } from '@/lib/errors';
import { requireCapability } from '@/server/auth/guards';
import { LeadDraftBody } from '@/lib/schemas/lead-console';
import { requestLeadDraft } from '@/server/services/ai/drafts';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadDraftBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  // Authorised before the shared budget is touched: a person who may not generate cannot spend it.
  requireCapability(target, 'drafts.generate');
  const decision = runtime.limiters.aiDraft.take(`workspace:${target.workspaceId}`);
  if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds });
  return requestLeadDraft(target, { leadId: String(params.leadId), local: body.local });
});
