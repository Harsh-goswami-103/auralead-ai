/**
 * Enqueue helpers of the Lead Finder jobs (ADR-118, slice F1; job type names from
 * LEAD_GEN_JOB_TYPES). Every helper works on a client or inside the caller's transaction and is
 * idempotent on its key. Payloads carry ids, positions and Google's page token, never a key.
 *
 * - `leadFinder.search` (kind fetch): one Text Search page per job; the job enqueues the next page
 *   or cell itself (self-continuation). `serialKey run:<runId>` keeps a run sequential and its
 *   priority (10) lets sends and PDFs (0) go first.
 * - `leadFinder.emails` (kind fetch, P1): at most three listed websites per job, same serial key.
 * - `leadFinder.purge`: at the end of the hour bucket of a result's `contentExpiresAt`; it nulls
 *   the expired Places content of the run and re-arms itself for the next bucket.
 * - `leads.placesExpire` (P1): a workspace sweep at the end of the day bucket of a lead's
 *   `placesContentExpiresAt`; it nulls unconfirmed Places-sourced lead fields and re-arms.
 */
import type { Clock } from '@/lib/clock';
import { LEAD_GEN_JOB_TYPES } from '@/lib/domain/lead-gen';
import { idempotencyKey } from '@/lib/ids';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';

export const FINDER_SEARCH_JOB = LEAD_GEN_JOB_TYPES.finderSearch;
export const FINDER_EMAILS_JOB = LEAD_GEN_JOB_TYPES.finderEmails;
export const FINDER_PURGE_JOB = LEAD_GEN_JOB_TYPES.finderPurge;
export const PLACES_EXPIRE_JOB = LEAD_GEN_JOB_TYPES.placesExpire;

/** Claim order is ascending: sends and PDFs (0) and integration checks (5) go first. */
export const FINDER_JOB_PRIORITY = 10;
/** ADR-118 (a): finder results are a 24-hour working copy. */
export const FINDER_CONTENT_TTL_MS = 24 * 3_600_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function finderSerialKey(runId: string): string {
  return `run:${runId}`;
}

type Base = { workspaceId: string; correlationId: string; causationId?: string | null };

export function enqueueFinderSearch(db: JobStore, clock: Clock, input: Base & { runId: string; cell: number; page: number; pageToken?: string | null }) {
  return enqueueJob(db, clock, {
    type: FINDER_SEARCH_JOB,
    payload: { runId: input.runId, cell: input.cell, page: input.page, ...(input.pageToken ? { pageToken: input.pageToken } : {}) },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(FINDER_SEARCH_JOB, input.runId, String(input.cell), String(input.page)),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    priority: FINDER_JOB_PRIORITY,
    serialKey: finderSerialKey(input.runId),
    kind: 'fetch',
  });
}

export function enqueueFinderEmails(db: JobStore, clock: Clock, input: Base & { runId: string; resultIds: string[]; key: string }) {
  return enqueueJob(db, clock, {
    type: FINDER_EMAILS_JOB,
    payload: { runId: input.runId, resultIds: input.resultIds },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(FINDER_EMAILS_JOB, input.runId, input.key),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    priority: FINDER_JOB_PRIORITY,
    serialKey: finderSerialKey(input.runId),
    kind: 'fetch',
  });
}

/** The purge of a run's results that expire in the hour bucket of `expiresAt`, run at the end of that bucket. */
export function enqueueFinderPurge(db: JobStore, clock: Clock, input: Base & { runId: string; expiresAt: Date }) {
  const bucket = Math.floor(input.expiresAt.getTime() / HOUR);
  return enqueueJob(db, clock, {
    type: FINDER_PURGE_JOB,
    payload: { runId: input.runId },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(FINDER_PURGE_JOB, input.runId, String(bucket)),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    runAt: new Date((bucket + 1) * HOUR),
    priority: FINDER_JOB_PRIORITY,
    kind: 'default',
  });
}

/** The sweep of the workspace's imported Places leads whose details expire in the day bucket of `expiresAt`. */
export function enqueuePlacesExpire(db: JobStore, clock: Clock, input: Base & { expiresAt: Date }) {
  const bucket = Math.floor(input.expiresAt.getTime() / DAY);
  return enqueueJob(db, clock, {
    type: PLACES_EXPIRE_JOB,
    payload: {},
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(PLACES_EXPIRE_JOB, input.workspaceId, String(bucket)),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    runAt: new Date((bucket + 1) * DAY),
    priority: FINDER_JOB_PRIORITY,
    kind: 'default',
  });
}
