/**
 * Integration center route helpers (T28, T32): the workspace an action is about (`workspaceSlug`,
 * resolved like a `[ws]` segment through the lead console's `consoleContext`, ADR-58: a foreign
 * slug is 404, a missing capability in it 403), the integration kind from the `[kind]` URL
 * segment (a catalog slug; anything else is 404), and the credential rate rule.
 */
import type { IntegrationKind } from '@/lib/domain/enums';
import { integrationKindFromSlug } from '@/lib/domain/integrations';
import { NotFoundError } from '@/lib/errors';
import type { RateRule } from '../../../_lib/with-route';

export { consoleContext as integrationContext } from '../../leads/_lib/console-context';

export function kindParam(value: string | string[] | undefined): IntegrationKind {
  const kind = typeof value === 'string' ? integrationKindFromSlug(value) : null;
  if (!kind) throw new NotFoundError({ message: `no integration for slug ${String(value)}` });
  return kind;
}

/**
 * Credential writes and revocations (T32): the plan §9 `inviteReset` policy (10 per hour), the
 * secret-handling limit of the table, keyed by the person and the workspace slug named in the
 * body (the session's active workspace without one).
 */
export const credentialRateRule: RateRule = {
  policy: 'inviteReset',
  key: ({ body, ctx }) => {
    const slug = typeof (body as { workspaceSlug?: unknown } | null)?.workspaceSlug === 'string' ? String((body as { workspaceSlug: string }).workspaceSlug).slice(0, 100) : 'active';
    return ctx.actor ? `integration-credentials:${ctx.actor.userId}:${slug}` : null;
  },
};
