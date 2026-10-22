/**
 * One conversation in the client panel (T22; 06-design §11.2 "User Inbox" second and third fold;
 * ADR-121 WhatsApp-like look, ADR-122 AI replies, ADR-124 handed-over leads). The view is the shared
 * ConversationView (threads, the conversation with its header, timeline and composer, the lead
 * context and, in DEMO, the customer's phone); this page loads it for the session's workspace and
 * links quotations to the client's own pages. Another workspace's conversation is 404.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ConversationView } from '@/components/inbox/ConversationView';
import { USER_INBOX_PATH } from '@/components/inbox/ThreadList';
import { NotFoundError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { getRuntime } from '@/server/boot';
import { getInboxThread, inboxDepsFromConfig, listInboxThreads, type InboxList, type InboxThread } from '@/server/services/messaging/inbox';
import { isQuoteStatus, QuoteStatusBadge } from '../../quotations/quote-status';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

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
  return (
    <ConversationView
      thread={thread}
      list={list}
      basePath={USER_INBOX_PATH}
      canDecide={hasCapability(ctx, 'approvals.decide')}
      links={{
        list: USER_INBOX_PATH,
        lead: null,
        quote: (id) => `/dashboard/user/quotations/${id}`,
        newQuote: `/dashboard/user/quotations/new?leadId=${thread.lead.id}`,
      }}
      quoteStatus={(status) => (isQuoteStatus(status) ? <QuoteStatusBadge status={status} /> : <span className="text-fg-2">{status}</span>)}
    />
  );
}
