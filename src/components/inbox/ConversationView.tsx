/**
 * One WhatsApp-style conversation (T22; 06-design §11.2 "User Inbox" second and third fold, §11.8
 * breakpoints; ADR-121 operator inbox, ADR-122 AI replies, ADR-124 handed-over leads), shared by the
 * client's `/dashboard/user/inbox/[conversationId]` and the operator's
 * `/dashboard/employee/<ws>/inbox/[conversationId]`. Server component; the pages load the data.
 *
 * At 1280 px and above three panes: threads, the conversation, the lead context (and, in DEMO, the
 * customer's phone); below that the conversation alone with a link back to the list.
 *  - Header: the lead's name, stage and window state ("Free-form until HH:MM" or "Window closed"),
 *    the Handed over and Escalated badges, the AI mode control with take over and resume, and the
 *    workspace's Automatic sending switch.
 *  - A handed-over lead shows the handoff ("Handed over to <client> by <operator>") as a banner and
 *    a timeline event; for an operator the thread is read-only (composer, mode and approvals).
 *  - The timeline on the chat wallpaper, prepared replies with approve-and-send and reject, and the
 *    composer whose eligibility line comes from the server ("Final check happens at send").
 *  - DEMO: "Customer's phone (Simulated)" beside the thread.
 * The page re-reads itself while a send is in flight or a reply is being prepared (a send is
 * pending, or the customer wrote last within two minutes while AI replies are on); otherwise every
 * 10 s, so a settled thread does not poll every 3 s forever.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, FilePlus2, FileText, Handshake, ShieldAlert, Timer, TimerOff, UserRound } from 'lucide-react';
import { ApprovalActions, type ActionChannel } from '@/components/approvals/ApprovalActions';
import { InitialsAvatar } from '@/components/client/InitialsAvatar';
import type { Gate } from '@/components/patterns/GatedAction';
import { IconChip } from '@/components/patterns/IconChip';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import { generatorInfo } from '@/lib/schemas/lead-console';
import type { InboxList, InboxThread, ThreadMessage } from '@/server/services/messaging/inbox';
import { AutoRefresh } from './AutoRefresh';
import { AutoSendToggle } from './AutoSendToggle';
import { Composer } from './Composer';
import { CustomerPhone, type PhoneMessage } from './CustomerPhone';
import { ModeControls } from './ModeControls';
import { ThreadList } from './ThreadList';
import { ThreadTimeline } from './ThreadTimeline';
import { formatClockTime, formatDayMonth, formatShortDateTime } from './format';

const STAGE_LABELS: Record<string, string> = { NEW: 'New', CONTACTED: 'Contacted', REPLIED: 'Replied', QUOTE_SENT: 'Quote sent', CONVERTED: 'Converted', LOST: 'Lost' };
/** How long after an inbound message the page keeps polling fast for the AI's reply. */
const REPLY_WINDOW_MS = 120_000;
/** Messages the customer actually received (or sent): drafts and messages that never left are not on their phone. */
const ON_PHONE = new Set(['SENT', 'DELIVERED', 'READ']);

export type ConversationLinks = {
  /** The inbox list (`/dashboard/user/inbox` or `/dashboard/employee/<ws>/inbox`). */
  list: string;
  /** The lead's own page in this panel, when the panel has one for it. */
  lead: string | null;
  /** A quotation's page, when the panel has one. */
  quote: ((quoteId: string) => string) | null;
  /** Create a quotation for the lead, when the panel can. */
  newQuote: string | null;
};

function draftGate(thread: InboxThread, m: ThreadMessage): Gate | null {
  if (m.kind === 'TEMPLATE') return thread.composer.templateGate;
  const f = thread.composer.freeform;
  if (f.eligible || f.deferrable) return null;
  const index = f.reasons.findIndex((r) => r !== 'GLOBAL_PAUSED' && r !== 'CAP_REACHED');
  const code = f.reasons[index >= 0 ? index : 0];
  const label = f.labels[index >= 0 ? index : 0] ?? 'This message cannot be sent now';
  return { category: code === 'NOT_CONFIGURED' ? 'configuration' : 'eligibility', reason: `${label}.` };
}

function phoneMessages(thread: InboxThread): PhoneMessage[] {
  return thread.messages
    .filter((m) => m.direction === 'IN' || ON_PHONE.has(m.status))
    .map((m) => ({
      id: m.id,
      from: m.direction === 'IN' ? ('customer' as const) : ('business' as const),
      text: m.quickReplyLabel ?? m.template?.body ?? m.body ?? (m.quote ? `Quotation ${m.quote.number} (PDF)` : 'Message'),
      time: formatClockTime(m.at, thread.workspace.timezone),
    }))
    .slice(-30);
}

const chip = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs [&>svg]:size-3 [&>svg]:shrink-0';

export function ConversationView(props: {
  thread: InboxThread;
  list: InboxList;
  links: ConversationLinks;
  basePath: string;
  canDecide: boolean;
  workspaceSlug?: string;
  /** The panel's quotation status chip (the client panel has one); plain words otherwise. */
  quoteStatus?: (status: string) => ReactNode;
}) {
  const { thread, list, links } = props;
  const tz = thread.workspace.timezone;
  const last = thread.messages.at(-1);
  const replyExpected =
    last?.direction === 'IN' && thread.conversation.aiMode !== 'OFF' && !thread.conversation.humanTakeover && thread.serverNow.getTime() - last.at.getTime() < REPLY_WINDOW_MS;
  const inFlight = thread.messages.some((m) => m.status === 'PENDING') || replyExpected;
  const channelSource = thread.conversation.channel === 'EMAIL' ? 'EMAIL_INBOUND' : 'WHATSAPP_INBOUND';
  const score = thread.lead.score;
  const readOnly = thread.readOnly;
  const windowEnd = thread.composer.freeform.windowEndsAt;
  const sameDay = windowEnd ? formatDayMonth(windowEnd, tz) === formatDayMonth(thread.serverNow, tz) : true;

  const draftActions = (m: ThreadMessage) => {
    if (m.direction !== 'OUT' || m.status !== 'DRAFT' || !m.approval || m.approval.status !== 'PENDING') return null;
    const channel: ActionChannel = {
      channel: thread.conversation.channel,
      gate: draftGate(thread, m),
      templates: [],
      deferredLabels: thread.composer.freeform.deferrable ? thread.composer.freeform.labels : [],
    };
    return (
      <ApprovalActions
        approvalId={m.approval.id}
        workspaceSlug={thread.workspace.slug}
        workspaceName={thread.workspace.name}
        kind="OUTBOUND_MESSAGE"
        status="PENDING"
        label={generatorInfo(m.generatorLabel).kind === 'ai' ? 'AI suggestion' : 'Draft reply'}
        versionNo={null}
        isCurrent
        pdfReady
        channels={[channel]}
        permissions={{ canDecide: props.canDecide && readOnly === null, canSend: thread.permissions.canSend }}
      />
    );
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_19rem] 2xl:grid-cols-[20rem_minmax(0,1fr)_21rem]">
      <AutoRefresh intervalMs={inFlight ? 3_000 : 10_000} />
      <aside
        aria-label="Conversations"
        className="hidden min-w-0 xl:sticky xl:top-20 xl:block xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:rounded-xl xl:[scrollbar-color:var(--border-strong)_transparent] xl:[scrollbar-width:thin]"
      >
        <ThreadList rows={list.rows} activeId={thread.conversation.id} timeZone={tz} now={thread.serverNow} basePath={props.basePath} compact />
      </aside>

      <section aria-labelledby="thread-heading" className="flex min-w-0 flex-col gap-4">
        <Link href={links.list} className="group inline-flex min-h-11 w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1 lg:min-h-9 xl:hidden">
          <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
          All conversations
        </Link>
        <header className="relative flex flex-col gap-4 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5">
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-0 h-0.5 rounded-full bg-chat-accent" />
          <Reveal className="flex min-w-0 flex-wrap items-center gap-3">
            <InitialsAvatar name={thread.lead.displayName} tone={thread.conversation.channel === 'EMAIL' ? 'email' : 'whatsapp'} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h1 id="thread-heading" className="max-w-full truncate font-display text-xl font-semibold text-fg-1 sm:text-2xl">
                {thread.lead.displayName}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceChip source={channelSource} withIcon />
                <span className={cn(chip, 'border-border-strong bg-bg-2 text-fg-1')} data-lead-stage>
                  {STAGE_LABELS[thread.lead.salesStage] ?? thread.lead.salesStage}
                </span>
                {thread.conversation.channel === 'WHATSAPP' ? (
                  windowEnd ? (
                    <span className={cn(chip, 'border-chat-accent/40 bg-bg-2 text-chat-accent')} data-window-state="open">
                      <Timer aria-hidden="true" />
                      Free-form until {formatClockTime(windowEnd, tz)}
                      {sameDay ? '' : `, ${formatDayMonth(windowEnd, tz)}`}
                    </span>
                  ) : (
                    <span className={cn(chip, 'border-border-strong bg-bg-2 text-fg-2')} data-window-state="closed">
                      <TimerOff aria-hidden="true" />
                      Window closed
                    </span>
                  )
                ) : null}
                {thread.handoff ? (
                  <span className={cn(chip, TONE_CLASSES.info)} data-handed-over>
                    <Handshake aria-hidden="true" />
                    Handed over
                  </span>
                ) : null}
                {thread.conversation.escalated ? (
                  <span className={cn(chip, TONE_CLASSES.warning)} data-escalated>
                    <ShieldAlert aria-hidden="true" />
                    Needs you
                  </span>
                ) : null}
                {thread.lead.simulated ? <ModeChip simulated /> : null}
              </div>
            </div>
          </Reveal>
          {thread.handoff ? (
            <div role="status" className="flex items-start gap-2.5 rounded-xl border border-info/35 bg-info/12 px-3 py-2.5 text-sm text-fg-1" data-handoff-banner>
              <Handshake aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
              <span>
                Handed over to {thread.handoff.clientName}
                {thread.handoff.operatorName ? ` by ${thread.handoff.operatorName}` : ''} on {formatShortDateTime(thread.handoff.at, tz)}.
                {thread.handoff.status === 'ACKNOWLEDGED' ? ' The client acknowledged it.' : ''}
                {thread.handoff.note ? <span className="mt-1 block text-fg-2">Note: {thread.handoff.note}</span> : null}
              </span>
            </div>
          ) : null}
          <ModeControls
            conversationId={thread.conversation.id}
            workspaceName={thread.workspace.name}
            aiMode={thread.conversation.aiMode}
            humanTakeover={thread.conversation.humanTakeover}
            modeVersion={thread.conversation.modeVersion}
            autoSendEnabled={thread.conversation.autoSendEnabled}
            autoAvailable={thread.conversation.autoAvailable}
            canChangeMode={thread.permissions.canChangeMode}
            readOnly={readOnly}
            {...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {})}
          />
          <AutoSendToggle
            enabled={thread.conversation.autoSendEnabled}
            canManage={thread.permissions.canManageAutomation}
            workspaceName={thread.workspace.name}
            {...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {})}
          />
        </header>

        {thread.messages.length === 0 && thread.events.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-fg-2">No messages in this conversation yet.</p>
        ) : (
          <ThreadTimeline messages={thread.messages} events={thread.events} timeZone={tz} draftActions={draftActions} />
        )}

        <Composer
          conversationId={thread.conversation.id}
          channel={thread.conversation.channel}
          timeZone={tz}
          serverNow={thread.serverNow.toISOString()}
          freeform={{ ...thread.composer.freeform, windowEndsAt: thread.composer.freeform.windowEndsAt?.toISOString() ?? null }}
          templates={thread.composer.templates}
          templateGate={thread.composer.templateGate}
          permissions={{ canSend: thread.permissions.canSend, canDraft: thread.permissions.canDraft }}
          readOnly={readOnly}
          {...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {})}
        />
      </section>

      <aside aria-label="Lead" className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:[scrollbar-width:thin]">
        {thread.permissions.canSimulate && thread.conversation.channel === 'WHATSAPP' && thread.lead.phoneLast4 ? (
          <CustomerPhone
            leadId={thread.lead.id}
            leadName={thread.lead.displayName}
            businessName={thread.workspace.name}
            messages={phoneMessages(thread)}
            canSimulate
            {...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {})}
          />
        ) : null}
        <section className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg-1">
            <IconChip size="sm">
              <UserRound />
            </IconChip>
            Lead
          </h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
            <dt className="text-fg-2">Stage</dt>
            <dd>
              <span className="inline-flex w-fit items-center rounded-full border border-panel/35 bg-panel/10 px-2 py-0.5 text-xs font-medium text-fg-1">{STAGE_LABELS[thread.lead.salesStage] ?? thread.lead.salesStage}</span>
            </dd>
            <dt className="text-fg-2">Source</dt>
            <dd className="min-w-0">
              <SourceChip source={thread.lead.firstSource} />
            </dd>
            <dt className="text-fg-2">City</dt>
            <dd className="text-fg-1">{thread.lead.city ?? 'Unknown'}</dd>
            <dt className="text-fg-2">Score</dt>
            <dd className="flex flex-col gap-1">
              <span className="tabular text-fg-1">{score === null ? 'Not scored' : `${score} / 100`}</span>
              {score !== null ? (
                <span aria-hidden="true" className="block h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
                  <span className="block h-full rounded-full [background-image:var(--panel-grad)]" style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
                </span>
              ) : null}
            </dd>
            <dt className="text-fg-2">WhatsApp</dt>
            <dd className="tabular text-fg-1">{thread.lead.phoneLast4 ? `ends ${thread.lead.phoneLast4}` : 'None'}</dd>
            <dt className="text-fg-2">Email</dt>
            <dd className="break-all text-fg-1">{thread.lead.emailMasked ?? 'None'}</dd>
            <dt className="self-start text-fg-2">Unanswered</dt>
            <dd className="tabular text-fg-1">{thread.conversation.unansweredOutboundCount} sent since their last message</dd>
          </dl>
          {links.lead ? (
            <Link href={links.lead} className="inline-flex w-fit items-center gap-1 text-sm text-cyan underline-offset-4 hover:underline max-lg:min-h-11">
              <UserRound aria-hidden="true" className="size-3.5" />
              Open the lead
            </Link>
          ) : null}
        </section>
        <section className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg-1">
            <IconChip size="sm" hue="volt">
              <FileText />
            </IconChip>
            Quotations
          </h2>
          {thread.quotes.length === 0 ? (
            <p className="text-sm text-fg-2">
              None yet.
              {links.newQuote ? (
                <>
                  {' '}
                  <Link href={links.newQuote} className="inline-flex items-center gap-1 text-cyan underline-offset-4 hover:underline">
                    <FilePlus2 aria-hidden="true" className="size-3.5" />
                    Create one
                  </Link>
                </>
              ) : null}
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {thread.quotes.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center justify-between gap-2">
                  {links.quote ? (
                    <Link href={links.quote(q.id)} className="inline-flex items-center gap-1.5 font-medium text-cyan underline-offset-4 hover:underline max-lg:min-h-11">
                      <FileText aria-hidden="true" className="size-3.5" />
                      {q.number} v{q.versionNo}
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 font-medium text-fg-1">
                      <FileText aria-hidden="true" className="size-3.5" />
                      {q.number} v{q.versionNo}
                    </span>
                  )}
                  {props.quoteStatus ? props.quoteStatus(q.status) : <span className="text-fg-2">{q.status.replace(/_/g, ' ').toLowerCase()}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
