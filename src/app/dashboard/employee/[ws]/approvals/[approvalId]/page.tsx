/**
 * One approval item (T22; 06-design §11.2 "Approvals" second and third fold, F18). Shows what is
 * being approved exactly as stored (the quotation version's lines and totals, or the message text),
 * the diff against the previous version, the pricing checks and flags, each channel with the shared
 * eligibility result, and the dispatch history. Actions: approve (the version on screen),
 * approve-and-send, reject, and edit within the employee's own pricing permissions. A stale tab gets
 * "This item changed since you opened it". Another workspace's item is 404. The page re-reads itself
 * while the PDF is being prepared or a send is in flight.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { ApprovalActions } from '@/components/approvals/ApprovalActions';
import { ApprovalEditor } from '@/components/approvals/ApprovalEditor';
import { flagLabel } from '@/components/approvals/QueueList';
import { VersionDiff } from '@/components/approvals/VersionDiff';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { formatShortDateTime } from '@/components/inbox/format';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { NotFoundError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { getApprovalItem, type ApprovalItemDetail } from '@/server/services/approvals/queue';
import { inboxDepsFromConfig } from '@/server/services/messaging/inbox';
import { getQuoteEditorCatalog, serializeCatalog } from '@/server/services/quotes/versioning';

export const metadata: Metadata = { title: 'Approval' };
export const dynamic = 'force-dynamic';

const STATUS_WORDS: Record<string, string> = { PENDING: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Rejected', INVALIDATED: 'Withdrawn (the quotation changed)' };
const DISPATCH_WORDS: Record<string, string> = { QUEUED: 'Queued', SENDING: 'Sending', SENT: 'Sent', FAILED: 'Failed', SKIPPED: 'Blocked before sending', AMBIGUOUS: 'Delivery unknown (not retried automatically)', CANCELLED: 'Cancelled' };

function reviewText(reason: unknown): string {
  const code = (reason as { code?: string } | null)?.code;
  switch (code) {
    case 'PRICE_MISSING':
      return 'A service has no price in this price list.';
    case 'SERVICE_ARCHIVED':
      return 'A service was archived.';
    case 'TOTAL_ABOVE_SANITY_CAP':
      return 'The total is above the ₹100 crore check.';
    case 'UNKNOWN_SERVICE':
      return 'The AI proposal named a service outside the catalog; it was dropped.';
    case 'QTY_OUT_OF_BOUNDS':
      return 'The AI proposal asked for a quantity outside the allowed range.';
    case 'DUPLICATE_SERVICE':
      return 'The AI proposal listed a service twice.';
    case 'NO_ITEMS':
      return 'The AI proposal had no usable services.';
    default:
      return 'Review needed.';
  }
}

export default async function ApprovalItemPage({ params }: { params: Promise<{ ws: string; approvalId: string }> }) {
  const { ws, approvalId } = await params;
  let page;
  try {
    page = await getPageContext({ workspaceSlug: ws });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();
  let detail: ApprovalItemDetail;
  try {
    detail = await getApprovalItem(page.ctx, approvalId, inboxDepsFromConfig(getRuntime().config));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { item, version } = detail;
  const tz = detail.workspace.timezone;
  const catalog = item.quote && detail.permissions.canEdit ? serializeCatalog(await getQuoteEditorCatalog(page.ctx)) : null;
  const inFlight = (item.quote !== null && !item.quote.pdfReady) || detail.attempts.some((a) => a.state === 'QUEUED' || a.state === 'SENDING');
  const flags = item.flags.map(flagLabel).filter((f): f is string => f !== null);
  const reviewReasons = Array.isArray(version?.reviewReasons) ? version.reviewReasons : [];
  const title = item.quote ? `${item.quote.number} v${item.quote.versionNo}` : item.message?.channel === 'EMAIL' ? 'Email draft' : 'WhatsApp draft';
  const queueHref = `/dashboard/employee/${ws}/approvals`;

  return (
    <div className="flex flex-col gap-6">
      {inFlight ? <AutoRefresh intervalMs={3_000} /> : null}
      <Link href={queueHref} className="inline-flex w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {detail.workspace.name} queue
      </Link>
      <header className="flex flex-col gap-2">
        <p className="text-sm text-fg-2">
          For {item.lead.displayName} · requested {formatShortDateTime(item.requestedAt, tz)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl" data-approval-title>
            {title}
          </h1>
          <span className="rounded-sm border border-border-strong bg-bg-2 px-2 py-0.5 text-sm text-fg-1" data-approval-status={item.status}>
            {STATUS_WORDS[item.status] ?? item.status}
          </span>
        </div>
        {flags.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {flags.map((f) => (
              <li key={f} className="rounded-sm border border-border-strong bg-bg-2 px-1.5 py-0.5 text-xs text-fg-2">
                {f}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      {item.quote && !item.quote.isCurrent ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
          This item changed since it was opened: v{item.quote.currentVersionNo} replaced v{item.quote.versionNo}.{' '}
          {detail.currentApprovalId ? (
            <Link href={`/dashboard/employee/${ws}/approvals/${detail.currentApprovalId}`} className="font-medium text-cyan underline-offset-4 hover:underline">
              Open v{item.quote.currentVersionNo}
            </Link>
          ) : null}
        </p>
      ) : null}

      {reviewReasons.length > 0 || (version?.aiPolicyFlags.length ?? 0) > 0 || detail.validityPassed ? (
        <section aria-labelledby="checks-heading" className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <h2 id="checks-heading" className="flex items-center gap-2 text-sm font-semibold text-fg-1">
            <ShieldAlert aria-hidden="true" className="size-4 text-warning" />
            Check before approving
          </h2>
          <ul className="list-disc pl-5 text-sm text-fg-1">
            {reviewReasons.map((r, i) => (
              <li key={`r${i}`}>{reviewText(r)}</li>
            ))}
            {(version?.aiPolicyFlags ?? []).map((f) => (
              <li key={f}>{flagLabel(f) ?? f}</li>
            ))}
            {detail.validityPassed ? <li>This version is past its validity date. Edit it to set a new one.</li> : null}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {version ? (
            <section aria-labelledby="version-heading" className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-4">
              <h2 id="version-heading" className="text-lg font-semibold text-fg-1">
                Version {version.versionNo}
              </h2>
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {version.lines.map((l) => (
                  <li key={l.serviceId} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span className="text-fg-1">
                      {l.name} <span className="text-fg-2">× {l.qty} {l.unitLabel}</span>
                    </span>
                    <span className="tabular text-fg-1">{formatINR(l.lineTotalPaise)}</span>
                  </li>
                ))}
              </ul>
              <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-2">Subtotal</dt>
                <dd className="text-right tabular text-fg-1">{formatINR(version.subtotalPaise)}</dd>
                {version.discountPaise > 0n ? (
                  <>
                    <dt className="text-fg-2">Discount</dt>
                    <dd className="text-right tabular text-fg-1">-{formatINR(version.discountPaise)}</dd>
                  </>
                ) : null}
                <dt className="text-fg-2">{version.taxLabel ?? 'Tax'}</dt>
                <dd className="text-right tabular text-fg-1">{version.taxBps === null ? 'Not charged' : formatINR(version.taxPaise)}</dd>
                <dt className="font-semibold text-fg-1">Total</dt>
                <dd className="text-right font-semibold tabular text-fg-1" data-field="total">
                  {formatINR(version.totalPaise)}
                </dd>
              </dl>
              <p className="text-sm text-fg-2">
                {version.scopeText} · {version.timelineText} · valid until {formatShortDateTime(version.validUntil, tz)}
              </p>
              <p className="text-xs text-fg-2" data-field="pdf">
                {item.quote?.pdfReady ? 'PDF ready.' : 'PDF being prepared by the worker.'}
              </p>
            </section>
          ) : null}
          {detail.diff ? <VersionDiff diff={detail.diff} /> : null}
          {detail.message ? (
            <section aria-labelledby="message-heading" className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-4">
              <h2 id="message-heading" className="text-lg font-semibold text-fg-1">
                Message
              </h2>
              {detail.message.subject ? <p className="text-sm font-semibold text-fg-1">{detail.message.subject}</p> : null}
              {detail.message.templateName ? <p className="text-sm text-fg-2">Template: {detail.message.templateName}</p> : null}
              {detail.message.body ? <p className="whitespace-pre-line text-sm text-fg-1">{detail.message.body}</p> : null}
              {Object.keys(detail.message.variables).length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                  {Object.entries(detail.message.variables).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-fg-2">{k}</dt>
                      <dd className="text-fg-1">{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </section>
          ) : null}
          {item.quote && version && catalog && detail.quoteRef && item.quote.isCurrent && (item.status === 'PENDING' || item.status === 'APPROVED') ? (
            <ApprovalEditor
              approvalId={item.id}
              workspaceSlug={ws}
              quoteId={detail.quoteRef.quoteId}
              versionNo={version.versionNo}
              pricingVersionId={version.pricingVersionId}
              pricingVersionNo={detail.quoteRef.pricingVersionNo}
              catalog={catalog}
              canEdit={detail.permissions.canEdit}
              initial={{
                items: version.lines.map((l) => ({ serviceId: l.serviceId, qty: l.qty, name: l.name, unitLabel: l.unitLabel })),
                discountKind: version.discountKind as 'NONE' | 'PERCENT_BPS' | 'FLAT_PAISE',
                discountValue: version.discountValue.toString(),
                scopeText: version.scopeText,
                timelineText: version.timelineText,
                validityDays: null,
              }}
            />
          ) : null}
        </div>

        <aside aria-label="Decision" className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-4">
            <h2 className="text-sm font-semibold text-fg-1">Decision</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {detail.channels.map((c) => (
                <li key={c.channel} className="text-fg-2" data-channel-eligibility={c.channel}>
                  <span className="font-medium text-fg-1">{c.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}:</span>{' '}
                  {c.gate ? c.gate.reason : c.eligibility?.deferrable ? `can be queued; it waits (${c.eligibility.labels.join('; ')}).` : 'can be sent. Final check happens at send.'}
                </li>
              ))}
            </ul>
            <ApprovalActions
              approvalId={item.id}
              workspaceSlug={ws}
              workspaceName={detail.workspace.name}
              kind={item.kind === 'QUOTE_VERSION' ? 'QUOTE_VERSION' : 'OUTBOUND_MESSAGE'}
              status={item.status}
              label={title}
              versionNo={item.quote?.versionNo ?? null}
              isCurrent={item.quote?.isCurrent ?? true}
              pdfReady={item.quote?.pdfReady ?? true}
              channels={detail.channels.map((c) => ({ channel: c.channel, gate: c.gate, templates: c.templates, deferredLabels: c.eligibility?.deferrable ? c.eligibility.labels : [] }))}
              permissions={{ canDecide: detail.permissions.canDecide, canSend: detail.permissions.canSend }}
            />
            {item.status !== 'PENDING' && !(item.kind === 'QUOTE_VERSION' && item.status === 'APPROVED') ? <p className="text-sm text-fg-2">No decision left on this item.</p> : null}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-4">
            <h2 className="text-sm font-semibold text-fg-1">Dispatch</h2>
            {detail.attempts.length === 0 ? (
              <p className="text-sm text-fg-2">Not sent yet.</p>
            ) : (
              <ol className="flex flex-col gap-1 text-sm" data-dispatch-attempts={detail.attempts.length}>
                {detail.attempts.map((a) => (
                  <li key={a.id} className="text-fg-1" data-attempt-state={a.state}>
                    Attempt {a.attemptNo} {a.channel === 'EMAIL' ? 'by email' : 'on WhatsApp'}: {DISPATCH_WORDS[a.state] ?? a.state}
                    {a.reasonLabel && a.state !== 'SENT' ? ` (${a.reasonLabel})` : ''} <ModeChip simulated={page.ctx.mode === 'demo'} />
                    <span className="block text-xs text-fg-2">{formatShortDateTime(a.updatedAt, tz)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
