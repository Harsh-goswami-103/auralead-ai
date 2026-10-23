/**
 * Website email extraction for a finder run (ADR-118, slice F1, P1), opt-in per run.
 *
 * LIVE (`crawlSiteEmails`): the listed website only, through `safeFetch` (SSRF-hardened, public
 * addresses only, text/html and text/plain), with an identifying User-Agent, 8 s and 1 MB per page,
 * one request at a time: robots.txt first (a site that disallows our bot, or `*`, is not read:
 * BLOCKED), then the home page, then at most two same-host contact pages robots.txt allows. The
 * addresses found are filtered and classified by `email-extract.ts` and stored as `{ address,
 * sourceUrl, kind }`. A site that cannot be read is FAILED (never "no emails").
 *
 * DEMO (`demoSiteEmails`): the simulated directory's `@demo-leads.in` addresses; no website is
 * contacted.
 *
 * `applyEmailOutcomes` writes the outcomes in the job's fenced transaction (only rows still
 * PENDING, so a cancelled run is never filled in), adds to the run's email count and audits the
 * counts (`finder.emails.extract`, no addresses).
 */
import type { Prisma } from '@/generated/prisma/client';
import { demoWebsiteEmails } from '@/lib/demo/places';
import type { FinderEmailStatus } from '@/lib/domain/lead-gen';
import type { AppCtx } from '@/server/auth/context';
import type { TxClient } from '@/server/jobs/types';
import type { SafeFetchResult } from '@/server/security/safe-fetch';
import { recordAudit } from '@/server/services/audit/record';
import { blacklisted, contactPageUrls, emailCandidates, keepEmails, mergeEmails, robotsAllows, robotsRules, type ExtractedEmail } from './email-extract';

/** ADR-118: 8 seconds and 1 MB per page. */
export const EMAIL_PAGE_LIMITS = { totalTimeoutMs: 8_000, maxBytes: 1024 * 1024 } as const;
/** ADR-118: the home page and at most two same-host contact pages robots.txt allows. */
export const MAX_CONTACT_PAGES = 2;

export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<SafeFetchResult>;

export type SiteEmailOutcome = { status: Extract<FinderEmailStatus, 'FOUND' | 'NONE_FOUND' | 'BLOCKED' | 'FAILED' | 'NO_WEBSITE'>; emails: ExtractedEmail[]; pagesRead: number };

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * How a site's robots.txt answered (RFC 9309, 2.3.1):
 *  - `rules`: it was read, or the site has none (404 and other 4xx, or a file that is not text);
 *  - `unreachable`: a server error or throttling (5xx, 429): the crawler assumes everything is
 *    disallowed, so the site is not read (BLOCKED);
 *  - `failed`: no answer at all (DNS, connect, timeout, a blocked destination): the site cannot be
 *    read (FAILED), and nothing else is requested from it.
 */
type RobotsAnswer = { kind: 'rules'; rules: ReturnType<typeof robotsRules> } | { kind: 'unreachable' } | { kind: 'failed' };

function robotsFailure(error: unknown): RobotsAnswer {
  const e = error as { code?: unknown; safeDetails?: { httpStatus?: unknown } } | null;
  const status = typeof e?.safeDetails?.httpStatus === 'number' ? e.safeDetails.httpStatus : null;
  if (status !== null) return status >= 500 || status === 429 ? { kind: 'unreachable' } : { kind: 'rules', rules: [] };
  if (e?.code === 'ENRICHMENT_UNSUPPORTED_CONTENT_TYPE') return { kind: 'rules', rules: [] };
  return { kind: 'failed' };
}

export async function crawlSiteEmails(website: string, blacklist: readonly string[], fetchPage: PageFetcher, signal?: AbortSignal): Promise<SiteEmailOutcome> {
  let start: URL;
  try {
    start = new URL(website);
  } catch {
    return { status: 'FAILED', emails: [], pagesRead: 0 };
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') return { status: 'FAILED', emails: [], pagesRead: 0 };

  const rulesByOrigin = new Map<string, RobotsAnswer>();
  const rulesFor = async (url: URL): Promise<RobotsAnswer> => {
    const cached = rulesByOrigin.get(url.origin);
    if (cached) return cached;
    let answer: RobotsAnswer;
    try {
      const res = await fetchPage(`${url.origin}/robots.txt`, signal);
      answer = { kind: 'rules', rules: robotsRules(res.body) };
    } catch (error) {
      answer = robotsFailure(error);
    }
    rulesByOrigin.set(url.origin, answer);
    return answer;
  };

  const startRules = await rulesFor(start);
  if (startRules.kind === 'unreachable') return { status: 'BLOCKED', emails: [], pagesRead: 0 };
  if (startRules.kind === 'failed') return { status: 'FAILED', emails: [], pagesRead: 0 };
  if (!robotsAllows(startRules.rules, pathOf(start))) return { status: 'BLOCKED', emails: [], pagesRead: 0 };
  let home: SafeFetchResult;
  try {
    home = await fetchPage(start.toString(), signal);
  } catch {
    return { status: 'FAILED', emails: [], pagesRead: 0 };
  }
  const found: ExtractedEmail[][] = [keepEmails(emailCandidates(home.body), home.finalUrl, blacklist)];
  let pagesRead = 1;
  let contactPages = 0;
  for (const page of contactPageUrls(home.body, home.finalUrl, 10)) {
    if (contactPages >= MAX_CONTACT_PAGES) break;
    const url = new URL(page);
    const rules = await rulesFor(url);
    if (rules.kind !== 'rules' || !robotsAllows(rules.rules, pathOf(url))) continue;
    contactPages += 1;
    try {
      const res = await fetchPage(page, signal);
      pagesRead += 1;
      found.push(keepEmails(emailCandidates(res.body), res.finalUrl, blacklist));
    } catch {
      // One unreadable contact page does not hide what the others published.
    }
  }
  const emails = mergeEmails(found);
  return { status: emails.length > 0 ? 'FOUND' : 'NONE_FOUND', emails, pagesRead };
}

/** DEMO: the simulated listing's `@demo-leads.in` addresses, through the same blacklist. */
export function demoSiteEmails(row: { placeId: string; website: string | null; name: string | null }, blacklist: readonly string[]): SiteEmailOutcome {
  if (!row.website) return { status: 'FAILED', emails: [], pagesRead: 0 };
  const emails = demoWebsiteEmails({ placeId: row.placeId, website: row.website, name: row.name ?? row.placeId }).filter((e) => !blacklisted(e.address, blacklist));
  return { status: emails.length > 0 ? 'FOUND' : 'NONE_FOUND', emails, pagesRead: 0 };
}

export async function applyEmailOutcomes(
  tx: TxClient,
  ctx: AppCtx & { workspaceId: string },
  input: { runId: string; jobId: string; simulated: boolean; outcomes: ReadonlyArray<{ resultId: string; outcome: SiteEmailOutcome }> },
): Promise<{ found: number }> {
  let found = 0;
  const counts: Record<SiteEmailOutcome['status'], number> = { FOUND: 0, NONE_FOUND: 0, BLOCKED: 0, FAILED: 0, NO_WEBSITE: 0 };
  for (const { resultId, outcome } of input.outcomes) {
    const moved = await tx.leadFinderResult.updateMany({
      where: { id: resultId, workspaceId: ctx.workspaceId, runId: input.runId, emailStatus: 'PENDING' },
      data: { emails: outcome.emails as unknown as Prisma.InputJsonValue, emailCount: outcome.emails.length, emailStatus: outcome.status },
    });
    if (moved.count === 0) continue;
    found += outcome.emails.length;
    counts[outcome.status] += 1;
  }
  if (found > 0) await tx.leadFinderRun.updateMany({ where: { id: input.runId, workspaceId: ctx.workspaceId }, data: { emailsFound: { increment: found } } });
  if (Object.values(counts).some((n) => n > 0)) {
    await recordAudit(tx, ctx, {
      action: 'finder.emails.extract',
      targetType: 'LeadFinderRun',
      targetId: input.runId,
      workspaceId: ctx.workspaceId,
      simulated: input.simulated,
      // Counts only: no address, no site (`emails` would be redacted as a PII key anyway).
      summary: { sites: Object.values(counts).reduce((a, b) => a + b, 0), found, byStatus: counts, jobId: input.jobId },
    });
  }
  return { found };
}
