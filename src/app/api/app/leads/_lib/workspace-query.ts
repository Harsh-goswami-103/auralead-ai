/**
 * The `?workspaceSlug=` query of the leads GET routes (T26), chosen exactly like the lead console
 * routes' body field (ADR-58).
 */
import { ValidationError } from '@/lib/errors';
import { LeadWorkspaceQuery } from '@/lib/schemas/leads';

export function workspaceQuery(req: Request): LeadWorkspaceQuery {
  const parsed = LeadWorkspaceQuery.safeParse({ workspaceSlug: new URL(req.url).searchParams.get('workspaceSlug') ?? undefined });
  if (!parsed.success) throw new ValidationError({ code: 'QUERY_INVALID', message: 'invalid workspaceSlug query' });
  return parsed.data;
}
