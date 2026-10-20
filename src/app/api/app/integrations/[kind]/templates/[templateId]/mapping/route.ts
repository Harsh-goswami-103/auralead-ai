/**
 * POST /api/app/integrations/[kind]/templates/[templateId]/mapping (T32, P12): maps a synced
 * WhatsApp template to a send intent, says what each positional variable holds, and maps its
 * quick-reply buttons to QUOTE, CALL or STOP (their payload ids are set per send). Only `whatsapp`
 * has templates (any other kind is 404); a template of another workspace is 404. No provider is
 * contacted, in DEMO or LIVE. Roles USER and EMPLOYEE, `integrations.manage`; CSRF.
 */
import { NotFoundError } from '@/lib/errors';
import { TemplateMappingBody } from '@/lib/schemas/integrations';
import { saveTemplateMapping } from '@/server/services/integrations/template-sync';
import { withRoute } from '../../../../../../_lib/with-route';
import { integrationContext, kindParam } from '../../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateMappingBody }, async ({ ctx, session, runtime, body, params }) => {
  if (kindParam(params.kind) !== 'WHATSAPP_CLOUD') throw new NotFoundError({ message: 'only WhatsApp has message templates' });
  const templateId = typeof params.templateId === 'string' ? params.templateId : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(templateId)) throw new NotFoundError();
  const target = await integrationContext({ ctx, session, runtime }, body.workspaceSlug);
  return saveTemplateMapping(target, { templateId, intent: body.intent, variables: body.variables, buttons: body.buttons });
});
