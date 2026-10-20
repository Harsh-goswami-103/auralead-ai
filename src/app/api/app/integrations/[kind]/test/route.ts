/**
 * POST /api/app/integrations/[kind]/test (T28): "Test connection". DEMO answers "Simulated, no
 * provider contacted" and never changes the status; LIVE runs the tester T32-T36 register in
 * `services/integrations/live-adapters.ts`, answers "Verification required" while none is
 * registered, and 422 INTEGRATION_NOT_CONFIGURED when nothing is configured. Never a simulated
 * success in LIVE. Roles USER and EMPLOYEE, `integrations.manage` in the `workspaceSlug` workspace.
 */
import { IntegrationTestBody } from '@/lib/schemas/integrations';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { LIVE_CONNECTION_TESTERS } from '@/server/services/integrations/live-adapters';
import { withRoute } from '../../../../_lib/with-route';
import { integrationContext, kindParam } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: IntegrationTestBody }, async ({ ctx, session, runtime, body, params }) => {
  const kind = kindParam(params.kind);
  const target = await integrationContext({ ctx, session, runtime }, body.workspaceSlug);
  return testIntegrationConnection(target, { kind }, { testers: LIVE_CONNECTION_TESTERS });
});
