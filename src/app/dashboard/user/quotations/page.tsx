/**
 * Client Quotations list (T15; 06-design "User Quotations"): every quotation of the workspace,
 * newest activity first, with the status a reader should see (an approved or sent quote past its
 * validity reads Expired before the sweep runs), the current version, its persisted total and the
 * validity date. Read on the server through the tenant-scoped context. Filters are T27's.
 *
 * Aurora look (design spec §6-§7): PageHeader with the one primary action, a row of status counts
 * computed from the listed rows only (truthful: "in this list" when the list is capped), and a
 * neutral table (no colored cells, money in text-1) whose rows become cards below md with the total
 * kept visible; on a phone the whole card opens the quotation.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { FilePlus2, FileText, TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
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
import { listQuotes, QUOTE_LIST_LIMIT } from '@/server/services/quotes/versioning';
import { QUOTE_STATUS_VOCABULARY, QuoteStatusBadge } from './quote-status';

export const metadata: Metadata = { title: 'Quotations' };
export const dynamic = 'force-dynamic';

const STATUS_ORDER: QuoteStatus[] = ['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'];

/** Visible below md only, where a row is laid out as a card. */
function CardLabel({ children }: { children: ReactNode }) {
  return <span className="block text-xs text-fg-3 md:hidden">{children}</span>;
}

export default async function QuotationsPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const ctx = page.ctx;
  const quotes = await listQuotes(ctx, {});
  const canCreate = hasCapability(ctx, 'quotes.edit');
  const counts = new Map<QuoteStatus, number>();
  for (const q of quotes) counts.set(q.effectiveStatus, (counts.get(q.effectiveStatus) ?? 0) + 1);
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

      {quotes.length === 0 ? (
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
            <ul aria-label="Quotations by status" className="flex flex-wrap items-center gap-2">
              {STATUS_ORDER.filter((s) => counts.has(s)).map((s) => {
                const entry = QUOTE_STATUS_VOCABULARY[s];
                const Icon = entry.icon;
                return (
                  <li key={s} className={cn('inline-flex items-center gap-1.5 rounded-full border py-1 pr-1 pl-2.5 text-xs font-medium', TONE_CLASSES[entry.tone])}>
                    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                    {entry.label}
                    <span className="tabular rounded-full bg-bg-0/50 px-1.5 py-px text-fg-1">{counts.get(s)}</span>
                  </li>
                );
              })}
              <li className="text-xs text-fg-2">
                {quotes.length} {quotes.length === 1 ? 'quotation' : 'quotations'}
                {capped ? ' in this list (the latest)' : ''}
              </li>
            </ul>
          </Reveal>

          <Reveal variant="fade" delay={0.12} className="relative min-w-0 rounded-xl border border-border-subtle bg-bg-1/80 max-md:border-0 max-md:bg-transparent">
            <div className="relative md:overflow-x-auto">
              <table className="w-full text-left text-sm md:min-w-[44rem]">
                <caption className="sr-only">Quotations, newest activity first{capped ? `, the latest ${QUOTE_LIST_LIMIT}` : ''}</caption>
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
