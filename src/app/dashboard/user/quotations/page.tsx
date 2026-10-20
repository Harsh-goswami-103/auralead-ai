/**
 * Client Quotations list (T15; 06-design "User Quotations"): every quotation of the workspace,
 * newest activity first, with the status a reader should see (an approved or sent quote past its
 * validity reads Expired before the sweep runs), the current version, its persisted total and the
 * validity date. Read on the server through the tenant-scoped context.
 *
 * Filters (T27): a plain GET form (works without JavaScript; the URL is shareable and Back works)
 * with a search over the quote number and the lead's normalised name, the status a reader sees and
 * "needs pricing review". The status chips are links that set the status filter; their counts
 * cover every quotation matching the search, not just the listed rows (services/quotes/list.ts).
 *
 * Aurora look (design spec §6-§7): PageHeader with the one primary action, the filter bar, the
 * status chips, and a neutral table (no colored cells, money in text-1) whose rows become cards
 * below md with the total kept visible; on a phone the whole card opens the quotation.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { FilePlus2, FileText, Search, SearchX, TriangleAlert, X } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { PageHeader } from '@/components/patterns/PageHeader';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Reveal } from '@/components/visual/Reveal';
import type { QuoteStatus } from '@/lib/domain/enums';
import { formatDate } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { countQuotesByStatus, hasQuoteListFilters, listQuotesFiltered, parseQuoteListFilters, QUOTE_SEARCH_MAX, type QuoteListFilters } from '@/server/services/quotes/list';
import { QUOTE_LIST_LIMIT } from '@/server/services/quotes/versioning';
import { QUOTE_STATUS_VOCABULARY, QuoteStatusBadge } from './quote-status';

export const metadata: Metadata = { title: 'Quotations' };
export const dynamic = 'force-dynamic';

const STATUS_ORDER: QuoteStatus[] = ['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'];

/** Visible below md only, where a row is laid out as a card. */
function CardLabel({ children }: { children: ReactNode }) {
  return <span className="block text-xs text-fg-3 md:hidden">{children}</span>;
}

const BASE = '/dashboard/user/quotations';

function hrefWith(filters: QuoteListFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  if (filters.needsReview) params.set('review', '1');
  const query = params.toString();
  return query ? `${BASE}?${query}` : BASE;
}

function FilterBar(props: { filters: QuoteListFilters }) {
  const { filters } = props;
  return (
    <form method="get" action={BASE} role="search" aria-label="Filter quotations" className="flex flex-wrap items-end gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-3 sm:p-4">
      <label className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1.5 text-sm text-fg-1">
        Search
        <span className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input type="search" name="q" defaultValue={filters.q ?? ''} maxLength={QUOTE_SEARCH_MAX} placeholder="Quote number or lead name" className="pl-9" />
        </span>
      </label>
      <label className="flex flex-[0_1_12rem] flex-col gap-1.5 text-sm text-fg-1">
        Status
        <NativeSelect name="status" defaultValue={filters.status ?? ''}>
          <option value="">All statuses</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {QUOTE_STATUS_VOCABULARY[s].label}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm text-fg-1 lg:min-h-9">
        <input type="checkbox" name="review" value="1" defaultChecked={filters.needsReview === true} className="size-4 accent-cyan" />
        Needs pricing review
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" className={buttonVariants({ variant: 'secondary' })}>
          Apply
        </button>
        {hasQuoteListFilters(filters) ? (
          <Link href={BASE} className={buttonVariants({ variant: 'ghost' })}>
            <X aria-hidden="true" />
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function QuotationsPage(props: { searchParams?: SearchParams } = {}) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const ctx = page.ctx;
  const filters = parseQuoteListFilters((await props.searchParams) ?? {});
  const filtered = hasQuoteListFilters(filters);
  const [quotes, statusCounts] = await Promise.all([listQuotesFiltered(ctx, filters), countQuotesByStatus(ctx, { q: filters.q, needsReview: filters.needsReview })]);
  const canCreate = hasCapability(ctx, 'quotes.edit');
  const counts = new Map<QuoteStatus, number>(STATUS_ORDER.filter((s) => statusCounts[s] > 0).map((s) => [s, statusCounts[s]]));
  const anyQuote = Object.values(statusCounts).some((n) => n > 0) || filtered;
  const capped = quotes.length === QUOTE_LIST_LIMIT;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Quotations"
        title="Quotes and their versions"
        description="Each version keeps the prices it was issued with. Editing an approved quote creates a new version that needs approval again."
        actions={
          canCreate ? (
            <GlowFrame>
              <Link href="/dashboard/user/quotations/new" className={buttonVariants()}>
                <FilePlus2 aria-hidden="true" />
                New quotation
              </Link>
            </GlowFrame>
          ) : null
        }
      />

      {anyQuote ? <FilterBar filters={filters} /> : null}

      {quotes.length === 0 && filtered ? (
        <EmptyState
          icon={<SearchX aria-hidden="true" className="size-5" />}
          title="No quotations match"
          description="Nothing matches these filters. Search covers the quote number and the lead's name."
          action={
            <Link href={BASE} className={buttonVariants({ variant: 'outline' })}>
              Clear filters
            </Link>
          }
        />
      ) : quotes.length === 0 ? (
        <EmptyState
          icon={<FileText aria-hidden="true" className="size-5" />}
          title="No quotations yet"
          description="Create one for a lead, from its AI proposal or by choosing services from your price list."
          action={
            canCreate ? (
              <Link href="/dashboard/user/quotations/new" className={buttonVariants({ variant: 'outline' })}>
                New quotation
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <Reveal delay={0.1}>
            <ul aria-label={filters.q || filters.needsReview ? 'Matching quotations by status' : 'Quotations by status'} className="flex flex-wrap items-center gap-2">
              {STATUS_ORDER.filter((s) => counts.has(s)).map((s) => {
                const entry = QUOTE_STATUS_VOCABULARY[s];
                const Icon = entry.icon;
                const current = filters.status === s;
                return (
                  <li key={s}>
                    <Link
                      href={hrefWith({ ...filters, status: current ? undefined : s })}
                      aria-current={current ? 'true' : undefined}
                      className={cn(
                        'inline-flex min-h-11 items-center gap-1.5 rounded-full border py-1 pr-1 pl-2.5 text-xs font-medium transition-[filter] duration-fast hover:brightness-110 lg:min-h-0',
                        TONE_CLASSES[entry.tone],
                        current && 'ring-2 ring-panel/70 ring-offset-2 ring-offset-bg-0',
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                      {entry.label}
                      <span className="tabular rounded-full bg-bg-0/50 px-1.5 py-px text-fg-1">{counts.get(s)}</span>
                      {current ? <span className="sr-only"> (filter on; select to clear)</span> : null}
                    </Link>
                  </li>
                );
              })}
              <li className="text-xs text-fg-2">
                {filtered ? (
                  <>
                    {quotes.length} {quotes.length === 1 ? 'quotation matches' : 'quotations match'}
                    {capped ? ' (the latest shown)' : ''}
                  </>
                ) : (
                  <>
                    {quotes.length} {quotes.length === 1 ? 'quotation' : 'quotations'}
                    {capped ? ' in this list (the latest)' : ''}
                  </>
                )}
              </li>
            </ul>
          </Reveal>

          <Reveal variant="fade" delay={0.12} className="relative min-w-0 rounded-xl border border-border-subtle bg-bg-1/80 max-md:border-0 max-md:bg-transparent">
            <div className="relative md:overflow-x-auto">
              <table className="w-full text-left text-sm md:min-w-[44rem]">
                <caption className="sr-only">
                  {filtered ? 'Quotations matching the filters' : 'Quotations'}, newest activity first{capped ? `, the latest ${QUOTE_LIST_LIMIT}` : ''}
                </caption>
                <thead className="text-xs text-fg-2 max-md:sr-only">
                  <tr className="border-b border-border-subtle">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Quote
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Lead
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">
                      Total
                    </th>
                    <th scope="col" className="px-3 py-3 font-medium">
                      Valid until
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody className="max-md:flex max-md:flex-col max-md:gap-3">
                  {quotes.map((q) => (
                    <tr
                      key={q.id}
                      className="border-b border-border-subtle transition-colors duration-fast last:border-b-0 md:hover:bg-bg-2/60 max-md:relative max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-2 max-md:rounded-xl max-md:border max-md:bg-bg-1/80 max-md:p-4 max-md:last:border-b max-md:hover:border-panel/45"
                    >
                      <td className="px-4 py-3 max-md:order-1 max-md:p-0">
                        <Link
                          href={`/dashboard/user/quotations/${q.id}`}
                          className="font-display font-semibold text-cyan underline-offset-4 hover:underline max-md:after:absolute max-md:after:inset-0 max-md:after:rounded-xl"
                        >
                          {q.number}
                        </Link>
                        <span className="ml-2 rounded-full border border-border-subtle bg-bg-2 px-1.5 py-px text-[11px] text-fg-2">v{q.currentVersionNo}</span>
                      </td>
                      <td className="px-3 py-3 text-fg-1 max-md:order-3 max-md:col-span-2 max-md:p-0">{q.lead.displayName}</td>
                      <td className="px-3 py-3 max-md:order-4 max-md:col-span-2 max-md:p-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <QuoteStatusBadge status={q.effectiveStatus} />
                          {q.needsPricingReview ? (
                            <span className={cn('inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', TONE_CLASSES.warning)}>
                              <TriangleAlert aria-hidden="true" className="size-3.5" />
                              Needs pricing review
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="tabular px-3 py-3 text-right font-medium whitespace-nowrap text-fg-1 max-md:order-2 max-md:p-0">
                        {q.totalPaise === null ? <span className="font-normal text-fg-3">Not priced</span> : formatINR(q.totalPaise)}
                      </td>
                      <td className="px-3 py-3 text-fg-2 max-md:order-5 max-md:p-0">
                        <CardLabel>Valid until</CardLabel>
                        {q.validUntil ? formatDate(q.validUntil) : <span className="text-fg-3">Not set</span>}
                      </td>
                      <td className="px-4 py-3 text-fg-2 max-md:order-6 max-md:p-0 max-md:text-right">
                        <CardLabel>Updated</CardLabel>
                        {formatDate(q.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </>
      )}
    </div>
  );
}
