/**
 * One conversation, oldest first (T22; 06-design §11.2 "Thread view", F6): customer messages on the
 * left, the business's on the right, each outbound message with its delivery badge (mode chip
 * always, "Unknown (provider timeout)" for an ambiguous send) and the note that explains a
 * non-delivery ("AI reply cancelled by takeover", a blocked reason, a deferral). AI-prepared replies
 * are marked as suggestions and carry their approval actions; events (takeover, resume, mode
 * changes, escalations, call requests) sit between the messages. Server-rendered.
 */
import { CalendarClock, FileText, Hand, PhoneCall, ShieldAlert, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { DeliveryStatusBadge, ModeChip } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import type { ThreadEvent, ThreadMessage } from '@/server/services/messaging/inbox';
import { formatShortDateTime } from './format';

type Item = { at: Date; key: string; node: ReactNode };

const EVENT_ICONS = { MODE: Hand, ESCALATION: ShieldAlert, CALL_REQUEST: PhoneCall, REVIEW: ShieldAlert } as const;

export function ThreadTimeline(props: { messages: ThreadMessage[]; events: ThreadEvent[]; timeZone: string; draftActions: (m: ThreadMessage) => ReactNode }) {
  const items: Item[] = [
    ...props.messages.map((m) => ({ at: m.at, key: `m:${m.id}`, node: <MessageBubble key={m.id} m={m} timeZone={props.timeZone} actions={props.draftActions(m)} /> })),
    ...props.events.map((e) => {
      const Icon = EVENT_ICONS[e.kind];
      return {
        at: e.at,
        key: `e:${e.id}`,
        node: (
          <li key={e.id} className="flex items-center justify-center gap-2 py-1 text-xs text-fg-2" data-thread-event={e.kind}>
            <Icon aria-hidden="true" className="size-3.5" />
            <span>{e.label}</span>
            <span className="text-fg-3">{formatShortDateTime(e.at, props.timeZone)}</span>
          </li>
        ),
      };
    }),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.key.localeCompare(b.key));

  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation" data-thread-timeline>
      {items.map((i) => i.node)}
    </ol>
  );
}

function MessageBubble({ m, timeZone, actions }: { m: ThreadMessage; timeZone: string; actions: ReactNode }) {
  const outbound = m.direction === 'OUT';
  const suggestion = outbound && m.status === 'DRAFT' && m.generatorLabel !== 'human' && m.generatorLabel !== null;
  return (
    <li className={cn('flex flex-col gap-1', outbound ? 'items-end' : 'items-start')} data-message={m.id} data-direction={m.direction} data-status={m.status}>
      <div
        className={cn(
          'flex max-w-[min(36rem,92%)] flex-col gap-1.5 rounded-xl border px-3 py-2',
          outbound ? 'rounded-br-sm border-primary/25 bg-primary/10' : 'rounded-bl-sm border-border-subtle bg-bg-2',
          m.status === 'DRAFT' && 'border-dashed bg-bg-1',
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
        {m.body && !m.quickReplyLabel ? <p className="whitespace-pre-line break-words text-sm text-fg-1">{m.body}</p> : null}
        {m.quote ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
            <FileText aria-hidden="true" className="size-3.5" />
            Quotation {m.quote.number} v{m.quote.versionNo} (PDF)
          </span>
        ) : null}
      </div>
      <div className={cn('flex flex-wrap items-center gap-2 text-xs text-fg-3', outbound ? 'justify-end' : 'justify-start')}>
        <span className="tabular">{formatShortDateTime(m.at, timeZone)}</span>
        {outbound ? (
          m.status === 'DRAFT' ? null : <DeliveryStatusBadge status={m.status} simulated={m.simulated} />
        ) : m.simulated ? (
          <ModeChip simulated />
        ) : null}
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
    </li>
  );
}
