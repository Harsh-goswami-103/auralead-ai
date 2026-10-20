/**
 * Quotations list with filters (T27 "quotations list filters"; T15's `listQuotes` stays the
 * unfiltered list the API route serves).
 *
 *  - Status filters use the status a reader sees (`effectiveQuoteStatus`): an APPROVED, SENT or
 *    VIEWED quote past its validity is EXPIRED before the sweep runs, so it is found under Expired
 *    and not under its stored status.
 *  - Search matches the quote number (case-insensitive) or the lead's name through the normalised
 *    column (`Lead.nameNormalized`: case, accents and punctuation folded, plan §5.8), never a JSON
 *    or free-text scan.
 *  - "Needs pricing review" narrows to quotes flagged for review.
 *  - Counts per status cover every quotation matching the search (two grouped statements), so the
 *    status chips stay true when the list itself is capped.
 * Everything reads through the tenant-scoped client.
 */
import type { Prisma } from '@/generated/prisma/client';
import { QuoteStatus as QUOTE_STATUSES, type QuoteStatus } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import { normalizeName } from '@/server/services/leads/normalize';
import { EXPIRING_STATUSES } from './state-machine';
import { effectiveQuoteStatus, QUOTE_LIST_LIMIT, type QuoteListRow } from './versioning';

export const QUOTE_SEARCH_MAX = 100;

export type QuoteListFilters = { status?: QuoteStatus; q?: string; needsReview?: boolean };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads `?status=&q=&review=1` leniently: an unknown or empty value is simply not a filter. */
export function parseQuoteListFilters(params: Record<string, string | string[] | undefined>): QuoteListFilters {
  const out: QuoteListFilters = {};
  const status = first(params.status);
  if (status && (QUOTE_STATUSES as readonly string[]).includes(status)) out.status = status as QuoteStatus;
  const q = first(params.q)?.trim().slice(0, QUOTE_SEARCH_MAX);
  if (q) out.q = q;
  if (first(params.review) === '1') out.needsReview = true;
  return out;
}

export function hasQuoteListFilters(f: QuoteListFilters): boolean {
  return f.status !== undefined || f.q !== undefined || f.needsReview === true;
}

/** The stored-column condition for "the status a reader sees is `status`". */
export function effectiveStatusWhere(status: QuoteStatus, now: Date): Prisma.QuoteWhereInput {
  const expiring = EXPIRING_STATUSES as QuoteStatus[];
  if (status === 'EXPIRED') return { OR: [{ status: 'EXPIRED' }, { status: { in: expiring }, validUntil: { lte: now } }] };
  if (expiring.includes(status)) return { status, OR: [{ validUntil: null }, { validUntil: { gt: now } }] };
  return { status };
}

function searchWhere(q: string | undefined): Prisma.QuoteWhereInput | null {
  if (!q) return null;
  const name = normalizeName(q);
  const or: Prisma.QuoteWhereInput[] = [{ number: { contains: q.toUpperCase() } }];
  if (name) or.push({ lead: { nameNormalized: { contains: name } } });
  return { OR: or };
}

function whereOf(filters: QuoteListFilters, now: Date): Prisma.QuoteWhereInput {
  const and: Prisma.QuoteWhereInput[] = [];
  if (filters.status) and.push(effectiveStatusWhere(filters.status, now));
  const search = searchWhere(filters.q);
  if (search) and.push(search);
  if (filters.needsReview) and.push({ needsPricingReview: true });
  return and.length > 0 ? { AND: and } : {};
}

export async function listQuotesFiltered(ctx: AppCtx, filters: QuoteListFilters): Promise<QuoteListRow[]> {
  requireWorkspace(ctx);
  const now = ctx.clock.now();
  const rows = await ctx.db.quote.findMany({
    where: whereOf(filters, now),
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: QUOTE_LIST_LIMIT,
    include: { lead: { select: { id: true, displayName: true } }, currentVersion: { select: { totalPaise: true } } },
  });
  return rows.map((q) => ({
    id: q.id,
    number: q.number,
    status: q.status,
    effectiveStatus: effectiveQuoteStatus(q, now),
    lead: q.lead,
    currentVersionNo: q.currentVersionNo,
    totalPaise: q.currentVersion?.totalPaise ?? null,
    validUntil: q.validUntil,
    needsPricingReview: q.needsPricingReview,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  }));
}

/** How many quotations matching the search (and review flag) a reader sees in each status. */
export async function countQuotesByStatus(ctx: AppCtx, filters: Omit<QuoteListFilters, 'status'>): Promise<Record<QuoteStatus, number>> {
  requireWorkspace(ctx);
  const now = ctx.clock.now();
  const base = whereOf({ q: filters.q, needsReview: filters.needsReview }, now);
  const [stored, lapsed] = await Promise.all([
    ctx.db.quote.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ctx.db.quote.groupBy({ by: ['status'], where: { AND: [base, { status: { in: EXPIRING_STATUSES as QuoteStatus[] }, validUntil: { lte: now } }] }, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(QUOTE_STATUSES.map((s) => [s, 0])) as Record<QuoteStatus, number>;
  for (const g of stored) counts[g.status] += g._count._all;
  for (const g of lapsed) {
    counts[g.status] -= g._count._all;
    counts.EXPIRED += g._count._all;
  }
  return counts;
}
