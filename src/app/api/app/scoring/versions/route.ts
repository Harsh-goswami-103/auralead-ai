/**
 * POST /api/app/scoring/versions (T26, P9, R14): activate a scoring configuration as version N+1.
 * Body `{ config, expectedActiveVersion, workspaceSlug? }`: a version other than the active one
 * answers 409 SCORING_VERSION_CONFLICT, an invalid configuration 400 SCORING_CONFIG_INVALID. In
 * one transaction the new version becomes the only active one, the `lead.rescore` job is enqueued
 * and the activation is audited. Operator panel route (EMPLOYEE); needs `scoring.manage`.
 */
import { ScoringActivateBody } from '@/lib/schemas/leads';
import { activateScoringConfig } from '@/server/services/scoring/manage';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['EMPLOYEE'], body: ScoringActivateBody }, async ({ ctx, session, runtime, body }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  return { activated: await activateScoringConfig(target, { config: body.config, expectedActiveVersion: body.expectedActiveVersion }) };
});
