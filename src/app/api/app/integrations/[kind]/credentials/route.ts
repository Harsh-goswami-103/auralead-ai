/**
 * POST /api/app/integrations/[kind]/credentials (T32; plan §9 Credentials, ADR-25): set or replace
 * (rotate by re-entering) an integration's credentials and non-secret configuration. Values are
 * encrypted with the key ring (AAD `workspaceId|integrationId|field`); the answer is masked (saved,
 * last four, time) and never repeats a value. LIVE leaves the integration CONFIGURED_UNVERIFIED
 * until Test connection verifies it; DEMO accepts `demo_` placeholders only and stays Simulated.
 * There is no GET: credentials are never read back over HTTP (masked reads are rendered by the
 * setup page). Roles USER and EMPLOYEE, `integrations.manage` in the `workspaceSlug` workspace;
 * CSRF; rate limit `inviteReset` (10 per hour) per person and workspace.
 */
import { IntegrationCredentialsBody } from '@/lib/schemas/integrations';
import { saveIntegrationCredentials } from '@/server/services/integrations/credentials';
import { withRoute } from '../../../../_lib/with-route';
import { credentialRateRule, integrationContext, kindParam } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: IntegrationCredentialsBody, rateLimit: [credentialRateRule] },
  async ({ ctx, session, runtime, body, params }) => {
    const kind = kindParam(params.kind);
    const target = await integrationContext({ ctx, session, runtime }, body.workspaceSlug);
    return saveIntegrationCredentials(
      target,
      { kind, ...(body.config ? { config: body.config } : {}), ...(body.credentials ? { credentials: body.credentials } : {}) },
      { keyRing: runtime.config.secrets.credentials },
    );
  },
);
