/**
 * POST /api/app/extension/tokens/[tokenId]/revoke (T36): revokes an ingestion token; the next
 * request with it is 401 `token_revoked`. The typed confirmation `REVOKE` is required; a repeat is
 * idempotent. Roles USER and EMPLOYEE, `extension.manage`; a token of another workspace is 404;
 * CSRF; rate limit `inviteReset`.
 */
import { ExtensionTokenRevokeBody } from '@/lib/schemas/webhooks';
import { revokeExtensionToken } from '@/server/services/extension/tokens';
import { withRoute } from '../../../../../_lib/with-route';
import { extensionContext, extensionTokenRateRule, tokenIdParam } from '../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ExtensionTokenRevokeBody, rateLimit: [extensionTokenRateRule] },
  async ({ ctx, session, runtime, body, params }) => {
    const target = await extensionContext({ ctx, session, runtime }, body.workspaceSlug);
    return revokeExtensionToken(target, { tokenId: tokenIdParam(params.tokenId) });
  },
);
