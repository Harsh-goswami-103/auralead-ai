/**
 * New quotation (T15; "new from proposal"): pick a lead; when the lead has an AI draft with a
 * quote proposal, the editor starts from its services, quantities, scope and timeline and the
 * quote carries the draft's policy flags to the approver. Prices are never taken from the draft:
 * the server prices v1 from the active price list when it is saved. The lead choice is a plain GET
 * form (`?leadId=`), so the page works without client script for that step.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
import type { Gate } from '@/components/patterns/GatedAction';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { getNewQuoteSources, getQuoteEditorCatalog, serializeCatalog } from '@/server/services/quotes/versioning';
import { QuoteEditor } from '../quote-editor';

export const metadata: Metadata = { title: 'New quotation' };
export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);

export default async function NewQuotationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const page = await getPageContext();
  if (!page) redirect('/login');
  const ctx = page.ctx;
  const sources = await getNewQuoteSources(ctx, { leadId: one(query.leadId), draftId: one(query.draftId) });
  const catalog = await getQuoteEditorCatalog(ctx);
  const gate: Gate | null = hasCapability(ctx, 'quotes.edit') ? null : { category: 'permission', reason: 'Your role cannot create quotations in this workspace.' };
  const lead = sources.leads.find((l) => l.id === sources.selectedLeadId) ?? null;
  const draft = sources.draft;
  const known = new Set(catalog.services.map((s) => s.id));

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/user/quotations" className="inline-flex w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1">
        <ArrowLeft aria-hidden="true" className="size-4" />
        All quotations
      </Link>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Quotations</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">New quotation</h1>
        <p className="max-w-prose text-fg-2">It starts as a draft (v1). Prices come from your price list; the quote is approved before it can be sent.</p>
      </header>

      {catalog.activePricingVersion === null || catalog.services.length === 0 ? (
        <EmptyState
          title="No price list yet"
          description="Quotations take their prices from your price list. Add services under Pricing first."
          action={
            <Link href="/dashboard/user/pricing" className={buttonVariants({ variant: 'outline' })}>
              Open Pricing
            </Link>
          }
        />
      ) : sources.leads.length === 0 ? (
        <EmptyState title="No leads to quote" description="Quotations are made for a lead. Leads appear here once they arrive from your sources." />
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-64 flex-1 flex-col gap-1.5">
              <label htmlFor="new-quote-lead" className="text-sm font-medium text-fg-1">
                Lead
              </label>
              <select
                id="new-quote-lead"
                name="leadId"
                defaultValue={sources.selectedLeadId ?? ''}
                className="h-9 w-full rounded-md border border-input bg-input/30 px-3 text-sm text-fg-1 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">Choose a lead</option>
                {sources.leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.displayName}
                    {l.city ? `, ${l.city}` : ''}
                    {l.category ? ` (${l.category})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="outline">
              Use this lead
            </Button>
          </form>

          {lead ? (
            <section aria-labelledby="editor-heading" className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-bg-1 p-4">
              <h2 id="editor-heading" className="text-lg font-semibold text-fg-1">
                Quotation for {lead.displayName}
              </h2>
              {draft ? (
                <p className="text-sm text-fg-2">
                  Started from the proposal in the draft of {formatDateTime(draft.createdAt)} ({draft.generatorLabel}
                  {draft.status === 'NEEDS_REVIEW' ? ', needs review' : ''}). Check every line; prices are set by the server.
                  {draft.items.some((i) => !known.has(i.serviceId)) ? ' Services no longer in the price list were left out.' : ''}
                </p>
              ) : (
                <p className="text-sm text-fg-2">This lead has no AI proposal. Choose services from your price list.</p>
              )}
              <QuoteEditor
                catalog={serializeCatalog(catalog)}
                mode={{ kind: 'create', leadId: lead.id, draftId: draft?.id ?? null }}
                initial={{
                  items: (draft?.items ?? []).filter((i) => known.has(i.serviceId)),
                  discountKind: 'NONE',
                  discountValue: '0',
                  scopeText: draft?.scopeText ?? '',
                  timelineText: draft?.timelineText ?? '',
                  validityDays: null,
                }}
                gate={gate}
                submitLabel="Create draft quotation"
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
