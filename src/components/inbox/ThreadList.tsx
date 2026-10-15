/**
 * Inbox thread list (T22; 06-design §11.2 "User Inbox" first fold): channel, lead, last message,
 * its delivery state, AI mode or takeover, the window state the server computed, and what needs a
 * person. Server-rendered; status is never colour-only (icon plus words).
 */
import Link from 'next/link';
import { Bot, Hand, Mail, MessageCircle, PhoneCall, ShieldAlert, TimerOff, Timer } from 'lucide-react';
import { DeliveryStatusBadge } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import type { InboxThreadRow } from '@/server/services/messaging/inbox';
import { ageHint, formatClockTime, formatDayMonth } from './format';

const MODE_LABELS = { OFF: 'AI off', DRAFT: 'AI drafts', AUTO: 'AI auto' } as const;

export function ThreadList({ rows, activeId, timeZone, now }: { rows: InboxThreadRow[]; activeId?: string; timeZone: string; now: Date }) {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-1" data-thread-list>
      {rows.map((t) => {
        const active = t.conversationId === activeId;
        const ChannelIcon = t.channel === 'EMAIL' ? Mail : MessageCircle;
        return (
          <li key={t.conversationId}>
            <Link
              href={`/dashboard/user/inbox/${t.conversationId}`}
              aria-current={active ? 'page' : undefined}
              className={cn('flex flex-col gap-1.5 px-4 py-3 transition-colors duration-150 hover:bg-bg-2 focus-visible:bg-bg-2 focus-visible:outline-none', active && 'bg-bg-2 shadow-[inset_2px_0_0_var(--accent)]')}
              data-thread={t.conversationId}
              data-channel={t.channel}
            >
              <span className="flex items-center gap-2">
                <ChannelIcon aria-label={t.channel === 'EMAIL' ? 'Email' : 'WhatsApp'} className="size-4 shrink-0 text-fg-2" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-1">{t.leadName}</span>
                <span className="shrink-0 text-xs text-fg-3 tabular">{ageHint(now.getTime() - t.lastActivityAt.getTime())}</span>
              </span>
              <span className="line-clamp-2 text-sm text-fg-2">
                {t.lastMessage ? `${t.lastMessage.direction === 'OUT' ? 'You: ' : ''}${t.lastMessage.preview}` : 'No messages yet'}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs">
                {t.lastMessage && t.lastMessage.direction === 'OUT' ? <DeliveryStatusBadge status={t.lastMessage.status} simulated={t.lastMessage.simulated} /> : null}
                {t.humanTakeover ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-info/30 bg-info/10 px-1.5 py-0.5 text-info">
                    <Hand aria-hidden="true" className="size-3" />
                    You are handling
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-border-strong bg-bg-2 px-1.5 py-0.5 text-fg-2">
                    <Bot aria-hidden="true" className="size-3" />
                    {MODE_LABELS[t.aiMode]}
                  </span>
                )}
                {t.channel === 'WHATSAPP' ? (
                  t.windowOpen && t.windowEndsAt ? (
                    <span className="inline-flex items-center gap-1 rounded-sm border border-success/30 bg-success/10 px-1.5 py-0.5 text-success">
                      <Timer aria-hidden="true" className="size-3" />
                      Free-form until {formatClockTime(t.windowEndsAt, timeZone)}
                      {formatDayMonth(t.windowEndsAt, timeZone) === formatDayMonth(now, timeZone) ? '' : `, ${formatDayMonth(t.windowEndsAt, timeZone)}`}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-sm border border-border-strong bg-bg-2 px-1.5 py-0.5 text-fg-2">
                      <TimerOff aria-hidden="true" className="size-3" />
                      Window closed
                    </span>
                  )
                ) : null}
                {t.pendingApprovals > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-warning">
                    <ShieldAlert aria-hidden="true" className="size-3" />
                    {t.pendingApprovals} to approve
                  </span>
                ) : null}
                {t.openCallRequests > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-warning">
                    <PhoneCall aria-hidden="true" className="size-3" />
                    Call requested
                  </span>
                ) : null}
                {t.attentionDeliveries > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-danger">
                    <ShieldAlert aria-hidden="true" className="size-3" />
                    {t.attentionDeliveries} failed or unknown
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
