/**
 * POST /api/app/extension/tokens (T36; plan §9 Extension): issues an ingestion token
 * `alx_<keyId>_<secret>` for the Maps extension bridge. The answer carries the token once (it is
 * never stored: only the prefix and the secret's sha256 are) and `Cache-Control: no-store`. Scope
 * `ingest:gmaps`, one workspace, at most 10 active tokens. Roles USER and EMPLOYEE,
 * `extension.manage` in the `workspaceSlug` workspace; CSRF; rate limit `inviteReset`.
 */
import { ExtensionTokenCreateBody } from '@/lib/schemas/webhooks';
import { createExtensionToken } from '@/server/services/extension/tokens';
import { withRoute } from '../../../_lib/with-route';
import { extensionContext, extensionTokenRateRule } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ExtensionTokenCreateBody, rateLimit: [extensionTokenRateRule] },
  async ({ ctx, session, runtime, body }) => {
    const target = await extensionContext({ ctx, session, runtime }, body.workspaceSlug);
    return createExtensionToken(target, { name: body.name, allowedExtensionId: body.allowedExtensionId ?? null, expiresInDays: body.expiresInDays ?? null });
  },
);
