/**
 * POST /api/app/integrations/[kind]/templates/sync (T28, ADR-17): sync the WhatsApp templates from
 * WhatsApp Manager. Only `whatsapp` has templates (any other kind is 404). DEMO plays the provider
 * and adds the demo templates that are absent (approved and rejected), labelled simulated; LIVE
 * needs a connected integration and the live sync T32 registers. Roles USER and EMPLOYEE,
 * `integrations.manage` in the `workspaceSlug` workspace.
 */
import { NotFoundError } from '@/lib/errors';
import { TemplateSyncBody } from '@/lib/schemas/integrations';
import { LIVE_TEMPLATE_SYNC } from '@/server/services/integrations/live-adapters';
import { syncWhatsAppTemplates } from '@/server/services/integrations/templates';
import { withRoute } from '../../../../../_lib/with-route';
import { integrationContext, kindParam } from '../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateSyncBody }, async ({ ctx, session, runtime, body, params }) => {
  if (kindParam(params.kind) !== 'WHATSAPP_CLOUD') throw new NotFoundError({ message: 'only WhatsApp has message templates' });
  const target = await integrationContext({ ctx, session, runtime }, body.workspaceSlug);
  return syncWhatsAppTemplates(target, { liveSync: LIVE_TEMPLATE_SYNC });
});
