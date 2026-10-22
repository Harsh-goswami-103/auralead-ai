/**
 * POST /api/app/templates/[templateId] (ADR-123, slice F4): saves changes to a template draft.
 * Only a DRAFT written in the studio can change (409 TEMPLATE_NOT_EDITABLE otherwise); the rules
 * and answers are those of creating a draft. A template of another workspace is 404. No provider
 * is contacted. Roles USER and EMPLOYEE, `templates.manage` (in the service); CSRF.
 */
import { draftOf, TemplateDraftBody } from '@/lib/schemas/templates';
import { updateTemplateDraft } from '@/server/services/integrations/template-authoring';
import { withRoute } from '../../../_lib/with-route';
import { studioContext, templateIdParam } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateDraftBody }, async ({ ctx, session, runtime, body, params }) => {
  const templateId = templateIdParam(params.templateId);
  const target = await studioContext({ ctx, session, runtime }, body.workspaceSlug);
  return updateTemplateDraft(target, templateId, { draft: draftOf(body), copyGeneratorLabel: body.copyGeneratorLabel });
});
