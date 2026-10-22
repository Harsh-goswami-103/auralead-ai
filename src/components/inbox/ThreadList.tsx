/**
 * Inbox thread list (T22; 06-design §11.2 "User Inbox" first fold; ADR-121 WhatsApp-like look),
 * shared by the client inbox and the operator's `[ws]` inbox (`basePath`). Each row: the initials
 * avatar tinted by its channel, the lead's name and the time of the last activity, the last
 * message's preview (with the delivery tick and its label when the business wrote last), and the
 * facts the server computed: the window ("Free-form until HH:MM" in the chat accent, or "Window
 * closed"), AI mode or takeover, "Needs you" with what needs a person (drafts to approve, a call
 * request, failed deliveries, an escalation), and "Handed over" once the lead belongs to the client
 * (ADR-124). Server-rendered; status is never colour-only (icon plus words).
 *
 * The list rises in once as a whole; rows carry no entrance of their own, because the list re-reads
 * itself (every 10 s, every 3 s beside a pending send) and when a thread moves to the top React
 * re-inserts the unchanged rows above it, which would restart a CSS entrance on exactly the rows
 * that did not change. In the conversation's narrow side column (`compact`) the channel and window
 * read as quiet icon + text facts and only what needs a person stays a chip; the full list keeps the
 * channel chip, the delivery badge and the AI-mode chip.
 */
import Link from 'next/link';
import { Bot, Hand, Handshake, PhoneCall, ShieldAlert, Timer, TimerOff, UserRoundCheck } from 'lucide-react';
import { InitialsAvatar } from '@/components/client/InitialsAvatar';
import { SourceChip } from '@/components/patterns/SourceChip';
import { sourceStyle } from '@/components/patterns/source-style';
import { DeliveryStatusBadge } from '@/components/patterns/StatusBadge';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import type { InboxThreadRow } from '@/server/services/messaging/inbox';
import { DeliveryTick } from './DeliveryTick';
import { formatClockTime, formatDayMonth } from './format';

export const USER_INBOX_PATH = '/dashboard/user/inbox';

const MODE_LABELS = { OFF: 'AI off', DRAFT: 'AI drafts', AUTO: 'AI auto' } as const;
const STATUS_WORDS: Readonly<Record<string, string>> = { PENDING: 'Queued', SENT: 'Sent', DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Failed', UNKNOWN: 'Delivery unknown', NOT_SENT: 'Not sent' };

const chip = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 [&>svg]:size-3 [&>svg]:shrink-0';
/** Compact facts: icon + words without a chip border (the side column is too narrow for chips). */
const fact = 'inline-flex items-center gap-1 whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0';

/** "05:30 IST" today, otherwise "21 Oct". */
function rowTime(at: Date, now: Date, timeZone: string): string {
  return formatDayMonth(at, timeZone) === formatDayMonth(now, timeZone) ? formatClockTime(at, timeZone) : formatDayMonth(at, timeZone);
}

export function ThreadList({
  rows,
  activeId,
  timeZone,
  now,
  compact,
  basePath = USER_INBOX_PATH,
}: {
  rows: InboxThreadRow[];
  activeId?: string;
  timeZone: string;
  now: Date;
  compact?: boolean;
  /** The inbox the rows link into: the client's (default) or `/dashboard/employee/<ws>/inbox`. */
  basePath?: string;
}) {
  return (
    <Reveal className="min-w-0">
      <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80" data-thread-list>
        {rows.map((t) => {
          const active = t.conversationId === activeId;
          const theyWroteLast = t.lastMessage?.direction === 'IN';
          const channel = sourceStyle(t.channel === 'EMAIL' ? 'EMAIL_INBOUND' : 'WHATSAPP_INBOUND');
          const ChannelIcon = channel.icon;
          const windowEnd =
            t.channel === 'WHATSAPP' && t.windowOpen && t.windowEndsAt
              ? `Free-form until ${formatClockTime(t.windowEndsAt, timeZone)}${formatDayMonth(t.windowEndsAt, timeZone) === formatDayMonth(now, timeZone) ? '' : `, ${formatDayMonth(t.windowEndsAt, timeZone)}`}`
              : null;
          const handedOver = t.handedOverAt !== null ? (
            <span className={cn(chip, TONE_CLASSES.info)} data-handed-over>
              <Handshake aria-hidden="true" />
              Handed over
            </span>
          ) : null;
          const attention = (
            <>
              {t.needsYou ? (
                <span className={cn(chip, TONE_CLASSES.warning)} data-needs-you>
                  <UserRoundCheck aria-hidden="true" />
                  Needs you
                </span>
              ) : null}
              {t.pendingApprovals > 0 ? (
                <span className={cn(chip, TONE_CLASSES.warning)}>
                  <ShieldAlert aria-hidden="true" />
                  {t.pendingApprovals} to approve
                </span>
              ) : null}
              {t.openCallRequests > 0 ? (
                <span className={cn(chip, TONE_CLASSES.warning)}>
                  <PhoneCall aria-hidden="true" />
                  Call requested
                </span>
              ) : null}
              {t.attentionDeliveries > 0 ? (
                <span className={cn(chip, TONE_CLASSES.danger)}>
                  <ShieldAlert aria-hidden="true" />
                  {t.attentionDeliveries} failed or unknown
                </span>
              ) : null}
              {t.escalated ? (
                <span className={cn(chip, TONE_CLASSES.warning)} data-escalated>
                  <ShieldAlert aria-hidden="true" />
                  Escalated
                </span>
              ) : null}
            </>
          );
          const hasAttention = t.needsYou || t.handedOverAt !== null;
          return (
            <li key={t.conversationId}>
              <Link
                href={`${basePath}/${t.conversationId}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex gap-3 transition-colors duration-fast hover:bg-bg-2/70 focus-visible:-outline-offset-2',
                  compact ? 'px-3.5 py-3' : 'px-4 py-3',
                  active && 'bg-bg-2/80 hover:bg-bg-2/80',
                )}
                data-thread={t.conversationId}
                data-channel={t.channel}
              >
                {active ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-chat-accent" /> : t.needsYou ? <span aria-hidden="true" className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-warning" /> : null}
                <span className={cn('flex min-w-0 flex-1', compact ? 'gap-2.5' : 'gap-3')}>
                  <InitialsAvatar name={t.leadName} tone={t.channel === 'EMAIL' ? 'email' : 'whatsapp'} size={compact ? 'sm' : 'md'} className="mt-0.5" />
                  <span className={cn('flex min-w-0 flex-1 flex-col', compact ? 'gap-1' : 'gap-1.5')}>
                    <span className="flex items-center gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-sm text-fg-1', theyWroteLast ? 'font-semibold' : 'font-medium')}>{t.leadName}</span>
                      <span className={cn('shrink-0 text-xs tabular', theyWroteLast ? 'font-medium text-chat-accent' : 'text-chat-meta')} data-thread-time>
                        {rowTime(t.lastActivityAt, now, timeZone)}
                      </span>
                    </span>
                    <span className={cn('flex min-w-0 items-center gap-1.5 text-sm', theyWroteLast ? 'text-fg-1' : 'text-fg-2')}>
                      {t.lastMessage && t.lastMessage.direction === 'OUT' && t.lastMessage.status !== 'DRAFT' ? (
                        <DeliveryTick status={t.lastMessage.status} label={STATUS_WORDS[t.lastMessage.status] ?? t.lastMessage.status} className="shrink-0 text-xs" />
                      ) : null}
                      <span className={cn('min-w-0', compact ? 'line-clamp-1' : 'line-clamp-2')}>{t.lastMessage ? t.lastMessage.preview : 'No messages yet'}</span>
                      {theyWroteLast ? (
                        <span className="ml-auto inline-flex shrink-0 items-center">
                          <span aria-hidden="true" className="size-2 rounded-full bg-chat-accent" />
                          <span className="sr-only">The customer wrote last</span>
                        </span>
                      ) : null}
                    </span>
                    {compact ? (
                      <>
                        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-fg-2">
                          <span className={fact}>
                            <ChannelIcon aria-hidden="true" className={channel.iconClass} />
                            {channel.label}
                          </span>
                          {t.humanTakeover ? (
                            <span className={cn(fact, 'text-fg-1')}>
                              <Hand aria-hidden="true" className="text-info" />
                              You are handling
                            </span>
                          ) : null}
                          {windowEnd ? (
                            <span className={cn(fact, 'text-chat-accent')} data-window-open>
                              <Timer aria-hidden="true" />
                              {windowEnd}
                            </span>
                          ) : t.channel === 'WHATSAPP' ? (
                            <span className={fact}>
                              <TimerOff aria-hidden="true" className="text-fg-3" />
                              Window closed
                            </span>
                          ) : null}
                        </span>
                        {hasAttention ? (
                          <span className="flex flex-wrap items-center gap-1.5 text-xs">
                            {handedOver}
                            {attention}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <SourceChip source={t.channel === 'EMAIL' ? 'EMAIL_INBOUND' : 'WHATSAPP_INBOUND'} withIcon />
                        {t.lastMessage && t.lastMessage.direction === 'OUT' ? <DeliveryStatusBadge status={t.lastMessage.status} simulated={t.lastMessage.simulated} /> : null}
                        {handedOver}
                        {t.humanTakeover ? (
                          <span className={cn(chip, TONE_CLASSES.info)}>
                            <Hand aria-hidden="true" />
                            You are handling
                          </span>
                        ) : (
                          <span className={cn(chip, 'border-border-strong bg-bg-2 text-fg-2')}>
                            <Bot aria-hidden="true" />
                            {MODE_LABELS[t.aiMode]}
                          </span>
                        )}
                        {windowEnd ? (
                          <span className={cn(chip, 'border-chat-accent/40 bg-bg-2 text-chat-accent')} data-window-open>
                            <Timer aria-hidden="true" />
                            {windowEnd}
                          </span>
                        ) : t.channel === 'WHATSAPP' ? (
                          <span className={cn(chip, 'border-border-strong bg-bg-2 text-fg-2')}>
                            <TimerOff aria-hidden="true" />
                            Window closed
                          </span>
                        ) : null}
                        {attention}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}
