/**
 * POST /api/app/integrations/[kind]/credentials/revoke (T32): removes every saved credential of the
 * integration and sets it REVOKED (sends stop: eligibility needs CONNECTED). The typed confirmation
 * `REVOKE` is required. The provider is not contacted: the token must also be revoked in the
 * provider's console, which the setup page says. Roles USER and EMPLOYEE, `integrations.manage`;
 * CSRF; the credential rate limit.
 */
import { IntegrationRevokeBody } from '@/lib/schemas/integrations';
import { revokeIntegrationCredentials } from '@/server/services/integrations/credentials';
import { withRoute } from '../../../../../_lib/with-route';
import { credentialRateRule, integrationContext, kindParam } from '../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: IntegrationRevokeBody, rateLimit: [credentialRateRule] },
  async ({ ctx, session, runtime, body, params }) => {
    const kind = kindParam(params.kind);
    const target = await integrationContext({ ctx, session, runtime }, body.workspaceSlug);
    return revokeIntegrationCredentials(target, { kind });
  },
);
