/**
 * User Inbox (T22; 06-design §11.2 "User Inbox", §11.3 "Inbox thread list"): every open WhatsApp and
 * email conversation of the workspace, newest activity first, with the window state, AI mode or
 * takeover, delivery state and what needs a person. "Needs you" filters to threads with a draft to
 * approve, a failed or unknown delivery, a call request or a takeover. In DEMO the presenter can make
 * a lead "send" a WhatsApp message through the same receive path (Simulated). The list re-reads
 * itself every 10 s so worker results appear.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { DemoSimulator } from '@/components/inbox/DemoSimulator';
import { ThreadList } from '@/components/inbox/ThreadList';
import { EmptyState } from '@/components/patterns/EmptyState';
import { cn } from '@/components/ui/cn';
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
  const tabs = [
    { key: 'all', label: `All (${list.counts.all})`, href: '/dashboard/user/inbox' },
    { key: 'needs_you', label: `Needs you (${list.counts.needsYou})`, href: '/dashboard/user/inbox?filter=needs_you' },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Inbox</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Conversations</h1>
        <p className="max-w-prose text-fg-2">WhatsApp and email threads with your leads. Replies are checked for consent, opt-outs and the 24-hour window when they are sent.</p>
      </header>

      <nav aria-label="Inbox filter" className="flex gap-1 border-b border-border-subtle">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={filter === t.key ? 'page' : undefined}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', filter === t.key ? 'border-primary font-medium text-fg-1' : 'border-transparent text-fg-2 hover:text-fg-1')}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
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
        {demo ? <DemoSimulator leads={simLeads} canSimulate={hasCapability(page.ctx, 'leads.write')} /> : null}
      </div>
    </div>
  );
}
