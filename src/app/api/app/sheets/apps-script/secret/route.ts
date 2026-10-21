/**
 * POST /api/app/sheets/apps-script/secret (T34, ADR-105): issues the Apps Script signing secret and
 * a new key id, or rotates them (typed ROTATE when one exists). The secret is encrypted with the
 * key ring and returned in this answer only; nothing can read it back. LIVE only. `sheets.manage`;
 * CSRF; the credential rate limit (10 per hour per person and workspace).
 */
import { AppsScriptSecretBody } from '@/lib/schemas/sheets';
import { issueAppsScriptSecret } from '@/server/services/sheets/secret';
import { withRoute } from '../../../../_lib/with-route';
import { secretRateRule, sheetsContext } from '../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: AppsScriptSecretBody, rateLimit: [secretRateRule] }, async ({ ctx, session, runtime, body }) => {
  const target = await sheetsContext({ ctx, session, runtime }, body.workspaceSlug);
  const issued = await issueAppsScriptSecret(target, body.confirm ? { confirm: body.confirm } : {}, { keyRing: runtime.config.secrets.credentials });
  return { keyId: issued.keyId, secret: issued.secret, rotated: issued.rotated, issuedAt: issued.issuedAt.toISOString() };
});
