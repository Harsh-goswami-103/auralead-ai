/**
 * Cross-workspace approval view for an employee (T22; 06-design §11.2 route map "also cross-ws view
 * at /dashboard/employee/approvals", F8). One section per active assignment, each read through that
 * workspace's own tenant-scoped context (the same resolution as a `[ws]` page), so an item is only
 * ever shown and decided inside its workspace. A workspace where the assignment lacks `leads.read`
 * is listed as not readable instead of hidden. Every item opens in its workspace's queue.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Building2, ClipboardCheck } from 'lucide-react';
import { QueueList } from '@/components/approvals/QueueList';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { listApprovalQueue, type ApprovalQueue } from '@/server/services/approvals/queue';
import { loadPanelChrome } from '@/server/services/shell/panel-chrome';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

type Section = { slug: string; name: string; queue: ApprovalQueue | null };

export default async function EmployeeApprovalsPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();
  const chrome = await loadPanelChrome(page.ctx, page.session, { envOutboundPaused: getRuntime().config.outboundPaused });
  const sections: Section[] = [];
  for (const ws of chrome.switchable) {
    const scoped = await getPageContext({ workspaceSlug: ws.slug });
    if (!scoped) redirect('/login');
    try {
      sections.push({ slug: ws.slug, name: ws.name, queue: await listApprovalQueue(scoped.ctx) });
    } catch (error) {
      if (!(error instanceof PermissionDeniedError)) throw error;
      sections.push({ slug: ws.slug, name: ws.name, queue: null });
    }
  }
  const now = page.ctx.clock.now();
  const waiting = sections.reduce((n, s) => n + (s.queue?.pending.length ?? 0), 0);

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Approvals</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">All assigned workspaces</h1>
        <p className="max-w-prose text-fg-2">
          {sections.length === 0 ? 'You have no active workspace assignment.' : `${waiting} item${waiting === 1 ? '' : 's'} waiting across ${sections.length} workspace${sections.length === 1 ? '' : 's'}. Each item is decided inside its own workspace.`}
        </p>
      </header>

      {sections.length === 0 ? (
        <EmptyState icon={<Building2 aria-hidden="true" className="size-5" />} title="No assigned workspaces" description="A super admin assigns workspaces to employees. Their approval queues appear here once assigned." />
      ) : (
        sections.map((s) => (
          <section key={s.slug} aria-labelledby={`ws-${s.slug}`} className="flex flex-col gap-3" data-workspace-queue={s.slug}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id={`ws-${s.slug}`} className="font-display text-lg font-semibold text-fg-1">
                {s.name}
              </h2>
              <Link href={`/dashboard/employee/${s.slug}/approvals`} className="text-sm text-cyan underline-offset-4 hover:underline">
                Open queue
              </Link>
            </div>
            {s.queue === null ? (
              <p className="text-sm text-fg-2">Not readable: your assignment here does not include leads.</p>
            ) : s.queue.pending.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-fg-2">
                <ClipboardCheck aria-hidden="true" className="size-4" />
                Nothing waiting.
              </p>
            ) : (
              <QueueList items={s.queue.pending} href={(i) => `/dashboard/employee/${s.slug}/approvals/${i.id}`} now={now} timeZone={s.queue.workspace.timezone} />
            )}
          </section>
        ))
      )}
    </div>
  );
}
