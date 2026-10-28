/**
 * `leadFinder.search` (ADR-118, slice F1): one Text Search page of one keyword x location cell of
 * a Lead Finder run per job. Payload v1 `{ runId, cell, page, pageToken? }`, a workspace job,
 * kind fetch, `serialKey run:<runId>`, priority 10 (behind sends).
 *
 * The provider is resolved and called outside any transaction (DEMO: the simulated directory,
 * zero outbound; LIVE: Google Places with the workspace's key, or a typed problem); everything is
 * written in the fenced settle (services/lead-finder/search.ts), which also enqueues the next page
 * or cell. Failures:
 *  - no usable key, an unreadable key (also recorded on the integration), a rejected key or a
 *    refused API: the run stops (PARTIAL with what it found, else FAILED) with its error code;
 *  - throttling, 5xx or no answer: retried with backoff (Retry-After honoured); after the last
 *    attempt the cell is skipped and the run continues, ending PARTIAL;
 *  - a bad request or an answer that is not the documented shape: the cell is skipped.
 * A cancelled or finished run makes the job a no-op; nothing is ever invented in place of a
 * provider answer.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import type { PlacesSeams } from '@/server/adapters/registry';
import { markCredentialUnreadable } from '@/server/services/integrations/credentials';
import { resolveWorkspacePlaces } from '@/server/services/lead-finder/provider';
import { FINDER_SEARCH_JOB } from '@/server/services/lead-finder/jobs';
import { TERMINAL_RUN_STATUSES } from '@/server/services/lead-finder/runs';
import { applySearchPage, cellTerms, placesErrorCode, problemErrorCode, retryable, skipCell, stopRun, stopsRun } from '@/server/services/lead-finder/search';
import { PLACES_PAGE_SIZE } from '@/server/adapters/places/port';
import type { KeyRing } from '@/server/security/secrets';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, parseWorkspacePayload } from './lead-job-support';

export { FINDER_SEARCH_JOB };

const payloadSchema = z.object({
  runId: z.string().min(1).max(64),
  cell: z.number().int().min(0).max(99),
  page: z.number().int().min(0).max(2),
  pageToken: z.string().min(1).max(4096).optional(),
});

export type FinderSearchDeps = { keyRing: KeyRing | null; seams?: PlacesSeams };
export type FinderSearchOptions = { mode?: () => 'demo' | 'live'; deps?: () => FinderSearchDeps };

function defaultDeps(): FinderSearchDeps {
  return { keyRing: getConfig().secrets.credentials };
}

export function createLeadFinderSearchJob(options: FinderSearchOptions = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const deps = options.deps ?? defaultDeps;
  return {
    type: FINDER_SEARCH_JOB,
    kind: 'fetch',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const run = await job.db.leadFinderRun.findFirst({ where: { id: payload.runId, workspaceId } });
      if (!run) return deadResult('RUN_NOT_FOUND', `no finder run ${payload.runId} in the job's workspace`);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { outcome: 'succeeded' };
      const terms = cellTerms(run, payload.cell);
      if (!terms) return deadResult('INVALID_PAYLOAD', `cell ${payload.cell} is outside run ${run.id}`);

      const ctx = { ...jobCtx(job, workspaceId, mode()), workspaceId };
      const step = { runId: run.id, jobId: job.job.id };
      const provider = await resolveWorkspacePlaces(ctx, deps());
      if (!provider.ok) {
        const errorCode = problemErrorCode(provider.code);
        return {
          outcome: 'succeeded',
          finalTx: async (tx) => {
            if (provider.code === 'CREDENTIAL_UNREADABLE' && provider.integrationId) {
              await markCredentialUnreadable(tx, ctx, { workspaceId, integrationId: provider.integrationId, field: provider.field ?? null });
            }
            await stopRun(tx, ctx, { ...step, errorCode });
          },
        };
      }

      const call = await provider.value.searchText({ keyword: terms.keyword, location: terms.location, pageSize: PLACES_PAGE_SIZE, pageToken: payload.pageToken ?? null });
      if (!call.ok) {
        const errorCode = placesErrorCode(call.kind);
        job.logger.warn({ runId: run.id, cell: payload.cell, page: payload.page, kind: call.kind, status: call.status, reason: call.reason }, 'lead finder search failed');
        if (stopsRun(call.kind)) return { outcome: 'succeeded', finalTx: (tx) => stopRun(tx, ctx, { ...step, errorCode }) };
        if (retryable(call.kind) && job.job.attempts < job.job.maxAttempts) {
          return { outcome: 'retry', errorCode, error: call.message, ...(call.retryAfterMs !== undefined ? { retryAfterMs: call.retryAfterMs } : {}) };
        }
        return { outcome: 'succeeded', finalTx: (tx) => skipCell(tx, ctx, { ...step, cell: payload.cell, errorCode }) };
      }

      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await applySearchPage(tx, ctx, {
            ...step,
            cell: payload.cell,
            page: payload.page,
            keyword: terms.keyword,
            location: terms.location,
            places: call.data.places,
            nextPageToken: call.data.nextPageToken,
            simulated: provider.value.simulated,
          });
        },
      };
    },
  };
}

export const leadFinderSearchJob = createLeadFinderSearchJob();
