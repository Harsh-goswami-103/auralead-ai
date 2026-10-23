/**
 * "Refresh details" of expired finder results (ADR-118 (a), slice F1, P1). Needs `finder.run`: in
 * LIVE each refreshed result is one paid Place Details call by its place ID with the same field
 * mask. At most 10 per request, called one after another outside any transaction; a rejected key or
 * a refused API stops the remaining calls. Refreshed rows get their Places content back as a new
 * 24-hour working copy (`contentExpiresAt`, `contentPurgedAt` cleared, the purge re-armed); rows
 * that have not expired are left alone, and a result whose details an erasure removed is refused
 * (never fetched again). Audited `finder.results.refresh` with counts only. DEMO
 * rebuilds the simulated listing from its ID and never contacts anything.
 */
import { Prisma } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import type { PlaceRecord } from '@/server/adapters/places/port';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { JobStore } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit/record';
import { enqueueFinderPurge, FINDER_CONTENT_TTL_MS } from './jobs';
import { resolveWorkspacePlaces, type PlacesDeps } from './provider';
import { erasedResult, hasDetails, loadFinderRun, PlacesNotConfiguredError } from './runs';
import { placeHasContent, placesErrorCode, stopsRun } from './search';

export type RefreshResult = { requested: number; refreshed: number; failed: number; notExpired: number; erased: number; errorCode: string | null };

export async function refreshFinderResults(ctx: AppCtx, input: { runId: string; resultIds: readonly string[] }, deps: PlacesDeps): Promise<RefreshResult> {
  requireCapability(ctx, 'finder.run');
  const workspaceId = requireWorkspace(ctx);
  const run = await loadFinderRun(ctx, input.runId);
  const ids = [...new Set(input.resultIds)];
  const rows = await ctx.db.leadFinderResult.findMany({ where: { runId: run.id, id: { in: ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (rows.length !== ids.length) throw new NotFoundError({ message: 'a selected finder result is not in this run' });
  const now = ctx.clock.now();
  // A listing whose details an erasure removed is never fetched again.
  const erased = rows.filter((r) => erasedResult(r)).length;
  const expired = rows.filter((r) => !erasedResult(r) && !hasDetails(r, now));
  const notExpired = rows.length - erased - expired.length;
  if (expired.length === 0) return { requested: rows.length, refreshed: 0, failed: 0, notExpired, erased, errorCode: null };

  const provider = await resolveWorkspacePlaces(ctx, deps);
  if (!provider.ok) {
    if (provider.code === 'MODE_MISMATCH') throw new NotFoundError();
    throw new PlacesNotConfiguredError({ safeDetails: { problem: provider.code } });
  }

  const fresh: Array<{ id: string; place: PlaceRecord }> = [];
  let failed = 0;
  let errorCode: string | null = null;
  for (const row of expired) {
    const call = await provider.value.getPlace(row.placeId, { keyword: row.keyword, location: row.location });
    if (call.ok && call.data.placeId === row.placeId && placeHasContent(call.data)) {
      fresh.push({ id: row.id, place: call.data });
      continue;
    }
    failed += 1;
    if (!call.ok) {
      errorCode ??= placesErrorCode(call.kind);
      if (stopsRun(call.kind)) {
        // The key or the API is refused: every remaining call would be refused too.
        failed = expired.length - fresh.length;
        break;
      }
    }
  }

  const expiresAt = new Date(now.getTime() + FINDER_CONTENT_TTL_MS);
  await withTx(ctx.db, async (tx) => {
    for (const { id, place } of fresh) {
      await tx.leadFinderResult.updateMany({
        where: { id, runId: run.id },
        data: {
          name: place.name?.slice(0, 300) ?? null,
          category: place.category?.slice(0, 200) ?? null,
          phoneRaw: place.phone?.slice(0, 64) ?? null,
          hasPhone: place.phone !== null,
          website: place.website?.slice(0, 2048) ?? null,
          websiteListed: place.websiteListed,
          ratingX10: place.rating === null ? null : Math.round(place.rating * 10),
          reviewCount: place.reviewCount,
          address: place.address?.slice(0, 1000) ?? null,
          city: place.city?.slice(0, 200) ?? null,
          state: place.state?.slice(0, 200) ?? null,
          pincode: place.pincode,
          // The copy is replaced as a whole: attributions Google no longer sends must not linger.
          attributions: place.attributions.length > 0 ? (place.attributions as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          contentExpiresAt: expiresAt,
          contentPurgedAt: null,
        },
      });
    }
    if (fresh.length > 0) await enqueueFinderPurge(tx as unknown as JobStore, ctx.clock, { workspaceId, runId: run.id, expiresAt, correlationId: ctx.correlationId });
    await recordAudit(tx, ctx, {
      action: 'finder.results.refresh',
      targetType: 'LeadFinderRun',
      targetId: run.id,
      workspaceId,
      simulated: run.simulated,
      result: fresh.length === 0 ? 'FAILED' : 'SUCCESS',
      summary: { requested: rows.length, refreshed: fresh.length, failed, notExpired, erased, errorCode },
    });
  });
  return { requested: rows.length, refreshed: fresh.length, failed, notExpired, erased, errorCode };
}
