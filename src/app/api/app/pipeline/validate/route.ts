/**
 * POST /api/app/pipeline/validate (T28): the editor's dry run. Runs T23's PipelineConfigVersion
 * validator with the workspace's auto-send setting and answers `{ ok, issues }` (each issue may name
 * the offending node or edge); nothing is written. Roles USER and EMPLOYEE, `pipeline.manage` in
 * the `workspaceSlug` workspace.
 */
import { PipelineDraftBody } from '@/lib/schemas/pipeline';
import { validatePipelineDraft } from '@/server/services/pipeline/editor';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: PipelineDraftBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return validatePipelineDraft(target, { graph: body.graph, approvalMode: body.approvalMode });
});
