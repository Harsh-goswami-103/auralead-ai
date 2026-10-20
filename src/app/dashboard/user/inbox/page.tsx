/**
 * User Inbox (T22; 06-design §11.2 "User Inbox", §11.3 "Inbox thread list"): every open WhatsApp and
 * email conversation of the workspace, newest activity first, with the window state, AI mode or
 * takeover, delivery state and what needs a person. "Needs you" filters to threads with a draft to
 * approve, a failed or unknown delivery, a call request or a takeover. In DEMO the presenter can make
 * a lead "send" a WhatsApp message through the same receive path (Simulated). The list re-reads
 * itself every 10 s so worker results appear.
 *
 * Aurora look (design spec §6): PageHeader, the filter as a pill strip with a sliding highlight, and
 * the simulator aligned to the top of its column (sticky from xl) instead of stretching to the
 * height of the thread list.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { DemoSimulator } from '@/components/inbox/DemoSimulator';
import { InboxFilter } from '@/components/inbox/InboxFilter';
import { ThreadList } from '@/components/inbox/ThreadList';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { NotFoundError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { hasCapability } from '@/server/auth/guards';
import { listInboxThreads, listSimulationLeads } from '@/server/services/messaging/inbox';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const sp = await searchParams;
  const filter = sp.filter === 'needs_you' ? 'needs_you' : 'all';
  let list;
  try {
    list = await listInboxThreads(page.ctx, { filter });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const demo = page.ctx.mode === 'demo';
  const simLeads = demo ? await listSimulationLeads(page.ctx) : [];

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <PageHeader
        eyebrow="Inbox"
        title="Conversations"
        description="WhatsApp and email threads with your leads. Replies are checked for consent, opt-outs and the 24-hour window when they are sent."
      />

      <InboxFilter current={filter} counts={list.counts} />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={<Inbox aria-hidden="true" className="size-5" />}
            title={filter === 'needs_you' ? 'Nothing needs you right now' : 'No conversations'}
            description={
              filter === 'needs_you'
                ? 'Drafts to approve, failed or unknown deliveries, call requests and threads you took over appear here.'
                : 'A thread starts when a lead messages you on WhatsApp, or when an approved template or email is sent to a lead.'
            }
          />
        ) : (
          <ThreadList rows={list.rows} timeZone={list.timezone} now={list.serverNow} />
        )}
        {demo ? (
          <aside aria-label="Demo tools" className="min-w-0 xl:sticky xl:top-20">
            <DemoSimulator leads={simLeads} canSimulate={hasCapability(page.ctx, 'leads.write')} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
