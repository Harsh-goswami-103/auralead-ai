/**
 * The 24-hour working copy of finder results (ADR-118 (a), slice F1). `purgeExpiredResults` nulls
 * the Places content of a run's results whose `contentExpiresAt` has passed (name, category, phone,
 * website, rating, review count, address, city, state, PIN code, attributions) and stamps
 * `contentPurgedAt`; it keeps the place ID, keyword, location, the derived flags (`websiteListed`,
 * `hasPhone`), the website-sourced emails and `importedLeadId`. It audits the count (no content)
 * and re-arms `leadFinder.purge` for the run's next expiry, if any. Runs in the purge job's fenced
 * transaction.
 */
import { Prisma } from '@/generated/prisma/client';
import type { AppCtx } from '@/server/auth/context';
import type { JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { enqueueFinderPurge } from './jobs';

/** The Places content columns a purge nulls (and a Refresh writes again). */
export const PLACES_CONTENT_NULLS = {
  name: null,
  category: null,
  phoneRaw: null,
  website: null,
  ratingX10: null,
  reviewCount: null,
  address: null,
  city: null,
  state: null,
  pincode: null,
  attributions: Prisma.DbNull,
} satisfies Prisma.LeadFinderResultUpdateManyMutationInput;

export async function purgeExpiredResults(tx: TxClient, ctx: AppCtx & { workspaceId: string }, input: { runId: string; jobId: string }): Promise<{ purged: number; nextExpiry: Date | null }> {
  const now = ctx.clock.now();
  const purged = await tx.leadFinderResult.updateMany({
    where: { workspaceId: ctx.workspaceId, runId: input.runId, contentPurgedAt: null, contentExpiresAt: { lte: now } },
    data: { ...PLACES_CONTENT_NULLS, contentPurgedAt: now },
  });
  if (purged.count > 0) {
    const run = await tx.leadFinderRun.findFirst({ where: { id: input.runId, workspaceId: ctx.workspaceId }, select: { simulated: true } });
    await recordAudit(tx, ctx, {
      action: 'finder.results.purge',
      targetType: 'LeadFinderRun',
      targetId: input.runId,
      workspaceId: ctx.workspaceId,
      simulated: run?.simulated ?? false,
      summary: { purged: purged.count, jobId: input.jobId },
    });
  }
  const next = await tx.leadFinderResult.findFirst({
    where: { workspaceId: ctx.workspaceId, runId: input.runId, contentPurgedAt: null, contentExpiresAt: { gt: now } },
    orderBy: { contentExpiresAt: 'asc' },
    select: { contentExpiresAt: true },
  });
  const nextExpiry = next?.contentExpiresAt ?? null;
  if (nextExpiry) await enqueueFinderPurge(tx as unknown as JobStore, ctx.clock, { workspaceId: ctx.workspaceId, runId: input.runId, expiresAt: nextExpiry, correlationId: ctx.correlationId, causationId: input.jobId });
  return { purged: purged.count, nextExpiry };
}
