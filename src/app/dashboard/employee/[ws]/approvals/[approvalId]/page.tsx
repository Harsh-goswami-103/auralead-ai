/**
 * One approval item (T22; 06-design §11.2 "Approvals" second and third fold, F18). Shows what is
 * being approved exactly as stored (the quotation version's lines and totals, or the message text),
 * the diff against the previous version, the pricing checks and flags, each channel with the shared
 * eligibility result, and the dispatch history. Actions: approve (the version on screen),
 * approve-and-send, reject, and edit within the employee's own pricing permissions. A stale tab gets
 * "This item changed since you opened it". Another workspace's item is 404. The page re-reads itself
 * while the PDF is being prepared or a send is in flight.
 *
 * Look (design spec §6): the page header in the operator hue (the h1 keeps `data-approval-title`
 * with exactly the item's name, so it is composed here rather than with PageHeader), the approval
 * status as an icon + label chip beside it, section titles with an icon chip (the same pattern as
 * the client panel's quotation page), the version as a receipt with its totals boxed and the scope
 * and timeline as labelled panels, the message as a preview, channel eligibility as a status list
 * and the dispatch history as a timeline. The decision column stays in view on wide screens.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, CalendarClock, CircleCheck, Clock, FileCheck2, FileText, Gavel, Loader2, Lock, Mail, MessageCircle, ScrollText, Send, ShieldAlert, Timer, TriangleAlert, type LucideIcon } from 'lucide-react';
import { ApprovalActions } from '@/components/approvals/ApprovalActions';
import { ApprovalEditor } from '@/components/approvals/ApprovalEditor';
import { approvalStatusEntry, dispatchEntry, ITEM_KINDS } from '@/components/approvals/approval-vocabulary';
import { ChipTitle, IconChip } from '@/components/patterns/IconChip';
import { FlagChips, flagLabel, itemKind } from '@/components/approvals/QueueList';
import { VersionDiff } from '@/components/approvals/VersionDiff';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { formatShortDateTime } from '@/components/inbox/format';
import { GeneratorChip } from '@/components/leads/GeneratorChip';
import { reviewReasonText } from '@/components/leads/lead-vocabulary';
import { ToneChip } from '@/components/leads/ToneChip';
import { SectionCard } from '@/components/patterns/SectionCard';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { Reveal } from '@/components/visual/Reveal';
import { NotFoundError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { getApprovalItem, type ApprovalItemDetail } from '@/server/services/approvals/queue';
import { inboxDepsFromConfig } from '@/server/services/messaging/inbox';
import { getQuoteEditorCatalog, serializeCatalog } from '@/server/services/quotes/versioning';

export const metadata: Metadata = { title: 'Approval' };
export const dynamic = 'force-dynamic';

const CHANNEL_NAMES = { EMAIL: 'Email', WHATSAPP: 'WhatsApp' } as const;
const CHANNEL_ICONS: Record<'EMAIL' | 'WHATSAPP', LucideIcon> = { EMAIL: Mail, WHATSAPP: MessageCircle };

const DOT_TONES: Readonly<Record<string, string>> = {
  success: 'border-success/45 bg-success/14 text-success',
  info: 'border-info/45 bg-info/14 text-info',
  warning: 'border-warning/45 bg-warning/14 text-warning',
  danger: 'border-danger/45 bg-danger/14 text-danger',
  neutral: 'border-border-strong bg-bg-2 text-fg-2',
  demo: 'border-demo/45 bg-demo/14 text-demo',
};

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
  // The editor (and its catalog) only when it will render: a current quotation still open for a decision.
  const editable = item.quote !== null && version !== null && detail.quoteRef !== null && item.quote.isCurrent && (item.status === 'PENDING' || item.status === 'APPROVED');
  const catalog = editable && detail.permissions.canEdit ? serializeCatalog(await getQuoteEditorCatalog(page.ctx)) : null;
  const inFlight = (item.quote !== null && !item.quote.pdfReady) || detail.attempts.some((a) => a.state === 'QUEUED' || a.state === 'SENDING');
  const policyFlags = version?.aiPolicyFlags ?? [];
  const reviewReasons = Array.isArray(version?.reviewReasons) ? version.reviewReasons : [];
  const title = item.quote ? `${item.quote.number} v${item.quote.versionNo}` : item.message?.channel === 'EMAIL' ? 'Email draft' : 'WhatsApp draft';
  const queueHref = `/dashboard/employee/${ws}/approvals`;
  const status = approvalStatusEntry(item.status);
  const StatusIcon = status.icon;
  const kind = ITEM_KINDS[itemKind(item)];
  const KindIcon = kind.icon;
  const decided = item.status !== 'PENDING' && !(item.kind === 'QUOTE_VERSION' && item.status === 'APPROVED');

  return (
    <div className="flex flex-col gap-6">
      {inFlight ? <AutoRefresh intervalMs={3_000} /> : null}
      <Link href={queueHref} className="group inline-flex w-fit items-center gap-1.5 text-sm text-fg-2 hover:text-fg-1">
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        {detail.workspace.name} queue
      </Link>

      <header data-page-header="" className="relative isolate -mt-3 flex flex-col gap-2 pb-1">
        <AuroraBackdrop variant="header" />
        <Reveal as="p" className="flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-fg-2 uppercase">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-panel" />
          {kind.label} for {item.lead.displayName}
        </Reveal>
        <div className="flex flex-wrap items-center gap-3">
          <Reveal as="span" variant="focus" delay={0.04} className="flex items-center gap-3">
            <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl border', kind.tile)}>
              <KindIcon className={cn('size-5', kind.iconClass)} />
            </span>
            <h1 className="text-gradient w-fit max-w-full font-display text-2xl font-semibold sm:text-3xl" data-approval-title>
              {title}
            </h1>
          </Reveal>
          <ToneChip tone={status.tone} icon={status.icon} label={status.label} size="md" attrs={{ 'data-approval-status': item.status }} />
        </div>
        <Reveal delay={0.08} className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden="true" className="size-3.5 text-fg-3" />
            Requested {formatShortDateTime(item.requestedAt, tz)}
          </span>
          {item.decidedAt && item.status !== 'PENDING' ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusIcon aria-hidden="true" className="size-3.5 text-fg-3" />
              {status.label}
              {item.decidedByName ? ` by ${item.decidedByName}` : ''} · {formatShortDateTime(item.decidedAt, tz)}
            </span>
          ) : null}
          {item.message ? <GeneratorChip generatorLabel={item.message.generatorLabel} /> : null}
          <FlagChips flags={item.flags} />
        </Reveal>
      </header>

      {item.quote && !item.quote.isCurrent ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <span>
            This item changed since it was opened: v{item.quote.currentVersionNo} replaced v{item.quote.versionNo}.{' '}
            {detail.currentApprovalId ? (
              <Link href={`/dashboard/employee/${ws}/approvals/${detail.currentApprovalId}`} className="font-medium text-cyan underline underline-offset-4">
                Open v{item.quote.currentVersionNo}
              </Link>
            ) : null}
          </span>
        </p>
      ) : null}

      {reviewReasons.length > 0 || policyFlags.length > 0 || detail.validityPassed ? (
        <section aria-labelledby="checks-heading" className="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-warning/35 bg-warning/8 p-4 pl-5">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-warning" />
          <h2 id="checks-heading" className="flex items-center gap-2 font-display text-base font-semibold text-fg-1">
            <ShieldAlert aria-hidden="true" className="size-4 text-warning" />
            Check before approving
          </h2>
          <ul className="flex flex-col gap-1 text-sm text-fg-1">
            {reviewReasons.map((r, i) => (
              <li key={`r${i}`} className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {reviewReasonText(r)}
              </li>
            ))}
            {policyFlags.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {flagLabel(f) ?? 'The AI output was adjusted by the output policy.'}
              </li>
            ))}
            {detail.validityPassed ? (
              <li className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                This version is past its validity date. Edit it to set a new one.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem] xl:items-start">
        <Reveal variant="fade" delay={0.1} className="flex min-w-0 flex-col gap-6">
          {version ? (
            <SectionCard
              title={<ChipTitle icon={<FileText aria-hidden="true" />}>{`Version ${version.versionNo}`}</ChipTitle>}
              meta={
                <span className="inline-flex items-center gap-1.5">
                  <CalendarClock aria-hidden="true" className="size-3.5 text-fg-3" />
                  Valid until {formatShortDateTime(version.validUntil, tz)}
                </span>
              }
              accent
              actions={
                <span className="inline-flex items-center gap-1.5 text-xs text-fg-2" data-field="pdf">
                  {item.quote?.pdfReady ? <FileCheck2 aria-hidden="true" className="size-3.5 text-success" /> : <Loader2 aria-hidden="true" className="size-3.5 text-info motion-safe:animate-spin" />}
                  {item.quote?.pdfReady ? 'PDF ready.' : 'PDF being prepared by the worker.'}
                </span>
              }
            >
              <ul className="flex flex-col divide-y divide-border-subtle text-sm">
                {version.lines.map((l) => (
                  <li key={l.serviceId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-fg-1">{l.name}</span>
                      <span className="tabular text-xs text-fg-2">
                        {l.qty} {l.unitLabel} × {formatINR(l.unitPricePaise)}
                      </span>
                    </span>
                    <span className="tabular text-fg-1">{formatINR(l.lineTotalPaise)}</span>
                  </li>
                ))}
              </ul>
              <dl className="grid w-full grid-cols-[1fr_auto] gap-y-1.5 rounded-lg border border-border-subtle bg-bg-2/40 p-3.5 text-sm sm:ml-auto sm:max-w-sm [&>dd]:pl-4">
                <dt className="text-fg-2">Subtotal</dt>
                <dd className="tabular text-right text-fg-1">{formatINR(version.subtotalPaise)}</dd>
                {version.discountPaise > 0n ? (
                  <>
                    <dt className="text-fg-2">Discount</dt>
                    <dd className="tabular text-right text-fg-1">−{formatINR(version.discountPaise)}</dd>
                  </>
                ) : null}
                <dt className="text-fg-2">{version.taxLabel ?? 'Tax'}</dt>
                <dd className="tabular text-right text-fg-1">{version.taxBps === null ? 'Not charged' : formatINR(version.taxPaise)}</dd>
                <dt className="mt-1.5 flex items-center border-t border-border-subtle pt-2 font-semibold text-fg-1">Total</dt>
                <dd className="tabular mt-1.5 border-t border-border-subtle pt-2 text-right font-display text-2xl font-semibold text-fg-1" data-field="total">
                  {formatINR(version.totalPaise)}
                </dd>
              </dl>
              {version.scopeText.trim() !== '' || version.timelineText.trim() !== '' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {version.scopeText.trim() !== '' ? (
                    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-2/40 p-3">
                      <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">
                        <ScrollText aria-hidden="true" className="size-3.5 text-panel" />
                        Scope of work
                      </h3>
                      <p className="text-sm whitespace-pre-line text-fg-1">{version.scopeText}</p>
                    </div>
                  ) : null}
                  {version.timelineText.trim() !== '' ? (
                    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-2/40 p-3">
                      <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">
                        <Timer aria-hidden="true" className="size-3.5 text-panel" />
                        Timeline
                      </h3>
                      <p className="text-sm text-fg-1">{version.timelineText}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </SectionCard>
          ) : null}
          {detail.diff ? <VersionDiff diff={detail.diff} /> : null}
          {detail.message ? (
            <SectionCard
              title={
                <span className="flex items-center gap-2.5">
                  {/* The icon chip in the item kind's color (email ice, WhatsApp flare), like the header tile. */}
                  <IconChip className={kind.titleChip}>
                    <KindIcon />
                  </IconChip>
                  <span>Message</span>
                </span>
              }
              accent
              meta={item.message ? `${CHANNEL_NAMES[item.message.channel]} to ${item.lead.displayName}` : undefined}
            >
              <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-2/50">
                {detail.message.subject ? <p className="border-b border-border-subtle px-3.5 py-2.5 text-sm font-semibold text-fg-1">{detail.message.subject}</p> : null}
                {detail.message.templateName ? <p className="border-b border-border-subtle px-3.5 py-2 text-sm text-fg-2">Template: {detail.message.templateName}</p> : null}
                {detail.message.body ? (
                  <div className="px-3.5 py-3">
                    <p
                      className={cn(
                        'text-sm whitespace-pre-line text-fg-1',
                        item.message?.channel === 'WHATSAPP' && 'w-fit max-w-prose rounded-2xl rounded-tl-sm border border-aura/25 bg-aura/12 px-3.5 py-2.5',
                      )}
                    >
                      {detail.message.body}
                    </p>
                  </div>
                ) : null}
                {Object.keys(detail.message.variables).length > 0 ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border-subtle px-3.5 py-2.5 text-sm">
                    {Object.entries(detail.message.variables).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="font-mono text-xs text-fg-2">{k}</dt>
                        <dd className="text-fg-1">{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </SectionCard>
          ) : null}
          {editable && item.quote && version && catalog && detail.quoteRef ? (
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
        </Reveal>

        <aside aria-label="Decision" className="min-w-0 xl:sticky xl:top-[calc(var(--topbar-h)+1.5rem)]">
          <Reveal delay={0.16} className="flex flex-col gap-4">
            <SectionCard title={<ChipTitle icon={<Gavel aria-hidden="true" />} hue="zest">Decision</ChipTitle>} accent>
              <ul className="flex flex-col gap-2 text-sm">
                {detail.channels.map((c) => {
                  const ChannelIcon = CHANNEL_ICONS[c.channel];
                  const deferrable = !c.gate && Boolean(c.eligibility?.deferrable);
                  const StateIcon = c.gate ? Lock : deferrable ? Clock : CircleCheck;
                  return (
                    <li key={c.channel} className="flex items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2 text-fg-2" data-channel-eligibility={c.channel}>
                      <span aria-hidden="true" className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border', c.gate ? DOT_TONES.neutral : deferrable ? DOT_TONES.warning : DOT_TONES.success)}>
                        <StateIcon className="size-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="inline-flex items-center gap-1 font-medium text-fg-1">
                          <ChannelIcon aria-hidden="true" className={cn('size-3.5', c.channel === 'EMAIL' ? 'text-ice' : 'text-chart-3-hi')} />
                          {CHANNEL_NAMES[c.channel]}:
                        </span>{' '}
                        {c.gate ? c.gate.reason : c.eligibility?.deferrable ? `can be queued; it waits (${c.eligibility.labels.join('; ')}).` : 'can be sent. Final check happens at send.'}
                      </span>
                    </li>
                  );
                })}
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
              {decided ? (
                <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2.5 text-sm text-fg-2">
                  <ToneChip tone={status.tone} icon={status.icon} label={status.label} />
                  {item.decidedAt ? (
                    <span>
                      {item.decidedByName ? `By ${item.decidedByName}, ` : ''}
                      {formatShortDateTime(item.decidedAt, tz)}.
                    </span>
                  ) : null}
                  <span>No decision left on this item.</span>
                </div>
              ) : null}
            </SectionCard>
            <SectionCard title={<ChipTitle icon={<Send aria-hidden="true" />} hue="volt">Dispatch</ChipTitle>} titleAs="h2">
              {detail.attempts.length === 0 ? (
                <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2.5 text-sm text-fg-2">
                  <Clock aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
                  Not sent yet.
                </p>
              ) : (
                <ol className="relative flex flex-col gap-4 text-sm" data-dispatch-attempts={detail.attempts.length}>
                  <span aria-hidden="true" className="absolute top-3 bottom-3 left-[13px] w-px bg-border-strong" />
                  {detail.attempts.map((a) => {
                    const entry = dispatchEntry(a.state);
                    const StateIcon = entry.icon;
                    return (
                      <li key={a.id} className="relative flex gap-3 text-fg-1" data-attempt-state={a.state}>
                        <span aria-hidden="true" className={cn('relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border', DOT_TONES[entry.tone])}>
                          <StateIcon className={cn('size-3.5', entry.spinning && 'motion-safe:animate-spin')} />
                        </span>
                        <span className="flex min-w-0 flex-col gap-1">
                          <span>
                            Attempt {a.attemptNo} {a.channel === 'EMAIL' ? 'by email' : 'on WhatsApp'}: <span className="font-medium">{entry.long ?? entry.label}</span>
                            {a.reasonLabel && a.state !== 'SENT' ? ` (${a.reasonLabel})` : ''} <ModeChip simulated={page.ctx.mode === 'demo'} />
                          </span>
                          <span className="text-xs text-fg-2">{formatShortDateTime(a.updatedAt, tz)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </SectionCard>
          </Reveal>
        </aside>
      </div>
    </div>
  );
}
