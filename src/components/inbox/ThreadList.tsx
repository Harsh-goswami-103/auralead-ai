/**
 * Inbox thread list (T22; 06-design §11.2 "User Inbox" first fold): channel, lead, last message,
 * its delivery state, AI mode or takeover, the window state the server computed, and what needs a
 * person. Server-rendered; status is never colour-only (icon plus words).
 *
 * Aurora look (design spec §6): each row has an initials avatar tinted by its channel and a channel
 * chip with the channel's name (WhatsApp and Email threads of one lead are told apart in words), a
 * warning bar when the thread needs a person (the chips say why), a panel-hue dot when the customer
 * wrote last, and the panel bar on the open thread. The list rises in once as a whole; rows carry no
 * entrance of their own, because the list re-reads itself (every 10 s, every 3 s beside a pending
 * send) and when a thread moves to the top React re-inserts the unchanged rows above it, which would
 * restart a CSS entrance on exactly the rows that did not change. In the
 * conversation's narrow side column (`compact`) the channel and window read as quiet icon + text
 * facts and only what needs a person stays a chip, so a row no longer stacks four chip lines. In
 * both layouts tinted chips are kept for what needs a person (approve, call, failed delivery,
 * takeover); routine state (window open, AI mode) is a neutral chip with a toned icon.
 */
import Link from 'next/link';
import { Bot, Hand, PhoneCall, ShieldAlert, TimerOff, Timer } from 'lucide-react';
import { InitialsAvatar } from '@/components/client/InitialsAvatar';
import { SourceChip } from '@/components/patterns/SourceChip';
import { sourceStyle } from '@/components/patterns/source-style';
import { DeliveryStatusBadge } from '@/components/patterns/StatusBadge';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import type { InboxThreadRow } from '@/server/services/messaging/inbox';
import { ageHint, formatClockTime, formatDayMonth } from './format';

const MODE_LABELS = { OFF: 'AI off', DRAFT: 'AI drafts', AUTO: 'AI auto' } as const;

const chip = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 [&>svg]:size-3 [&>svg]:shrink-0';
/** Compact facts: icon + words without a chip border (the side column is too narrow for chips). */
const fact = 'inline-flex items-center gap-1 whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0';

/**
 * `compact` is the conversation page's side column (about 18rem): a one-line preview, the channel
 * and the window (or takeover) as quiet icon + text facts, and chips only for what needs a person.
 * It leaves out the delivery badge and the AI-mode chip. The full list keeps every chip.
 */
export function ThreadList({ rows, activeId, timeZone, now, compact }: { rows: InboxThreadRow[]; activeId?: string; timeZone: string; now: Date; compact?: boolean }) {
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
          const attention = (
            <>
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
            </>
          );
          return (
            <li key={t.conversationId}>
              <Link
                href={`/dashboard/user/inbox/${t.conversationId}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex gap-3 transition-colors duration-fast hover:bg-bg-2/70 focus-visible:-outline-offset-2',
                  compact ? 'px-3.5 py-3' : 'px-4 py-3',
                  active && 'bg-[linear-gradient(90deg,color-mix(in_oklab,var(--panel-hue)_12%,transparent),transparent_75%)] hover:bg-bg-2/40',
                )}
                data-thread={t.conversationId}
                data-channel={t.channel}
              >
                {active ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-panel" /> : t.needsYou ? <span aria-hidden="true" className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-warning" /> : null}
                <span className={cn('flex min-w-0 flex-1', compact ? 'gap-2.5' : 'gap-3')}>
                  <InitialsAvatar name={t.leadName} tone={t.channel === 'EMAIL' ? 'email' : 'whatsapp'} size={compact ? 'sm' : 'md'} className="mt-0.5" />
                  <span className={cn('flex min-w-0 flex-1 flex-col', compact ? 'gap-1' : 'gap-1.5')}>
                    <span className="flex items-center gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-sm text-fg-1', theyWroteLast ? 'font-semibold' : 'font-medium')}>{t.leadName}</span>
                      {theyWroteLast ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-2">
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-panel" />
                          <span className="sr-only">The customer wrote last,</span>
                        </span>
                      ) : null}
                      <span className="shrink-0 text-xs text-fg-3 tabular">{ageHint(now.getTime() - t.lastActivityAt.getTime())}</span>
                    </span>
                    <span className={cn('text-sm', compact ? 'line-clamp-1' : 'line-clamp-2', theyWroteLast ? 'text-fg-1' : 'text-fg-2')}>
                      {t.lastMessage ? `${t.lastMessage.direction === 'OUT' ? 'You: ' : ''}${t.lastMessage.preview}` : 'No messages yet'}
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
                            <span className={fact}>
                              <Timer aria-hidden="true" className="text-success" />
                              {windowEnd}
                            </span>
                          ) : t.channel === 'WHATSAPP' ? (
                            <span className={fact}>
                              <TimerOff aria-hidden="true" className="text-fg-3" />
                              Window closed
                            </span>
                          ) : null}
                        </span>
                        {t.pendingApprovals > 0 || t.openCallRequests > 0 || t.attentionDeliveries > 0 ? <span className="flex flex-wrap items-center gap-1.5 text-xs">{attention}</span> : null}
                      </>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <SourceChip source={t.channel === 'EMAIL' ? 'EMAIL_INBOUND' : 'WHATSAPP_INBOUND'} withIcon />
                        {t.lastMessage && t.lastMessage.direction === 'OUT' ? <DeliveryStatusBadge status={t.lastMessage.status} simulated={t.lastMessage.simulated} /> : null}
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
                          <span className={cn(chip, 'border-border-strong bg-bg-2 text-fg-1')}>
                            <Timer aria-hidden="true" className="text-success" />
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
