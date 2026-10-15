/**
 * POST /api/app/bulk/preflight (T23, AT13): the bulk confirm dialog's pre-flight. Classifies every
 * selected lead as eligible, skipped (reason codes from the shared dispatch eligibility function,
 * sendIntent BULK) or failed, so eligible + skipped + failed == selected. Writes nothing. Roles USER
 * and EMPLOYEE, capability `dispatch.send` in the workspace chosen by `workspaceSlug` (as the lead
 * console routes); a lead outside it is 404.
 */
import { BulkPreflightBody } from '@/lib/schemas/bulk';
import { previewBulkAction } from '@/server/services/bulk/bulk';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';
import { bulkDeps } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: BulkPreflightBody }, async ({ ctx, session, runtime, body }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return previewBulkAction(target, input, bulkDeps(runtime));
});
