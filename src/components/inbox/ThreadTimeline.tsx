/**
 * One conversation, oldest first (T22; 06-design §11.2 "Thread view", F6): customer messages on the
 * left, the business's on the right, each outbound message with its delivery badge (mode chip
 * always, "Unknown (provider timeout)" for an ambiguous send) and the note that explains a
 * non-delivery ("AI reply cancelled by takeover", a blocked reason, a deferral). AI-prepared replies
 * are marked as suggestions and carry their approval actions; events (takeover, resume, mode
 * changes, escalations, call requests) sit between the messages. Server-rendered.
 *
 * Aurora look (design spec §6 "Chat bubbles"): outbound bubbles in the aura tint (bg-aura/12,
 * border-aura/25) with a tucked corner, inbound bubbles on bg-2 beside the customer's initials, a
 * dashed bubble for anything not sent (drafts), a day divider when the date changes, and events as
 * centred pills toned by kind with their icon and words. Each item rises in on first paint; a
 * refresh keeps the same nodes (keyed by id), so only newly arrived items animate.
 */
import { CalendarClock, FileText, Hand, PhoneCall, ShieldAlert, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { InitialsAvatar } from '@/components/client/InitialsAvatar';
import { DeliveryStatusBadge, ModeChip } from '@/components/patterns/StatusBadge';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import type { ThreadEvent, ThreadMessage } from '@/server/services/messaging/inbox';
import { formatClockTime, formatDayMonth, formatShortDateTime } from './format';

type Item = { at: Date; key: string; node: ReactNode };

const EVENT_ICONS = { MODE: Hand, ESCALATION: ShieldAlert, CALL_REQUEST: PhoneCall, REVIEW: ShieldAlert } as const;
const EVENT_TONES = { MODE: TONE_CLASSES.info, ESCALATION: TONE_CLASSES.warning, CALL_REQUEST: TONE_CLASSES.warning, REVIEW: TONE_CLASSES.warning } as const;

export function ThreadTimeline(props: { messages: ThreadMessage[]; events: ThreadEvent[]; timeZone: string; draftActions: (m: ThreadMessage) => ReactNode; leadName?: string }) {
  const items: Item[] = [
    ...props.messages.map((m) => ({
      at: m.at,
      key: `m:${m.id}`,
      node: <MessageBubble key={m.id} m={m} timeZone={props.timeZone} actions={props.draftActions(m)} leadName={props.leadName} />,
    })),
    ...props.events.map((e) => {
      const Icon = EVENT_ICONS[e.kind];
      return {
        at: e.at,
        key: `e:${e.id}`,
        node: (
          <li key={e.id} className="flex justify-center py-1" data-thread-event={e.kind}>
            <Reveal variant="fade" className={cn('inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-xl border px-3 py-1 text-center text-xs sm:rounded-full', EVENT_TONES[e.kind])}>
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="text-fg-1">{e.label}</span>
              <span className="text-fg-2">{formatShortDateTime(e.at, props.timeZone)}</span>
            </Reveal>
          </li>
        ),
      };
    }),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.key.localeCompare(b.key));

  // A day divider before the first item of each day (in the workspace time zone).
  const nodes: ReactNode[] = [];
  let day: string | null = null;
  for (const item of items) {
    const itemDay = formatDayMonth(item.at, props.timeZone);
    if (itemDay !== day) {
      day = itemDay;
      nodes.push(
        <li key={`d:${itemDay}:${item.key}`} className="flex items-center gap-3 py-1 text-xs font-medium text-fg-3" data-thread-day>
          <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
          {itemDay}
          <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
        </li>,
      );
    }
    nodes.push(item.node);
  }

  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation" data-thread-timeline>
      {nodes}
    </ol>
  );
}

function MessageBubble({ m, timeZone, actions, leadName }: { m: ThreadMessage; timeZone: string; actions: ReactNode; leadName?: string }) {
  const outbound = m.direction === 'OUT';
  const suggestion = outbound && m.status === 'DRAFT' && m.generatorLabel !== 'human' && m.generatorLabel !== null;
  const notSent = m.status === 'DRAFT';
  return (
    <li className="flex" data-message={m.id} data-direction={m.direction} data-status={m.status}>
      <Reveal className={cn('flex w-full gap-2.5', outbound ? 'flex-row-reverse' : 'flex-row')}>
        {!outbound && leadName ? <InitialsAvatar name={leadName} tone="neutral" size="sm" className="mt-auto mb-6 max-sm:hidden" /> : null}
        <div className={cn('flex min-w-0 flex-1 flex-col gap-1', outbound ? 'items-end' : 'items-start')}>
          <div
            className={cn(
              'flex max-w-[min(36rem,92%)] flex-col gap-1.5 rounded-2xl border px-3.5 py-2.5',
              outbound ? 'rounded-br-md border-aura/25 bg-aura/12' : 'rounded-bl-md border-border-subtle bg-bg-2',
              notSent && 'border-dashed border-border-input bg-bg-1',
              (m.status === 'NOT_SENT' || m.status === 'FAILED') && 'opacity-80',
            )}
          >
            {suggestion ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
                <Sparkles aria-hidden="true" className="size-3.5" />
                AI suggestion · not sent
              </span>
            ) : null}
            {m.quickReplyLabel ? <span className="text-sm font-medium text-fg-1">{m.quickReplyLabel}</span> : null}
            {m.subject ? <span className="text-sm font-semibold text-fg-1">{m.subject}</span> : null}
            {m.templateName ? <span className="text-xs text-fg-2">Template: {m.templateName}</span> : null}
            {m.body && !m.quickReplyLabel ? <p className="text-sm break-words whitespace-pre-line text-fg-1">{m.body}</p> : null}
            {m.quote ? (
              <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border-subtle bg-bg-1/60 px-2 py-1 text-xs text-fg-1">
                <FileText aria-hidden="true" className="size-3.5 text-panel" />
                Quotation {m.quote.number} v{m.quote.versionNo} (PDF)
              </span>
            ) : null}
          </div>
          <div className={cn('flex flex-wrap items-center gap-2 text-xs text-fg-3', outbound ? 'justify-end' : 'justify-start')}>
            <span className="tabular" title={formatShortDateTime(m.at, timeZone)}>
              {formatClockTime(m.at, timeZone)}
            </span>
            {outbound ? m.status === 'DRAFT' ? null : <DeliveryStatusBadge status={m.status} simulated={m.simulated} /> : m.simulated ? <ModeChip simulated /> : null}
            {outbound && m.automated && m.status !== 'DRAFT' ? <span>Automated</span> : null}
          </div>
          {m.deferredUntil ? (
            <p className="flex items-center gap-1 text-xs text-warning">
              <CalendarClock aria-hidden="true" className="size-3.5" />
              Deferred until {formatShortDateTime(m.deferredUntil, timeZone)}
            </p>
          ) : null}
          {m.note ? <p className={cn('text-xs', m.status === 'NOT_SENT' || m.status === 'FAILED' || m.status === 'UNKNOWN' ? 'text-warning' : 'text-fg-2')}>{m.note}</p> : null}
          {actions ? <div className="w-full max-w-[min(36rem,92%)]">{actions}</div> : null}
        </div>
      </Reveal>
    </li>
  );
}
