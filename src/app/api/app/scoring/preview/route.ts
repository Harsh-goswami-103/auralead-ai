/**
 * POST /api/app/scoring/preview (T26, P9): score the 20 newest leads of the workspace with a
 * proposed scoring configuration, next to their stored scores. Writes nothing. A configuration
 * that fails the shared Zod schema answers 400 SCORING_CONFIG_INVALID with its issues. Operator
 * panel route (EMPLOYEE, workspace by `workspaceSlug`); needs `scoring.manage`. The workspace
 * owner reads the configuration but does not edit it (P9), so a USER session gets 404 here.
 */
import { ScoringPreviewBody } from '@/lib/schemas/leads';
import { previewScoringConfig } from '@/server/services/scoring/manage';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['EMPLOYEE'], body: ScoringPreviewBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return { preview: await previewScoringConfig(target, { config: body.config }) };
});
