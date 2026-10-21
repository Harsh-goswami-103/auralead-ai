/**
 * Extension token route helpers (T36): the workspace named by `workspaceSlug` (resolved like a
 * `[ws]` segment, ADR-58: a foreign slug is 404, a missing capability in it 403), the token id
 * from the URL, and the rate rule. Token creation and revocation handle secrets, so they share the
 * plan §9 `inviteReset` policy (10 per hour) like the credential writes (ADR-95), keyed by the
 * person and the workspace slug.
 */
import { NotFoundError } from '@/lib/errors';
import type { RateRule } from '../../../_lib/with-route';

export { consoleContext as extensionContext } from '../../leads/_lib/console-context';

export function tokenIdParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new NotFoundError({ message: 'malformed extension token id' });
  return value;
}

export const extensionTokenRateRule: RateRule = {
  policy: 'inviteReset',
  key: ({ body, ctx }) => {
    const raw = (body as { workspaceSlug?: unknown } | null)?.workspaceSlug;
    const slug = typeof raw === 'string' ? raw.slice(0, 100) : 'active';
    return ctx.actor ? `extension-tokens:${ctx.actor.userId}:${slug}` : null;
  },
};
