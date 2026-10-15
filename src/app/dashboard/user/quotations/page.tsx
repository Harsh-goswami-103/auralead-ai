/**
 * Client Quotations list (T15; 06-design "User Quotations"): every quotation of the workspace,
 * newest activity first, with the status a reader should see (an approved or sent quote past its
 * validity reads Expired before the sweep runs), the current version, its persisted total and the
 * validity date. Read on the server through the tenant-scoped context. Filters are T27's.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FilePlus2 } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
import { buttonVariants } from '@/components/ui/button';
import { formatDate } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { listQuotes, QUOTE_LIST_LIMIT } from '@/server/services/quotes/versioning';
import { QuoteStatusBadge } from './quote-status';

export const metadata: Metadata = { title: 'Quotations' };
export const dynamic = 'force-dynamic';

export default async function QuotationsPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const ctx = page.ctx;
  const quotes = await listQuotes(ctx, {});
  const canCreate = hasCapability(ctx, 'quotes.edit');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-fg-2">Quotations</p>
          <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Quotes and their versions</h1>
          <p className="max-w-prose text-fg-2">Each version keeps the prices it was issued with. Editing an approved quote creates a new version that needs approval again.</p>
        </div>
        {canCreate ? (
          <Link href="/dashboard/user/quotations/new" className={buttonVariants()}>
            <FilePlus2 aria-hidden="true" />
            New quotation
          </Link>
        ) : null}
      </header>

      {quotes.length === 0 ? (
        <EmptyState
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
        <div className="overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Quotations, newest activity first{quotes.length === QUOTE_LIST_LIMIT ? `, the latest ${QUOTE_LIST_LIMIT}` : ''}</caption>
            <thead className="bg-bg-2 text-xs text-fg-2">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Quote</th>
                <th scope="col" className="px-3 py-2 font-medium">Lead</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
                <th scope="col" className="px-3 py-2 font-medium">Valid until</th>
                <th scope="col" className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2">
                    <Link href={`/dashboard/user/quotations/${q.id}`} className="font-medium text-cyan underline-offset-4 hover:underline">
                      {q.number}
                    </Link>
                    <span className="ml-2 text-xs text-fg-2">v{q.currentVersionNo}</span>
                  </td>
                  <td className="px-3 py-2 text-fg-1">{q.lead.displayName}</td>
                  <td className="px-3 py-2">
                    <QuoteStatusBadge status={q.effectiveStatus} />
                    {q.needsPricingReview ? <span className="mt-1 block text-xs text-warning">Needs pricing review</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-1 tabular">{q.totalPaise === null ? '' : formatINR(q.totalPaise)}</td>
                  <td className="px-3 py-2 text-fg-2">{q.validUntil ? formatDate(q.validUntil) : ''}</td>
                  <td className="px-3 py-2 text-fg-2">{formatDate(q.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
