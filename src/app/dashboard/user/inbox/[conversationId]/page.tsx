/**
 * One conversation (T22; 06-design §11.2 "User Inbox" second and third fold, §11.8 breakpoints).
 * At 1280 px and above three panes: threads, the conversation, the lead context; below that the
 * conversation alone with a link back to the list. The thread shows every message with its delivery
 * state and events, the AI mode and takeover controls, prepared replies with approve-and-send and
 * reject, and the composer whose eligibility line comes from the server ("Final check happens at
 * send"). Another workspace's conversation is 404. The page re-reads itself while a send is in
 * flight or a reply is being prepared: a send is pending, or the customer wrote last within the
 * last two minutes while AI replies are on (not Off, not taken over). Otherwise it re-reads every
 * 10 s, so a settled thread no longer polls every 3 s forever (user report).
 *
 * Aurora look (design spec §6): the thread list and the lead column stick under the top bar from xl
 * (the list scrolls inside itself), the header carries the lead's initials, the gradient name and
 * the channel chip, and the lead column shows the source chip, the stage pill, the score as a
 * meter with its value in words, and quotations with their status chips.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, FilePlus2, FileText, UserRound } from 'lucide-react';
import { ApprovalActions, type ActionChannel } from '@/components/approvals/ApprovalActions';
import { IconChip } from '@/components/patterns/IconChip';
import { InitialsAvatar } from '@/components/client/InitialsAvatar';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { Composer } from '@/components/inbox/Composer';
import { DemoSimulator } from '@/components/inbox/DemoSimulator';
import { ModeControls } from '@/components/inbox/ModeControls';
import { ThreadList } from '@/components/inbox/ThreadList';
import { ThreadTimeline } from '@/components/inbox/ThreadTimeline';
import type { Gate } from '@/components/patterns/GatedAction';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { Reveal } from '@/components/visual/Reveal';
import { NotFoundError } from '@/lib/errors';
import { generatorInfo } from '@/lib/schemas/lead-console';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { getRuntime } from '@/server/boot';
import { getInboxThread, inboxDepsFromConfig, listInboxThreads, type InboxList, type InboxThread, type ThreadMessage } from '@/server/services/messaging/inbox';
import { isQuoteStatus, QuoteStatusBadge } from '../../quotations/quote-status';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

const STAGE_LABELS: Record<string, string> = { NEW: 'New', CONTACTED: 'Contacted', REPLIED: 'Replied', QUOTE_SENT: 'Quote sent', CONVERTED: 'Converted', LOST: 'Lost' };
/** How long after an inbound message the page keeps polling fast for the AI's reply. */
const REPLY_WINDOW_MS = 120_000;

function draftGate(thread: InboxThread, m: ThreadMessage): Gate | null {
  if (m.kind === 'TEMPLATE') return thread.composer.templateGate;
  const f = thread.composer.freeform;
  if (f.eligible || f.deferrable) return null;
  const index = f.reasons.findIndex((r) => r !== 'GLOBAL_PAUSED' && r !== 'CAP_REACHED');
  const code = f.reasons[index >= 0 ? index : 0];
  const label = f.labels[index >= 0 ? index : 0] ?? 'This message cannot be sent now';
  return { category: code === 'NOT_CONFIGURED' ? 'configuration' : 'eligibility', reason: `${label}.` };
}

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const page = await getPageContext();
  if (!page) redirect('/login');
  const ctx = page.ctx;
  let thread: InboxThread;
  let list: InboxList;
  try {
    thread = await getInboxThread(ctx, conversationId, inboxDepsFromConfig(getRuntime().config));
    list = await listInboxThreads(ctx, {});
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const tz = thread.workspace.timezone;
  const canDecide = hasCapability(ctx, 'approvals.decide');
  const last = thread.messages.at(-1);
  const replyExpected =
    last?.direction === 'IN' && thread.conversation.aiMode !== 'OFF' && !thread.conversation.humanTakeover && thread.serverNow.getTime() - last.at.getTime() < REPLY_WINDOW_MS;
  const inFlight = thread.messages.some((m) => m.status === 'PENDING') || replyExpected;
  const channelSource = thread.conversation.channel === 'EMAIL' ? 'EMAIL_INBOUND' : 'WHATSAPP_INBOUND';
  const score = thread.lead.score;

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
        permissions={{ canDecide, canSend: thread.permissions.canSend }}
      />
    );
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_17rem] 2xl:grid-cols-[20rem_minmax(0,1fr)_19rem]">
      <AutoRefresh intervalMs={inFlight ? 3_000 : 10_000} />
      <aside
        aria-label="Conversations"
        className="hidden min-w-0 xl:sticky xl:top-20 xl:block xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:rounded-xl xl:[scrollbar-color:var(--border-strong)_transparent] xl:[scrollbar-width:thin]"
      >
        <ThreadList rows={list.rows} activeId={thread.conversation.id} timeZone={tz} now={thread.serverNow} compact />
      </aside>

      <section aria-labelledby="thread-heading" className="flex min-w-0 flex-col gap-4">
        <Link href="/dashboard/user/inbox" className="group inline-flex min-h-11 w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1 lg:min-h-9 xl:hidden">
          <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
          All conversations
        </Link>
        <header className="relative flex flex-col gap-4 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5">
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-0 h-0.5 rounded-full [background-image:var(--grad-hairline)]" />
          <Reveal className="flex min-w-0 items-center gap-3">
            <InitialsAvatar name={thread.lead.displayName} tone={thread.conversation.channel === 'EMAIL' ? 'email' : 'whatsapp'} size="lg" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 id="thread-heading" className="text-gradient max-w-full truncate font-display text-xl font-semibold sm:text-2xl">
                {thread.lead.displayName}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5">
                <SourceChip source={channelSource} withIcon />
                {thread.lead.simulated ? <ModeChip simulated /> : null}
              </div>
            </div>
          </Reveal>
          <ModeControls
            conversationId={thread.conversation.id}
            workspaceName={thread.workspace.name}
            aiMode={thread.conversation.aiMode}
            humanTakeover={thread.conversation.humanTakeover}
            modeVersion={thread.conversation.modeVersion}
            autoSendEnabled={thread.conversation.autoSendEnabled}
            autoAvailable={thread.conversation.autoAvailable}
            canChangeMode={thread.permissions.canChangeMode}
          />
        </header>

        {thread.messages.length === 0 && thread.events.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-fg-2">No messages in this conversation yet.</p>
        ) : (
          <ThreadTimeline messages={thread.messages} events={thread.events} timeZone={tz} draftActions={draftActions} leadName={thread.lead.displayName} />
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
        />
      </section>

      <aside aria-label="Lead" className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:[scrollbar-width:thin]">
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
              None yet.{' '}
              <Link href={`/dashboard/user/quotations/new?leadId=${thread.lead.id}`} className="inline-flex items-center gap-1 text-cyan underline-offset-4 hover:underline">
                <FilePlus2 aria-hidden="true" className="size-3.5" />
                Create one
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {thread.quotes.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/dashboard/user/quotations/${q.id}`} className="inline-flex items-center gap-1.5 font-medium text-cyan underline-offset-4 hover:underline max-lg:min-h-11">
                    <FileText aria-hidden="true" className="size-3.5" />
                    {q.number} v{q.versionNo}
                  </Link>
                  {isQuoteStatus(q.status) ? <QuoteStatusBadge status={q.status} /> : <span className="text-fg-2">{q.status}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        {thread.permissions.canSimulate && thread.conversation.channel === 'WHATSAPP' && thread.lead.phoneLast4 ? (
          <DemoSimulator leads={[{ id: thread.lead.id, displayName: thread.lead.displayName, phoneLast4: thread.lead.phoneLast4 }]} fixedLeadId={thread.lead.id} canSimulate compact />
        ) : null}
      </aside>
    </div>
  );
}
