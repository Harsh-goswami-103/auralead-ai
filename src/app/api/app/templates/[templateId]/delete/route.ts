/**
 * POST /api/app/templates/[templateId]/delete (ADR-123, slice F4): deletes a template draft, or
 * an authored template Meta rejected (LIVE deletes it at Meta first, by name; DEMO only here,
 * labelled simulated). Anything else is 409 TEMPLATE_NOT_DELETABLE. Roles USER and EMPLOYEE,
 * `templates.manage` (in the service); CSRF.
 */
import { TemplateActionBody } from '@/lib/schemas/templates';
import { deleteTemplate } from '@/server/services/integrations/template-authoring';
import { withRoute } from '../../../../_lib/with-route';
import { studioContext, studioDeps, templateIdParam } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateActionBody }, async ({ ctx, session, runtime, body, params }) => {
  const templateId = templateIdParam(params.templateId);
  const target = await studioContext({ ctx, session, runtime }, body.workspaceSlug);
  return deleteTemplate(target, templateId, studioDeps(runtime));
});
