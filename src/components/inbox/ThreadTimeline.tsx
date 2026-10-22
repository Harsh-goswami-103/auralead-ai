/**
 * One conversation, oldest first (T22; 06-design §11.2 "Thread view", F6; ADR-121 WhatsApp-like
 * look): the customer's messages on the left, the business's on the right, on the chat wallpaper.
 *
 *  - Bubbles: incoming on --chat-bubble-in with a tail at the top left, outgoing on
 *    --chat-bubble-out with a tail at the top right; text in text-1, so it reads on both. A draft
 *    (not sent) is a dashed bubble with no tail.
 *  - Under the text, inside the bubble: the time and, for outgoing messages, the delivery tick with
 *    its label (DeliveryTick: Queued, Sent, Delivered, Read, Failed, ...). Status is never icon-only.
 *  - Template messages render as WhatsApp shows them: header text or the document's name, the body
 *    with its values, the footer, and the buttons under the bubble.
 *  - Automated replies carry their provenance (AiProvenance: "AI prepared" in violet only for a
 *    model provider; "Local template" or "Automatic reply" otherwise). A prepared reply that waits
 *    for approval says who wrote it in the same vocabulary ("AI suggestion" only for a model) and
 *    carries its approval actions.
 *  - Day separators and events (takeover, resume, mode changes, escalations, call requests, the
 *    handoff to the client) are centred pills on the wallpaper, each with its icon and words.
 *  - Simulated messages keep the Simulated chip, outside the bubble.
 * Each item rises in on first paint; a refresh keeps the same nodes (keyed by id), so only newly
 * arrived items animate. Server-rendered.
 */
import { Bot, CalendarClock, CircleHelp, Cog, FileText, Hand, Handshake, PhoneCall, Reply, ShieldAlert, Sparkles, Wand2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { AiProvenance } from '@/components/ai/AiProvenance';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import { generatorInfo, type GeneratorKind } from '@/lib/schemas/lead-console';
import type { ThreadEvent, ThreadMessage } from '@/server/services/messaging/inbox';
import { DeliveryTick } from './DeliveryTick';
import { formatClockTime, formatDayMonth, formatShortDateTime } from './format';

type Item = { at: Date; key: string; node: ReactNode };

const EVENT_ICONS: Readonly<Record<ThreadEvent['kind'], LucideIcon>> = { MODE: Hand, ESCALATION: ShieldAlert, CALL_REQUEST: PhoneCall, REVIEW: ShieldAlert, HANDOFF: Handshake };
const EVENT_TONES: Readonly<Record<ThreadEvent['kind'], string>> = {
  MODE: TONE_CLASSES.info,
  ESCALATION: TONE_CLASSES.warning,
  CALL_REQUEST: TONE_CLASSES.warning,
  REVIEW: TONE_CLASSES.warning,
  HANDOFF: TONE_CLASSES.info,
};
/** The draft marker's icon per generator kind (the same icons as GeneratorChip); a person's own draft has none. */
const DRAFT_ICONS: Readonly<Partial<Record<GeneratorKind, LucideIcon>>> = { ai: Sparkles, template: Wand2, automatic: Bot, system: Cog, other: CircleHelp };
/** Labels of the reply job's own replies (reply guard or the conversation_reply generator). */
const REPLY_LABELS = new Set(['reply-guard', 'local-deterministic', 'anthropic', 'openai']);

export function ThreadTimeline(props: { messages: ThreadMessage[]; events: ThreadEvent[]; timeZone: string; draftActions: (m: ThreadMessage) => ReactNode }) {
  const items: Item[] = [
    ...props.messages.map((m) => ({
      at: m.at,
      key: `m:${m.id}`,
      node: <MessageBubble key={m.id} m={m} timeZone={props.timeZone} actions={props.draftActions(m)} />,
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

  // A day separator before the first item of each day (in the workspace time zone).
  const nodes: ReactNode[] = [];
  let day: string | null = null;
  for (const item of items) {
    const itemDay = formatDayMonth(item.at, props.timeZone);
    if (itemDay !== day) {
      day = itemDay;
      nodes.push(
        <li key={`d:${itemDay}:${item.key}`} className="flex justify-center py-1" data-thread-day>
          <span className="rounded-md bg-chat-bubble-in px-2.5 py-0.5 text-xs font-medium text-fg-2">{itemDay}</span>
        </li>,
      );
    }
    nodes.push(item.node);
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-chat-wallpaper p-3 sm:p-4" data-chat-wallpaper>
      <ol className="flex flex-col gap-2" aria-label="Conversation" data-thread-timeline>
        {nodes}
      </ol>
    </div>
  );
}

function TemplateBody({ m }: { m: ThreadMessage }) {
  const t = m.template!;
  return (
    <div className="flex flex-col gap-1.5" data-template-bubble>
      {t.headerFormat === 'DOCUMENT' && t.documentName ? (
        <span className="flex items-center gap-2 rounded-md bg-chat-wallpaper/40 px-2 py-1.5 text-xs text-fg-1">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-fg-2" />
          <span className="min-w-0 truncate" data-template-document>
            {t.documentName}
          </span>
        </span>
      ) : null}
      {t.headerText ? <p className="text-sm font-semibold break-words text-fg-1">{t.headerText}</p> : null}
      <p className="text-sm break-words whitespace-pre-line text-fg-1">{t.body}</p>
      {t.footer ? <p className="text-xs break-words text-chat-meta">{t.footer}</p> : null}
    </div>
  );
}

function MessageBubble({ m, timeZone, actions }: { m: ThreadMessage; timeZone: string; actions: ReactNode }) {
  const outbound = m.direction === 'OUT';
  const generator = generatorInfo(m.generatorLabel);
  const notSent = m.status === 'DRAFT';
  const DraftIcon = outbound && notSent ? DRAFT_ICONS[generator.kind] : undefined;
  const replyProvenance = outbound && !notSent && m.automated && REPLY_LABELS.has(m.generatorLabel ?? '');
  const buttons = m.template?.buttons ?? [];
  return (
    <li className="flex" data-message={m.id} data-direction={m.direction} data-status={m.status}>
      <Reveal className={cn('flex w-full flex-col gap-1', outbound ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'relative flex max-w-[min(34rem,88%)] flex-col gap-1 rounded-lg px-3 pt-2 pb-1.5',
            outbound ? 'rounded-tr-none bg-chat-bubble-out' : 'rounded-tl-none bg-chat-bubble-in',
            notSent && 'rounded-lg border border-dashed border-border-input bg-bg-1',
            (m.status === 'NOT_SENT' || m.status === 'FAILED') && 'opacity-80',
          )}
          data-bubble={outbound ? 'out' : 'in'}
        >
          {!notSent ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-0 size-0 border-t-[10px] border-solid',
                outbound ? '-right-2 border-r-[10px] border-t-chat-bubble-out border-r-transparent' : '-left-2 border-l-[10px] border-t-chat-bubble-in border-l-transparent',
              )}
            />
          ) : null}
          {DraftIcon ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-fg-2" data-draft-marker={generator.kind}>
              <DraftIcon aria-hidden="true" className="size-3.5" />
              {generator.kind === 'ai' ? 'AI suggestion' : generator.short} · not sent
            </span>
          ) : null}
          {m.quickReplyLabel ? (
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg-1">
              <Reply aria-hidden="true" className="size-3.5 shrink-0 text-fg-2" />
              {m.quickReplyLabel}
            </span>
          ) : null}
          {m.subject ? <span className="text-sm font-semibold text-fg-1">{m.subject}</span> : null}
          {m.template ? <TemplateBody m={m} /> : m.templateName ? <span className="text-xs text-fg-2">Template: {m.templateName}</span> : null}
          {m.body && !m.quickReplyLabel ? <p className="text-sm break-words whitespace-pre-line text-fg-1">{m.body}</p> : null}
          {m.quote && !m.template ? (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-chat-wallpaper/40 px-2 py-1 text-xs text-fg-1">
              <FileText aria-hidden="true" className="size-3.5 text-fg-2" />
              Quotation {m.quote.number} v{m.quote.versionNo} (PDF)
            </span>
          ) : null}
          <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 self-end text-[11px] leading-4 text-chat-meta" data-bubble-meta>
            <span className="tabular" title={formatShortDateTime(m.at, timeZone)}>
              {formatClockTime(m.at, timeZone)}
            </span>
            {outbound ? <DeliveryTick status={m.status} label={m.statusLabel} /> : null}
          </span>
        </div>
        {buttons.length > 0 ? (
          <ul className="flex w-full max-w-[min(34rem,88%)] flex-col gap-1" aria-label="Template buttons" data-template-buttons>
            {buttons.map((b, i) => (
              <li key={`${b.type}:${i}`} className="flex items-center justify-center gap-1.5 rounded-lg bg-chat-bubble-out px-3 py-1.5 text-sm font-medium text-aura">
                <Reply aria-hidden="true" className="size-3.5 shrink-0" />
                {b.text}
              </li>
            ))}
          </ul>
        ) : null}
        {replyProvenance || m.simulated || (outbound && m.automated && !notSent && !replyProvenance) ? (
          <span className={cn('flex flex-wrap items-center gap-1.5 text-xs text-fg-2', outbound ? 'justify-end' : 'justify-start')}>
            {replyProvenance ? <AiProvenance generatorLabel={m.generatorLabel} /> : outbound && m.automated && !notSent ? <span>Automated</span> : null}
            {m.simulated ? <ModeChip simulated /> : null}
          </span>
        ) : null}
        {m.deferredUntil ? (
          <p className="flex items-center gap-1 text-xs text-warning">
            <CalendarClock aria-hidden="true" className="size-3.5" />
            Deferred until {formatShortDateTime(m.deferredUntil, timeZone)}
          </p>
        ) : null}
        {m.note ? <p className={cn('text-xs', m.status === 'NOT_SENT' || m.status === 'FAILED' || m.status === 'UNKNOWN' ? 'text-warning' : 'text-fg-2')}>{m.note}</p> : null}
        {actions ? <div className="w-full max-w-[min(34rem,88%)]">{actions}</div> : null}
      </Reveal>
    </li>
  );
}
