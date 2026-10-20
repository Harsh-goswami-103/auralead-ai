/**
 * New quotation (T15; "new from proposal"): pick a lead; when the lead has an AI draft with a
 * quote proposal, the editor starts from its services, quantities, scope and timeline and the
 * quote carries the draft's policy flags to the approver. Prices are never taken from the draft:
 * the server prices v1 from the active price list when it is saved. The lead choice is a plain GET
 * form (`?leadId=`), so the page works without client script for that step.
 *
 * Aurora look (design spec §6): PageHeader, then two numbered steps as section cards (choose the
 * lead, then the quotation itself). The draft's generator is named in words, never by its id.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, FileText, Sparkles, Tags, UserRound, Users } from 'lucide-react';
import { ChipTitle } from '@/components/patterns/IconChip';
import { generatorLabel } from '@/components/client/labels';
import { EmptyState } from '@/components/patterns/EmptyState';
import type { Gate } from '@/components/patterns/GatedAction';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Reveal } from '@/components/visual/Reveal';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { getNewQuoteSources, getQuoteEditorCatalog, serializeCatalog } from '@/server/services/quotes/versioning';
import { QuoteEditor } from '../quote-editor';

export const metadata: Metadata = { title: 'New quotation' };
export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);

function StepMeta({ step }: { step: number }) {
  return <span className="font-medium tracking-[0.12em] text-fg-3 uppercase">Step {step} of 2</span>;
}

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
      <Link href="/dashboard/user/quotations" className="group inline-flex min-h-11 w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1 lg:min-h-9">
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        All quotations
      </Link>
      <PageHeader
        eyebrow="Quotations"
        title="New quotation"
        description="It starts as a draft (v1). Prices come from your price list; the quote is approved before it can be sent."
      />

      {catalog.activePricingVersion === null || catalog.services.length === 0 ? (
        <EmptyState
          icon={<Tags aria-hidden="true" className="size-5" />}
          title="No price list yet"
          description="Quotations take their prices from your price list. Add services under Pricing first."
          action={
            <Link href="/dashboard/user/pricing" className={buttonVariants({ variant: 'outline' })}>
              Open Pricing
            </Link>
          }
        />
      ) : sources.leads.length === 0 ? (
        <EmptyState icon={<Users aria-hidden="true" className="size-5" />} title="No leads to quote" description="Quotations are made for a lead. Leads appear here once they arrive from your sources." />
      ) : (
        <>
          <Reveal delay={0.12}>
            <SectionCard title={<ChipTitle icon={<UserRound aria-hidden="true" />}>Choose who it is for</ChipTitle>} meta={<StepMeta step={1} />}>
              <form method="get" className="flex max-w-2xl flex-wrap items-end gap-2">
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
                  <label htmlFor="new-quote-lead" className="text-sm font-medium text-fg-1">
                    Lead
                  </label>
                  <NativeSelect id="new-quote-lead" name="leadId" defaultValue={sources.selectedLeadId ?? ''} wrapperClassName="w-full">
                    <option value="">Choose a lead</option>
                    {sources.leads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.displayName}
                        {l.city ? `, ${l.city}` : ''}
                        {l.category ? ` (${l.category})` : ''}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <Button type="submit" variant="outline">
                  Use this lead
                </Button>
              </form>
            </SectionCard>
          </Reveal>

          {lead ? (
            <Reveal delay={0.18}>
              <SectionCard accent title={<ChipTitle icon={<FileText aria-hidden="true" />} hue="volt">{`Quotation for ${lead.displayName}`}</ChipTitle>} meta={<StepMeta step={2} />}>
                {draft ? (
                  <p className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2 text-sm text-fg-2">
                    <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-panel" />
                    <span>
                      Started from the proposal in the draft of {formatDateTime(draft.createdAt)} ({generatorLabel(draft.generatorLabel)}
                      {draft.status === 'NEEDS_REVIEW' ? ', needs review' : ''}). Check every line; prices are set by the server.
                      {draft.items.some((i) => !known.has(i.serviceId)) ? ' Services no longer in the price list were left out.' : ''}
                    </span>
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
              </SectionCard>
            </Reveal>
          ) : null}
        </>
      )}
    </div>
  );
}
