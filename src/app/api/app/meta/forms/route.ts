/**
 * POST /api/app/meta/forms (T35; P1): creates or replaces one Instant Form's mapping (question key
 * per lead field, and the consent question with its truthy answers, channel, purpose and notice).
 * Roles USER and EMPLOYEE, `integrations.manage` in the `workspaceSlug` workspace; CSRF.
 */
import { MetaFormMappingBody } from '@/lib/schemas/meta';
import { saveMetaFormMapping } from '@/server/services/campaigns/forms';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: MetaFormMappingBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return saveMetaFormMapping(target, { formId: body.formId, fields: body.fields, consent: body.consent });
});
