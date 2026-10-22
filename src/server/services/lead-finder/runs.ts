/**
 * Lead Finder runs (ADR-118, slice F1): keywords x locations searched on Google Places (LIVE) or
 * the simulated directory (DEMO), page by page in the worker.
 *
 * - `startFinderRun` (needs `finder.run`, checked here on the console target): normalizes the
 *   terms (trimmed, de-duplicated, at most 10 x 10), refuses a LIVE workspace without a usable
 *   Google Places key, holds at most `FINDER_ACTIVE_RUN_CAP` queued or running runs per workspace,
 *   and in one transaction stores the run, enqueues its first `leadFinder.search` job and audits
 *   `finder.run.start` (counts only: search terms are not written to the audit). Idempotent per
 *   request key; a replay is not rate limited.
 * - `listFinderRuns`, `getFinderRunView` (needs `leads.read`): the runs with their progress, and
 *   one run's results filtered on real columns (no website, has phone, not imported), 50 a page.
 *   Places content past its 24-hour expiry is never shown (ADR-118 (a)), even before the purge job
 *   has nulled it.
 */
import type { LeadFinderResult, LeadFinderRun, Prisma } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, IdempotencyConflictError, NotFoundError } from '@/lib/errors';
import { FINDER_EMAIL_STATUSES, type FinderEmailStatus } from '@/lib/domain/lead-gen';
import type { LeadFinderRunStatus } from '@/lib/domain/enums';
import { placesMapsLink, type PlaceAttribution } from '@/server/adapters/places/port';
import type { AppCtx } from '@/server/auth/context';
import { requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { requestCancel, type JobStore } from '@/server/jobs/queue';
import type { TxClient } from '@/server/jobs/types';
import { safeHref } from '@/server/security/safe-href';
import { recordAudit } from '@/server/services/audit/record';
import { enqueueFinderSearch, finderSerialKey } from './jobs';
import { resolveWorkspacePlaces, type PlacesDeps } from './provider';
import { FINDER_LIMITS, type FinderResultFilters, type StartFinderRunInput } from './schemas';

/** Queued or running runs a workspace may hold at once (the worker runs one job at a time). */
export const FINDER_ACTIVE_RUN_CAP = 2;
const LIST_LIMIT = 10;
export const TERMINAL_RUN_STATUSES: ReadonlySet<LeadFinderRunStatus> = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export class FinderRunLimitError extends ConflictError {
  static override readonly defaultCode: string = 'FINDER_RUN_LIMIT';
  static override readonly defaultUserMessage: string = `This workspace already has ${FINDER_ACTIVE_RUN_CAP} searches waiting or running. Wait for one to finish, then try again.`;
}

export class PlacesNotConfiguredError extends DomainRuleError {
  static override readonly defaultCode: string = 'PLACES_NOT_CONFIGURED';
  static override readonly defaultUserMessage: string = 'Set up Google Places first: save the API key in the integration setup.';
}

export type FinderEmail = { address: string; sourceUrl: string; kind: 'ROLE' | 'PERSONAL' | 'FREEMAIL' };

export type FinderRunDto = {
  id: string;
  status: LeadFinderRunStatus;
  keywords: string[];
  locations: string[];
  maxPerQuery: number;
  extractEmails: boolean;
  blacklistCount: number;
  cellsTotal: number;
  cellsDone: number;
  resultsFound: number;
  emailsFound: number;
  simulated: boolean;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  /** The viewer started this run (only they can download its Excel file). */
  requestedByViewer: boolean;
};

export type FinderResultDto = {
  id: string;
  placeId: string;
  keyword: string;
  location: string;
  /** False once the 24-hour working copy expired: every Places content field below is then null. */
  hasDetails: boolean;
  /** The details were removed by an erasure request: they are never fetched again. */
  erased: boolean;
  name: string | null;
  category: string | null;
  phone: string | null;
  hasPhone: boolean;
  website: string | null;
  /** The website as a safe link, or null. */
  websiteHref: string | null;
  websiteListed: boolean;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  attributions: PlaceAttribution[];
  /** A Google Maps link built from the place ID (LIVE results only; a simulated ID has no map). */
  mapsHref: string | null;
  emails: FinderEmail[];
  emailStatus: FinderEmailStatus;
  simulated: boolean;
  importedLeadId: string | null;
  importedAt: string | null;
};

export type FinderRunView = {
  run: FinderRunDto;
  results: FinderResultDto[];
  filters: FinderResultFilters;
  page: number;
  pageCount: number;
  /** Matching the filters. */
  total: number;
  /** Per filter, over the whole run, for the filter chips. */
  counts: { all: number; noWebsite: number; hasPhone: number; notImported: number };
  /** The distinct attributions of the shown LIVE results (ADR-118 (b)). */
  attributions: PlaceAttribution[];
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function runDto(row: LeadFinderRun, viewerId: string | null): FinderRunDto {
  return {
    id: row.id,
    status: row.status,
    keywords: stringList(row.keywords),
    locations: stringList(row.locations),
    maxPerQuery: row.maxPerQuery,
    extractEmails: row.extractEmails,
    blacklistCount: stringList(row.emailBlacklist).length,
    cellsTotal: row.cellsTotal,
    cellsDone: row.cellsDone,
    resultsFound: row.resultsFound,
    emailsFound: row.emailsFound,
    simulated: row.simulated,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    requestedByViewer: viewerId !== null && row.requestedBy === viewerId,
  };
}

export function finderEmails(value: unknown): FinderEmail[] {
  if (!Array.isArray(value)) return [];
  const out: FinderEmail[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.address !== 'string' || typeof e.sourceUrl !== 'string') continue;
    const kind = e.kind === 'PERSONAL' || e.kind === 'FREEMAIL' ? e.kind : 'ROLE';
    out.push({ address: e.address, sourceUrl: e.sourceUrl, kind });
  }
  return out;
}

/** Stored attributions; a provider link survives only as a safe http(s) href. */
export function attributionList(value: unknown): PlaceAttribution[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null && typeof (a as Record<string, unknown>).provider === 'string')
    .map((a) => {
      const href = typeof a.providerUri === 'string' ? safeHref(a.providerUri) : null;
      return { provider: String(a.provider), providerUri: href && /^https?:/i.test(href) ? href : null };
    });
}

type ContentColumns = Pick<LeadFinderResult, 'name' | 'category' | 'phoneRaw' | 'website' | 'ratingX10' | 'reviewCount' | 'address' | 'city' | 'state' | 'pincode'>;

/** Whether any Places content column still holds a value. */
export function holdsContent(row: ContentColumns): boolean {
  return [row.name, row.category, row.phoneRaw, row.website, row.ratingX10, row.reviewCount, row.address, row.city, row.state, row.pincode].some((v) => v !== null);
}

/**
 * A result whose content was removed by erasure (`lead:erase`, ADR-127) rather than by the 24-hour
 * purge: no content left and never stamped `contentPurgedAt` (the purge only stamps rows that still
 * hold content). Its listing is never fetched again (Refresh refuses it).
 */
export function erasedResult(row: ContentColumns & Pick<LeadFinderResult, 'contentPurgedAt'>): boolean {
  return row.contentPurgedAt === null && !holdsContent(row);
}

/** True while the result's Places content may be shown: not purged, not erased and not past `contentExpiresAt`. */
export function hasDetails(row: ContentColumns & Pick<LeadFinderResult, 'contentPurgedAt' | 'contentExpiresAt'>, now: Date): boolean {
  if (row.contentPurgedAt !== null || erasedResult(row)) return false;
  return row.contentExpiresAt === null || row.contentExpiresAt.getTime() > now.getTime();
}

function emailStatusOf(value: string): FinderEmailStatus {
  return (FINDER_EMAIL_STATUSES as readonly string[]).includes(value) ? (value as FinderEmailStatus) : 'NOT_REQUESTED';
}

export function resultDto(row: LeadFinderResult, now: Date): FinderResultDto {
  const shown = hasDetails(row, now);
  const website = shown ? row.website : null;
  const href = website ? safeHref(website) : null;
  return {
    id: row.id,
    placeId: row.placeId,
    keyword: row.keyword,
    location: row.location,
    hasDetails: shown,
    erased: erasedResult(row),
    name: shown ? row.name : null,
    category: shown ? row.category : null,
    phone: shown ? row.phoneRaw : null,
    hasPhone: row.hasPhone,
    website,
    websiteHref: href && /^https?:/i.test(href) ? href : null,
    websiteListed: row.websiteListed,
    rating: shown && row.ratingX10 !== null ? row.ratingX10 / 10 : null,
    reviewCount: shown ? row.reviewCount : null,
    address: shown ? row.address : null,
    city: shown ? row.city : null,
    state: shown ? row.state : null,
    pincode: shown ? row.pincode : null,
    attributions: shown ? attributionList(row.attributions) : [],
    mapsHref: row.simulated ? null : placesMapsLink(row.placeId, `${row.keyword} ${row.location}`),
    emails: finderEmails(row.emails),
    emailStatus: emailStatusOf(row.emailStatus),
    simulated: row.simulated,
    importedLeadId: row.importedLeadId,
    importedAt: row.importedAt?.toISOString() ?? null,
  };
}

// ---- Start --------------------------------------------------------------------------------------

export type StartFinderRunDeps = PlacesDeps & {
  /** The `finderRun` limiter of the route (throws RateLimitedError); not called for a replayed request key. */
  rateLimit?: () => void;
};

export async function startFinderRun(ctx: AppCtx, input: StartFinderRunInput, deps: StartFinderRunDeps): Promise<{ run: FinderRunDto; created: boolean }> {
  requireCapability(ctx, 'finder.run');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);

  const existing = await ctx.db.leadFinderRun.findFirst({ where: { requestKey: input.requestKey } });
  if (existing) {
    if (existing.requestedBy !== actor.userId) throw new IdempotencyConflictError({ message: 'finder request key used by another person' });
    return { run: runDto(existing, actor.userId), created: false };
  }
  deps.rateLimit?.();

  // LIVE: a search needs the workspace's own usable key (decrypted outside any transaction).
  const provider = await resolveWorkspacePlaces(ctx, deps);
  if (!provider.ok) {
    if (provider.code === 'MODE_MISMATCH') throw new NotFoundError();
    throw new PlacesNotConfiguredError({ safeDetails: { problem: provider.code } });
  }

  const now = ctx.clock.now();
  const cellsTotal = input.keywords.length * input.locations.length;
  return withTx(ctx.db, async (tx) => {
    const again = await tx.leadFinderRun.findFirst({ where: { requestKey: input.requestKey } });
    if (again) return { run: runDto(again, actor.userId), created: false };
    const active = await tx.leadFinderRun.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    if (active >= FINDER_ACTIVE_RUN_CAP) throw new FinderRunLimitError({ safeDetails: { limit: FINDER_ACTIVE_RUN_CAP } });
    const row = await tx.leadFinderRun.create({
      data: {
        workspaceId,
        requestKey: input.requestKey,
        requestedBy: actor.userId,
        keywords: input.keywords,
        locations: input.locations,
        maxPerQuery: input.maxPerQuery,
        extractEmails: input.extractEmails,
        emailBlacklist: input.emailBlacklist,
        status: 'QUEUED',
        cellsTotal,
        simulated: provider.value.simulated,
        createdAt: now,
      },
    });
    const { job } = await enqueueFinderSearch(tx as unknown as JobStore, ctx.clock, { workspaceId, runId: row.id, cell: 0, page: 0, correlationId: ctx.correlationId });
    await recordAudit(tx, ctx, {
      action: 'finder.run.start',
      targetType: 'LeadFinderRun',
      targetId: row.id,
      workspaceId,
      simulated: row.simulated,
      summary: { keywords: input.keywords.length, locations: input.locations.length, cells: cellsTotal, maxPerQuery: input.maxPerQuery, extractEmails: input.extractEmails, blacklist: input.emailBlacklist.length, jobId: job.id },
    });
    return { run: runDto(row, actor.userId), created: true };
  });
}

// ---- Cancel (P1) --------------------------------------------------------------------------------

/**
 * Stops a queued or running run (needs `finder.run`): CANCELLED with the time, its queued search
 * and email jobs cancelled (a running one finds the run cancelled and writes nothing), email checks
 * that never ran are reset to "not requested", audited `finder.run.cancel`. Places already found
 * stay. A finished run is left as it is.
 */
export async function cancelFinderRun(ctx: AppCtx, runId: string): Promise<{ run: FinderRunDto; cancelled: boolean }> {
  requireCapability(ctx, 'finder.run');
  const workspaceId = requireWorkspace(ctx);
  const viewer = ctx.actor?.userId ?? null;
  const run = await loadFinderRun(ctx, runId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return { run: runDto(run, viewer), cancelled: false };
  const now = ctx.clock.now();
  return withTx(ctx.db, async (tx) => {
    const moved = await tx.leadFinderRun.updateMany({ where: { id: run.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', cancelledAt: now, finishedAt: now } });
    const after = await tx.leadFinderRun.findFirstOrThrow({ where: { id: run.id } });
    if (moved.count === 0) return { run: runDto(after, viewer), cancelled: false };
    const jobs = await tx.job.findMany({ where: { serialKey: finderSerialKey(run.id), status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
    for (const job of jobs) await requestCancel(tx as unknown as TxClient, ctx.clock, job.id);
    await tx.leadFinderResult.updateMany({ where: { runId: run.id, emailStatus: 'PENDING' }, data: { emailStatus: 'NOT_REQUESTED' } });
    await recordAudit(tx, ctx, { action: 'finder.run.cancel', targetType: 'LeadFinderRun', targetId: run.id, workspaceId, simulated: run.simulated, summary: { results: after.resultsFound, cellsDone: after.cellsDone, cells: after.cellsTotal, jobsCancelled: jobs.length } });
    return { run: runDto(after, viewer), cancelled: true };
  });
}

// ---- Read ---------------------------------------------------------------------------------------

export async function listFinderRuns(ctx: AppCtx): Promise<FinderRunDto[]> {
  requireCapability(ctx, 'leads.read');
  const viewer = ctx.actor?.userId ?? null;
  const rows = await ctx.db.leadFinderRun.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT });
  return rows.map((r) => runDto(r, viewer));
}

function filterWhere(runId: string, filters: FinderResultFilters): Prisma.LeadFinderResultWhereInput {
  return {
    runId,
    ...(filters.noWebsite ? { websiteListed: false } : {}),
    ...(filters.hasPhone ? { hasPhone: true } : {}),
    ...(filters.notImported ? { importedLeadId: null } : {}),
  };
}

export async function loadFinderRun(ctx: AppCtx, runId: string): Promise<LeadFinderRun> {
  const run = await ctx.db.leadFinderRun.findFirst({ where: { id: runId } });
  if (!run) throw new NotFoundError();
  return run;
}

export async function getFinderRunView(ctx: AppCtx, runId: string, filters: FinderResultFilters, page = 1): Promise<FinderRunView> {
  requireCapability(ctx, 'leads.read');
  const run = await loadFinderRun(ctx, runId);
  const now = ctx.clock.now();
  const where = filterWhere(run.id, filters);
  const [total, all, noWebsite, hasPhone, notImported] = await Promise.all([
    ctx.db.leadFinderResult.count({ where }),
    ctx.db.leadFinderResult.count({ where: { runId: run.id } }),
    ctx.db.leadFinderResult.count({ where: { runId: run.id, websiteListed: false } }),
    ctx.db.leadFinderResult.count({ where: { runId: run.id, hasPhone: true } }),
    ctx.db.leadFinderResult.count({ where: { runId: run.id, importedLeadId: null } }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / FINDER_LIMITS.pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const rows = await ctx.db.leadFinderResult.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (current - 1) * FINDER_LIMITS.pageSize, take: FINDER_LIMITS.pageSize });
  const results = rows.map((r) => resultDto(r, now));
  const seen = new Set<string>();
  const attributions: PlaceAttribution[] = [];
  for (const a of results.flatMap((r) => r.attributions)) {
    const key = `${a.provider}|${a.providerUri ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attributions.push(a);
  }
  return {
    run: runDto(run, ctx.actor?.userId ?? null),
    results,
    filters,
    page: current,
    pageCount,
    total,
    counts: { all, noWebsite, hasPhone, notImported },
    attributions,
  };
}
