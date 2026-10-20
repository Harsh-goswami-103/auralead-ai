/**
 * Approval queue list (T22; 06-design §11.2 "Approvals": queue sorted by age, version badge). Each
 * row names the lead, what is waiting (a quotation version with its total, or a message draft), its
 * flags in words, its age, the PDF state, and for decided items the dispatch outcome
 * ("Approved but dispatch deferred/blocked: shows reason"). Server-rendered.
 *
 * Look (design spec §6): a kind accent bar and tinted icon tile per row (quotation aura, email ice,
 * WhatsApp flare, the shared category palette), a kind chip, who wrote a message (only real AI
 * providers read "AI prepared"), toned flag chips, a waiting chip whose tone rises with the age,
 * and decided rows with approval and dispatch status chips (icon + label; a sent message shows its
 * delivery status in place of a second "Sent"). Keyboard focus draws
 * the 2px aura outline inside the row, so the rounded list cannot clip it.
 */
import Link from 'next/link';
import { FileCheck2, History, Loader2 } from 'lucide-react';
import { GeneratorChip } from '@/components/leads/GeneratorChip';
import { ToneChip } from '@/components/leads/ToneChip';
import { DeliveryStatusBadge } from '@/components/patterns/StatusBadge';
import { ageHint, formatShortDateTime } from '@/components/inbox/format';
import { cn } from '@/components/ui/cn';
import { formatINR } from '@/lib/money';
import type { ApprovalQueueItem } from '@/server/services/approvals/queue';
import { approvalStatusEntry, dispatchEntry, flagTone, ITEM_KINDS, waitingTier, type ItemKind } from './approval-vocabulary';

export const FLAG_LABELS: Readonly<Record<string, string>> = {
  customer_requested: 'Customer asked for it',
  call_request: 'Call requested',
  ai_reply: 'Reply suggestion',
  escalated: 'Escalated to a person',
  pipeline_first_touch: 'First message from the pipeline',
  needs_pricing_review: 'Needs pricing review',
  ai_price_ignored: 'AI tried to set a price',
  ai_discount_ignored: 'AI tried to set a discount',
  ai_tax_ignored: 'AI tried to set tax',
  ai_recipient_ignored: 'AI named a recipient',
  ai_policy_violation: 'AI text broke the output policy',
  composer: 'Written in the inbox',
};

export function flagLabel(flag: string): string | null {
  if (flag.startsWith('intent:')) return `Intent: ${flag.slice(7).replace(/_/g, ' ')}`;
  if (flag.startsWith('auto_blocked:')) return `Auto-send blocked: ${flag.slice(13).replace(/_/g, ' ').toLowerCase()}`;
  if (flag.startsWith('policy_auto_blocked:')) return `Policy approval blocked: ${flag.slice(20).replace(/_/g, ' ').toLowerCase()}`;
  return FLAG_LABELS[flag] ?? null;
}

function waitingText(ms: number): string {
  const age = ageHint(ms);
  return age === 'just now' ? 'Just requested' : `Waiting ${age.replace(' ago', '')}`;
}

export function itemKind(item: Pick<ApprovalQueueItem, 'quote' | 'message'>): ItemKind {
  if (item.quote) return 'quote';
  return item.message?.channel === 'EMAIL' ? 'email' : 'whatsapp';
}

/** The flags of an item that have words, with their chip tone. */
export function FlagChips({ flags, className }: { flags: string[]; className?: string }) {
  const labelled = flags.map((f) => ({ flag: f, label: flagLabel(f) })).filter((f): f is { flag: string; label: string } => f.label !== null);
  if (labelled.length === 0) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {labelled.map(({ flag, label }) => {
        const tone = flagTone(flag);
        return <ToneChip key={flag} tone={tone.tone} icon={tone.icon} label={label} className="whitespace-normal" />;
      })}
    </span>
  );
}

export function QueueList({ items, href, now, timeZone, decided = false }: { items: ApprovalQueueItem[]; href: (item: ApprovalQueueItem) => string; now: Date; timeZone: string; decided?: boolean }) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80" data-approval-queue={decided ? 'recent' : 'pending'}>
      {items.map((item) => {
        const kind = ITEM_KINDS[itemKind(item)];
        const Icon = kind.icon;
        const title = item.quote ? `${item.quote.number} v${item.quote.versionNo}` : item.message?.channel === 'EMAIL' ? (item.message.subject ?? 'Email draft') : 'WhatsApp message';
        const waitedMs = now.getTime() - item.requestedAt.getTime();
        const tier = waitingTier(waitedMs);
        const status = approvalStatusEntry(item.status);
        const dispatch = item.dispatch ? dispatchEntry(item.dispatch.state) : null;
        const delivery = item.message && item.message.status !== 'DRAFT' ? item.message : null;
        return (
          <li key={item.id}>
            <Link
              href={href(item)}
              className="group relative flex gap-3 py-3.5 pr-4 pl-5 transition-[background-color] duration-fast hover:bg-bg-2/70 focus-visible:bg-bg-2/70 focus-visible:-outline-offset-2 sm:items-center sm:gap-4"
              data-approval-item={item.id}
            >
              <span aria-hidden="true" className={cn('absolute inset-y-2.5 left-0 w-[3px] rounded-r-full opacity-80 transition-[width,opacity] duration-fast group-hover:w-[5px] group-hover:opacity-100', kind.bar)} />
              <span aria-hidden="true" className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border sm:mt-0', kind.tile)}>
                <Icon className={cn('size-4', kind.iconClass)} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-sm font-semibold text-fg-1">{title}</span>
                    {item.quote && !item.quote.isCurrent ? (
                      <ToneChip tone="warning" icon={History} label={`Replaced by v${item.quote.currentVersionNo}`} />
                    ) : null}
                    {item.message ? <GeneratorChip generatorLabel={item.message.generatorLabel} /> : null}
                  </span>
                  <span className="line-clamp-2 text-sm text-fg-2">
                    <span className={cn('mr-1.5 inline-flex rounded-full border px-1.5 text-[11px] leading-4 font-medium align-[1px]', kind.chip)}>{kind.label}</span>
                    <span className="text-fg-1">{item.lead.displayName}</span>
                    {item.quote ? <span className="tabular"> · {formatINR(item.quote.totalPaise)}</span> : item.message ? ` · ${item.message.preview}` : ''}
                  </span>
                  <FlagChips flags={item.flags} className="pt-0.5" />
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-fg-2 sm:max-w-[45%] sm:flex-col sm:items-end">
                  {decided ? (
                    <>
                      <span className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                        <ToneChip tone={status.tone} icon={status.icon} label={status.label} />
                        <span>
                          {item.decidedByName ? `by ${item.decidedByName}` : ''}
                          {item.decidedAt ? `${item.decidedByName ? ' · ' : ''}${formatShortDateTime(item.decidedAt, timeZone)}` : ''}
                        </span>
                      </span>
                      {item.dispatch && dispatch ? (
                        <span data-dispatch-state={item.dispatch.state} className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                          {/* A sent message shows its delivery status here (it says "Sent" or later) instead of a second "Sent" chip. */}
                          {delivery && item.dispatch.state === 'SENT' ? (
                            <DeliveryStatusBadge status={delivery.status} simulated={delivery.simulated} />
                          ) : (
                            <ToneChip tone={dispatch.tone} icon={dispatch.icon} label={dispatch.label} spinning={dispatch.spinning} />
                          )}
                          {item.dispatch.deferredUntil ? <span>deferred until {formatShortDateTime(item.dispatch.deferredUntil, timeZone)}</span> : null}
                          {item.dispatch.reasonLabel && item.dispatch.state !== 'SENT' ? <span>{item.dispatch.reasonLabel}</span> : null}
                        </span>
                      ) : item.status === 'APPROVED' ? (
                        <span>Not sent yet</span>
                      ) : null}
                      {delivery && item.dispatch?.state !== 'SENT' ? <DeliveryStatusBadge status={delivery.status} simulated={delivery.simulated} /> : null}
                    </>
                  ) : (
                    <>
                      <ToneChip tone={tier.tone} icon={tier.icon} label={waitingText(waitedMs)} className="tabular" />
                      {item.quote ? (
                        <span className="inline-flex items-center gap-1">
                          {item.quote.pdfReady ? (
                            <FileCheck2 aria-hidden="true" className="size-3.5 text-success" />
                          ) : (
                            <Loader2 aria-hidden="true" className="size-3.5 text-info motion-safe:animate-spin" />
                          )}
                          {item.quote.pdfReady ? 'PDF ready' : 'PDF being prepared'}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
