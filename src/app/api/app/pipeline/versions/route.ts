/**
 * POST /api/app/pipeline/versions (T28): save the edited pipeline as version N+1 through T23's
 * `savePipelineConfig` (validator, CAS on `expectedVersion`, the new version active, audited
 * `pipeline.config.activate`). Leads already in flight keep the version they were pinned to (O5).
 * 422 PIPELINE_INVALID carries the issues in `details`; 409 PIPELINE_VERSION_CONFLICT when someone
 * saved first. Roles USER and EMPLOYEE, `pipeline.manage` in the `workspaceSlug` workspace.
 */
import { PipelineSaveBody } from '@/lib/schemas/pipeline';
import { savePipelineConfig } from '@/server/services/pipeline/config';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: PipelineSaveBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return savePipelineConfig(target, { graph: body.graph, approvalMode: body.approvalMode, expectedVersion: body.expectedVersion });
});
