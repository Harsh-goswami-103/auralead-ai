/**
 * POST /api/app/extension/tokens/[tokenId]/allowed-extension (T36; C18): sets (32 letters a-p) or
 * clears (null) the Chrome extension id this token is bound to. The receiver answers CORS only for
 * `chrome-extension://<that id>` and refuses another extension Origin with this token. A revoked
 * token is 409. Roles USER and EMPLOYEE, `extension.manage`; CSRF; rate limit `inviteReset`.
 */
import { ExtensionAllowedIdBody } from '@/lib/schemas/webhooks';
import { setExtensionTokenAllowedId } from '@/server/services/extension/tokens';
import { withRoute } from '../../../../../_lib/with-route';
import { extensionContext, extensionTokenRateRule, tokenIdParam } from '../../../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute(
  { auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ExtensionAllowedIdBody, rateLimit: [extensionTokenRateRule] },
  async ({ ctx, session, runtime, body, params }) => {
    const target = await extensionContext({ ctx, session, runtime }, body.workspaceSlug);
    return setExtensionTokenAllowedId(target, { tokenId: tokenIdParam(params.tokenId), allowedExtensionId: body.allowedExtensionId });
  },
);
