/**
 * Client quotation detail (T15; 06-design "Quotation detail"): the current version exactly as
 * persisted (lines, discount, tax, totals, scope, timeline, validity), what the approver must know
 * (pricing review reasons, AI policy flags), the actions the state machine allows (approve, revise,
 * cancel), every earlier version, the approval rows, the share links (state only, never tokens)
 * and the state timeline from the quote's audit trail. A quote of another workspace is 404.
 *
 * Aurora look (design spec §6-§7): PageHeader (quote number as the gradient h1, the status chip
 * first in DOM order so it stays the first [data-quote-status]), the version on the left with a
 * neutral totals panel (money is never colored) and line items that stack below sm, and on the
 * right the share panel, the status history (T27: one step per status change with how long the
 * quote stayed in it, derived from the same audit rows), the colored timeline rail (every audit
 * code has a label) and approvals as icon pills. The actions (and the revise editor they open) sit above both columns, so the
 * version and the share card start on the same line.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, CalendarClock, CircleCheck, Clock, FileStack, History, ListChecks, ListOrdered, ScrollText, Send, ShieldAlert, Tags, Timer, Undo2, type LucideIcon } from 'lucide-react';
import { ChipTitle } from '@/components/patterns/IconChip';
import { humanize } from '@/components/client/labels';
import { QuoteTimeline } from '@/components/client/QuoteTimeline';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { TONE_CLASSES, type StatusTone } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { NotFoundError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { bpsToPercentString } from '@/lib/schemas/pricing';
import { getPageContext } from '@/server/auth/page-context';
import { getQuoteDetail, getQuoteEditorCatalog, serializeCatalog, type QuoteDetail } from '@/server/services/quotes/versioning';
import { QuoteSharePanel } from '@/components/approvals/QuoteSharePanel';
import { loadQuoteShareEvidence } from '@/server/services/quotes/manual-send';
import { QuoteActions } from '../quote-actions';
import { QUOTE_STATUS_VOCABULARY, QuoteStatusBadge } from '../quote-status';
import { deriveStatusHistory, QuoteStatusHistory } from '../status-history';

export const metadata: Metadata = { title: 'Quotation' };
export const dynamic = 'force-dynamic';

const FLAG_LABELS: Record<string, string> = {
  ai_price_ignored: 'The AI proposal tried to set a price; the server price list was used.',
  ai_discount_ignored: 'The AI proposal tried to set a discount; it was ignored.',
  ai_tax_ignored: 'The AI proposal tried to set tax; it was ignored.',
  ai_recipient_ignored: 'The AI proposal named a recipient; it was ignored.',
  ai_policy_violation: 'Some AI text broke the output policy and was not kept.',
};

function reasonText(reason: unknown): string {
  const r = (reason ?? {}) as { code?: string; source?: string };
  switch (r.code) {
    case 'PRICE_MISSING':
      return 'A service has no price in this price list; it is left out of the totals.';
    case 'SERVICE_ARCHIVED':
      return 'A service was archived; it is left out of the totals.';
    case 'TOTAL_ABOVE_SANITY_CAP':
      return 'The total is above the ₹100 crore check.';
    case 'UNKNOWN_SERVICE':
      return 'The AI proposal named a service that is not in the catalog; it was dropped.';
    case 'QTY_OUT_OF_BOUNDS':
      return 'The AI proposal asked for a quantity outside the allowed range; that line was dropped.';
    case 'DUPLICATE_SERVICE':
      return 'The AI proposal listed a service twice; the repeat was dropped.';
    case 'NO_ITEMS':
      return 'The AI proposal had no usable services.';
    default:
      return 'Review needed.';
  }
}

function discountLabel(kind: string, value: bigint): string {
  if (kind === 'PERCENT_BPS') return `Discount (${bpsToPercentString(Number(value))}%)`;
  if (kind === 'FLAT_PAISE') return 'Discount (flat)';
  return 'Discount';
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function VersionLines({ version, tz }: { version: QuoteDetail['versions'][number]; tz: string }) {
  const pricingVersion = (version.snapshot as { pricingVersion?: number } | null)?.pricingVersion;
  return (
    <div className="flex flex-col gap-4">
      <div className="relative sm:overflow-x-auto">
        <table className="w-full text-left text-sm sm:min-w-[32rem]">
          <caption className="sr-only">Services in version {version.versionNo}</caption>
          <thead className="text-xs text-fg-2 max-sm:sr-only">
            <tr className="border-b border-border-subtle">
              <th scope="col" className="py-2 pr-3 font-medium">
                Service
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Unit price
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {version.items.map((i) => (
              <tr key={i.id} className="border-b border-border-subtle last:border-b-0 max-sm:grid max-sm:grid-cols-[auto_auto_minmax(0,1fr)] max-sm:gap-x-1.5 max-sm:gap-y-0.5 max-sm:py-2.5">
                <td className="py-2.5 pr-3 font-medium text-fg-1 max-sm:col-span-3 max-sm:p-0">{i.serviceNameSnapshot}</td>
                <td className="py-2.5 pr-3 text-right tabular text-fg-1 max-sm:p-0 max-sm:text-left max-sm:text-xs max-sm:text-fg-2">
                  {i.qty} {i.unitLabel}
                </td>
                <td className="py-2.5 pr-3 text-right tabular text-fg-2 max-sm:p-0 max-sm:text-left max-sm:text-xs max-sm:before:content-['×_']">{formatINR(i.unitPricePaise)}</td>
                <td className="py-2.5 text-right tabular font-medium text-fg-1 max-sm:p-0">{formatINR(i.lineTotalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-end sm:justify-between">
        <dl className="grid w-full grid-cols-[1fr_auto] gap-y-1.5 rounded-lg [&>dt]:pr-4 border border-border-subtle bg-bg-2/50 p-4 text-sm sm:max-w-sm sm:shrink-0">
          <dt className="text-fg-2">Subtotal</dt>
          <dd className="text-right tabular text-fg-1">{formatINR(version.subtotalPaise)}</dd>
          {version.discountKind !== 'NONE' ? (
            <>
              <dt className="text-fg-2">{discountLabel(version.discountKind, version.discountValue)}</dt>
              <dd className="text-right tabular text-fg-1">-{formatINR(version.discountPaise)}</dd>
            </>
          ) : null}
          {version.taxBps !== null ? (
            <>
              <dt className="text-fg-2">
                {version.taxLabel ?? 'Tax'} ({bpsToPercentString(version.taxBps)}%)
              </dt>
              <dd className="text-right tabular text-fg-1">{formatINR(version.taxPaise)}</dd>
            </>
          ) : (
            <>
              <dt className="text-fg-2">Tax</dt>
              <dd className="text-right text-fg-2">Not charged</dd>
            </>
          )}
          <dt className="mt-1.5 border-t border-border-strong pt-2.5 font-display text-base font-semibold text-fg-1">Total</dt>
          <dd className="mt-1.5 border-t border-border-strong pt-2.5 text-right font-display text-lg font-semibold tabular text-fg-1">{formatINR(version.totalPaise)}</dd>
        </dl>
        <ul className="flex flex-col gap-1.5 text-xs text-fg-2 sm:pb-1">
          <li className="flex items-center gap-1.5">
            <Tags aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
            {typeof pricingVersion === 'number' ? `Priced from price list v${pricingVersion}` : 'Priced from an earlier price list'}
          </li>
          <li className="flex items-center gap-1.5">
            <CalendarClock aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
            Valid until {formatDate(version.validUntil, tz)}
          </li>
          {version.sentAt ? (
            <li className="flex items-center gap-1.5">
              <Send aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
              Sent {formatDateTime(version.sentAt, tz)}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function approvalLine(a: QuoteDetail['approvals'][number]): { text: string; tone: StatusTone; icon: LucideIcon } {
  if (a.status === 'PENDING') return { text: 'waiting for approval', tone: 'warning', icon: Clock };
  if (a.status === 'APPROVED') return { text: `approved${a.decidedByName ? ` by ${a.decidedByName}` : ''}`, tone: 'success', icon: CircleCheck };
  if (a.status === 'INVALIDATED') return { text: `withdrawn (${a.invalidationReason === 'QUOTE_CANCELLED' ? 'quote cancelled' : 'quote changed'})`, tone: 'neutral', icon: Undo2 };
  return { text: a.status.toLowerCase(), tone: 'neutral', icon: History };
}

export default async function QuotationDetailPage({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params;
  const page = await getPageContext();
  if (!page) redirect('/login');
  let detail: QuoteDetail;
  try {
    detail = await getQuoteDetail(page.ctx, quoteId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const catalog = await getQuoteEditorCatalog(page.ctx);
  const evidence = await loadQuoteShareEvidence(page.ctx, quoteId);
  const tz = detail.workspace.timezone;
  const current = detail.versions[0]!;
  const reasons = Array.isArray(current.reviewReasons) ? current.reviewReasons : [];
  const flags = strings(current.aiPolicyFlags);
  const pricingVersionNo = (current.snapshot as { pricingVersion?: number } | null)?.pricingVersion ?? null;
  const validityPassed = page.ctx.clock.now().getTime() >= current.validUntil.getTime();

  const statusEntry = QUOTE_STATUS_VOCABULARY[detail.effectiveStatus];
  const whoOf = (t: QuoteDetail['timeline'][number]) => t.actorName ?? (t.actorKind === 'WORKER' ? 'Scheduled job' : t.actorKind === 'PUBLIC' ? 'Customer (quote page)' : humanize(t.actorKind));
  const versionOf = (t: QuoteDetail['timeline'][number]) => {
    const summary = (t.summary ?? {}) as { versionNo?: number };
    return typeof summary.versionNo === 'number' ? summary.versionNo : null;
  };
  const statusSteps = deriveStatusHistory(
    detail.timeline.map((t) => ({ id: t.id, action: t.action, createdAt: t.createdAt, who: whoOf(t), versionNo: versionOf(t) })),
    { effectiveStatus: detail.effectiveStatus, validUntil: detail.quote.validUntil, now: page.ctx.clock.now() },
  );

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/user/quotations" className="group inline-flex min-h-11 w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1 lg:min-h-9">
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        All quotations
      </Link>
      <PageHeader
        eyebrow="Quotation"
        title={detail.quote.number}
        description={
          <span className="flex flex-col gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <QuoteStatusBadge status={detail.effectiveStatus} size="md" />
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-bg-2 px-2.5 py-1 text-sm font-medium text-fg-1">
                <FileStack aria-hidden="true" className="size-4 text-panel" />v{detail.quote.currentVersionNo}
              </span>
              <span className="text-fg-1">
                for {detail.lead.displayName}
                {detail.lead.city ? `, ${detail.lead.city}` : ''}
              </span>
            </span>
            <span className="text-sm text-fg-2">{statusEntry.detail}</span>
          </span>
        }
      />

      {reasons.length > 0 || flags.length > 0 ? (
        <section aria-labelledby="review-heading" className="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-warning/35 bg-warning/8 p-4 pl-5 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-warning">
          <h2 id="review-heading" className="flex items-center gap-2 text-sm font-semibold text-fg-1">
            <ShieldAlert aria-hidden="true" className="size-4 text-warning" />
            {detail.quote.needsPricingReview ? 'Needs pricing review before approval' : 'Check before approving'}
          </h2>
          <ul className="list-disc pl-5 text-sm text-fg-1 marker:text-warning">
            {reasons.map((r, i) => (
              <li key={`r${i}`}>{reasonText(r)}</li>
            ))}
            {flags.map((f) => (
              <li key={f}>{FLAG_LABELS[f] ?? f}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <QuoteActions
        quoteId={detail.quote.id}
        number={detail.quote.number}
        workspaceName={detail.workspace.name}
        status={detail.quote.status}
        effectiveStatus={detail.effectiveStatus}
        versionNo={detail.quote.currentVersionNo}
        pricingVersionId={current.pricingVersionId}
        pricingVersionNo={pricingVersionNo}
        needsPricingReview={detail.quote.needsPricingReview}
        validityPassed={validityPassed}
        permissions={detail.permissions}
        catalog={serializeCatalog(catalog)}
        editorInitial={{
          items: current.items.map((i) => ({ serviceId: i.serviceId, qty: i.qty, name: i.serviceNameSnapshot, unitLabel: i.unitLabel })),
          discountKind: current.discountKind,
          discountValue: current.discountValue.toString(),
          scopeText: current.scopeText,
          timelineText: current.timelineText,
          validityDays: null,
        }}
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard accent title={<ChipTitle icon={<FileStack aria-hidden="true" />}>{`Version ${current.versionNo}`}</ChipTitle>} meta={`Created ${formatDateTime(current.createdAt, tz)}${current.createdByName ? ` by ${current.createdByName}` : ''}`}>
            <VersionLines version={current} tz={tz} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-2/40 p-3">
                <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">
                  <ScrollText aria-hidden="true" className="size-3.5 text-panel" />
                  Scope of work
                </h3>
                <p className="text-sm whitespace-pre-line text-fg-1">{current.scopeText}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-2/40 p-3">
                <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">
                  <Timer aria-hidden="true" className="size-3.5 text-panel" />
                  Timeline
                </h3>
                <p className="text-sm text-fg-1">{current.timelineText}</p>
              </div>
            </div>
          </SectionCard>

          {detail.versions.length > 1 ? (
            <SectionCard title={<ChipTitle icon={<History aria-hidden="true" />} hue="volt">Earlier versions</ChipTitle>}>
              <div className="flex flex-col gap-2">
                {detail.versions.slice(1).map((v) => (
                  <details key={v.id} className="group rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2.5 open:border-border-strong">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-1">
                      <span className="rounded-full border border-border-strong bg-bg-2 px-2 py-px text-xs font-medium">v{v.versionNo}</span>
                      <span className="tabular font-medium">{formatINR(v.totalPaise)}</span>
                      <span className="text-xs text-fg-2">
                        {formatDateTime(v.createdAt, tz)}
                        {v.createdByName ? ` by ${v.createdByName}` : ''}
                      </span>
                    </summary>
                    <div className="mt-3">
                      <VersionLines version={v} tz={tz} />
                    </div>
                  </details>
                ))}
              </div>
            </SectionCard>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <QuoteSharePanel
            quoteId={detail.quote.id}
            number={detail.quote.number}
            versionNo={detail.quote.currentVersionNo}
            status={detail.effectiveStatus}
            sentVia={detail.quote.sentVia}
            timeZone={tz}
            shares={detail.shares.map((s) => ({
              id: s.id,
              state: s.revokedAt ? 'REVOKED' : s.supersededAt ? 'SUPERSEDED' : page.ctx.clock.now() >= s.expiresAt ? 'EXPIRED' : 'ACTIVE',
              expiresAt: s.expiresAt.toISOString(),
              createdAt: s.createdAt.toISOString(),
            }))}
            evidence={{ ...evidence, lastOpenAt: evidence.lastOpenAt?.toISOString() ?? null }}
            canShare={detail.permissions.canShare}
          />

          <SectionCard title={<ChipTitle icon={<ListOrdered aria-hidden="true" />} hue="zest">Status history</ChipTitle>} meta="Each status the quotation reached, and for how long.">
            <QuoteStatusHistory steps={statusSteps} timeZone={tz} />
          </SectionCard>

          <SectionCard title={<ChipTitle icon={<History aria-hidden="true" />} hue="volt">Timeline</ChipTitle>}>
            <QuoteTimeline
              items={detail.timeline.map((t) => ({
                id: t.id,
                action: t.action,
                versionNo: versionOf(t),
                when: formatDateTime(t.createdAt, tz),
                who: whoOf(t),
              }))}
            />
          </SectionCard>

          <SectionCard title={<ChipTitle icon={<ListChecks aria-hidden="true" />} hue="zest">Approvals</ChipTitle>}>
            {detail.approvals.length === 0 ? (
              <p className="text-sm text-fg-2">No approval requested yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {detail.approvals.map((a) => {
                  const v = detail.versions.find((x) => x.id === a.quoteVersionId);
                  const line = approvalLine(a);
                  const Icon = line.icon;
                  return (
                    <li key={a.id} className="flex items-center gap-2.5 text-fg-1">
                      <span aria-hidden="true" className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border', TONE_CLASSES[line.tone])}>
                        <Icon className="size-3.5" />
                      </span>
                      <span>
                        v{v?.versionNo ?? '?'}: {line.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
