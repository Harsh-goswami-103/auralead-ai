/**
 * Integration center route helpers (T28): the workspace an action is about (`workspaceSlug`,
 * resolved like a `[ws]` segment through the lead console's `consoleContext`, ADR-58: a foreign
 * slug is 404, a missing capability in it 403) and the integration kind from the `[kind]` URL
 * segment (a catalog slug; anything else is 404).
 */
import type { IntegrationKind } from '@/lib/domain/enums';
import { integrationKindFromSlug } from '@/lib/domain/integrations';
import { NotFoundError } from '@/lib/errors';

export { consoleContext as integrationContext } from '../../leads/_lib/console-context';

export function kindParam(value: string | string[] | undefined): IntegrationKind {
  const kind = typeof value === 'string' ? integrationKindFromSlug(value) : null;
  if (!kind) throw new NotFoundError({ message: `no integration for slug ${String(value)}` });
  return kind;
}
