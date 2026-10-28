/**
 * Lead Finder route helpers (ADR-118, slice F1): the places deps from the boot config (the
 * credentials key ring decrypts the workspace's Google Places key, LIVE only), the ingestion deps
 * (the contact-key pepper, which boot requires), the per-workspace `finderRun` limiter and the GET
 * queries.
 */
import { RateLimitedError, ValidationError } from '@/lib/errors';
import type { Runtime } from '@/server/boot';
import type { AppCtx } from '@/server/auth/context';
import type { IngestDeps } from '@/server/services/leads/ingest';
import type { PlacesDeps } from '@/server/services/lead-finder/provider';
import { FinderResultsQuery } from '@/server/services/lead-finder/schemas';

export function placesDeps(runtime: Runtime): PlacesDeps {
  return { keyRing: runtime.config.secrets.credentials };
}

export function finderIngestDeps(runtime: Runtime): IngestDeps {
  const pepper = runtime.config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper };
}

/** Each started run makes paid Places calls in LIVE: at most `finderRun` starts per workspace an hour. */
export function finderRateLimit(runtime: Runtime, target: AppCtx): () => void {
  return () => {
    const decision = runtime.limiters.finderRun.take(`workspace:${target.workspaceId}`);
    if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds });
  };
}

export function finderResultsQuery(req: Request) {
  const params = new URL(req.url).searchParams;
  const parsed = FinderResultsQuery.safeParse({
    workspaceSlug: params.get('workspaceSlug') ?? undefined,
    noWebsite: params.get('noWebsite') ?? undefined,
    hasPhone: params.get('hasPhone') ?? undefined,
    notImported: params.get('notImported') ?? undefined,
    page: params.get('page') ?? undefined,
  });
  if (!parsed.success) throw new ValidationError({ code: 'QUERY_INVALID', message: 'invalid finder results query' });
  return parsed.data;
}
