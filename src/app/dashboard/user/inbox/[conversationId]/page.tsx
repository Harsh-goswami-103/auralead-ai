/**
 * One conversation (T22; 06-design §11.2 "User Inbox" second and third fold, §11.8 breakpoints).
 * At 1280 px and above three panes: threads, the conversation, the lead context; below that the
 * conversation alone with a link back to the list. The thread shows every message with its delivery
 * state and events, the AI mode and takeover controls, AI suggestions with approve-and-send and
 * reject, and the composer whose eligibility line comes from the server ("Final check happens at
 * send"). Another workspace's conversation is 404. The page re-reads itself while a send is in
 * flight or a reply is being prepared.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, FileText, Mail, MessageCircle } from 'lucide-react';
import { ApprovalActions, type ActionChannel } from '@/components/approvals/ApprovalActions';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { Composer } from '@/components/inbox/Composer';
import { DemoSimulator } from '@/components/inbox/DemoSimulator';
import { ModeControls } from '@/components/inbox/ModeControls';
import { ThreadList } from '@/components/inbox/ThreadList';
import { ThreadTimeline } from '@/components/inbox/ThreadTimeline';
import type { Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { NotFoundError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { getRuntime } from '@/server/boot';
import { getInboxThread, inboxDepsFromConfig, listInboxThreads, type InboxList, type InboxThread, type ThreadMessage } from '@/server/services/messaging/inbox';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

const STAGE_LABELS: Record<string, string> = { NEW: 'New', CONTACTED: 'Contacted', REPLIED: 'Replied', QUOTE_SENT: 'Quote sent', CONVERTED: 'Converted', LOST: 'Lost' };
const SOURCE_LABELS: Record<string, string> = { GOOGLE_SHEETS: 'Google Sheets', META_ADS: 'Meta Lead Ads', GMAPS_EXTENSION: 'Maps extension', WHATSAPP_INBOUND: 'WhatsApp', EMAIL_INBOUND: 'Email', MANUAL: 'Manual' };
const QUOTE_STATUS: Record<string, string> = { DRAFT: 'Draft', APPROVED: 'Approved', SENT: 'Sent', VIEWED: 'Opened (may be automated)', ACCEPTED: 'Accepted', EXPIRED: 'Expired', CANCELLED: 'Cancelled' };

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
  const inFlight = thread.messages.some((m) => m.status === 'PENDING') || thread.messages.at(-1)?.direction === 'IN';
  const ChannelIcon = thread.conversation.channel === 'EMAIL' ? Mail : MessageCircle;

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
        label={m.generatorLabel === 'human' ? 'Draft reply' : 'AI suggestion'}
        versionNo={null}
        isCurrent
        pdfReady
        channels={[channel]}
        permissions={{ canDecide, canSend: thread.permissions.canSend }}
      />
    );
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)_17rem] 2xl:grid-cols-[20rem_minmax(0,1fr)_19rem]">
      <AutoRefresh intervalMs={inFlight ? 3_000 : 10_000} />
      <aside aria-label="Conversations" className="hidden xl:block">
        <ThreadList rows={list.rows} activeId={thread.conversation.id} timeZone={tz} now={thread.serverNow} />
      </aside>

      <section aria-labelledby="thread-heading" className="flex min-w-0 flex-col gap-4">
        <Link href="/dashboard/user/inbox" className="inline-flex w-fit items-center gap-1 text-sm text-fg-2 hover:text-fg-1 xl:hidden">
          <ArrowLeft aria-hidden="true" className="size-4" />
          All conversations
        </Link>
        <header className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ChannelIcon aria-hidden="true" className="size-5 text-fg-2" />
            <h1 id="thread-heading" className="font-display text-xl font-semibold text-fg-1 sm:text-2xl">
              {thread.lead.displayName}
            </h1>
            <span className="text-sm text-fg-2">{thread.conversation.channel === 'EMAIL' ? 'Email' : 'WhatsApp'}</span>
            {thread.lead.simulated ? <ModeChip simulated /> : null}
          </div>
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
          <p className="text-sm text-fg-2">No messages in this conversation yet.</p>
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
        />
      </section>

      <aside aria-label="Lead" className="flex flex-col gap-4">
        <section className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-4">
          <h2 className="text-sm font-semibold text-fg-1">Lead</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-fg-2">Stage</dt>
            <dd className="text-fg-1">{STAGE_LABELS[thread.lead.salesStage] ?? thread.lead.salesStage}</dd>
            <dt className="text-fg-2">Source</dt>
            <dd className="text-fg-1">{SOURCE_LABELS[thread.lead.firstSource] ?? thread.lead.firstSource}</dd>
            <dt className="text-fg-2">City</dt>
            <dd className="text-fg-1">{thread.lead.city ?? 'Unknown'}</dd>
            <dt className="text-fg-2">Score</dt>
            <dd className="tabular text-fg-1">{thread.lead.score === null ? 'Not scored' : `${thread.lead.score} / 100`}</dd>
            <dt className="text-fg-2">WhatsApp</dt>
            <dd className="tabular text-fg-1">{thread.lead.phoneLast4 ? `ends ${thread.lead.phoneLast4}` : 'None'}</dd>
            <dt className="text-fg-2">Email</dt>
            <dd className="break-all text-fg-1">{thread.lead.emailMasked ?? 'None'}</dd>
            <dt className="text-fg-2">Unanswered</dt>
            <dd className="tabular text-fg-1">{thread.conversation.unansweredOutboundCount} sent since their last message</dd>
          </dl>
        </section>
        <section className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-4">
          <h2 className="text-sm font-semibold text-fg-1">Quotations</h2>
          {thread.quotes.length === 0 ? (
            <p className="text-sm text-fg-2">
              None yet.{' '}
              <Link href={`/dashboard/user/quotations/new?leadId=${thread.lead.id}`} className="text-cyan underline-offset-4 hover:underline">
                Create one
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {thread.quotes.map((q) => (
                <li key={q.id}>
                  <Link href={`/dashboard/user/quotations/${q.id}`} className="inline-flex items-center gap-1.5 text-cyan underline-offset-4 hover:underline">
                    <FileText aria-hidden="true" className="size-3.5" />
                    {q.number} v{q.versionNo}
                  </Link>{' '}
                  <span className="text-fg-2">{QUOTE_STATUS[q.status] ?? q.status}</span>
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
