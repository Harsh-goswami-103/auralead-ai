/**
 * `lead.enrich` (R13, R15): checks one lead's website in the worker (never inline in a request,
 * G-SSRF-3) and, in the same fenced settle transaction, records the WebsiteStatus and the
 * untrusted page text and rescores the lead with the workspace's active scoring config (the
 * website is a score input). DEMO never fetches (zero outbound); the job then only audits why.
 *
 * Who enqueues it: a person's "check website again" action in later tasks, never ingestion (which
 * only enqueues `pipeline.advance`, E9). The SCORE pipeline stage runs the same check itself.
 * `fetchWebsite` and `mode` are injectable for tests, like `pipeline.advance`.
 */
import type { Clock } from '@/lib/clock';
import { getConfig } from '@/lib/config';
import { idempotencyKey } from '@/lib/ids';
import { applyWebsiteCheck, checkLeadWebsite, safeWebsiteFetcher, type WebsiteFetcher } from '@/server/services/enrichment/website';
import { loadActiveScoringConfig } from '@/server/services/scoring/config';
import { scoreInputOf, writeLeadScore } from '@/server/services/scoring/record';
import { scoreLead } from '@/server/services/scoring/score';
import { enqueueJob, type JobStore } from '../queue';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, leadPayloadSchema, parseWorkspacePayload } from './lead-job-support';

export const LEAD_ENRICH_JOB = 'lead.enrich';

export type LeadEnrichOptions = { fetchWebsite?: WebsiteFetcher; mode?: () => 'demo' | 'live' };

/** `requestKey` identifies the request (one job per request), e.g. the request's audit id. */
export function enqueueLeadEnrich(
  db: JobStore,
  clock: Clock,
  input: { workspaceId: string; leadId: string; requestKey: string; correlationId: string; causationId?: string | null },
) {
  return enqueueJob(db, clock, {
    type: LEAD_ENRICH_JOB,
    payload: { leadId: input.leadId },
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(LEAD_ENRICH_JOB, input.leadId, input.requestKey),
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    kind: 'fetch',
  });
}

export function createLeadEnrichJob(options: LeadEnrichOptions = {}): JobDefinition {
  let fetchWebsite = options.fetchWebsite;
  const mode = options.mode ?? (() => getConfig().mode);
  return {
    type: LEAD_ENRICH_JOB,
    kind: 'fetch',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, leadPayloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const lead = await job.db.lead.findFirst({ where: { id: payload.leadId, workspaceId } });
      if (!lead) return deadResult('LEAD_NOT_FOUND', `no lead ${payload.leadId} in the job's workspace`);

      const ctx = jobCtx(job, workspaceId, mode());
      fetchWebsite ??= safeWebsiteFetcher(getConfig().appOrigin);
      const outcome = await checkLeadWebsite(ctx, lead, { fetchWebsite });
      const scoring = outcome.checked ? await loadActiveScoringConfig(job.db, workspaceId) : null;

      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          const { applied } = await applyWebsiteCheck(tx, ctx, lead, outcome);
          if (!applied || scoring === null) return;
          const fresh = await tx.lead.findFirst({ where: { id: lead.id, workspaceId } });
          if (!fresh) return;
          await writeLeadScore(tx, ctx, fresh, scoreLead(scoreInputOf(fresh), scoring), { trigger: LEAD_ENRICH_JOB });
        },
      };
    },
  };
}

export const leadEnrichJob = createLeadEnrichJob();
