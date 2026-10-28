/**
 * The WhatsApp-style delivery tick of one outbound message (ADR-121): a clock while queued, one tick
 * when sent, two when delivered, two in the read hue when read, and a warning icon when it failed,
 * is unknown or was never sent. Status is never icon-only: the label (the server's delivery label)
 * is printed beside the tick, and the tick itself is decorative. Times, ticks and labels use the
 * chat meta hue; only the read tick takes --chat-tick-read. Server-safe.
 */
import { Check, CheckCheck, CircleAlert, CircleHelp, CircleSlash, Clock, type LucideIcon } from 'lucide-react';
import type { MessageStatus } from '@/lib/domain/enums';
import { cn } from '@/components/ui/cn';

type Tick = { icon: LucideIcon; tone: string };

const TICKS: Readonly<Record<Exclude<MessageStatus, 'DRAFT'>, Tick>> = {
  PENDING: { icon: Clock, tone: 'text-chat-meta' },
  SENT: { icon: Check, tone: 'text-chat-meta' },
  DELIVERED: { icon: CheckCheck, tone: 'text-chat-meta' },
  READ: { icon: CheckCheck, tone: 'text-chat-tick-read' },
  FAILED: { icon: CircleAlert, tone: 'text-danger' },
  UNKNOWN: { icon: CircleHelp, tone: 'text-warning' },
  NOT_SENT: { icon: CircleSlash, tone: 'text-chat-meta' },
};

export function DeliveryTick({ status, label, className }: { status: MessageStatus; label: string; className?: string }) {
  if (status === 'DRAFT') return null;
  const tick = TICKS[status];
  const Icon = tick.icon;
  return (
    <span className={cn('inline-flex items-center gap-1', className)} data-delivery-tick={status}>
      <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', tick.tone)} />
      {/* The read hue and warning read as text on both bubbles; danger does not on the outgoing one, so a failure's words stay text-1. */}
      <span data-status-label className={status === 'READ' ? 'text-chat-tick-read' : status === 'FAILED' ? 'font-medium text-fg-1' : status === 'UNKNOWN' ? 'text-warning' : 'text-chat-meta'}>
        {label}
      </span>
    </span>
  );
}
