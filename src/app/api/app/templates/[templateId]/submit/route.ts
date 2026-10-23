/**
 * POST /api/app/templates/[templateId]/submit (ADR-123, slice F4): "Submit for approval". The
 * draft must pass the submission rules (examples for every variable, the UTILITY trigger, a
 * document for a document header). DEMO: the simulated WhatsApp Manager accepts it as PENDING and
 * reviews it 30 s later, labelled Simulated. LIVE: SUBMITTING and one `wa.templateSubmit` job; a
 * WhatsApp integration that is not verified with a WABA ID is 422 and nothing changes. At most 20
 * submissions an hour per workspace (`templateSubmit`). Roles USER and EMPLOYEE,
 * `templates.manage` (in the service); CSRF.
 */
import { RateLimitedError } from '@/lib/errors';
import { TemplateActionBody } from '@/lib/schemas/templates';
import { submitTemplate } from '@/server/services/integrations/template-authoring';
import { withRoute } from '../../../../_lib/with-route';
import { studioContext, studioDeps, templateIdParam } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateActionBody }, async ({ ctx, session, runtime, body, params }) => {
  const templateId = templateIdParam(params.templateId);
  const target = await studioContext({ ctx, session, runtime }, body.workspaceSlug);
  const decision = runtime.limiters.templateSubmit.take(`workspace:${target.workspaceId}`);
  if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds });
  return submitTemplate(target, templateId, studioDeps(runtime));
});
