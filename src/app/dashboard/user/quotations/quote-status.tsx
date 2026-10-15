/**
 * Quote status badge (T15, plan §6.1, R20): one label, tone and icon per QuoteStatus, icon + label
 * always (never color alone), tones from the shared status tokens. VIEWED reads "Opened (may be
 * automated)" because a view beacon is evidence of an open, not of a person reading (C4).
 * Server-renderable.
 */
import { CircleCheck, CircleSlash, Clock, Eye, FileCheck2, PencilLine, Send, type LucideIcon } from 'lucide-react';
import type { QuoteStatus } from '@/lib/domain/enums';
import { TONE_CLASSES, type StatusTone } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';

export const QUOTE_STATUS_VOCABULARY: Readonly<Record<QuoteStatus, { label: string; tone: StatusTone; icon: LucideIcon; detail: string }>> = {
  DRAFT: { label: 'Draft', tone: 'neutral', icon: PencilLine, detail: 'Not approved yet. Nothing can be sent.' },
  APPROVED: { label: 'Approved', tone: 'info', icon: FileCheck2, detail: 'Approved and ready to send.' },
  SENT: { label: 'Sent', tone: 'info', icon: Send, detail: 'Sent to the customer.' },
  VIEWED: { label: 'Opened (may be automated)', tone: 'info', icon: Eye, detail: 'The link was opened; link previews and scanners can do this too.' },
  ACCEPTED: { label: 'Accepted', tone: 'success', icon: CircleCheck, detail: 'The customer accepted this version.' },
  EXPIRED: { label: 'Expired', tone: 'warning', icon: Clock, detail: 'Past its validity date. Revise it to reissue.' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash, detail: 'Cancelled; its links no longer open.' },
};

export function QuoteStatusBadge({ status, showDetail, className }: { status: QuoteStatus; showDetail?: boolean; className?: string }) {
  const entry = QUOTE_STATUS_VOCABULARY[status];
  const Icon = entry.icon;
  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <span data-quote-status={status} className={cn('inline-flex w-fit items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-medium', TONE_CLASSES[entry.tone])}>
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {entry.label}
      </span>
      {showDetail ? <span className="text-xs text-fg-2">{entry.detail}</span> : null}
    </span>
  );
}
