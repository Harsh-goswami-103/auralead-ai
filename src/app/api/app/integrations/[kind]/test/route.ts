/**
 * POST /api/app/integrations/[kind]/test (T28): "Test connection". DEMO answers "Simulated, no
 * provider contacted" and never changes the status; LIVE runs the tester registered in
 * `services/integrations/live-adapters.ts` (T32: WhatsApp, Anthropic, OpenAI; T33-T36 add theirs),
 * answers "Verification required" for a kind without one, and 422 INTEGRATION_NOT_CONFIGURED when
 * nothing is configured. Never a simulated success in LIVE. Roles USER and EMPLOYEE, `integrations.manage` in the `workspaceSlug` workspace.
 */
import { IntegrationTestBody } from '@/lib/schemas/integrations';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapterDepsFrom, liveAdapters } from '@/server/services/integrations/live-adapters';
import { withRoute } from '../../../../_lib/with-route';
import { integrationContext, kindParam } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: IntegrationTestBody }, async ({ ctx, session, runtime, body, params }) => {
  const kind = kindParam(params.kind);
  const target = await integrationContext({ ctx, session, runtime }, body.workspaceSlug);
  return testIntegrationConnection(target, { kind }, { testers: liveAdapters(liveAdapterDepsFrom(runtime.config)).testers });
});
