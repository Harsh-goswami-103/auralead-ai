/**
 * POST /api/app/templates (ADR-123, slice F4): saves a new template draft in the template studio
 * (category chosen first, language, name, header, body with `{{n}}` variables and their sources
 * and examples, footer, buttons). Answers the stored template and the rule warnings; a rule error
 * is 422 TEMPLATE_INVALID, a taken name 409. DEMO creates the simulated WhatsApp integration when
 * absent; LIVE needs a stored one (422 otherwise). No provider is contacted. Roles USER and
 * EMPLOYEE, `templates.manage` in the `workspaceSlug` workspace (checked in the service); CSRF.
 */
import { draftOf, TemplateDraftBody } from '@/lib/schemas/templates';
import { createTemplateDraft } from '@/server/services/integrations/template-authoring';
import { withRoute } from '../../_lib/with-route';
import { studioContext } from './_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateDraftBody }, async ({ ctx, session, runtime, body }) => {
  const target = await studioContext({ ctx, session, runtime }, body.workspaceSlug);
  return createTemplateDraft(target, { draft: draftOf(body), copyGeneratorLabel: body.copyGeneratorLabel });
});
