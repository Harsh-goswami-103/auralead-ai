/**
 * The job side of a Lead Finder run (ADR-118, slice F1): what one `leadFinder.search` job writes
 * in its fenced settle transaction after its single Text Search call (made outside it).
 *
 * - `applySearchPage`: stores the page's places (a place already found by this run is not stored
 *   twice), each a 24-hour working copy (`contentExpiresAt`), moves the run to RUNNING, counts
 *   them, arms the purge, queues email extraction when the run asked for it, then continues: the
 *   next page while Google offers one and the cell's `maxPerQuery` is not reached, else the next
 *   keyword x location cell, else the run ends (SUCCEEDED, or PARTIAL when a cell failed).
 * - `skipCell`: a cell that failed for good (bad request, retries exhausted) is counted as done
 *   with the run's error code, and the run continues with the next cell.
 * - `stopRun`: a failure that will repeat for every cell (no key, a rejected key, the API not
 *   enabled) ends the run: PARTIAL when it already found places, else FAILED.
 * Every function re-reads the run inside the transaction and does nothing once it is finished or
 * cancelled, so a late job never revives a run.
 */
import type { LeadFinderRun, Prisma } from '@/generated/prisma/client';
import type { PlaceRecord, PlacesFailureKind } from '@/server/adapters/places/port';
import type { ProblemCode } from '@/server/adapters/registry';
import type { AppCtx } from '@/server/auth/context';
import type { JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { enqueueFinderEmails, enqueueFinderPurge, enqueueFinderSearch, FINDER_CONTENT_TTL_MS } from './jobs';
import { TERMINAL_RUN_STATUSES } from './runs';

export function placesErrorCode(kind: PlacesFailureKind): string {
  switch (kind) {
    case 'auth':
      return 'PLACES_AUTH';
    case 'permission':
      return 'PLACES_PERMISSION';
    case 'rate-limited':
      return 'PLACES_RATE_LIMITED';
    case 'unavailable':
      return 'PLACES_UNAVAILABLE';
    case 'unreachable':
      return 'PLACES_UNREACHABLE';
    case 'invalid-argument':
    case 'not-found':
      return 'PLACES_INVALID_ARGUMENT';
    case 'rejected':
      return 'PLACES_REJECTED';
  }
}

export function problemErrorCode(code: ProblemCode): string {
  if (code === 'CREDENTIAL_UNREADABLE') return 'PLACES_CREDENTIAL_UNREADABLE';
  if (code === 'MODE_MISMATCH') return 'MODE_MISMATCH';
  return 'PLACES_NOT_CONFIGURED';
}

/** A failure that would repeat for every cell: the run stops instead of trying the next one. */
export function stopsRun(kind: PlacesFailureKind): boolean {
  return kind === 'auth' || kind === 'permission';
}

/** A transient failure worth retrying with backoff before the cell is skipped. */
export function retryable(kind: PlacesFailureKind): boolean {
  return kind === 'rate-limited' || kind === 'unavailable' || kind === 'unreachable';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Whether a listing carries any Places content besides its ID. A content-less, never-purged row is
 * how an erased place is recognised (runs.ts `erasedResult`), so such a listing is neither stored
 * nor accepted as a refresh: it has nothing to show or import anyway.
 */
export function placeHasContent(p: PlaceRecord): boolean {
  return [p.name, p.category, p.phone, p.website, p.rating, p.reviewCount, p.address, p.city, p.state, p.pincode].some((v) => v !== null);
}

/** The keyword and location of a cell (keywords outer, locations inner), or null past the end. */
export function cellTerms(run: Pick<LeadFinderRun, 'keywords' | 'locations'>, cell: number): { keyword: string; location: string } | null {
  const keywords = stringList(run.keywords);
  const locations = stringList(run.locations);
  if (!Number.isInteger(cell) || cell < 0 || locations.length === 0 || cell >= keywords.length * locations.length) return null;
  return { keyword: keywords[Math.floor(cell / locations.length)]!, location: locations[cell % locations.length]! };
}

/** Pages a cell may use: `maxPerQuery` of 20, 40 or 60 is one, two or three pages. */
export function pagesFor(maxPerQuery: number): number {
  return Math.max(1, Math.min(3, Math.ceil(maxPerQuery / 20)));
}

type StepCtx = AppCtx & { workspaceId: string };
type StepInput = { runId: string; jobId: string };

async function liveRun(tx: TxClient, ctx: StepCtx, runId: string): Promise<LeadFinderRun | null> {
  const run = await tx.leadFinderRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return null;
  return run;
}

async function finish(tx: TxClient, ctx: StepCtx, run: LeadFinderRun, patch: { cellsDone: number; errorCode: string | null; resultsFound: number }, input: StepInput): Promise<void> {
  const now = ctx.clock.now();
  const status = patch.errorCode === null ? 'SUCCEEDED' : patch.resultsFound > 0 ? 'PARTIAL' : 'FAILED';
  await tx.leadFinderRun.update({
    where: { id: run.id },
    data: { status, cellsDone: patch.cellsDone, errorCode: patch.errorCode, finishedAt: now, startedAt: run.startedAt ?? now },
  });
  await recordAudit(tx, ctx, {
    action: 'finder.run.finish',
    targetType: 'LeadFinderRun',
    targetId: run.id,
    workspaceId: ctx.workspaceId,
    simulated: run.simulated,
    result: status === 'FAILED' ? 'FAILED' : 'SUCCESS',
    summary: { status, results: patch.resultsFound, cells: run.cellsTotal, cellsDone: patch.cellsDone, errorCode: patch.errorCode, jobId: input.jobId },
  });
}

/** The cell is done: queue the next cell, or end the run after the last one. */
async function nextCell(tx: TxClient, ctx: StepCtx, run: LeadFinderRun, cell: number, patch: { errorCode: string | null; resultsFound: number }, input: StepInput): Promise<void> {
  const cellsDone = Math.min(run.cellsTotal, run.cellsDone + 1);
  if (cell + 1 < run.cellsTotal) {
    await tx.leadFinderRun.update({ where: { id: run.id }, data: { cellsDone, errorCode: patch.errorCode } });
    await enqueueFinderSearch(tx as unknown as JobStore, ctx.clock, { workspaceId: ctx.workspaceId, runId: run.id, cell: cell + 1, page: 0, correlationId: ctx.correlationId, causationId: input.jobId });
    return;
  }
  await finish(tx, ctx, run, { cellsDone, errorCode: patch.errorCode, resultsFound: patch.resultsFound }, input);
}

export async function applySearchPage(
  tx: TxClient,
  ctx: StepCtx,
  input: StepInput & { cell: number; page: number; keyword: string; location: string; places: readonly PlaceRecord[]; nextPageToken: string | null; simulated: boolean },
): Promise<{ inserted: number }> {
  const run = await liveRun(tx, ctx, input.runId);
  if (!run) return { inserted: 0 };
  const now = ctx.clock.now();
  const contentExpiresAt = new Date(now.getTime() + FINDER_CONTENT_TTL_MS);

  const unique = new Map<string, PlaceRecord>();
  for (const p of input.places) if (!unique.has(p.placeId) && placeHasContent(p)) unique.set(p.placeId, p);
  const known = unique.size === 0 ? [] : await tx.leadFinderResult.findMany({ where: { workspaceId: ctx.workspaceId, runId: run.id, placeId: { in: [...unique.keys()] } }, select: { placeId: true } });
  for (const k of known) unique.delete(k.placeId);

  // Rows keep the order the provider returned them in: `createdAt` is the clock's time, made
  // strictly increasing (by 1 ms) within the run, so the grid lists results in search order.
  const latest = await tx.leadFinderResult.findFirst({ where: { workspaceId: ctx.workspaceId, runId: run.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  let stamp = Math.max(now.getTime(), (latest?.createdAt.getTime() ?? 0) + 1);
  const created: Array<{ id: string; websiteListed: boolean }> = [];
  for (const p of unique.values()) {
    const emailStatus = run.extractEmails ? (p.website ? 'PENDING' : 'NO_WEBSITE') : 'NOT_REQUESTED';
    const row = await tx.leadFinderResult.create({
      data: {
        workspaceId: ctx.workspaceId,
        runId: run.id,
        placeId: p.placeId,
        keyword: input.keyword,
        location: input.location,
        name: p.name?.slice(0, 300) ?? null,
        category: p.category?.slice(0, 200) ?? null,
        phoneRaw: p.phone?.slice(0, 64) ?? null,
        hasPhone: p.phone !== null,
        website: p.website?.slice(0, 2048) ?? null,
        websiteListed: p.websiteListed,
        ratingX10: p.rating === null ? null : Math.round(p.rating * 10),
        reviewCount: p.reviewCount,
        address: p.address?.slice(0, 1000) ?? null,
        city: p.city?.slice(0, 200) ?? null,
        state: p.state?.slice(0, 200) ?? null,
        pincode: p.pincode,
        ...(p.attributions.length > 0 ? { attributions: p.attributions as unknown as Prisma.InputJsonValue } : {}),
        emails: [],
        emailCount: 0,
        emailStatus,
        simulated: input.simulated,
        contentExpiresAt,
        createdAt: new Date(stamp),
      },
      select: { id: true, websiteListed: true },
    });
    stamp += 1;
    created.push(row);
  }

  const resultsFound = run.resultsFound + created.length;
  await tx.leadFinderRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: run.startedAt ?? now, resultsFound } });
  if (created.length > 0) {
    await enqueueFinderPurge(tx as unknown as JobStore, ctx.clock, { workspaceId: ctx.workspaceId, runId: run.id, expiresAt: contentExpiresAt, correlationId: ctx.correlationId, causationId: input.jobId });
  }
  if (run.extractEmails) {
    const withSite = created.filter((c) => c.websiteListed).map((c) => c.id);
    for (let i = 0; i < withSite.length; i += 3) {
      await enqueueFinderEmails(tx as unknown as JobStore, ctx.clock, {
        workspaceId: ctx.workspaceId,
        runId: run.id,
        resultIds: withSite.slice(i, i + 3),
        key: `${input.cell}:${input.page}:${i / 3}`,
        correlationId: ctx.correlationId,
        causationId: input.jobId,
      });
    }
  }

  const fetched = input.page * 20 + input.places.length;
  const morePages = input.nextPageToken !== null && input.page + 1 < pagesFor(run.maxPerQuery) && fetched < run.maxPerQuery;
  if (morePages) {
    await enqueueFinderSearch(tx as unknown as JobStore, ctx.clock, {
      workspaceId: ctx.workspaceId,
      runId: run.id,
      cell: input.cell,
      page: input.page + 1,
      pageToken: input.nextPageToken,
      correlationId: ctx.correlationId,
      causationId: input.jobId,
    });
    return { inserted: created.length };
  }
  await nextCell(tx, ctx, run, input.cell, { errorCode: run.errorCode, resultsFound }, input);
  return { inserted: created.length };
}

export async function skipCell(tx: TxClient, ctx: StepCtx, input: StepInput & { cell: number; errorCode: string }): Promise<void> {
  const run = await liveRun(tx, ctx, input.runId);
  if (!run) return;
  const now = ctx.clock.now();
  if (run.status === 'QUEUED') await tx.leadFinderRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: now } });
  await nextCell(tx, ctx, { ...run, startedAt: run.startedAt ?? now }, input.cell, { errorCode: run.errorCode ?? input.errorCode, resultsFound: run.resultsFound }, input);
}

export async function stopRun(tx: TxClient, ctx: StepCtx, input: StepInput & { errorCode: string }): Promise<void> {
  const run = await liveRun(tx, ctx, input.runId);
  if (!run) return;
  await finish(tx, ctx, run, { cellsDone: run.cellsDone, errorCode: input.errorCode, resultsFound: run.resultsFound }, input);
}
