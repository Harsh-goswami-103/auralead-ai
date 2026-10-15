/**
 * Approval queue list (T22; 06-design §11.2 "Approvals": queue sorted by age, version badge). Each
 * row names the lead, what is waiting (a quotation version with its total, or a message draft), its
 * flags in words, its age, the PDF state, and for decided items the dispatch outcome
 * ("Approved but dispatch deferred/blocked: shows reason"). Server-rendered.
 */
import Link from 'next/link';
import { Clock3, FileText, Mail, MessageCircle, Sparkles } from 'lucide-react';
import { DeliveryStatusBadge } from '@/components/patterns/StatusBadge';
import { ageHint, formatShortDateTime } from '@/components/inbox/format';
import { formatINR } from '@/lib/money';
import type { ApprovalQueueItem } from '@/server/services/approvals/queue';

export const FLAG_LABELS: Readonly<Record<string, string>> = {
  customer_requested: 'Customer asked for it',
  call_request: 'Call requested',
  ai_reply: 'AI reply',
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

const DISPATCH_WORDS: Record<string, string> = {
  QUEUED: 'Queued',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  SKIPPED: 'Blocked before sending',
  AMBIGUOUS: 'Delivery unknown',
  CANCELLED: 'Cancelled',
};

function waitingText(ms: number): string {
  const age = ageHint(ms);
  return age === 'just now' ? 'Just requested' : `Waiting ${age.replace(' ago', '')}`;
}

export function QueueList({ items, href, now, timeZone, decided = false }: { items: ApprovalQueueItem[]; href: (item: ApprovalQueueItem) => string; now: Date; timeZone: string; decided?: boolean }) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-1" data-approval-queue={decided ? 'recent' : 'pending'}>
      {items.map((item) => {
        const Icon = item.quote ? FileText : item.message?.channel === 'EMAIL' ? Mail : MessageCircle;
        const flags = item.flags.map(flagLabel).filter((f): f is string => f !== null);
        const title = item.quote ? `${item.quote.number} v${item.quote.versionNo}` : item.message?.channel === 'EMAIL' ? `Email${item.message.subject ? `: ${item.message.subject}` : ''}` : 'WhatsApp message';
        return (
          <li key={item.id}>
            <Link href={href(item)} className="flex flex-col gap-1.5 px-4 py-3 transition-colors duration-150 hover:bg-bg-2 focus-visible:bg-bg-2 focus-visible:outline-none sm:flex-row sm:items-center sm:gap-4" data-approval-item={item.id}>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-2" />
                  <span className="truncate text-sm font-semibold text-fg-1">{title}</span>
                  {item.quote && !item.quote.isCurrent ? <span className="rounded-sm border border-warning/30 bg-warning/10 px-1.5 text-xs text-warning">Replaced by v{item.quote.currentVersionNo}</span> : null}
                  {item.message && item.message.generatorLabel && item.message.generatorLabel !== 'human' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                      <Sparkles aria-hidden="true" className="size-3" />
                      AI prepared
                    </span>
                  ) : null}
                </span>
                <span className="text-sm text-fg-2">
                  {item.lead.displayName}
                  {item.quote ? ` · ${formatINR(item.quote.totalPaise)}` : item.message ? ` · ${item.message.preview}` : ''}
                </span>
                {flags.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {flags.map((f) => (
                      <span key={f} className="rounded-sm border border-border-strong bg-bg-2 px-1.5 py-0.5 text-xs text-fg-2">
                        {f}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 flex-col items-start gap-1 text-xs text-fg-2 sm:items-end">
                {decided ? (
                  <>
                    <span className="text-fg-1">
                      {item.status === 'APPROVED' ? 'Approved' : 'Rejected'}
                      {item.decidedByName ? ` by ${item.decidedByName}` : ''}
                      {item.decidedAt ? ` · ${formatShortDateTime(item.decidedAt, timeZone)}` : ''}
                    </span>
                    {item.dispatch ? (
                      <span data-dispatch-state={item.dispatch.state}>
                        {DISPATCH_WORDS[item.dispatch.state] ?? item.dispatch.state}
                        {item.dispatch.deferredUntil ? `, deferred until ${formatShortDateTime(item.dispatch.deferredUntil, timeZone)}` : ''}
                        {item.dispatch.reasonLabel && item.dispatch.state !== 'SENT' ? `: ${item.dispatch.reasonLabel}` : ''}
                      </span>
                    ) : item.status === 'APPROVED' ? (
                      <span>Not sent yet</span>
                    ) : null}
                    {item.message && item.message.status !== 'DRAFT' ? <DeliveryStatusBadge status={item.message.status} simulated={item.message.simulated} /> : null}
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 tabular">
                      <Clock3 aria-hidden="true" className="size-3.5" />
                      {waitingText(now.getTime() - item.requestedAt.getTime())}
                    </span>
                    {item.quote ? <span>{item.quote.pdfReady ? 'PDF ready' : 'PDF being prepared'}</span> : null}
                  </>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
