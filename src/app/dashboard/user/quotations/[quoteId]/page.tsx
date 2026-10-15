/**
 * Client quotation detail (T15; 06-design "Quotation detail"): the current version exactly as
 * persisted (lines, discount, tax, totals, scope, timeline, validity), what the approver must know
 * (pricing review reasons, AI policy flags), the actions the state machine allows (approve, revise,
 * cancel), every earlier version, the approval rows, the share links (state only, never tokens)
 * and the state timeline from the quote's audit trail. A quote of another workspace is 404.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { NotFoundError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { bpsToPercentString } from '@/lib/schemas/pricing';
import { getPageContext } from '@/server/auth/page-context';
import { getQuoteDetail, getQuoteEditorCatalog, serializeCatalog, type QuoteDetail } from '@/server/services/quotes/versioning';
import { QuoteActions } from '../quote-actions';
import { QuoteStatusBadge } from '../quote-status';

export const metadata: Metadata = { title: 'Quotation' };
export const dynamic = 'force-dynamic';

const ACTION_LABELS: Record<string, string> = {
  'quote.create': 'Created as a draft',
  'quote.revise': 'New version saved',
  'quote.approve': 'Approved',
  'quote.cancel': 'Cancelled',
  'quote.expire': 'Expired (validity date passed)',
  'quote.share.create': 'Share link created',
  'quote.share.revoke': 'Share link revoked',
};

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
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="sr-only">Services in version {version.versionNo}</caption>
          <thead className="text-xs text-fg-2">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">Service</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Qty</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Unit price</th>
              <th scope="col" className="py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {version.items.map((i) => (
              <tr key={i.id} className="border-t border-border-subtle">
                <td className="py-1.5 pr-3 text-fg-1">{i.serviceNameSnapshot}</td>
                <td className="py-1.5 pr-3 text-right tabular text-fg-1">
                  {i.qty} {i.unitLabel}
                </td>
                <td className="py-1.5 pr-3 text-right tabular text-fg-2">{formatINR(i.unitPricePaise)}</td>
                <td className="py-1.5 text-right tabular text-fg-1">{formatINR(i.lineTotalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
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
        <dt className="font-semibold text-fg-1">Total</dt>
        <dd className="text-right font-semibold tabular text-fg-1">{formatINR(version.totalPaise)}</dd>
      </dl>
      <p className="text-xs text-fg-2">
        Priced from price list v{(version.snapshot as { pricingVersion?: number } | null)?.pricingVersion ?? '?'} · valid until {formatDate(version.validUntil, tz)}
        {version.sentAt ? ` · sent ${formatDateTime(version.sentAt, tz)}` : ''}
      </p>
    </div>
  );
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
  const tz = detail.workspace.timezone;
  const current = detail.versions[0]!;
  const reasons = Array.isArray(current.reviewReasons) ? current.reviewReasons : [];
  const flags = strings(current.aiPolicyFlags);
  const pricingVersionNo = (current.snapshot as { pricingVersion?: number } | null)?.pricingVersion ?? null;
  const validityPassed = page.ctx.clock.now().getTime() >= current.validUntil.getTime();

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/user/quotations" className="inline-flex w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1">
        <ArrowLeft aria-hidden="true" className="size-4" />
        All quotations
      </Link>
      <header className="flex flex-col gap-2">
        <p className="text-sm text-fg-2">
          Quotation for {detail.lead.displayName}
          {detail.lead.city ? `, ${detail.lead.city}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">
            {detail.quote.number} <span className="text-fg-2">v{detail.quote.currentVersionNo}</span>
          </h1>
          <QuoteStatusBadge status={detail.effectiveStatus} showDetail />
        </div>
      </header>

      {reasons.length > 0 || flags.length > 0 ? (
        <section aria-labelledby="review-heading" className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <h2 id="review-heading" className="flex items-center gap-2 text-sm font-semibold text-fg-1">
            <ShieldAlert aria-hidden="true" className="size-4 text-warning" />
            {detail.quote.needsPricingReview ? 'Needs pricing review before approval' : 'Check before approving'}
          </h2>
          <ul className="list-disc pl-5 text-sm text-fg-1">
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

      <section aria-labelledby="current-heading" className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-bg-1 p-4">
        <h2 id="current-heading" className="text-lg font-semibold text-fg-1">
          Version {current.versionNo}
        </h2>
        <VersionLines version={current} tz={tz} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-fg-2">Scope of work</h3>
            <p className="whitespace-pre-line text-fg-1">{current.scopeText}</p>
          </div>
          <div>
            <h3 className="text-sm font-medium text-fg-2">Timeline</h3>
            <p className="text-fg-1">{current.timelineText}</p>
          </div>
        </div>
      </section>

      {detail.versions.length > 1 ? (
        <section aria-labelledby="history-heading" className="flex flex-col gap-2">
          <h2 id="history-heading" className="text-lg font-semibold text-fg-1">
            Earlier versions
          </h2>
          {detail.versions.slice(1).map((v) => (
            <details key={v.id} className="rounded-lg border border-border-subtle bg-bg-1 p-3">
              <summary className="cursor-pointer text-sm text-fg-1">
                v{v.versionNo} · {formatINR(v.totalPaise)} · {formatDateTime(v.createdAt, tz)}
                {v.createdByName ? ` by ${v.createdByName}` : ''}
              </summary>
              <div className="mt-3">
                <VersionLines version={v} tz={tz} />
              </div>
            </details>
          ))}
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="timeline-heading" className="flex flex-col gap-2">
          <h2 id="timeline-heading" className="text-lg font-semibold text-fg-1">
            Timeline
          </h2>
          <ol className="flex flex-col gap-2 border-l border-border-strong pl-4">
            {detail.timeline.map((t) => {
              const summary = (t.summary ?? {}) as { versionNo?: number };
              return (
                <li key={t.id} className="text-sm">
                  <span className="text-fg-1">
                    {ACTION_LABELS[t.action] ?? t.action}
                    {typeof summary.versionNo === 'number' ? ` (v${summary.versionNo})` : ''}
                  </span>
                  <span className="block text-xs text-fg-2">
                    {formatDateTime(t.createdAt, tz)} · {t.actorName ?? (t.actorKind === 'WORKER' ? 'Scheduled job' : t.actorKind.toLowerCase())}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-labelledby="approvals-heading" className="flex flex-col gap-2">
          <h2 id="approvals-heading" className="text-lg font-semibold text-fg-1">
            Approvals and links
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {detail.approvals.map((a) => {
              const v = detail.versions.find((x) => x.id === a.quoteVersionId);
              return (
                <li key={a.id} className="text-fg-1">
                  v{v?.versionNo ?? '?'}: {a.status === 'PENDING' ? 'waiting for approval' : a.status === 'APPROVED' ? `approved${a.decidedByName ? ` by ${a.decidedByName}` : ''}` : a.status === 'INVALIDATED' ? `withdrawn (${a.invalidationReason === 'QUOTE_CANCELLED' ? 'quote cancelled' : 'quote changed'})` : a.status.toLowerCase()}
                </li>
              );
            })}
          </ul>
          {detail.shares.length === 0 ? (
            <p className="text-sm text-fg-2">No share links yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {detail.shares.map((s) => (
                <li key={s.id} className="text-fg-1">
                  Link created {formatDateTime(s.createdAt, tz)}:{' '}
                  {s.revokedAt ? 'revoked' : s.supersededAt ? 'replaced by a newer version' : page.ctx.clock.now() >= s.expiresAt ? 'expired' : `active until ${formatDate(s.expiresAt, tz)}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
