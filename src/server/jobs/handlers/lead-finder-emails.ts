/**
 * `leadFinder.emails` (ADR-118, slice F1, P1): email extraction for at most three finder results of
 * a run that asked for it. Payload v1 `{ runId, resultIds }`, a workspace job, kind fetch, the run's
 * serial key and priority 10 (behind sends).
 *
 * The websites are read outside any transaction, one request at a time, in LIVE only through
 * `safeFetch` with the bot User-Agent, 8 s and 1 MB per page, robots.txt honoured
 * (services/lead-finder/emails.ts). A simulated run (DEMO) never fetches anything: it gets the
 * simulated `@demo-leads.in` addresses. The outcomes are written in the fenced settle, only for rows
 * still waiting (a cancelled run is left alone). A site that cannot be read is FAILED for that row;
 * the job itself does not retry (a second attempt would read the same sites again).
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { safeFetch } from '@/server/security/safe-fetch';
import { applyEmailOutcomes, crawlSiteEmails, demoSiteEmails, EMAIL_PAGE_LIMITS, type PageFetcher, type SiteEmailOutcome } from '@/server/services/lead-finder/emails';
import { FINDER_EMAILS_JOB } from '@/server/services/lead-finder/jobs';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, parseWorkspacePayload } from './lead-job-support';

export { FINDER_EMAILS_JOB };

const payloadSchema = z.object({ runId: z.string().min(1).max(64), resultIds: z.array(z.string().min(1).max(64)).min(1).max(3) });

/** The production fetcher: `safeFetch` with the identifying bot User-Agent and the ADR-118 page limits. */
export function finderPageFetcher(appOrigin: string): PageFetcher {
  const userAgent = `AuraLeadBot/1.0 (+${appOrigin.replace(/\/+$/, '')}/docs/bot)`;
  return (url, signal) => safeFetch(url, { userAgent, totalTimeoutMs: EMAIL_PAGE_LIMITS.totalTimeoutMs, maxBytes: EMAIL_PAGE_LIMITS.maxBytes, ...(signal ? { signal } : {}) });
}

export type FinderEmailsOptions = { mode?: () => 'demo' | 'live'; fetchPage?: () => PageFetcher };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function createLeadFinderEmailsJob(options: FinderEmailsOptions = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const fetchPage = options.fetchPage ?? (() => finderPageFetcher(getConfig().appOrigin));
  return {
    type: FINDER_EMAILS_JOB,
    kind: 'fetch',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const run = await job.db.leadFinderRun.findFirst({ where: { id: payload.runId, workspaceId } });
      if (!run) return deadResult('RUN_NOT_FOUND', `no finder run ${payload.runId} in the job's workspace`);
      if (run.status === 'CANCELLED') return { outcome: 'succeeded' };
      const rows = await job.db.leadFinderResult.findMany({ where: { workspaceId, runId: run.id, id: { in: payload.resultIds }, emailStatus: 'PENDING' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (rows.length === 0) return { outcome: 'succeeded' };

      const blacklist = stringList(run.emailBlacklist);
      const simulated = run.simulated || mode() === 'demo';
      const outcomes: Array<{ resultId: string; outcome: SiteEmailOutcome }> = [];
      for (const row of rows) {
        if (job.signal.aborted) break;
        let outcome: SiteEmailOutcome;
        if (!row.websiteListed) outcome = { status: 'NO_WEBSITE', emails: [], pagesRead: 0 };
        else if (simulated) outcome = demoSiteEmails(row, blacklist);
        else if (!row.website) outcome = { status: 'FAILED', emails: [], pagesRead: 0 };
        else outcome = await crawlSiteEmails(row.website, blacklist, fetchPage(), job.signal);
        outcomes.push({ resultId: row.id, outcome });
      }
      const ctx = { ...jobCtx(job, workspaceId, mode()), workspaceId };
      return { outcome: 'succeeded', finalTx: async (tx) => void (await applyEmailOutcomes(tx, ctx, { runId: run.id, jobId: job.job.id, simulated: run.simulated, outcomes })) };
    },
  };
}

export const leadFinderEmailsJob = createLeadFinderEmailsJob();
