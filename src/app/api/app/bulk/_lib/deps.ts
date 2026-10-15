/**
 * Bulk route helpers (T23): the contact-key pepper from the boot config (eligibility reads consent
 * and suppression rows by the contact HMAC, C17) and the `workspaceSlug` query of the GET routes.
 * Boot refuses to start without the pepper, so a missing one here is a configuration fault.
 */
import { BulkRunQuery } from '@/lib/schemas/bulk';
import { ValidationError } from '@/lib/errors';
import type { Runtime } from '@/server/boot';
import type { BulkDeps } from '@/server/services/bulk/bulk';

export function bulkDeps(runtime: Runtime): BulkDeps {
  const pepper = runtime.config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper };
}

export function bulkQuery(req: Request): BulkRunQuery {
  const parsed = BulkRunQuery.safeParse({ workspaceSlug: new URL(req.url).searchParams.get('workspaceSlug') ?? undefined });
  if (!parsed.success) throw new ValidationError({ code: 'QUERY_INVALID', message: 'invalid workspaceSlug query' });
  return parsed.data;
}
