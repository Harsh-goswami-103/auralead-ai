/**
 * Website enrichment (R13, R15, G-SSRF-2, G-SSRF-3). Runs only in the worker: the `lead.enrich`
 * job and the SCORE pipeline stage call `checkLeadWebsite` outside any transaction (it may fetch)
 * and then `applyWebsiteCheck` inside their fenced settle transaction.
 *
 * Status rules:
 * - REACHABLE: a 2xx text/html or text/plain response (after at most 3 re-validated redirects).
 *   The visible text is stripped from the HTML and stored in `Lead.websiteEnrichment` with
 *   `untrusted: true`: it is data about the business, never instructions (T10 prompt injection).
 * - BLOCKED: the SSRF guard refused the destination. Nothing was fetched from it.
 * - UNREACHABLE: DNS miss (NXDOMAIN), connect failure, timeout, HTTP error or unsupported content.
 *   A failed fetch is never evidence that the website does not exist.
 * - VERIFIED_ABSENT is set only by a person (audited, T26); enrichment never sets it and never
 *   re-checks a lead a person marked that way.
 * - No website: nothing to check; the status stays UNKNOWN.
 * - DEMO: no outbound network at all (plan §4.2). The check is not run and the status is left as
 *   it is; a simulated result would be a faked provider result.
 */
import type { Lead, Prisma } from '@/generated/prisma/client';
import { AppError, EnrichmentBlockedDestinationError, EnrichmentError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import type { TxClient } from '@/server/jobs/types';
import { safeFetch, type SafeFetchResult } from '@/server/security/safe-fetch';
import { recordAudit } from '@/server/services/audit/record';

export type WebsiteFetcher = (url: string) => Promise<SafeFetchResult>;
export type EnrichmentDeps = { fetchWebsite: WebsiteFetcher };

/** The production fetcher: `safeFetch` with the fixed bot User-Agent. */
export function safeWebsiteFetcher(appOrigin: string): WebsiteFetcher {
  const userAgent = `AuraLeadBot/1.0 (+${appOrigin.replace(/\/+$/, '')}/docs/bot)`;
  return (url) => safeFetch(url, { userAgent });
}

/** Stored page text cap (characters). The AI context builder caps further (4 KB, plan §9). */
export const WEBSITE_TEXT_CAP = 8_000;
const TITLE_CAP = 200;

export type WebsiteEnrichmentRecord = {
  schemaVersion: 1;
  untrusted: true;
  checkedAt: string;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number;
  truncated: boolean;
  redirects: number;
  downgraded: boolean;
  /** Null when REACHABLE; otherwise the error code (ENRICHMENT_*). */
  reasonCode: string | null;
  title: string | null;
  text: string;
};

export type CheckedStatus = 'REACHABLE' | 'UNREACHABLE' | 'BLOCKED';
export type NotCheckedReason = 'NO_WEBSITE' | 'VERIFIED_ABSENT' | 'OUTBOUND_BLOCKED_IN_DEMO';

export type WebsiteCheckOutcome =
  | { checked: false; reasonCode: NotCheckedReason }
  | { checked: true; url: string; host: string; status: CheckedStatus; record: WebsiteEnrichmentRecord };

// ---- HTML to text -------------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', middot: '·', laquo: '«', raquo: '»',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function clean(s: string): string {
  return decodeEntities(s)
    // Control characters (keep newline and tab out of the final text too).
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Visible text and title of an HTML document. Scripts, styles, comments and markup are dropped. */
export function stripHtmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? clean(titleMatch[1] ?? '').slice(0, TITLE_CAP) || null : null;
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer|nav)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return { title, text: clean(body).slice(0, WEBSITE_TEXT_CAP) };
}

// ---- the check ----------------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function failureRecord(url: string, checkedAt: string, reasonCode: string, httpStatus: number | null): WebsiteEnrichmentRecord {
  return {
    schemaVersion: 1,
    untrusted: true,
    checkedAt,
    url,
    finalUrl: null,
    httpStatus,
    contentType: null,
    bytes: 0,
    truncated: false,
    redirects: 0,
    downgraded: false,
    reasonCode,
    title: null,
    text: '',
  };
}

/**
 * Checks a lead's website. Never writes; never throws for a fetch outcome (every enrichment
 * failure becomes BLOCKED or UNREACHABLE). Unexpected errors propagate.
 */
export async function checkLeadWebsite(
  ctx: Pick<AppCtx, 'mode' | 'clock'>,
  lead: Pick<Lead, 'website' | 'websiteStatus'>,
  deps: EnrichmentDeps,
): Promise<WebsiteCheckOutcome> {
  if (lead.websiteStatus === 'VERIFIED_ABSENT') return { checked: false, reasonCode: 'VERIFIED_ABSENT' };
  if (lead.website === null || lead.website.trim() === '') return { checked: false, reasonCode: 'NO_WEBSITE' };
  if (ctx.mode === 'demo') return { checked: false, reasonCode: 'OUTBOUND_BLOCKED_IN_DEMO' };

  const url = lead.website;
  const host = hostOf(url);
  try {
    const result = await deps.fetchWebsite(url);
    const checkedAt = ctx.clock.now().toISOString();
    const page = result.contentType === 'text/html' ? stripHtmlToText(result.body) : { title: null, text: clean(result.body).slice(0, WEBSITE_TEXT_CAP) };
    return {
      checked: true,
      url,
      host,
      status: 'REACHABLE',
      record: {
        schemaVersion: 1,
        untrusted: true,
        checkedAt,
        url,
        finalUrl: result.finalUrl,
        httpStatus: result.status,
        contentType: result.contentType,
        bytes: result.bytes,
        truncated: result.truncated,
        redirects: result.redirects,
        downgraded: result.downgraded,
        reasonCode: null,
        title: page.title,
        text: page.text,
      },
    };
  } catch (error) {
    if (!(error instanceof EnrichmentError)) throw error;
    const checkedAt = ctx.clock.now().toISOString();
    const httpStatus = typeof error.safeDetails?.httpStatus === 'number' ? error.safeDetails.httpStatus : null;
    const status: CheckedStatus = error instanceof EnrichmentBlockedDestinationError ? 'BLOCKED' : 'UNREACHABLE';
    return { checked: true, url, host, status, record: failureRecord(url, checkedAt, (error as AppError).code, httpStatus) };
  }
}

/**
 * Writes a checked outcome onto the lead and audits it (no PII, no page text in the summary). The
 * write applies only while the lead still has the same website and a person has not marked it
 * VERIFIED_ABSENT in the meantime. Returns whether the lead was updated. A not-checked outcome is
 * audited only.
 */
export async function applyWebsiteCheck(
  tx: TxClient,
  ctx: AppCtx,
  lead: Pick<Lead, 'id' | 'workspaceId' | 'simulated'>,
  outcome: WebsiteCheckOutcome,
): Promise<{ applied: boolean }> {
  if (!outcome.checked) {
    await recordAudit(tx, ctx, { action: 'lead.enrich', targetType: 'Lead', targetId: lead.id, workspaceId: lead.workspaceId, simulated: lead.simulated, summary: { checked: false, reasonCode: outcome.reasonCode } });
    return { applied: false };
  }
  const updated = await tx.lead.updateMany({
    where: { id: lead.id, workspaceId: lead.workspaceId, website: outcome.url, websiteStatus: { not: 'VERIFIED_ABSENT' } },
    data: { websiteStatus: outcome.status, websiteEnrichment: outcome.record as unknown as Prisma.InputJsonValue },
  });
  const applied = updated.count === 1;
  await recordAudit(tx, ctx, {
    action: 'lead.enrich',
    targetType: 'Lead',
    targetId: lead.id,
    workspaceId: lead.workspaceId,
    simulated: lead.simulated,
    summary: {
      checked: true,
      applied,
      status: outcome.status,
      reasonCode: outcome.record.reasonCode,
      host: outcome.host,
      httpStatus: outcome.record.httpStatus,
      truncated: outcome.record.truncated,
      redirects: outcome.record.redirects,
      downgraded: outcome.record.downgraded,
    },
  });
  return { applied };
}
